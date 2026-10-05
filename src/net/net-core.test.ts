import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { getAIInput } from '../sim/ai';
import { useItem } from '../sim/items';
import { createRace, stepRace } from '../sim/race';
import { COURSE_FINGERPRINT, TRACK_IDS } from '../sim/tracks';
import { CLOCK_WINDOW_MS, ClockSync, packPing, packPong, TickMap, TICK_MS, unpackClock } from './clock';
import { INPUT_HOLD_TICKS, InputBuffer, NEUTRAL_INPUT, pack, quantizeInput, unpack } from './inputBuffer';
import { MockTransport } from './mockTransport';
import {
  PROTOCOL_TRACK_IDS,
  controlGuards, encodeControlMessage, isControlMessage, isPlayerName, isRaceEvent, isRaceState,
  isRosterPlayers, MAX_CONTROL_LENGTH, PacketKind, parseControlMessage, PROTOCOL_VERSION, ROOM_PREFIX,
} from './protocol';
import type { ControlMessage, InputFrame, RosterPlayer } from './protocol';
import { fromPeerId, generateRoomCode, isRoomCode, normalize, ROOM_ALPHABET, toPeerId } from './roomCode';
import { TransportError } from './transport';
import type { PeerLink } from './transport';

const accelerate: InputFrame = { steer: 0, throttle: 1, brake: false, drift: false, useItem: false };
const players: RosterPlayer[] = Array.from({ length: 8 }, (_, slot) => ({
  slot, name: `RACER${slot}`, color: 0xff0000 + slot,
  kind: slot === 0 ? 'host' : slot === 1 ? 'guest' : 'cpu', connected: slot < 2,
}));

function finalState() {
  return {
    tick: 600, seed: 42, trackId: 'meadow' as const, phase: 'finished' as const, countdown: 0, racingTicks: 420, time: 7,
    karts: players.map(player => ({
      id: player.slot, name: player.name, color: player.color, x: 0, y: 0, z: 0, heading: 0,
      speed: 0, steer: 0, trackDistance: 0, lateralOffset: 0, lap: 3, nextCheckpoint: 0,
      lapStartTime: 0, lapTimes: [2, 2, 3], finishTime: 7, driftTime: 0, driftDirection: 0,
      boostTime: 0, spinTime: 0, hopTime: 0, item: null, wrongWay: false, startedLap: true,
      lapProgress: 0, lapValid: true, previousDrift: false, previousItem: false, aiPhase: 0, hitCooldown: 0, airTime: 0,
      human: player.kind !== 'cpu', effects: { rouletteTime: 0, rapidTime: 0, rapidUnused: 1, auraTime: 0, shrinkTime: 0, inkTime: 0,
        autoTime: 0, charges: 0, holding: 0, aiHoldTicks: 0, orbitKind: 0, orbitCount: 0 },
    })),
    boxes: [{ id: 100, x: 0, y: 0, z: 0, heading: 0, respawnTime: 0 }],
    projectiles: [{ kind: 'bolt' as const, id: 101, ownerId: 0, x: 0, y: 0, z: 0, heading: 0, life: 1, bounces: 0 }],
    traps: [{ kind: 'trap' as const, id: 102, ownerId: 1, x: 0, y: 0, z: 0, heading: 0, life: 1, age: 0 }],
    events: [{ type: 'finish' as const, kartId: 0, value: 7 }], nextEntityId: 103,
  };
}

const messages: ControlMessage[] = [
  { type: 'hello', protocol: PROTOCOL_VERSION, course: COURSE_FINGERPRINT, name: 'ゲスト', color: 0xff0000 },
  { type: 'welcome', trackId: 'meadow', slot: 1, roster: players, hostTime: 100 },
  { type: 'reject', reason: 'full' },
  { type: 'roster', players },
  { type: 'profile', name: 'PIP', color: 0xabcdef },
  { type: 'race_start', trackId: 'meadow', raceId: 1, seed: 0xffffffff, roster: players, startAtHostTime: 1500 },
  { type: 'events', raceId: 1, tick: 600, events: [{ type: 'lap', kartId: 1, value: 3 }] },
  { type: 'race_end', raceId: 1, finalState: finalState() },
  { type: 'return_lobby' }, { type: 'leave' }, { type: 'host_closed' },
  { type: 'course', trackId: 'neon' },
];

async function pair(network: MockTransport, room = 'AB2X') {
  const host = await network.host(room);
  let server!: PeerLink;
  host.onJoin(link => { server = link; });
  const guest = await network.join(room);
  return { host, server, guest };
}

describe('room codes', () => {
  it('generates 100,000 four-character codes using only the permitted alphabet', () => {
    const characters = new Set<string>();
    let valid = true;
    for (let i = 0; i < 100_000; i++) {
      const code = generateRoomCode();
      valid &&= code.length === 4 && isRoomCode(code) && [...code].every(char => ROOM_ALPHABET.includes(char));
      for (const char of code) characters.add(char);
    }
    expect(valid).toBe(true);
    expect(characters.size).toBe(ROOM_ALPHABET.length);
  });

  it('normalizes ASCII case and surrounding space, rejects excluded characters and Unicode expansions', () => {
    expect(normalize('ab2x ')).toBe('AB2X');
    for (const code of ['AB0X', 'ABOX', 'AB1X', 'ABIX', 'ABLX', 'A B2', 'A!2X', 'ABC', 'ABCDE', 'ß2x', 'ＡＢ２Ｘ', '', null, 1234]) {
      expect(normalize(code), String(code)).toBeNull();
    }
    expect(toPeerId('ab2x ')).toBe(`${ROOM_PREFIX}AB2X`);
    expect(fromPeerId(toPeerId('AB2X'))).toBe('AB2X');
    expect(fromPeerId('pcircuit-v0-AB2X')).toBeNull();
    expect(fromPeerId(`${ROOM_PREFIX}AB0X`)).toBeNull();
    expect(() => toPeerId('AB0X')).toThrow(TypeError);
  });
});

describe('control protocol', () => {
  it('isolates protocol v7 rooms from earlier versions', () => {
    expect(PROTOCOL_VERSION).toBe(7);
    expect(ROOM_PREFIX).toBe('pcircuit-v7-');
    expect(fromPeerId('pcircuit-v5-AB2X')).toBeNull();
  });

  it.each(TRACK_IDS)('guards %s in welcome, course, race_start and race_end', trackId => {
    const controls: ControlMessage[] = [
      { type: 'welcome', slot: 1, roster: players, hostTime: 0, trackId },
      { type: 'course', trackId },
      { type: 'race_start', raceId: 1, seed: 42, roster: players, startAtHostTime: 1500, trackId },
    ];
    for (const message of controls) {
      expect(parseControlMessage(encodeControlMessage(message))).toEqual(message);
      const missing: Record<string, unknown> = { ...message };
      delete missing.trackId;
      for (const invalid of [missing, { ...message, extra: true },
        ...['unknown', 'MEADOW', '', null, 0, {}, []].map(trackId => ({ ...message, trackId }))]) {
        expect(parseControlMessage(JSON.stringify(invalid))).toBeNull();
      }
    }
    const state = createRace(42, { trackId });
    state.karts[0].airTime = 0.8;
    const message: ControlMessage = { type: 'race_end', raceId: 1, finalState: state };
    expect(parseControlMessage(encodeControlMessage(message))).toEqual(message);
    const missing: Record<string, unknown> = { ...state };
    delete missing.trackId;
    for (const invalid of [missing, { ...state, trackId: 'unknown' }, { ...state, extra: true }]) {
      expect(isRaceState(invalid)).toBe(false);
      expect(parseControlMessage(JSON.stringify({ ...message, finalState: invalid }))).toBeNull();
    }
    const kart: Record<string, unknown> = { ...state.karts[0] };
    delete kart.airTime;
    expect(isRaceState({ ...state, karts: [kart, ...state.karts.slice(1)] })).toBe(false);
  });

  it('requires a uint32 course fingerprint and leaves mismatches for host version rejection', () => {
    const hello = messages[0];
    for (const course of [-1, 0x100000000, 1.5, null, '2027374372', {}, []]) {
      expect(parseControlMessage(JSON.stringify({ ...hello, course }))).toBeNull();
    }
    const mismatch = { ...hello, course: (COURSE_FINGERPRINT ^ 1) >>> 0 };
    expect(parseControlMessage(JSON.stringify(mismatch))).toEqual(mismatch);
  });

  it.each(messages)('guards and round-trips $type', message => {
    const guard = controlGuards[message.type];
    expect(guard(message)).toBe(true);
    expect(isControlMessage(message)).toBe(true);
    expect(parseControlMessage(encodeControlMessage(message))).toEqual(message);
    for (const value of [null, undefined, true, 1, [], '{', '{"type":', 'x'.repeat(MAX_CONTROL_LENGTH + 1)]) {
      expect(guard(value)).toBe(false);
      expect(isControlMessage(value)).toBe(false);
      expect(parseControlMessage(value)).toBeNull();
    }
    for (const key of Object.keys(message)) {
      const missing: Record<string, unknown> = { ...message };
      delete missing[key];
      expect(guard(missing), `missing ${key}`).toBe(false);
      for (const value of [null, [], {}, 'x'.repeat(100)]) {
        if (key === 'events' && Array.isArray(value)) continue; // An empty event batch is valid.
        expect(guard({ ...message, [key]: value }), `invalid ${key}`).toBe(false);
      }
    }
    expect(guard({ ...message, extra: 'x'.repeat(MAX_CONTROL_LENGTH) })).toBe(false);
  });

  it('rejects malformed JSON, unknown discriminants, nested invalid values and oversized JSON', () => {
    for (const data of ['{', 'null', '[]', 'true', '{"type":"toString"}', '{"type":"__proto__"}',
      '{"type":"leave"} trailing', ' '.repeat(MAX_CONTROL_LENGTH) + '{"type":"leave"}']) {
      expect(parseControlMessage(data)).toBeNull();
    }
    expect(isPlayerName(' ')).toBe(false);
    expect(isPlayerName('bad\nname')).toBe(false);
    expect(isPlayerName('x'.repeat(11))).toBe(false);
    expect(isPlayerName('車'.repeat(10))).toBe(true);
    expect(isPlayerName('🏎'.repeat(10))).toBe(true);
    expect(isPlayerName('🏎'.repeat(11))).toBe(false);
    expect(controlGuards.hello({ ...messages[0], protocol: PROTOCOL_VERSION + 1 })).toBe(true);
    expect(controlGuards.hello({ ...messages[0], color: Infinity })).toBe(false);
    expect(controlGuards.hello({ ...messages[0], color: -1 })).toBe(false);
    expect(isRosterPlayers([...players, players[0]])).toBe(false);
    expect(isRosterPlayers([players[0], players[0]])).toBe(false);
    expect(isRosterPlayers([{ ...players[0], connected: 1 }])).toBe(false);
    expect(isRosterPlayers([{ ...players[0], name: 'x'.repeat(11) }])).toBe(false);
    expect(isRosterPlayers(Array(1))).toBe(false);
    expect(controlGuards.events({ ...messages[6], events: [{ type: 'unknown', kartId: 0 }] })).toBe(false);
    expect(controlGuards.events({ ...messages[6], events: [{ type: 'lap', kartId: 0, value: NaN }] })).toBe(false);
    expect(controlGuards.events({ ...messages[6], events: Array(257).fill({ type: 'go', kartId: -1 }) })).toBe(false);
    expect(controlGuards.race_start({ ...messages[5], raceId: 256 })).toBe(false);
    expect(() => encodeControlMessage({ type: 'reject', reason: 'unknown' } as unknown as ControlMessage)).toThrow();
  });

  it('validates the entire final state, not only the race_end envelope', () => {
    expect(isRaceState(finalState())).toBe(true);
    const invalidStates = [
      { ...finalState(), tick: -1 }, { ...finalState(), seed: NaN }, { ...finalState(), phase: 'bad' },
      { ...finalState(), karts: [] }, { ...finalState(), karts: [finalState().karts[0], finalState().karts[0]] },
      { ...finalState(), karts: [{ ...finalState().karts[0], name: 'x'.repeat(11) }] },
      { ...finalState(), karts: [{ ...finalState().karts[0], speed: '1' }] },
      { ...finalState(), karts: [{ ...finalState().karts[0], lapTimes: [Infinity] }] },
      { ...finalState(), boxes: [{ ...finalState().boxes[0], respawnTime: '0' }] },
      { ...finalState(), projectiles: [{ ...finalState().projectiles[0], ownerId: 8 }] },
      { ...finalState(), traps: [{ ...finalState().traps[0], age: null }] },
      { ...finalState(), events: [{ type: 'finish', kartId: 0, value: '7' }] },
    ];
    for (const state of invalidStates) {
      expect(isRaceState(state)).toBe(false);
      expect(parseControlMessage(JSON.stringify({ type: 'race_end', raceId: 0, finalState: state }))).toBeNull();
    }
  });

  it('preserves all effect timers, rapid-dash state and defensive hold ticks in race_end JSON', () => {
    const state = finalState();
    state.karts.forEach((kart, id) => {
      kart.effects = { rouletteTime: 1.4 - id * 0.1, rapidTime: 0.024, rapidUnused: id % 2, auraTime: 6.75,
        shrinkTime: 4.125, inkTime: 3.5, autoTime: 3.875, charges: id % 4,
        holding: id % 2, aiHoldTicks: id === 7 ? 60 : id * 8, orbitKind: id % 3, orbitCount: id % 4 };
    });
    const message: ControlMessage = { type: 'race_end', raceId: 4, finalState: state };
    expect(isRaceState(JSON.parse(JSON.stringify(state)))).toBe(true);
    expect(parseControlMessage(encodeControlMessage(message))).toEqual(message);
  });

  it.each([
    { field: 'rouletteTime' }, { field: 'rapidTime' }, { field: 'auraTime' }, { field: 'shrinkTime' },
    { field: 'inkTime' }, { field: 'autoTime' },
    { field: 'rapidUnused', max: 1 }, { field: 'charges', max: 3 },
    { field: 'holding', max: 1 }, { field: 'aiHoldTicks', max: 60 },
    { field: 'orbitKind', max: 2 }, { field: 'orbitCount', max: 3 },
  ])('requires a valid $field in restored effect state', ({ field, max }) => {
    const base = finalState();
    const missing: Record<string, unknown> = { ...base.karts[0].effects };
    delete missing[field];
    const invalidValues: unknown[] = [null, false, '1', -1, NaN, Infinity];
    if (max !== undefined) invalidValues.push(0.5, max + 1);
    const invalidEffects: Record<string, unknown>[] = [missing,
      ...invalidValues.map(value => ({ ...base.karts[0].effects, [field]: value }))];
    for (const effects of invalidEffects) {
      const state = { ...base, karts: base.karts.map((kart, id) => id === 0 ? { ...kart, effects } : kart) };
      expect(isRaceState(state), `${field}=${String(effects[field])}`).toBe(false);
      expect(parseControlMessage(JSON.stringify({ type: 'race_end', raceId: 4, finalState: state }))).toBeNull();
    }
  });

  it('validates projectile launch speed and clearance state in race_end payloads', () => {
    const base = finalState();
    const bomb = { ...base.projectiles[0], kind: 'bomb', speed: 56.5, aux: 2.4 };
    const state = { ...base, projectiles: [bomb] };
    expect(isRaceState(state)).toBe(true);
    expect(parseControlMessage(JSON.stringify({ type: 'race_end', raceId: 0, finalState: state })))
      .toEqual({ type: 'race_end', raceId: 0, finalState: state });
    for (const invalid of [
      { speed: -1 }, { speed: 128 }, { speed: NaN }, { speed: '56' },
      { ownerCleared: true }, { ownerCleared: false }, { ownerCleared: 1 }, { ownerCleared: null }, { bounces: 128 }, { kind: 'seeker' },
    ]) expect(isRaceState({ ...state, projectiles: [{ ...bomb, ...invalid }] })).toBe(false);
  });

  it('accepts every JSON-restored simulation state and event through a complete eight-kart race', () => {
    const racers = createRace(2026).karts.map(({ name, color }) => ({ name, color, human: true }));
    const state = createRace(2026, { racers });
    const events = new Set<string>();
    const kinds = new Set<string>();
    let held = false;
    const observe = () => {
      const restored: unknown = JSON.parse(JSON.stringify(state));
      expect(isRaceState(restored), `state at tick ${state.tick}`).toBe(true);
      for (const event of state.events) {
        expect(isRaceEvent(JSON.parse(JSON.stringify(event)))).toBe(true);
        events.add(event.type);
      }
      held ||= state.karts.some(kart => kart.effects.holding === 1);
      for (const entity of [...state.projectiles, ...state.traps]) kinds.add(entity.kind);
    };
    for (let tick = 0; tick < 60 * 180 && state.phase !== 'finished'; tick++) {
      if (state.phase === 'racing' && state.racingTicks === 0) {
        const items = ['seeker', 'skycomet', 'bomb', 'decoy', 'bolt', 'trap', 'ink', 'autopilot'] as const;
        items.forEach((item, id) => {
          const kart = state.karts[id];
          kart.item = item;
          useItem(state, kart, { ...NEUTRAL_INPUT, useItem: true });
          observe();
          useItem(state, kart, NEUTRAL_INPUT);
          // Projectiles can hit immediately in the grid; validate before physics removes them.
          observe();
        });
      }
      stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
      observe();
    }
    expect(state.phase).toBe('finished');
    expect(state.karts.every(kart => kart.finishTime !== null)).toBe(true);
    expect(held).toBe(true);
    for (const kind of ['seeker', 'skycomet', 'bomb', 'decoy']) expect(kinds.has(kind), kind).toBe(true);
    for (const type of ['go', 'pickup', 'use', 'hit', 'explode', 'ink', 'auto_start', 'lap', 'finish']) {
      expect(events.has(type), type).toBe(true);
    }
    expect(parseControlMessage(encodeControlMessage({ type: 'race_end', raceId: 1, finalState: state })))
      .toEqual({ type: 'race_end', raceId: 1, finalState: state });
  }, 20_000);
});

describe('MockTransport', () => {
  async function trace(seed: number, stepped = false) {
    const network = new MockTransport({ seed, latencyMs: 20, jitterMs: 8, lossRate: 0.3, reorderRate: 0.5, reorderDelayMs: 60 });
    const { guest, server } = await pair(network);
    const received: [number, string][] = [];
    server.onMessage((_, data) => received.push([network.now, data as string]));
    for (let i = 0; i < 200; i++) guest.send('unreliable', String(i));
    if (stepped) for (let i = 0; i < 100; i++) network.advance(1);
    else network.flush();
    return received;
  }

  it('reproduces delay, jitter, loss and reordering with a seed, regardless of clock step size', async () => {
    const first = await trace(42);
    expect(await trace(42)).toEqual(first);
    expect(await trace(42, true)).toEqual(first);
    expect(await trace(43)).not.toEqual(first);
    expect(first.length).toBeGreaterThan(100);
    expect(first.length).toBeLessThan(170);
    expect(first.every(([at]) => at >= 12 && at <= 88)).toBe(true);
    expect(new Set(first.map(([at]) => at)).size).toBeGreaterThan(10);
    expect(first.map(([, value]) => +value)).not.toEqual(first.map(([, value]) => +value).sort((a, b) => a - b));
  });

  it('keeps reliable traffic lossless and ordered, and snapshots binary payloads on send', async () => {
    const network = new MockTransport({ seed: 0, latencyMs: 20, jitterMs: 20, lossRate: 1, reorderRate: 1 });
    const { guest, server } = await pair(network);
    const received: (string | ArrayBuffer)[] = [];
    server.onMessage((_, data) => received.push(data));
    for (let i = 0; i < 20; i++) guest.send('reliable', String(i));
    guest.send('unreliable', 'lost');
    const binary = new Uint8Array([1, 2, 3]);
    guest.send('reliable', binary.buffer);
    binary.fill(9);
    expect(received).toEqual([]);
    network.flush();
    expect(received.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
    expect(new Uint8Array(received[20] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('applies exactly the configured fixed latency in both directions', async () => {
    const network = new MockTransport({ latencyMs: 20 });
    const { guest, server } = await pair(network);
    const times: number[] = [];
    server.onMessage(() => { times.push(network.now); server.send('unreliable', 'pong'); });
    guest.onMessage(() => times.push(network.now));
    guest.send('unreliable', 'ping');
    network.advance(19);
    expect(times).toEqual([]);
    network.advance(1);
    expect(times).toEqual([20]);
    network.advance(20);
    expect(times).toEqual([20, 40]);
  });

  it('propagates close once, cancels pending delivery, isolates guests, and releases room IDs', async () => {
    const network = new MockTransport();
    const { host, guest, server } = await pair(network);
    const secondGuest = await network.join('ab2x ');
    const closes: string[] = [];
    const received: unknown[] = [];
    guest.onClose(reason => closes.push(`guest:${reason}`));
    server.onClose(reason => closes.push(`server:${reason}`));
    secondGuest.onClose(reason => closes.push(`second:${reason}`));
    server.onMessage((_, data) => received.push(data));
    guest.send('reliable', 'cancel');
    guest.close();
    guest.close();
    guest.send('reliable', 'closed');
    network.flush();
    expect(received).toEqual([]);
    expect(network.pendingMessages).toBe(0);
    expect(closes).toEqual(['guest:closed', 'server:peer_closed']);
    host.close();
    host.close();
    expect(closes).toEqual(['guest:closed', 'server:peer_closed', 'second:host_closed']);
    await expect(network.join('AB2X')).rejects.toMatchObject({ code: 'room_not_found' });
    await expect(network.host('AB2X')).resolves.toBeDefined();
  });

  it('queues joins until subscribed and reports typed transport failures', async () => {
    const network = new MockTransport();
    const host = await network.host('AB2X');
    const guest = await network.join('AB2X');
    const peers: string[] = [];
    host.onJoin(link => peers.push(link.peerId));
    expect(peers).toEqual(['mock-guest-1']);
    expect(guest.peerId).toBe(toPeerId('AB2X'));
    const regenerated = await network.host('ab2x');
    expect(isRoomCode(regenerated.roomCode)).toBe(true);
    expect(regenerated.roomCode).not.toBe(host.roomCode);
    const secondGuest = await network.join(regenerated.roomCode);
    expect(secondGuest.peerId).toBe(toPeerId(regenerated.roomCode));
    regenerated.close();
    await expect(network.join('ZZZZ')).rejects.toBeInstanceOf(TransportError);
    await expect(network.join('ZZZZ')).rejects.toMatchObject({ code: 'room_not_found' });
    expect(() => network.advance(-1)).toThrow(RangeError);
    expect(() => new MockTransport({ lossRate: 2 })).toThrow(RangeError);
  });

  it('closes every guest and cancels delivery even when close handlers throw', async () => {
    const network = new MockTransport();
    const { host, guest, server } = await pair(network);
    const secondGuest = await network.join('AB2X');
    const closed: string[] = [];
    server.onClose(() => { throw new Error('consumer failure'); });
    server.onClose(() => closed.push('server'));
    guest.onClose(() => closed.push('guest'));
    secondGuest.onClose(() => closed.push('second'));
    guest.send('reliable', 'cancel first');
    secondGuest.send('reliable', 'cancel second');
    expect(() => host.close()).toThrow(AggregateError);
    expect(closed).toEqual(['server', 'guest', 'second']);
    expect(network.pendingMessages).toBe(0);
    network.flush();
    expect(() => host.close()).not.toThrow();
    await expect(network.host('AB2X')).resolves.toBeDefined();
  });
});

describe('clock synchronization', () => {
  it.each([1, 7, 42, 314, 65535])('converges within ten RTT 40 +/- 15ms samples (seed %i)', async seed => {
    const network = new MockTransport({ seed, latencyMs: 20, jitterMs: 7.5 });
    const { guest, server } = await pair(network);
    const clock = new ClockSync();
    const offset = 4321.25;
    const rtts: number[] = [];
    server.onMessage((_, data) => {
      const ping = unpackClock(data);
      if (ping?.kind === PacketKind.PING) server.send('unreliable', packPong(ping.t0, network.now + offset));
    });
    guest.onMessage((_, data) => {
      const pong = unpackClock(data);
      if (pong?.kind === PacketKind.PONG) {
        rtts.push(network.now - pong.t0);
        expect(clock.sample(pong.t0, pong.hostNow, network.now)).toBe(true);
      }
    });
    for (let i = 0; i < 10; i++) {
      guest.send('unreliable', packPing(network.now));
      network.advance(100);
    }
    expect(clock.sampleCount).toBe(10);
    expect(clock.ready).toBe(true);
    expect(rtts.every(rtt => rtt >= 25 && rtt <= 55)).toBe(true);
    expect(clock.rtt).toBe(Math.min(...rtts));
    expect(Math.abs(clock.offset - offset)).toBeLessThan(5);
  });

  it('rejects invalid/duplicate samples and expires the 10-second minimum-RTT window', () => {
    const clock = new ClockSync();
    expect(clock.ready).toBe(false);
    expect(clock.sample(0, 120, 40)).toBe(true);
    expect(clock.offset).toBe(100);
    expect(clock.sample(100, 235, 200)).toBe(true);
    expect(clock.offset).toBe(100);
    expect(clock.sample(0, 120, 240)).toBe(false);
    for (const args of [[NaN, 1, 2], [2, 1, 1], [300, Infinity, 340], [0, 1, CLOCK_WINDOW_MS + 1]]) {
      expect(clock.sample(args[0], args[1], args[2])).toBe(false);
    }
    clock.expire(CLOCK_WINDOW_MS + 41);
    expect(clock.offset).toBe(85);
    clock.expire(CLOCK_WINDOW_MS + 201);
    expect(clock.sampleCount).toBe(0);
    expect(clock.ready).toBe(false);
    expect(clock.offset).toBe(0);
    clock.reset();
    expect(clock.sample(0, 20, 40)).toBe(true);
  });

  it('round-trips clock packets and rejects malformed packets', () => {
    expect(unpackClock(packPing(123.25))).toEqual({ kind: PacketKind.PING, t0: 123.25 });
    expect(unpackClock(packPong(123.25, 456.5))).toEqual({ kind: PacketKind.PONG, t0: 123.25, hostNow: 456.5 });
    for (const invalid of [null, '', new ArrayBuffer(0), new ArrayBuffer(8), new ArrayBuffer(9), packPong(0, 0).slice(0, 9)]) {
      expect(unpackClock(invalid)).toBeNull();
    }
    const invalid = packPing(0);
    new DataView(invalid).setFloat64(1, NaN, true);
    expect(unpackClock(invalid)).toBeNull();
    expect(() => packPing(-1)).toThrow(RangeError);
  });

  it('maps host time and ticks, refreshes after pauses, and derives RTT-dependent lead', () => {
    const map = new TickMap(0, 1500);
    expect(map.hostTickAt(1500)).toBe(0);
    expect(map.hostTimeAt(60)).toBe(2500);
    expect(map.update(60, 3000)).toBe(true);
    expect(map.hostTickAt(4000)).toBeCloseTo(120);
    expect(map.update(59, 4000)).toBe(false);
    const clock = new ClockSync();
    clock.sample(0, 120, 40);
    expect(clock.lead).toBe(4);
    expect(clock.targetTick(map, 2900)).toBe(64);
    clock.reset();
    clock.sample(0, 250, 300);
    expect(clock.lead).toBe(11);
    map.reset(0, 5000);
    expect(map.hostTickAt(5000)).toBe(0);
  });
});

describe('input packets and host buffer', () => {
  it('round-trips all steering values and flag combinations exactly on the wire lattice', () => {
    for (let steer = -127; steer <= 127; steer++) {
      for (let flags = 0; flags < 8; flags++) {
        const frame: InputFrame = { steer: steer / 127, throttle: (steer + 127) / 255,
          brake: !!(flags & 1), drift: !!(flags & 2), useItem: !!(flags & 4) };
        const packet = { slot: 7, raceId: 255, latestTick: 0xffffffff, frames: [frame, frame, frame, frame] };
        const bytes = pack(packet);
        expect(bytes.byteLength).toBe(20);
        expect(unpack(bytes)).toEqual(packet);
        expect(pack(unpack(bytes)!)).toEqual(bytes);
      }
    }
    expect(unpack(pack({ slot: 0, raceId: 0, latestTick: 0, frames: [accelerate] }))!.frames[0]).toEqual(accelerate);
    const original = { ...accelerate, steer: -0.345, throttle: 0.543 };
    const quantized = quantizeInput(original);
    expect(Math.abs(original.steer - quantized.steer)).toBeLessThanOrEqual(0.5 / 127);
    expect(Math.abs(original.throttle - quantized.throttle)).toBeLessThanOrEqual(0.5 / 255);
    expect(unpack(pack({ slot: 1, raceId: 2, latestTick: 10, frames: [original] }))!.frames[0]).toEqual(quantized);
  });

  it('rejects invalid headers, truncated/extra bytes, invalid flags, and tick underflow', () => {
    const packet = { slot: 1, raceId: 2, latestTick: 10, frames: [accelerate] };
    for (const invalid of [null, 'x', new ArrayBuffer(0), pack(packet).slice(0, 10), new ArrayBuffer(12)]) {
      expect(unpack(invalid)).toBeNull();
    }
    for (const [offset, value] of [[0, 2], [1, 8], [7, 0], [7, 5], [8, 128], [10, 8]]) {
      const bytes = pack(packet);
      new DataView(bytes).setUint8(offset, value);
      expect(unpack(bytes)).toBeNull();
    }
    for (const invalid of [{ ...packet, slot: -1 }, { ...packet, raceId: 256 }, { ...packet, latestTick: 1.5 },
      { ...packet, latestTick: 0, frames: [accelerate, accelerate] }, { ...packet, frames: Array(1) },
      { ...packet, frames: [{ ...accelerate, steer: NaN }] }]) {
      expect(() => pack(invalid)).toThrow(RangeError);
    }
  });

  it('uses tick-addressed input, holds for exactly ten ticks, and never regresses on reordering', () => {
    const buffer = new InputBuffer({ slot: 1, raceId: 2 });
    expect(buffer.get(0)).toEqual(NEUTRAL_INPUT);
    expect(buffer.receive({ slot: 1, raceId: 2, latestTick: 3, frames: [accelerate] }, 0)).toBe(true);
    expect(buffer.get(2)).toEqual(NEUTRAL_INPUT);
    expect(buffer.get(3)).toEqual(accelerate);
    for (let tick = 4; tick <= 3 + INPUT_HOLD_TICKS; tick++) expect(buffer.get(tick)).toEqual(accelerate);
    expect(buffer.get(14)).toEqual(NEUTRAL_INPUT);
    const turn = { ...accelerate, steer: 1 };
    expect(buffer.receive({ slot: 1, raceId: 2, latestTick: 13, frames: [turn] }, 14)).toBe(true);
    expect(buffer.get(15)).toEqual(turn);
    expect(buffer.receive({ slot: 1, raceId: 2, latestTick: 12, frames: [accelerate] }, 15)).toBe(false);
    expect(buffer.get(16)).toEqual(turn);
    expect(buffer.receive({ slot: 1, raceId: 1, latestTick: 30, frames: [accelerate] }, 16)).toBe(false);
    expect(buffer.receive({ slot: 2, raceId: 2, latestTick: 30, frames: [accelerate] }, 16)).toBe(false);
    expect(buffer.receive({ slot: 1, raceId: 2, latestTick: 1000, frames: [accelerate] }, 16)).toBe(false);
    expect(buffer.size).toBe(0);
    buffer.reset(3);
    expect(buffer.get(0)).toEqual(NEUTRAL_INPUT);
    expect(buffer.receive({ slot: 1, raceId: 2, latestTick: 1, frames: [accelerate] }, 0)).toBe(false);
    expect(buffer.receive({ slot: 1, raceId: 3, latestTick: 1, frames: [accelerate] }, 0)).toBe(true);
    expect(buffer.get(1)).toEqual(accelerate);
  });

  it('recovers a lost one-tick action from redundant history and copies received/returned frames', () => {
    const buffer = new InputBuffer();
    const action = { ...accelerate, useItem: true };
    buffer.receive({ slot: 0, raceId: 0, latestTick: 4, frames: [accelerate, action, accelerate, accelerate] }, 0);
    action.useItem = false;
    expect(buffer.get(2).useItem).toBe(false);
    expect(buffer.get(3).useItem).toBe(true);
    const input = buffer.get(4);
    input.throttle = 0;
    expect(buffer.get(4)).toEqual(accelerate);
    expect(buffer.get(5)).toEqual(accelerate);
    expect(buffer.size).toBe(0);
  });

  it.each([1, 7, 42, 314, 65535])('stays below 1%% neutral over 6,000 ticks at 30%% loss with reordering (seed %i)', async seed => {
    const network = new MockTransport({ seed, latencyMs: 20, jitterMs: 7.5,
      lossRate: 0.3, reorderRate: 0.5, reorderDelayMs: 50 });
    const { guest, server } = await pair(network);
    const buffer = new InputBuffer({ slot: 1, raceId: 3 });
    const history: InputFrame[] = [];
    let currentTick = 0;
    let neutralTicks = 0;
    let packetsReceived = 0;
    let reordered = 0;
    let greatestTick = -1;
    server.onMessage((_, data) => {
      const packet = unpack(data);
      if (packet) {
        packetsReceived++;
        if (packet.latestTick < greatestTick) reordered++;
        greatestTick = Math.max(greatestTick, packet.latestTick);
        buffer.receive(packet, currentTick);
      }
    });
    for (let tick = 0; tick < 6000; tick++) {
      currentTick = tick;
      history.unshift({ ...accelerate, steer: (tick % 3 - 1) / 127, drift: tick % 60 < 10 });
      history.length = Math.min(history.length, 4);
      guest.send('unreliable', pack({ slot: 1, raceId: 3, latestTick: tick + 4, frames: history }));
      network.advance(TICK_MS);
      if (buffer.get(tick).throttle === 0) neutralTicks++;
      expect(buffer.size).toBeLessThanOrEqual(120);
    }
    expect(packetsReceived / 6000).toBeGreaterThan(0.65);
    expect(packetsReceived / 6000).toBeLessThan(0.75);
    expect(reordered).toBeGreaterThan(100);
    expect(neutralTicks / 6000).toBeLessThan(0.01);
    network.advance(200);
    expect(buffer.get(6020)).toEqual(NEUTRAL_INPUT);
  });
});

it('lists the same course ids as the sim registry', () => {
  expect(PROTOCOL_TRACK_IDS).toEqual(TRACK_IDS);
});

it('keeps the net core independent of sim runtime and three', () => {
  const sources = import.meta.glob<string>(['./transport.ts', './protocol.ts', './roomCode.ts', './clock.ts',
    './inputBuffer.ts', './mockTransport.ts', './session.ts'], { query: '?raw', import: 'default', eager: true });
  expect(Object.keys(sources)).toHaveLength(7);
  for (const [path, text] of Object.entries(sources)) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        expect(specifier.includes('three')).toBe(false);
        if (specifier.includes('/sim/')) {
          expect(['./protocol.ts', './transport.ts']).toContain(path);
          expect(specifier).toBe('../sim/types');
          expect(ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly).toBe(true);
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        expect(node.arguments.map(argument => argument.getText(source)).join()).not.toMatch(/sim|three/);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});

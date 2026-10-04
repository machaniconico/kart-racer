import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { CLOCK_WINDOW_MS, ClockSync, packPing, packPong, TickMap, TICK_MS, unpackClock } from './clock';
import { INPUT_HOLD_TICKS, InputBuffer, NEUTRAL_INPUT, pack, quantizeInput, unpack } from './inputBuffer';
import { MockTransport } from './mockTransport';
import {
  controlGuards, encodeControlMessage, isControlMessage, isPlayerName, isRaceState,
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
    tick: 600, seed: 42, phase: 'finished' as const, countdown: 0, racingTicks: 420, time: 7,
    karts: players.map(player => ({
      id: player.slot, name: player.name, color: player.color, x: 0, y: 0, z: 0, heading: 0,
      speed: 0, steer: 0, trackDistance: 0, lateralOffset: 0, lap: 3, nextCheckpoint: 0,
      lapStartTime: 0, lapTimes: [2, 2, 3], finishTime: 7, driftTime: 0, driftDirection: 0,
      boostTime: 0, spinTime: 0, hopTime: 0, item: null, wrongWay: false, startedLap: true,
      lapProgress: 0, lapValid: true, previousDrift: false, previousItem: false, aiPhase: 0, hitCooldown: 0,
      human: player.kind !== 'cpu', effects: { rapidTime: 0, auraTime: 0, shrinkTime: 0, inkTime: 0,
        autoTime: 0, charges: 0, holding: 0, orbitKind: 0, orbitCount: 0 },
    })),
    boxes: [{ id: 100, x: 0, y: 0, z: 0, heading: 0, respawnTime: 0 }],
    projectiles: [{ kind: 'bolt' as const, id: 101, ownerId: 0, x: 0, y: 0, z: 0, heading: 0, life: 1, bounces: 0 }],
    traps: [{ kind: 'trap' as const, id: 102, ownerId: 1, x: 0, y: 0, z: 0, heading: 0, life: 1, age: 0 }],
    events: [{ type: 'finish' as const, kartId: 0, value: 7 }], nextEntityId: 103,
  };
}

const messages: ControlMessage[] = [
  { type: 'hello', protocol: PROTOCOL_VERSION, name: 'ゲスト', color: 0xff0000 },
  { type: 'welcome', slot: 1, roster: players, hostTime: 100 },
  { type: 'reject', reason: 'full' },
  { type: 'roster', players },
  { type: 'profile', name: 'PIP', color: 0xabcdef },
  { type: 'race_start', raceId: 1, seed: 0xffffffff, roster: players, startAtHostTime: 1500 },
  { type: 'events', raceId: 1, tick: 600, events: [{ type: 'lap', kartId: 1, value: 3 }] },
  { type: 'race_end', raceId: 1, finalState: finalState() },
  { type: 'return_lobby' }, { type: 'leave' }, { type: 'host_closed' },
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
    expect(controlGuards.hello({ ...messages[0], protocol: 2 })).toBe(true);
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
    await expect(network.host('ab2x')).rejects.toBeInstanceOf(TransportError);
    await expect(network.host('ab2x')).rejects.toMatchObject({ code: 'room_taken' });
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

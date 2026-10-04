import { describe, expect, it, vi } from 'vitest';
import { COURSE_FINGERPRINT, TRACK_IDS } from '../sim/tracks';
import { getAIInput } from '../sim/ai';
import { stepRace } from '../sim/race';
import type { InputFrame, InputSource, RaceEvent, RaceState } from '../sim/types';
import { packPing, packPong, TICK_MS, unpackClock } from './clock';
import { HostSession } from './hostSession';
import { NEUTRAL_INPUT, pack, quantizeInput } from './inputBuffer';
import { MockTransport } from './mockTransport';
import type { MockTransportOptions } from './mockTransport';
import { encodeControlMessage, isRaceEvent, isRaceState, PacketKind, parseControlMessage,
  PROTOCOL_VERSION } from './protocol';
import type { ControlMessage, Hello } from './protocol';
import { decodeSnapshot } from './snapshotCodec';
import type { ChannelKind, PeerLink, WireData } from './transport';

const DRIVE: InputFrame = { steer: 0.5, throttle: 1, brake: false, drift: true, useItem: true };
const HOST_INPUT: InputSource = { sample: getAIInput };

interface DummyGuest {
  link: PeerLink;
  messages: ControlMessage[];
  packets: Array<{ kind: ChannelKind; data: ArrayBuffer }>;
  raw: Array<{ kind: ChannelKind; data: WireData }>;
  control: (message: ControlMessage) => void;
}

async function setup(options: MockTransportOptions = {}) {
  const network = new MockTransport({ latencyMs: 0, ...options });
  const host = await HostSession.create(network, {
    roomCode: 'AB2X', name: 'HOST', now: () => network.now, hostInput: HOST_INPUT,
  });
  const guest = async (profile: Partial<Hello> = {}, sayHello = true, answerPings = true): Promise<DummyGuest> => {
    const link = await network.join('AB2X');
    const messages: ControlMessage[] = [];
    const packets: DummyGuest['packets'] = [];
    const raw: DummyGuest['raw'] = [];
    link.onMessage((kind, data) => {
      raw.push({ kind, data });
      if (typeof data === 'string') {
        const message = parseControlMessage(data);
        expect(message).not.toBeNull();
        messages.push(message!);
      } else {
        packets.push({ kind, data });
        const clock = unpackClock(data);
        if (answerPings && clock?.kind === PacketKind.PING) {
          link.send('unreliable', packPong(clock.t0, network.now + 1234));
        }
      }
    });
    const control = (message: ControlMessage) => link.send('reliable', encodeControlMessage(message));
    if (sayHello) control({ type: 'hello', protocol: PROTOCOL_VERSION, course: COURSE_FINGERPRINT, name: 'GUEST', color: 0xff5f80, ...profile });
    network.flush();
    return { link, messages, packets, raw, control };
  };
  return { network, host, guest };
}

function snapshots(guest: DummyGuest): ArrayBuffer[] {
  return guest.packets.filter(packet => new Uint8Array(packet.data)[0] === PacketKind.SNAPSHOT)
    .map(packet => packet.data);
}
function sendInput(guest: DummyGuest, host: HostSession, tick: number, input = DRIVE, slot = 1): void {
  guest.link.send('unreliable', pack({ slot, raceId: host.raceId, latestTick: tick, frames: [input] }));
}
function tick(host: HostSession, state: RaceState): InputFrame[] {
  const inputs = state.karts.map(kart => host.inputSource(kart.id).sample(state, kart.id));
  stepRace(state, inputs);
  host.afterTick(state);
  return inputs;
}

describe('HostSession lobby', () => {
  it.each(TRACK_IDS)('broadcasts %s to every guest and retains it for late joins and rematches', async trackId => {
    const { host, guest, network } = await setup();
    try {
      expect(host.course).toBe('meadow');
      const one = await guest();
      const two = await guest({ name: 'TWO' });
      const changed = vi.fn();
      host.onChange(changed);
      expect(host.setCourse(trackId)).toBe(true);
      network.flush();
      expect(host.course).toBe(trackId);
      expect(changed).toHaveBeenCalledOnce();
      for (const peer of [one, two]) expect(peer.messages.at(-1)).toEqual({ type: 'course', trackId });
      const late = await guest({ name: 'LATE' });
      expect(late.messages[0]).toMatchObject({ type: 'welcome', trackId });
      const state = host.startRace(42);
      network.flush();
      expect(state.trackId).toBe(trackId);
      for (const peer of [one, two, late]) expect(peer.messages.at(-1)).toMatchObject({
        type: 'race_start', trackId, seed: 42, raceId: 1,
      });
      host.returnToLobby();
      network.flush();
      expect(host.course).toBe(trackId);
      expect(one.messages.at(-1)).toEqual({ type: 'return_lobby' });
      expect(host.startRace(43).trackId).toBe(trackId);
      network.flush();
      expect(one.messages.at(-1)).toMatchObject({ type: 'race_start', trackId, raceId: 2 });
    } finally { host.close(); }
  });

  it('rejects invalid or guest-originated course changes and locks selection outside the lobby', async () => {
    const { host, guest, network } = await setup();
    try {
      const one = await guest();
      const changed = vi.fn();
      host.onChange(changed);
      const count = one.messages.length;
      expect(host.setCourse('unknown' as typeof host.course)).toBe(false);
      one.control({ type: 'course', trackId: 'neon' });
      network.flush();
      expect(host.course).toBe('meadow');
      expect(changed).not.toHaveBeenCalled();
      expect(one.messages).toHaveLength(count);
      host.setCourse('canyon');
      const state = host.startRace(42);
      expect(host.setCourse('neon')).toBe(false);
      state.phase = 'racing';
      tick(host, state);
      expect(host.setCourse('neon')).toBe(false);
      state.phase = 'finished';
      state.tick++;
      host.afterTick(state);
      expect(host.setCourse('neon')).toBe(false);
      expect(host.course).toBe('canyon');
      expect(state.trackId).toBe('canyon');
      host.returnToLobby();
      expect(host.setCourse('snowpeak')).toBe(true);
      host.close();
      expect(host.setCourse('neon')).toBe(false);
    } finally { host.close(); }
  });

  it('rejects a same-version build with a different course fingerprint before allocating a slot', async () => {
    const { host, guest } = await setup();
    try {
      expect((await guest({ course: (COURSE_FINGERPRINT ^ 1) >>> 0 })).messages)
        .toEqual([{ type: 'reject', reason: 'version' }]);
      expect(host.roster.players.filter(player => player.kind === 'guest')).toHaveLength(0);
      expect((await guest()).messages[0]).toMatchObject({ type: 'welcome', slot: 1 });
    } finally { host.close(); }
  });

  it('advertises the room code actually assigned by the transport after a collision', async () => {
    const network = new MockTransport({ latencyMs: 0 });
    const transport = {
      join: (code: string) => network.join(code),
      host: async () => Object.assign(await network.host('ZZZZ'), { roomCode: 'ZZZZ' }),
    };
    const host = await HostSession.create(transport, { roomCode: 'AB2X', now: () => network.now });
    expect(host.roster.roomCode).toBe('ZZZZ');
    const link = await network.join(host.roster.roomCode);
    const messages: WireData[] = [];
    link.onMessage((_, data) => messages.push(data));
    link.send('reliable', encodeControlMessage({ type: 'hello', protocol: PROTOCOL_VERSION, course: COURSE_FINGERPRINT, name: 'ONE', color: 0xff5f80 }));
    network.flush();
    expect(parseControlMessage(messages[0])).toMatchObject({ type: 'welcome', slot: 1 });
    host.close();
  });

  it('welcomes slots 1..7 in order, reserves host slot 0 and rejects the ninth player', async () => {
    const { host, guest } = await setup();
    for (let slot = 1; slot < 8; slot++) {
      const joined = await guest({ name: `G${slot}` });
      expect(joined.messages[0]).toMatchObject({ type: 'welcome', slot,
        roster: expect.arrayContaining([expect.objectContaining({ slot, name: `G${slot}`, kind: 'guest' })]) });
    }
    expect((await guest()).messages).toEqual([{ type: 'reject', reason: 'full' }]);
    expect(host.roster.players[0]).toMatchObject({ slot: 0, kind: 'host', connected: true });
    expect(new Set(host.roster.players.map(player => player.color)).size).toBe(8);
    host.close();
  });

  it('rejects wrong versions and joins during countdown, racing and results', async () => {
    const { host, guest } = await setup();
    expect((await guest({ protocol: PROTOCOL_VERSION + 1 })).messages).toEqual([{ type: 'reject', reason: 'version' }]);
    const state = host.startRace(123);
    expect((await guest()).messages).toEqual([{ type: 'reject', reason: 'in_race' }]);
    state.phase = 'racing';
    tick(host, state);
    expect(host.phase).toBe('racing');
    expect((await guest()).messages).toEqual([{ type: 'reject', reason: 'in_race' }]);
    state.tick++;
    state.phase = 'finished';
    host.afterTick(state);
    expect((await guest()).messages).toEqual([{ type: 'reject', reason: 'in_race' }]);
    host.returnToLobby();
    expect((await guest()).messages[0]).toMatchObject({ type: 'welcome', slot: 1 });
    host.close();
  });

  it('updates valid lobby profiles, swaps CPU colors and prevents occupied colors', async () => {
    const { host, guest, network } = await setup();
    const one = await guest();
    const two = await guest({ name: 'TWO' });
    const cpuColor = host.roster.players[5].color;
    one.control({ type: 'profile', name: 'NEW', color: cpuColor });
    network.flush();
    expect(host.roster.players[1]).toMatchObject({ name: 'NEW', color: cpuColor });
    expect(two.messages.at(-1)).toMatchObject({ type: 'roster', players: host.roster.players });
    one.control({ type: 'profile', name: 'INVALID', color: host.roster.players[2].color });
    network.flush();
    expect(host.roster.players[1].name).toBe('NEW');
    expect(host.setProfile('RENAMED', host.roster.players[6].color)).toBe(true);
    expect(host.setProfile('   ', cpuColor)).toBe(false);
    expect(new Set(host.roster.players.map(player => player.color)).size).toBe(8);
    const view = host.roster;
    (view.players[1] as { name: string }).name = 'MUTATED';
    expect(host.roster.players[1].name).toBe('NEW');
    host.startRace(1);
    one.control({ type: 'profile', name: 'RACING', color: cpuColor });
    network.flush();
    expect(host.roster.players[1].name).toBe('NEW');
    host.close();
  });

  it('ignores malformed, unadmitted, wrong-channel and repeated hello messages', async () => {
    const { host, guest, network } = await setup();
    const one = await guest({}, false);
    for (const data of ['{', '{}', '{"type":"hello"}', 'x'.repeat(65_537)]) one.link.send('reliable', data);
    one.link.send('unreliable', encodeControlMessage({ type: 'hello', protocol: PROTOCOL_VERSION, course: COURSE_FINGERPRINT, name: 'X', color: 0xff5f80 }));
    sendInput(one, host, 1);
    network.flush();
    expect(one.messages).toEqual([]);
    expect(host.roster.players.filter(player => player.kind === 'guest')).toHaveLength(0);
    one.control({ type: 'hello', protocol: PROTOCOL_VERSION, course: COURSE_FINGERPRINT, name: 'ONE', color: 0xff5f80 });
    network.flush();
    one.control({ type: 'hello', protocol: PROTOCOL_VERSION, course: COURSE_FINGERPRINT, name: 'AGAIN', color: 0xff5f80 });
    network.flush();
    expect(one.messages.filter(message => message.type === 'welcome')).toHaveLength(1);
    expect(host.roster.players.filter(player => player.kind === 'guest')).toHaveLength(1);
    host.close();
  });

  it('answers an otherwise valid hello with an invalid name by reject:bad_name, then drops the link', async () => {
    vi.useFakeTimers();
    try {
      const { host, guest, network } = await setup();
      const one = await guest({}, false);
      const closed = vi.fn();
      one.link.onClose(closed);
      one.link.send('reliable', JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, course: COURSE_FINGERPRINT, name: ' ', color: 0xff5f80 }));
      network.flush();
      expect(one.messages).toEqual([{ type: 'reject', reason: 'bad_name' }]);
      expect(host.roster.players.filter(player => player.kind === 'guest')).toHaveLength(0);
      vi.advanceTimersByTime(3000);
      network.flush();
      expect(closed).toHaveBeenCalled();
      host.close();
    } finally { vi.useRealTimers(); }
  });

  it('notifies listeners on roster and phase changes', async () => {
    const { host, guest } = await setup();
    const changed = vi.fn();
    host.onChange(changed);
    await guest();
    expect(changed).toHaveBeenCalled();
    changed.mockClear();
    const state = host.startRace(5);
    expect(changed).toHaveBeenCalledTimes(1);
    state.tick++;
    state.phase = 'finished';
    host.afterTick(state);
    expect(host.phase).toBe('results');
    host.returnToLobby();
    expect(changed).toHaveBeenCalledTimes(3);
    host.close();
  });
});

describe('HostSession input and disconnects', () => {
  it('applies received input, holds it for ten further ticks, then returns neutral', async () => {
    const { host, guest, network } = await setup();
    const one = await guest();
    const state = host.startRace(1);
    const source: InputSource = host.inputSource(1);
    sendInput(one, host, 1);
    network.flush();
    for (let nextTick = 1; nextTick <= 11; nextTick++) {
      expect(source.sample(state, 1)).toEqual(quantizeInput(DRIVE));
      tick(host, state);
    }
    expect(source.sample(state, 1)).toEqual(NEUTRAL_INPUT);
    expect(() => host.inputSource(8)).toThrow(RangeError);
    host.close();
  });

  it('accepts input between sampling and afterTick, using the sampled tick as currentTick', async () => {
    const { host, guest, network } = await setup();
    const one = await guest();
    const state = host.startRace(1);
    expect(host.inputSource(1).sample(state, 1)).toEqual(NEUTRAL_INPUT);
    sendInput(one, host, 2);
    network.flush();
    tick(host, state);
    expect(host.inputSource(1).sample(state, 1)).toEqual(quantizeInput(DRIVE));
    host.close();
  });

  it('rejects spoofed slots, stale race IDs/ticks, excessive future ticks and wrong channels', async () => {
    const { host, guest, network } = await setup();
    const one = await guest();
    let state = host.startRace(1);
    const oldRaceId = host.raceId;
    sendInput(one, host, 1, DRIVE, 2);
    sendInput(one, host, 1000);
    one.link.send('reliable', pack({ slot: 1, raceId: host.raceId, latestTick: 1, frames: [DRIVE] }));
    one.link.send('unreliable', new ArrayBuffer(1));
    network.flush();
    expect(host.inputSource(1).sample(state, 1)).toEqual(NEUTRAL_INPUT);
    sendInput(one, host, 2, DRIVE);
    sendInput(one, host, 1, { ...DRIVE, steer: -1 });
    network.flush();
    tick(host, state);
    expect(host.inputSource(1).sample(state, 1)).toEqual(quantizeInput(DRIVE));
    host.returnToLobby();
    state = host.startRace(2);
    one.link.send('unreliable', pack({ slot: 1, raceId: oldRaceId, latestTick: 1, frames: [DRIVE] }));
    network.flush();
    expect(host.inputSource(1).sample(state, 1)).toEqual(NEUTRAL_INPUT);
    host.close();
  });

  it.each(['close', 'leave'] as const)('%s turns the slot into CPU, broadcasts roster and reuses it in the lobby', async method => {
    const { host, guest, network } = await setup();
    const one = await guest();
    const two = await guest();
    const state = host.startRace(1);
    const source = host.inputSource(1);
    sendInput(one, host, 1);
    network.flush();
    expect(source.sample(state, 1)).toEqual(quantizeInput(DRIVE));
    if (method === 'close') one.link.close();
    else one.control({ type: 'leave' });
    network.flush();
    expect(host.roster.players[1]).toMatchObject({ kind: 'cpu', connected: false });
    expect(state.karts[1].human).toBe(false);
    expect(source.sample(state, 1)).toEqual(getAIInput(state, 1));
    expect(two.messages.at(-1)).toEqual({ type: 'roster', players: host.roster.players });
    host.returnToLobby();
    const replacement = await guest({ name: 'NEW' });
    expect(replacement.messages[0]).toMatchObject({ type: 'welcome', slot: 1 });
    const next = host.startRace(2);
    expect(next.karts[1].human).toBe(true);
    expect(source.sample(next, 1)).toEqual(NEUTRAL_INPUT);
    host.close();
  });
});

describe('HostSession timing and broadcasts', () => {
  it('uses the slowest admitted guest RTT and ignores duplicate pong samples', async () => {
    const { host, guest, network } = await setup();
    await guest();
    const slow = await guest({}, true, false);
    const probe = slow.packets.map(packet => unpackClock(packet.data)).find(packet => packet?.kind === PacketKind.PING)!;
    network.advance(1000);
    slow.link.send('unreliable', packPong(probe.t0, 8000));
    network.flush();
    network.advance(2000);
    slow.link.send('unreliable', packPong(probe.t0, 9000));
    network.flush();
    const now = network.now;
    host.startRace(1);
    expect(host.startAtHostTime).toBe(now + 2000);
    host.close();
  });

  it.each([0, 60, 900])('schedules start using max RTT (one-way %i ms) and increments raceId', async latencyMs => {
    const { host, guest, network } = await setup({ latencyMs });
    const one = await guest();
    const now = network.now;
    host.startRace(123);
    expect(host.startAtHostTime).toBe(now + Math.max(1500, 4 * latencyMs));
    network.flush();
    expect(one.messages.find(message => message.type === 'race_start')).toMatchObject({
      raceId: 1, seed: 123, startAtHostTime: host.startAtHostTime,
    });
    host.returnToLobby();
    network.flush();
    expect(one.messages.at(-1)).toEqual({ type: 'return_lobby' });
    expect(host.phase).toBe('lobby');
    host.startRace(456);
    network.flush();
    expect(one.messages.at(-1)).toMatchObject({ type: 'race_start', raceId: 2, seed: 456 });
    expect(() => host.startRace()).toThrow();
    host.close();
  });

  it('answers guest clock pings and ignores unsolicited or expired RTT samples', async () => {
    const { host, guest, network } = await setup({ latencyMs: 900 });
    const one = await guest();
    const receivedAt = network.now + 900;
    one.link.send('unreliable', packPing(50));
    one.link.send('unreliable', packPong(0, 1));
    network.flush();
    expect(one.packets.map(packet => unpackClock(packet.data))).toContainEqual({
      kind: PacketKind.PONG, t0: 50, hostNow: receivedAt,
    });
    network.advance(10_001);
    const now = network.now;
    host.startRace(1);
    expect(host.startAtHostTime).toBe(now + 1500);
    host.close();
  });

  it('sends snapshots and accumulated events every three ticks, once, on their respective channels', async () => {
    const { host, guest, network } = await setup();
    const one = await guest();
    const two = await guest();
    const state = host.startRace(123);
    const template = structuredClone(state);
    const expected: RaceEvent[] = [];
    for (let n = 1; n <= 6; n++) {
      const inputs = state.karts.map(kart => host.inputSource(kart.id).sample(state, kart.id));
      stepRace(state, inputs);
      const event: RaceEvent = { type: 'boost', kartId: 1, value: n };
      state.events = n <= 3 ? [event] : [];
      if (n <= 3) expected.push({ ...event });
      host.afterTick(state);
      host.afterTick(state);
      event.value = 999;
      network.flush();
      expect(snapshots(one)).toHaveLength(Math.floor(n / 3));
    }
    for (const joined of [one, two]) {
      const decoded = snapshots(joined).map(data => decodeSnapshot(data, template));
      expect(decoded.map(snapshot => snapshot?.state.tick)).toEqual([3, 6]);
      expect(decoded[0]?.lastAppliedInput[0]).toEqual(quantizeInput(getAIInput(template, 0)));
      expect(joined.messages.filter(message => message.type === 'events')).toEqual([
        { type: 'events', raceId: 1, tick: 3, events: expected },
      ]);
      expect(joined.raw.filter(packet => typeof packet.data === 'string').every(packet => packet.kind === 'reliable')).toBe(true);
      expect(joined.packets.every(packet => packet.kind === 'unreliable')).toBe(true);
    }
    host.close();
  });

  it('flushes final events and sends race_end once even between snapshot ticks', async () => {
    const { host, guest, network } = await setup();
    const one = await guest();
    const state = host.startRace(1);
    tick(host, state);
    state.tick = 2;
    state.phase = 'finished';
    state.events = [{ type: 'finish', kartId: 0, value: 10 }];
    host.afterTick(state);
    host.afterTick(state);
    network.flush();
    expect(host.phase).toBe('results');
    expect(one.messages.slice(-2)).toEqual([
      { type: 'events', raceId: 1, tick: 2, events: state.events },
      { type: 'race_end', raceId: 1, finalState: state },
    ]);
    host.close();
  });

  it('contains snapshot encoding failures while continuing reliable event delivery', async () => {
    const { host, guest, network } = await setup();
    const one = await guest();
    const state = host.startRace(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      state.tick = 3;
      state.karts[0].x = NaN;
      state.events = [{ type: 'go', kartId: 0 }];
      expect(() => host.afterTick(state)).not.toThrow();
      network.flush();
      expect(warn).toHaveBeenCalledOnce();
      expect(snapshots(one)).toHaveLength(0);
      expect(one.messages.at(-1)).toMatchObject({ type: 'events', tick: 3 });
      state.karts[0].x = 0;
      state.tick = 6;
      state.events = [];
      host.afterTick(state);
      network.flush();
      expect(snapshots(one)).toHaveLength(1);
    } finally { warn.mockRestore(); host.close(); }
  });

  it('isolates a failed peer send, notifies remaining guests and continues snapshots', async () => {
    const network = new MockTransport({ latencyMs: 0 });
    const server = await network.host('AB2X');
    const links: PeerLink[] = [];
    const host = new HostSession({
      roomCode: server.roomCode,
      onJoin: handler => server.onJoin(link => { links.push(link); handler(link); }),
      onBrokerLost: handler => server.onBrokerLost(handler),
      close: () => server.close(),
    }, { roomCode: 'AB2X', now: () => network.now });
    const received: WireData[][] = [[], []];
    for (let index = 0; index < 2; index++) {
      const link = await network.join('AB2X');
      link.onMessage((_, data) => received[index].push(data));
      link.send('reliable', encodeControlMessage({ type: 'hello', protocol: PROTOCOL_VERSION, course: COURSE_FINGERPRINT, name: 'ONE', color: 0xff5f80 }));
    }
    network.flush();
    const state = host.startRace(1);
    vi.spyOn(links[0], 'send').mockImplementation(() => { throw new Error('Peer closed during send'); });
    for (let n = 0; n < 3; n++) expect(() => tick(host, state)).not.toThrow();
    network.flush();
    expect(host.roster.players[1].kind).toBe('cpu');
    expect(received[1].map(parseControlMessage).filter(message => message?.type === 'roster').at(-1))
      .toEqual({ type: 'roster', players: host.roster.players });
    const snapshot = received[1].find(data => data instanceof ArrayBuffer && new Uint8Array(data)[0] === PacketKind.SNAPSHOT);
    expect(snapshot).toBeInstanceOf(ArrayBuffer);
    host.close();
  });

  it('never wraps the u8 race ID into an earlier race and closes idempotently', async () => {
    const { host, network } = await setup();
    for (let raceId = 1; raceId <= 255; raceId++) {
      host.startRace(raceId);
      expect(host.raceId).toBe(raceId);
      host.returnToLobby();
    }
    expect(() => host.startRace(256)).toThrow(/exhausted/);
    expect(host.phase).toBe('lobby');
    host.close();
    host.close();
    expect(host.phase).toBe('closed');
    await expect(network.join('AB2X')).rejects.toMatchObject({ code: 'room_not_found' });
  });
});

describe('HostSession integration', () => {
  it.each([false, true])('runs host + two dummy guests for 600 ticks (impaired network: %s)', async impaired => {
    const { host, guest, network } = await setup(impaired
      ? { seed: 52, latencyMs: 60, jitterMs: 15, lossRate: 0.1, reorderRate: 0.2, reorderDelayMs: 30 }
      : {});
    const guests = [await guest({ name: 'ONE' }), await guest({ name: 'TWO' })];
    const state = host.startRace(0x12345678);
    const template = structuredClone(state);
    network.advance(host.startAtHostTime - network.now);
    const histories: InputFrame[][] = [[], []];
    const events: RaceEvent[] = [];
    const applied: InputFrame[][] = [];
    let neutralCount = 0;
    for (let n = 1; n <= 600; n++) {
      guests.forEach((joined, index) => {
        histories[index].unshift(getAIInput(state, index + 1));
        histories[index].length = Math.min(histories[index].length, 4);
        joined.link.send('unreliable', pack({ slot: index + 1, raceId: host.raceId,
          latestTick: n + (impaired ? 6 : 0), frames: histories[index] }));
      });
      network.advance(TICK_MS);
      const inputs = tick(host, state);
      if (n > 20) neutralCount += inputs.slice(1, 3).filter(input => input.throttle === 0).length;
      if (n % 3 === 0) applied.push(inputs.map(quantizeInput));
      events.push(...state.events.map(event => ({ ...event })));
    }
    network.flush();
    expect(state.tick).toBe(600);
    expect(host.phase).toBe('racing');
    expect(neutralCount).toBeLessThan(12);
    expect(state.karts.slice(0, 3).every(kart => kart.human && kart.lapProgress > 0)).toBe(true);
    for (const joined of guests) {
      const decoded = snapshots(joined).map(data => decodeSnapshot(data, template)!);
      expect(decoded.length).toBeGreaterThan(impaired ? 150 : 199);
      expect(decoded.every(snapshot => snapshot && snapshot.raceId === host.raceId && snapshot.state.tick % 3 === 0)).toBe(true);
      for (const snapshot of decoded) expect(snapshot.lastAppliedInput).toEqual(applied[snapshot.state.tick / 3 - 1]);
      const latest = decoded.reduce((a, b) => a.state.tick > b.state.tick ? a : b);
      expect(latest.state.tick).toBeGreaterThanOrEqual(594);
      if (!impaired) {
        expect(decoded).toHaveLength(200);
        for (const kart of state.karts) {
          expect(Math.hypot(kart.x - latest.state.karts[kart.id].x, kart.z - latest.state.karts[kart.id].z)).toBeLessThan(0.001);
        }
      }
      expect(joined.messages.filter(message => message.type === 'events').flatMap(message => message.events)).toEqual(events);
    }
    host.close();
  });

  it('drives a real race to completion and validates JSON states/events and race_end', async () => {
    const { host, guest, network } = await setup();
    const observer = await guest({}, false);
    // The dummy guest sends real AI decisions through the same wire input path.
    observer.control({ type: 'hello', protocol: PROTOCOL_VERSION, course: COURSE_FINGERPRINT, name: 'AI GUEST', color: 0xff5f80 });
    network.flush();
    const state = host.startRace(42);
    for (let n = 0; n < 20_000 && host.phase !== 'results'; n++) {
      sendInput(observer, host, state.tick + 1, getAIInput(state, 1));
      network.advance(TICK_MS);
      tick(host, state);
      expect(isRaceState(JSON.parse(JSON.stringify(state)))).toBe(true);
      expect(state.events.every(event => isRaceEvent(JSON.parse(JSON.stringify(event))))).toBe(true);
    }
    network.flush();
    expect(host.phase).toBe('results');
    const ending = observer.messages.filter(message => message.type === 'race_end');
    expect(ending).toHaveLength(1);
    expect(ending[0].finalState).toEqual(JSON.parse(JSON.stringify(state)));
    expect(state.karts.filter(kart => kart.human).every(kart => kart.finishTime !== null)).toBe(true);
    host.close();
  });
});

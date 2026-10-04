import { describe, expect, it, vi } from 'vitest';
import { COURSE_FINGERPRINT, TRACK_IDS } from '../sim/tracks';
import { getAIInput } from '../sim/ai';
import { createRace, stepRace } from '../sim/race';
import type { InputFrame, RaceState } from '../sim/types';
import { packPong, TICK_MS, unpackClock } from './clock';
import { GuestSession } from './guestSession';
import { HostSession } from './hostSession';
import { InputBuffer, NEUTRAL_INPUT, unpack } from './inputBuffer';
import type { InputPacket } from './inputBuffer';
import { interpolateState, SnapshotBuffer } from './interpolation';
import { MockTransport } from './mockTransport';
import type { MockTransportOptions } from './mockTransport';
import { encodeControlMessage, PacketKind, parseControlMessage, PROTOCOL_VERSION } from './protocol';
import type { ControlMessage } from './protocol';
import type { NetPhase, RosterPlayer } from './session';
import { decodeSnapshot, encodeSnapshot } from './snapshotCodec';
import type { Snapshot } from './snapshotCodec';
import type { PeerLink, Transport } from './transport';

const inputs = (): InputFrame[] => Array.from({ length: 8 }, () => ({ ...NEUTRAL_INPUT }));
const roster: RosterPlayer[] = createRace(1).karts.map(kart => ({
  slot: kart.id, name: kart.id === 1 ? 'Guest' : kart.name, color: kart.color,
  kind: kart.id === 0 ? 'host' : kart.id === 1 ? 'guest' : 'cpu', connected: true,
}));

function snapshot(tick: number, hostTime: number, x: number, raceId = 1): Snapshot {
  const state = createRace(1);
  state.tick = tick;
  state.phase = 'racing';
  for (const kart of state.karts) Object.assign(kart, { x: x + kart.id, y: x * 2, z: 0, speed: 10, heading: Math.PI / 2 });
  return { state, hostTime, raceId, lastAppliedInput: inputs() };
}

/** Controllable wire peer for malformed messages and exact packet timing. */
async function setup(options: MockTransportOptions = {}, hostOffset = 0, autoWelcome = true) {
  const network = new MockTransport({ latencyMs: 0, ...options });
  const host = await network.host('AB2X');
  let link!: PeerLink;
  const controls: ControlMessage[] = [];
  const receivedInputs: InputPacket[] = [];
  const pingTimes: number[] = [];
  let answerPings = true;
  host.onJoin(peer => {
    link = peer;
    peer.onMessage((kind, data) => {
      if (kind === 'reliable') {
        const message = parseControlMessage(data);
        if (message) controls.push(message);
        if (message?.type === 'hello' && autoWelcome) peer.send('reliable', encodeControlMessage({
          type: 'welcome', trackId: 'meadow', slot: 1, roster, hostTime: network.now + hostOffset,
        }));
      } else {
        const clock = unpackClock(data);
        if (clock?.kind === PacketKind.PING) {
          pingTimes.push(clock.t0);
          if (answerPings) peer.send('unreliable', packPong(clock.t0, network.now + hostOffset));
        }
        const input = unpack(data);
        if (input) receivedInputs.push(input);
      }
    });
  });
  const guest = new GuestSession(network, { name: 'Guest', color: roster[1].color, now: () => network.now, prediction: false });
  const phases: NetPhase[] = [guest.phase];
  guest.onChange(() => phases.push(guest.phase));
  await guest.join('ab2x ');
  const send = (message: ControlMessage) => link.send('reliable', encodeControlMessage(message));
  const start = (raceId = 1, startAtHostTime = network.now + hostOffset, seed = 1) => {
    send({ type: 'race_start', trackId: 'meadow', raceId, seed, roster, startAtHostTime });
    network.advance(options.latencyMs ?? 0);
  };
  const sendSnapshot = (value: Snapshot) => link.send('unreliable',
    encodeSnapshot(value.state, value.raceId, value.hostTime, value.lastAppliedInput));
  const pump = (duration: number) => {
    const end = network.now + duration;
    while (network.now < end) { guest.frame(network.now); network.advance(Math.min(10, end - network.now)); }
    guest.frame(network.now);
  };
  return { network, host, guest, link, controls, receivedInputs, pingTimes, phases, send, start, sendSnapshot, pump,
    answerPings: (answer: boolean) => { answerPings = answer; } };
}

describe('SnapshotBuffer and interpolation', () => {
  it('interpolates every kart and the shortest heading arc, retaining earlier timers', () => {
    const from = snapshot(3, 1000, 0);
    const to = snapshot(6, 1050, 10);
    for (const kart of from.state.karts) Object.assign(kart, {
      heading: Math.PI - 0.1, speed: 5, driftTime: 2, boostTime: 0.8, spinTime: 0.3,
      effects: { ...kart.effects, auraTime: 3 },
    });
    for (const kart of to.state.karts) Object.assign(kart, { heading: -Math.PI + 0.1, speed: 20, driftTime: 0 });
    const view = interpolateState(from, to, 1025);
    for (const kart of view.karts) {
      expect(kart.x).toBeCloseTo(5 + kart.id);
      expect(kart.y).toBeCloseTo(10);
      expect(kart.heading).toBeCloseTo(Math.PI);
      expect(kart.speed).toBe(5);
      expect(kart.driftTime).toBe(2);
      expect(kart.boostTime).toBe(0.8);
      expect(kart.spinTime).toBe(0.3);
      expect(kart.effects.auraTime).toBe(3);
    }
    expect(to.state.karts[0].x).toBe(10);
    view.karts[0].effects.auraTime = 42;
    expect(from.state.karts[0].effects.auraTime).toBe(3);
  });

  it('extrapolates for at most 100ms, then freezes without mutating snapshots', () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.sample(0)).toBeNull();
    const value = snapshot(3, 1000, 0);
    expect(buffer.push(value)).toBe(true);
    value.state.karts[0].x = 999;
    expect(buffer.sample(900)!.karts[0].x).toBe(0);
    expect(buffer.sample(1050)!.karts[0].x).toBeCloseTo(0.5);
    const frozen = buffer.sample(1100)!;
    expect(frozen.karts[0].x).toBeCloseTo(1);
    expect(buffer.sample(10_000)).toEqual(frozen);
    frozen.karts[0].x = 777;
    expect(buffer.sample(1100)!.karts[0].x).toBeCloseTo(1);
  });

  it('matches entity IDs despite reordering, shows new entities, and holds traps', () => {
    const from = snapshot(3, 1000, 0);
    const to = snapshot(6, 1050, 0);
    const bolt = { kind: 'bolt' as const, id: 1000, ownerId: 0, x: 0, y: 0, z: 0, heading: 0, life: 3, bounces: 0 };
    from.state.projectiles = [bolt, { ...bolt, id: 1001, x: 30 }];
    to.state.projectiles = [{ ...bolt, id: 1002, x: 50 }, { ...bolt, id: 1001, x: 40 }, { ...bolt, x: 10 }];
    from.state.traps = [{ kind: 'trap', id: 1003, ownerId: 0, x: 0, y: 0, z: 0, heading: 0, life: 3, age: 1 }];
    to.state.traps = [{ ...from.state.traps[0], x: 4 }];
    const view = interpolateState(from, to, 1025);
    expect(view.projectiles.map(entity => entity.x)).toEqual([50, 35, 5]);
    expect(view.traps[0].x).toBe(2);
    const extrapolated = interpolateState(from, to, 1200);
    expect(extrapolated.projectiles.map(entity => entity.x)).toEqual([50, 60, 30]);
    expect(extrapolated.traps[0].x).toBe(4);
  });

  it('rejects stale ticks/races/timestamps and bounds one second of history', () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.push(snapshot(3, 1000, 0))).toBe(true);
    expect(buffer.push(snapshot(3, 1050, 100))).toBe(false);
    expect(buffer.push(snapshot(2, 1050, 100))).toBe(false);
    expect(buffer.push(snapshot(6, 1050, 100, 2))).toBe(false);
    expect(buffer.push(snapshot(6, 999, 100))).toBe(false);
    for (let i = 2; i <= 100; i++) buffer.push(snapshot(i * 3, 1000 + i * 50, i));
    expect(buffer.size).toBeLessThanOrEqual(22);
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.push(snapshot(0, 0, 0, 2))).toBe(true);
  });

  it('accepts increasing ticks with equal timestamps without dividing by zero', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(3, 100, 0));
    buffer.push(snapshot(6, 100, 5));
    expect(buffer.sample(100)!.karts[0].x).toBe(5);
    expect(buffer.sample(150)!.karts[0].x).toBeCloseTo(5.5);
  });

  it('clamps render time monotonically and resets it for a new race', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(3, 1000, 0));
    buffer.push(snapshot(6, 1050, 10));
    expect(buffer.sample(1025)!.karts[0].x).toBe(5);
    expect(buffer.sample(1010)!.karts[0].x).toBe(5);
    expect(buffer.sample(1040)!.karts[0].x).toBe(8);
    expect(buffer.sample(NaN)).toBeNull();
    buffer.clear();
    buffer.push(snapshot(3, 50, 0, 2));
    buffer.push(snapshot(6, 100, 10, 2));
    expect(buffer.sample(75)!.karts[0].x).toBe(5);
  });

  it('uses the latest HUD state and immediately adds new entity IDs while delaying poses', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(3, 100, 0));
    buffer.push(snapshot(6, 150, 10));
    const latest = snapshot(9, 200, 20);
    latest.state.karts[1].lap = 2;
    latest.state.karts[1].item = 'tripleDash';
    latest.state.karts[1].effects.charges = 3;
    latest.state.projectiles.push({ kind: 'bolt', id: 1000, ownerId: 1, x: 42, y: 0, z: 0, heading: 0, life: 3, bounces: 0 });
    buffer.push(latest);
    const view = buffer.sample(125)!;
    expect(view.tick).toBe(9);
    expect(view.karts[1].x).toBeCloseTo(6);
    expect(view.karts[1].lap).toBe(2);
    expect(view.karts[1].item).toBe('tripleDash');
    expect(view.karts[1].effects.charges).toBe(3);
    expect(view.projectiles[0].x).toBe(42);
  });
});

describe('GuestSession', () => {
  it.each(TRACK_IDS)('uses %s from welcome and course updates for race creation and rematches', async trackId => {
    const h = await setup({}, 0, false);
    try {
      h.send({ type: 'course', trackId: 'neon' });
      h.network.advance(0);
      expect(h.guest.phase).toBe('connecting');
      expect(h.guest.course).toBe('meadow');
      h.send({ type: 'welcome', slot: 1, roster, hostTime: 0, trackId });
      h.network.advance(0);
      expect(h.guest.course).toBe(trackId);
      const changed = vi.fn();
      h.guest.onChange(changed);
      h.send({ type: 'course', trackId: 'snowpeak' });
      h.network.advance(0);
      expect(h.guest.course).toBe('snowpeak');
      expect(changed).toHaveBeenCalledOnce();
      h.send({ type: 'course', trackId });
      h.network.advance(0);
      const start = { type: 'race_start', trackId, seed: 42, raceId: 1, roster, startAtHostTime: 0 } as const;
      h.send(start);
      h.network.advance(0);
      expect(h.guest.phase).toBe('countdown');
      expect(h.guest.frame()!.state).toEqual(createRace(42, { trackId, racers: roster.map(player => ({
        name: player.name, color: player.color, human: player.kind !== 'cpu',
      })) }));
      h.send({ type: 'course', trackId: trackId === 'neon' ? 'canyon' : 'neon' });
      h.network.advance(0);
      expect(h.guest.course).toBe(trackId);
      const airborne = snapshot(3, 50, 1);
      airborne.state.trackId = trackId;
      airborne.state.karts[1].airTime = 0.8;
      h.sendSnapshot(airborne);
      h.network.advance(150);
      expect(h.guest.frame()!.state).toMatchObject({ trackId, karts: expect.arrayContaining([
        expect.objectContaining({ id: 1, airTime: 0.8 }),
      ]) });
      h.send({ type: 'return_lobby' });
      h.network.advance(0);
      expect(h.guest.course).toBe(trackId);
      h.send({ ...start, raceId: 2 });
      h.network.advance(0);
      expect(h.guest.frame()!.state.trackId).toBe(trackId);
    } finally { h.host.close(); }
  });

  it('ignores starts and results for a different course, plus unknown or extra course fields', async () => {
    const h = await setup();
    try {
      h.network.advance(0);
      h.send({ type: 'course', trackId: 'canyon' });
      h.network.advance(0);
      const start = { type: 'race_start', trackId: 'neon', seed: 42, raceId: 1, roster, startAtHostTime: 0 } as const;
      h.send(start);
      for (const message of [
        { type: 'course', trackId: 'unknown' }, { type: 'course', trackId: 'neon', extra: true },
        { ...start, trackId: 'unknown' }, { ...start, trackId: 'canyon', extra: true },
      ]) h.link.send('reliable', JSON.stringify(message));
      h.network.advance(0);
      expect(h.guest.course).toBe('canyon');
      expect(h.guest.phase).toBe('lobby');
      expect(h.guest.frame()).toBeNull();
      h.send({ ...start, trackId: 'canyon' });
      h.network.advance(0);
      expect(h.guest.phase).toBe('countdown');
      h.send({ type: 'race_end', raceId: 1, finalState: createRace(42, { trackId: 'neon' }) });
      h.network.advance(0);
      expect(h.guest.phase).toBe('countdown');
      expect(h.guest.finalState).toBeNull();
      expect(h.guest.frame()!.state.trackId).toBe('canyon');
    } finally { h.host.close(); }
  });

  it('observes connection, welcome, lobby, countdown, racing and reliable results via NetPhase', async () => {
    const h = await setup();
    expect(h.guest.phase).toBe('connecting');
    h.network.advance(0);
    expect(h.controls[0]).toEqual({ type: 'hello', protocol: PROTOCOL_VERSION, course: COURSE_FINGERPRINT, name: 'Guest', color: roster[1].color });
    expect(h.guest.phase).toBe('lobby');
    expect(h.guest.roster).toEqual({ roomCode: 'AB2X', localSlot: 1, players: roster });
    h.start();
    expect(h.guest.phase).toBe('countdown');
    const value = snapshot(3, 50, 1);
    h.sendSnapshot(value);
    h.network.advance(50);
    expect(h.guest.phase).toBe('racing');
    value.state.phase = 'finished';
    value.state.tick = 6;
    value.hostTime = 100;
    h.sendSnapshot(value);
    h.network.advance(50);
    expect(h.guest.phase).toBe('racing');
    value.state.karts[1].lapTimes = [30.123456789];
    h.send({ type: 'race_end', raceId: 1, finalState: value.state });
    h.network.advance(0);
    expect(h.guest.phase).toBe('results');
    expect(h.guest.frame()!.state).toEqual(value.state);
    expect(h.guest.finalState).toEqual(value.state);
    h.pump(6000);
    expect(h.guest.phase).toBe('results');
    h.send({ type: 'return_lobby' });
    h.network.advance(0);
    expect(h.guest.phase).toBe('lobby');
    expect(h.guest.frame()).toBeNull();
    expect(h.phases).toEqual(['idle', 'connecting', 'lobby', 'countdown', 'racing', 'results', 'lobby']);
  });

  it('frame delays all kart poses by 100ms including the local player and avoids double interpolation', async () => {
    const h = await setup({}, 5000);
    h.pump(500);
    expect(h.guest.offset).toBeCloseTo(5000);
    h.start(1, 5000);
    const from = snapshot(27, 5450, 0);
    const to = snapshot(30, 5500, 10);
    h.sendSnapshot(from);
    h.sendSnapshot(to);
    h.network.advance(0);
    h.network.advance(75);
    const frame = h.guest.frame(h.network.now)!;
    for (const kart of frame.state.karts) {
      expect(kart.x).toBeCloseTo(5 + kart.id);
      expect(frame.previous.karts[kart.id]).toEqual({ x: kart.x, y: kart.y, z: kart.z, heading: kart.heading });
    }
    expect(frame.alpha).toBe(1);
    h.network.advance(75);
    expect(h.guest.frame()!.state.karts[1].x).toBeCloseTo(11.5);
    h.network.advance(50);
    expect(h.guest.frame()!.state.karts[1].x).toBeCloseTo(12);
    h.network.advance(900);
    expect(h.guest.frame()!.state.karts[1].x).toBeCloseTo(12);
  });

  it.each([0, 60, 150])('sends 60 input packets per second at %ims one-way latency with RTT-dependent lead', async latencyMs => {
    const h = await setup({ latencyMs }, 5000);
    h.pump(1800);
    expect(h.guest.rtt).toBeCloseTo(latencyMs * 2);
    expect(h.guest.lead).toBe(Math.ceil(latencyMs / TICK_MS) + 2);
    const startedAt = h.network.now;
    h.start();
    const publish = () => {
      const tick = Math.floor((h.network.now - startedAt) / TICK_MS);
      h.sendSnapshot(snapshot(tick, startedAt + tick * TICK_MS + 5000, 0));
    };
    // Warm the real 20Hz snapshot cadence before measuring one second of input.
    for (let tick = 1; tick <= 30; tick++) {
      h.network.advance(TICK_MS);
      if (tick % 3 === 0) publish();
    }
    const firstTime = h.network.now;
    const expectedTick = Math.ceil((firstTime - startedAt) / TICK_MS) + h.guest.lead;
    const input: InputFrame = { steer: 0.3, throttle: 0.7, brake: false, drift: true, useItem: true };
    for (let i = 0; i < 60; i++) {
      h.guest.tick({ ...input, useItem: i === 0 });
      h.network.advance(TICK_MS);
      if ((i + 1) % 3 === 0) publish();
    }
    h.network.advance(latencyMs);
    expect(h.receivedInputs).toHaveLength(60);
    expect(h.receivedInputs[0].latestTick).toBe(expectedTick);
    expect(h.receivedInputs[59].latestTick).toBe(expectedTick + 59);
    expect(h.receivedInputs.every(packet => packet.slot === 1 && packet.raceId === 1)).toBe(true);
    expect(h.receivedInputs[3].frames.map(frame => frame.useItem)).toEqual([false, false, false, true]);
    expect(h.receivedInputs[59].frames[0].steer).toBeCloseTo(Math.round(0.3 * 127) / 127);
    expect(h.network.now - firstTime - latencyMs).toBeCloseTo(1000);
  });

  it('uses one clock for ping samples and expiry when frame timestamps lag callbacks', async () => {
    const h = await setup({ latencyMs: 60 }, 9000);
    for (let i = 0; i < 180; i++) {
      h.network.advance(10);
      h.guest.frame(Math.max(0, h.network.now - 50));
    }
    expect(h.guest.rtt).toBeCloseTo(120);
    expect(h.guest.offset).toBeCloseTo(9000);
    expect(h.pingTimes.slice(0, 5)).toEqual([0, 100, 200, 300, 400]);
    expect(h.pingTimes[5]).toBe(900);
  });

  it('adapts lead when old RTT samples expire and fresh probes take longer', async () => {
    const h = await setup();
    h.pump(500);
    expect(h.guest.lead).toBe(2);
    h.answerPings(false);
    // Slower but live pongs keep the lobby connected as the faster samples age out.
    for (let i = 0; i < 23; i++) {
      const previousPing = h.pingTimes.at(-1);
      while (h.pingTimes.at(-1) === previousPing) h.pump(10);
      const pingAt = h.pingTimes.at(-1)!;
      h.network.advance(120 - (h.network.now - pingAt));
      h.link.send('unreliable', packPong(pingAt, pingAt + 60));
      h.network.advance(0);
    }
    expect(h.guest.phase).toBe('lobby');
    expect(h.guest.rtt).toBe(120);
    expect(h.guest.lead).toBe(6);
    // Unsolicited pongs cannot manufacture an RTT estimate.
    h.link.send('unreliable', packPong(h.network.now - 10, h.network.now - 5));
    h.network.advance(0);
    expect(h.guest.rtt).toBe(120);
  });

  it('sends strictly increasing destinations that the host InputBuffer accepts during correction', async () => {
    const h = await setup();
    h.pump(500);
    h.start();
    h.guest.tick({ ...NEUTRAL_INPUT, throttle: 1 });
    h.network.advance(0);
    const first = h.receivedInputs.at(-1)!.latestTick;
    const buffer = new InputBuffer({ slot: 1, raceId: 1 });
    expect(buffer.receive(h.receivedInputs.at(-1)!, 0)).toBe(true);
    h.network.advance(100);
    h.guest.tick({ ...NEUTRAL_INPUT, throttle: 1, useItem: true });
    h.network.advance(0);
    const second = h.receivedInputs.at(-1)!;
    expect(second.latestTick).toBe(first + 2);
    expect(second.frames.map(input => input.useItem)).toEqual([true, true, false]);
    expect(buffer.receive(second, 0)).toBe(true);
    // A host resume reanchors its tick. Skipping a send must not lose an item pulse.
    h.sendSnapshot(snapshot(1, h.network.now, 0));
    h.network.advance(0);
    h.guest.tick({ ...NEUTRAL_INPUT, throttle: 1, useItem: true });
    h.network.advance(0);
    for (let tick = 2; tick <= 6; tick++) {
      h.network.advance(TICK_MS);
      h.sendSnapshot(snapshot(tick, h.network.now, 0));
      h.network.advance(0);
      h.guest.tick({ ...NEUTRAL_INPUT, throttle: 1 });
      h.network.advance(0);
    }
    let previous = second.latestTick;
    for (const packet of h.receivedInputs.slice(2)) {
      expect(packet.latestTick).toBeGreaterThan(previous);
      expect(buffer.receive(packet, 1)).toBe(true);
      previous = packet.latestTick;
    }
    expect(h.receivedInputs[2].frames[0].useItem).toBe(true);
    expect(h.receivedInputs.at(-1)!.frames[0].useItem).toBe(false);
  });

  it('immediately reanchors a guest that falls far behind without relabelling old history', async () => {
    const h = await setup();
    h.pump(500);
    h.start();
    h.guest.tick({ ...NEUTRAL_INPUT, useItem: true });
    h.network.advance(0);
    h.network.advance(2000);
    h.sendSnapshot(snapshot(120, h.network.now, 0));
    h.network.advance(0);
    h.guest.tick({ ...NEUTRAL_INPUT, throttle: 1 });
    h.network.advance(0);
    const packet = h.receivedInputs.at(-1)!;
    expect(packet.latestTick).toBe(120 + h.guest.lead);
    expect(packet.frames).toEqual([{ ...NEUTRAL_INPUT, throttle: 1 }]);
    const buffer = new InputBuffer({ slot: 1, raceId: 1 });
    expect(buffer.receive(h.receivedInputs[0], 0)).toBe(true);
    expect(buffer.receive(packet, 120)).toBe(true);
    expect(buffer.get(packet.latestTick).throttle).toBe(1);
  });

  it.each([NaN, Infinity, -Infinity, 2])('sends neutral input for an invalid axis (%s)', async steer => {
    const h = await setup();
    h.network.advance(0);
    h.start();
    expect(() => h.guest.tick({ ...NEUTRAL_INPUT, steer, throttle: 1, useItem: true })).not.toThrow();
    h.network.advance(0);
    expect(h.receivedInputs.at(-1)!.frames).toEqual([{ ...NEUTRAL_INPUT }]);
  });

  it('does not rewind poses when clock sync replaces a larger fallback offset', async () => {
    const h = await setup({}, 1000);
    h.answerPings(false);
    h.network.advance(0);
    h.start(1, 1000);
    h.network.advance(400);
    h.sendSnapshot(snapshot(21, 1350, 0));
    h.sendSnapshot(snapshot(24, 1400, 10));
    h.network.advance(0);
    h.network.advance(80);
    const before = h.guest.frame()!.state.karts[1].x;
    for (let i = 0; i < 3; i++) {
      const previousPing = h.pingTimes.at(-1);
      while (h.pingTimes.at(-1) === previousPing) h.pump(10);
      const t0 = h.pingTimes.at(-1)!;
      h.link.send('unreliable', packPong(t0, (t0 + h.network.now) / 2 + 500));
      h.network.advance(0);
    }
    expect(h.guest.offset).toBeCloseTo(500);
    const after = h.guest.frame()!.state.karts[1].x;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(h.guest.frame(h.network.now - 100)!.state.karts[1].x).toBe(after);
  });

  it('flags 1.5s of snapshot silence, clears on recovery, and closes at 5s despite pongs', async () => {
    const h = await setup();
    h.network.advance(0);
    h.start();
    h.pump(1490);
    expect(h.guest.stalled).toBe(false);
    h.pump(10);
    expect(h.guest.stalled).toBe(true);
    h.sendSnapshot(snapshot(3, 1500, 0));
    h.network.advance(0);
    expect(h.guest.stalled).toBe(false);
    h.pump(4990);
    expect(h.guest.phase).toBe('racing');
    h.pump(10);
    expect(h.guest.phase).toBe('closed');
    expect(h.guest.reason).toBe('host_lost');
    expect(h.guest.frame()).toBeNull();
  });

  it('does not count a scheduled start or an idle lobby as a snapshot outage', async () => {
    const h = await setup();
    h.pump(6000);
    expect(h.guest.phase).toBe('lobby');
    h.start(1, h.network.now + 3000);
    h.pump(3000);
    expect(h.guest.stalled).toBe(false);
    h.guest.tick({ ...NEUTRAL_INPUT });
    h.network.advance(0);
    expect(h.receivedInputs).toHaveLength(1);
    h.pump(1490);
    expect(h.guest.stalled).toBe(false);
    h.pump(10);
    expect(h.guest.stalled).toBe(true);
  });

  it.each(['link', 'host_closed'] as const)('reports host_lost on %s immediately', async kind => {
    const h = await setup();
    h.network.advance(0);
    if (kind === 'link') h.link.close();
    else { h.send({ type: 'host_closed' }); h.network.advance(0); }
    expect(h.guest.phase).toBe('closed');
    expect(h.guest.reason).toBe('host_lost');
  });

  it.each(['lobby', 'results'] as const)('closes %s after 5s without valid pongs', async phase => {
    const h = await setup();
    h.pump(500);
    if (phase === 'results') {
      h.start();
      const final = snapshot(3, h.network.now, 0).state;
      final.phase = 'finished';
      h.send({ type: 'race_end', raceId: 1, finalState: final });
      h.network.advance(0);
    }
    // The last valid pong was at 400ms. Unsolicited pongs are not liveness evidence.
    h.answerPings(false);
    h.pump(4890);
    h.link.send('unreliable', packPong(123, h.network.now));
    h.network.advance(0);
    expect(h.guest.phase).toBe(phase);
    h.pump(10);
    expect(h.guest.phase).toBe('closed');
    expect(h.guest.reason).toBe('host_lost');
  });

  it('discards wrong race IDs, old snapshot/event ticks and old reliable race ends after rematch', async () => {
    const h = await setup();
    h.pump(500);
    h.start(1, 0);
    h.sendSnapshot(snapshot(30, 500, 5));
    h.network.advance(0);
    const final = snapshot(30, 500, 5).state;
    final.phase = 'finished';
    h.send({ type: 'race_end', raceId: 1, finalState: final });
    h.send({ type: 'return_lobby' });
    h.network.advance(0);
    h.start(2, 500);
    h.network.advance(50);
    const nextLap = snapshot(3, 550, 10, 2);
    nextLap.state.karts[1].lap = 1;
    nextLap.state.karts[1].lapStartTime = 30;
    h.sendSnapshot(nextLap);
    h.network.advance(0);
    h.sendSnapshot(snapshot(90, 600, 999, 1));
    h.sendSnapshot(snapshot(2, 600, 999, 2));
    h.sendSnapshot(snapshot(3, 600, 999, 2));
    h.sendSnapshot(snapshot(6, 549, 999, 2));
    h.send({ type: 'race_end', raceId: 1, finalState: final });
    h.send({ type: 'events', raceId: 1, tick: 100, events: [{ type: 'lap', kartId: 1, value: 99 }] });
    h.send({ type: 'events', raceId: 2, tick: 6, events: [{ type: 'lap', kartId: 1, value: 1 }] });
    h.send({ type: 'events', raceId: 2, tick: 3, events: [{ type: 'lap', kartId: 1, value: 99 }] });
    h.send({ type: 'events', raceId: 2, tick: 6, events: [{ type: 'use', kartId: 2 }] });
    h.network.advance(100);
    const frame = h.guest.frame()!;
    expect(h.guest.phase).toBe('racing');
    expect(frame.state.tick).toBe(3);
    expect(frame.state.karts[1].x).toBeCloseTo(11);
    expect(frame.state.karts[1].lapTimes).toEqual([30]);
    expect(frame.state.events).toEqual([{ type: 'lap', kartId: 1, value: 1 }, { type: 'use', kartId: 2 }]);
    expect(h.guest.frame()!.state.events).toEqual([]);
    h.pump(4900);
    expect(h.guest.reason).toBe('host_lost');
  });

  it('validates controls, profiles and join failures without leaking malformed packets', async () => {
    const h = await setup();
    h.network.advance(0);
    expect(h.guest.updateProfile('', 0)).toBe(false);
    expect(h.guest.updateProfile('New name', 0xff00ff)).toBe(true);
    h.link.send('reliable', '{not json');
    h.link.send('unreliable', new ArrayBuffer(1));
    h.link.send('reliable', JSON.stringify({ type: 'race_start', trackId: 'meadow', raceId: -1 }));
    h.network.advance(0);
    expect(h.guest.phase).toBe('lobby');
    expect(h.controls.at(-1)).toEqual({ type: 'profile', name: 'New name', color: 0xff00ff });
    const unknown = new GuestSession(h.network, { now: () => h.network.now, prediction: false });
    await unknown.join('ZZZZ');
    expect(unknown.phase).toBe('closed');
    expect(unknown.reason).toBe('room_not_found');
  });

  it('ignores undecodable snapshots during a race without refreshing the silence timer', async () => {
    const h = await setup();
    h.network.advance(0);
    h.start();
    h.sendSnapshot(snapshot(3, 50, 5));
    h.network.advance(50);
    const value = snapshot(6, 100, 999);
    const valid = encodeSnapshot(value.state, value.raceId, value.hostTime, value.lastAppliedInput);
    const corrupt = valid.slice(0);
    new DataView(corrupt).setFloat64(6, NaN, true);
    for (const data of [new ArrayBuffer(1), valid.slice(0, -1), corrupt]) {
      expect(decodeSnapshot(data, value.state)).toBeNull();
      h.link.send('unreliable', data);
    }
    expect(() => h.network.advance(0)).not.toThrow();
    h.pump(1450);
    expect(h.guest.phase).toBe('racing');
    expect(h.guest.frame()!.state.tick).toBe(3);
    expect(h.guest.stalled).toBe(true);
    h.pump(3500);
    expect(h.guest.reason).toBe('host_lost');
  });

  it.each(['version', 'full', 'in_race', 'bad_name'] as const)('exposes rejection reason %s', async reason => {
    const h = await setup({}, 0, false);
    h.send({ type: 'reject', reason });
    h.network.advance(0);
    expect(h.guest.phase).toBe('closed');
    expect(h.guest.reason).toBe(reason);
  });

  it('times out a missing welcome and ignores a link arriving after explicit leave', async () => {
    const h = await setup({}, 0, false);
    h.pump(5000);
    expect(h.guest.reason).toBe('timeout');
    let resolve!: (link: PeerLink) => void;
    const delayed: Transport = { host: code => h.network.host(code), join: () => new Promise(done => { resolve = done; }) };
    const guest = new GuestSession(delayed, { now: () => h.network.now, prediction: false });
    const joining = guest.join('AB2X');
    guest.close();
    const link = await h.network.join('AB2X');
    let closed = false;
    link.onClose(() => { closed = true; });
    resolve(link);
    await joining;
    expect(guest.phase).toBe('closed');
    expect(guest.reason).toBe('left');
    expect(closed).toBe(true);
  });

  it('resets clocks, input history and race IDs when rejoining, and isolates read-only views', async () => {
    const h = await setup();
    h.pump(500);
    h.start(5);
    h.guest.tick({ ...NEUTRAL_INPUT, useItem: true });
    h.network.advance(0);
    h.guest.close();
    expect(h.guest.reason).toBe('left');
    expect(h.guest.frame()).toBeNull();
    h.network.advance(100);
    await h.guest.join('AB2X');
    h.network.advance(0);
    expect(h.guest.phase).toBe('lobby');
    expect(h.guest.reason).toBeNull();
    const view = h.guest.roster;
    (view.players[1] as RosterPlayer).name = 'Modified';
    expect(h.guest.roster.players[1].name).toBe('Guest');
    h.start(1);
    h.guest.tick({ ...NEUTRAL_INPUT });
    h.network.advance(0);
    expect(h.receivedInputs.at(-1)!.frames).toEqual([{ ...NEUTRAL_INPUT }]);
  });

  it('allows host cancellation to lobby but rejects delayed starts from an earlier race', async () => {
    const h = await setup();
    h.network.advance(0);
    h.start(2);
    h.send({ type: 'return_lobby' });
    h.network.advance(0);
    expect(h.guest.phase).toBe('lobby');
    h.start(1);
    expect(h.guest.phase).toBe('lobby');
    h.start(2);
    expect(h.guest.phase).toBe('lobby');
    h.start(3);
    expect(h.guest.phase).toBe('countdown');
  });

  it('recovers lap durations from snapshot timestamps regardless of event arrival order', async () => {
    const h = await setup();
    h.network.advance(0);
    h.start();
    h.send({ type: 'events', raceId: 1, tick: 3, events: [{ type: 'lap', kartId: 1, value: 1 }] });
    h.network.advance(0);
    expect(h.guest.frame()!.state.karts[1].lapTimes).toEqual([]);
    const firstLap = snapshot(3, 50, 0);
    Object.assign(firstLap.state.karts[1], { lap: 1, lapStartTime: 30.25 });
    h.sendSnapshot(firstLap);
    h.network.advance(50);
    expect(h.guest.frame()!.state.karts[1].lapTimes).toEqual([30.25]);
    const secondLap = snapshot(6, 100, 0);
    Object.assign(secondLap.state.karts[1], { lap: 2, lapStartTime: 60.5 });
    h.sendSnapshot(secondLap);
    h.network.advance(50);
    h.send({ type: 'events', raceId: 1, tick: 6, events: [{ type: 'lap', kartId: 1, value: 2 }] });
    h.network.advance(0);
    expect(h.guest.frame()!.state.karts[1].lapTimes).toEqual([30.25, 30.25]);
  });

  it('delivers final reliable events once when race_end arrives before the next render', async () => {
    const h = await setup();
    h.network.advance(0);
    h.start();
    const final = snapshot(600, 10_000, 0).state;
    final.phase = 'finished';
    final.events = [{ type: 'finish', kartId: 1, value: 70.25 }];
    h.send({ type: 'events', raceId: 1, tick: 600, events: final.events });
    h.send({ type: 'race_end', raceId: 1, finalState: final });
    h.network.advance(0);
    expect(h.guest.frame()!.state.events).toEqual(final.events);
    expect(h.guest.frame()!.state.events).toEqual([]);
    const copy = h.guest.finalState!;
    copy.karts[1].lapTimes.push(99);
    expect(h.guest.finalState).toEqual(final);
  });
});

describe('HostSession integration', () => {
  it.each([500, 2000].flatMap(pauseMs => [0, 60].flatMap(latencyMs =>
    ['pause', 'recovery'].map(pulse => ({ pauseMs, latencyMs, pulse })))))
  ('recovers input and uses an item once after $pauseMs ms pause, latency $latencyMs, pulse in $pulse', async ({ pauseMs, latencyMs, pulse }) => {
    const network = new MockTransport({ latencyMs });
    const host = await HostSession.create(network, { roomCode: 'AB2X', now: () => network.now });
    const guest = new GuestSession(network, { now: () => network.now, prediction: false });
    const receive = vi.spyOn(InputBuffer.prototype, 'receive');
    try {
      await guest.join('AB2X');
      for (let i = 0; i < 200; i++) { host.frame(); guest.frame(); network.advance(10); }
      const state = host.startRace(431);
      network.advance(host.startAtHostTime - network.now);
      const step = (input: InputFrame) => {
        guest.tick(input);
        network.advance(TICK_MS);
        const applied = state.karts.map(kart => host.inputSource(kart.id).sample(state, kart.id));
        stepRace(state, applied);
        host.afterTick(state);
        guest.frame();
        return applied[1];
      };
      for (let i = 0; i < 210; i++) step({ ...NEUTRAL_INPUT });
      expect(state.phase).toBe('racing');
      state.karts[1].item = 'tripleDash';
      state.karts[1].effects.charges = 3;
      const pauseTicks = Math.round(pauseMs / TICK_MS);
      for (let i = 0; i < pauseTicks; i++) {
        guest.tick({ ...NEUTRAL_INPUT, useItem: pulse === 'pause' && i === pauseTicks - 1 });
        // The host still receives packets, but its simulation and snapshots stop.
        network.advance(TICK_MS);
      }
      let firstApplied = Infinity;
      let firstUse = Infinity;
      let uses = 0;
      const recoveryPulseTick = 4 + Math.ceil(latencyMs / TICK_MS);
      for (let tick = 1; tick <= 90; tick++) {
        const applied = step({ ...NEUTRAL_INPUT, throttle: 1,
          useItem: pulse === 'recovery' && tick === recoveryPulseTick });
        if (applied.throttle === 1) firstApplied = Math.min(firstApplied, tick);
        for (const event of state.events) if (event.type === 'use' && event.kartId === 1) {
          uses++;
          firstUse = Math.min(firstUse, tick);
        }
      }
      // Bound recovery by snapshot transit plus two snapshot periods and one send.
      const recoveryLimit = guest.lead + Math.ceil(latencyMs / TICK_MS) + 7;
      expect(firstApplied).toBeLessThanOrEqual(recoveryLimit);
      expect(firstUse).toBeLessThanOrEqual(recoveryLimit);
      expect(uses).toBe(1);
      expect(state.karts[1].effects.charges).toBe(2);
      const packets = receive.mock.calls.map(([packet]) => packet);
      expect(packets.length).toBeGreaterThan(250);
      for (let i = 1; i < packets.length; i++) expect(packets[i].latestTick).toBeGreaterThan(packets[i - 1].latestTick);
      expect(receive.mock.results.every(result => result.type === 'return' && result.value === true)).toBe(true);
      expect(guest.stalled).toBe(false);
    } finally {
      receive.mockRestore();
      host.close();
    }
  });

  it('answers host clock probes so high RTT postpones the shared start', async () => {
    const network = new MockTransport({ latencyMs: 900 });
    const host = await HostSession.create(network, { roomCode: 'AB2X', now: () => network.now });
    const guest = new GuestSession(network, { now: () => network.now + 5000, prediction: false });
    await guest.join('AB2X');
    network.flush();
    const now = network.now;
    host.startRace(1);
    expect(host.startAtHostTime).toBe(now + 3600);
    host.close();
  });

  it.each([{ prediction: false }, { prediction: true }])
  ('matches host history for 600 ticks at RTT 120ms and loss 10% (prediction $prediction)', async ({ prediction }) => {
    const network = new MockTransport({ latencyMs: 60, lossRate: 0.1, seed: 92 });
    const host = await HostSession.create(network, { roomCode: 'AB2X', now: () => network.now, hostInput: { sample: getAIInput } });
    const guest = new GuestSession(network, { now: () => network.now, prediction });
    await guest.join('AB2X');
    for (let n = 0; n < 200; n++) { host.frame(); guest.frame(); network.advance(10); }
    const state = host.startRace(431);
    network.advance(host.startAtHostTime - network.now);
    let appliedGuestInput = 0;
    const history = new Map<number, RaceState>();
    history.set(0, structuredClone(state));
    let comparisons = 0;
    const views: { hostTick: number; predictedTick: number | undefined; state: RaceState }[] = [];
    // Run the host beyond the measured window so every leading local prediction
    // has an authoritative state at the same tick to compare after the loop.
    for (let tick = 1; tick <= (prediction ? 630 : 600); tick++) {
      guest.tick(getAIInput(state, 1));
      network.advance(TICK_MS);
      const applied = state.karts.map(kart => host.inputSource(kart.id).sample(state, kart.id));
      if (applied[1].throttle > 0) appliedGuestInput++;
      stepRace(state, applied);
      history.set(state.tick, structuredClone(state));
      host.afterTick(state);
      const view = guest.frame()!;
      if (tick >= 30 && tick <= 600) views.push({ hostTick: tick, predictedTick: guest.predictedState?.tick, state: view.state });
    }
    for (const view of views) {
      for (const kart of view.state.karts) {
        const localPrediction = prediction && kart.id === 1;
        const referenceTick = localPrediction ? view.predictedTick! : view.hostTick - 6;
        const reference = history.get(referenceTick);
        expect(reference, `missing host history at tick ${referenceTick}`).toBeDefined();
        const expected = reference!.karts[kart.id];
        const error = Math.hypot(kart.x - expected.x, kart.y - expected.y, kart.z - expected.z);
        const at = `host tick ${view.hostTick}, reference ${referenceTick}, kart ${kart.id}`;
        if (localPrediction) expect(error, at).toBeLessThanOrEqual(0.1);
        else expect(error, at).toBeLessThan(0.5);
        comparisons++;
      }
    }
    expect(comparisons).toBe(571 * 8);
    expect(appliedGuestInput).toBeGreaterThan(550);
    // Drain the intentional interpolation delay to compare against the final live state.
    network.advance(100);
    const finalView = guest.frame()!;
    for (const kart of finalView.state.karts) {
      // The local prediction still leads the stopped host; its same-tick view
      // was checked above. Only interpolated karts drain to the final live state.
      if (prediction && kart.id === 1) continue;
      const expected = state.karts[kart.id];
      expect(Math.hypot(kart.x - expected.x, kart.y - expected.y, kart.z - expected.z)).toBeLessThan(0.5);
    }
    expect(guest.phase).toBe('racing');
    expect(guest.stalled).toBe(false);
    state.tick++;
    state.phase = 'finished';
    host.afterTick(state);
    network.advance(60);
    expect(guest.phase).toBe('results');
    expect(guest.finalState).toEqual(state);
    host.returnToLobby();
    network.advance(60);
    expect(guest.phase).toBe('lobby');
    host.startRace(432);
    network.advance(60);
    expect(guest.phase).toBe('countdown');
    expect(guest.frame()!.state.tick).toBe(0);
    host.close();
    expect(guest.reason).toBe('host_lost');
  });
});

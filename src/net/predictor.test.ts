import { describe, expect, it, vi } from 'vitest';
import { getAIInput } from '../sim/ai';
import { createRace, FIXED_DT, stepRace } from '../sim/race';
import type { InputFrame, RaceState, TrackId } from '../sim/types';
import { packPong, TICK_MS, unpackClock } from './clock';
import { GuestSession } from './guestSession';
import { HostSession } from './hostSession';
import { NEUTRAL_INPUT, quantizeInput, unpack } from './inputBuffer';
import type { InputPacket } from './inputBuffer';
import { SnapshotBuffer } from './interpolation';
import { MockTransport } from './mockTransport';
import { MAX_REPLAY_TICKS, Predictor } from './predictor';
import { encodeControlMessage, PacketKind } from './protocol';
import type { RosterPlayer } from './session';
import { decodeSnapshot, encodeSnapshot } from './snapshotCodec';
import type { Snapshot } from './snapshotCodec';
import type { ChannelKind, PeerLink, Transport, WireData } from './transport';

const drive = quantizeInput({ ...NEUTRAL_INPUT, throttle: 1, steer: 0.17 });
const neutralInputs = () => Array.from({ length: 8 }, () => ({ ...NEUTRAL_INPUT }));
function snapshot(tick = 180, trackId: TrackId = 'meadow'): Snapshot {
  const state = createRace(431, { trackId });
  state.tick = tick;
  state.phase = 'racing';
  state.countdown = 0;
  state.racingTicks = tick - 180;
  state.time = state.racingTicks * FIXED_DT;
  state.karts[1].human = state.karts[2].human = true;
  return { state, raceId: 1, hostTime: tick * TICK_MS, lastAppliedInput: neutralInputs() };
}
function roster(state: RaceState): RosterPlayer[] {
  return state.karts.map(kart => ({ slot: kart.id, name: kart.name, color: kart.color,
    kind: kart.human ? kart.id === 0 ? 'host' : 'guest' : 'cpu', connected: kart.human }));
}
function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('Predictor', () => {
  it('preserves sub-centisecond airTime through airborne snapshots without replay or visible jumps', () => {
    const initial = snapshot(180, 'canyon');
    initial.state.karts[1].airTime = 0.8 - FIXED_DT;
    initial.state.karts[1].speed = 20;
    const host = structuredClone(initial.state);
    const predictor = new Predictor(initial, 1);
    let quantizedTimers = 0;
    for (let tick = 181; tick <= 216; tick++) {
      predictor.recordInput(tick, drive);
      predictor.advanceTo(tick);
      const inputs = host.karts.map(kart => !kart.human ? getAIInput(host, kart.id)
        : kart.id === 1 ? drive : NEUTRAL_INPUT);
      stepRace(host, inputs);
      if (tick % 3 !== 0) continue;
      expect(host.karts[1].airTime).toBeGreaterThan(0);
      const decoded = decodeSnapshot(encodeSnapshot(host, 1, tick * TICK_MS, inputs), initial.state)!;
      if (decoded.state.karts[1].airTime !== host.karts[1].airTime) quantizedTimers++;
      expect(predictor.reconcile(decoded)).toBe(false);
      expect(predictor.replayTicks).toBe(0);
      expect(predictor.kart.airTime).toBe(host.karts[1].airTime);
      expect(predictor.state.trackId).toBe('canyon');
      const offset = predictor.visualOffset;
      expect(Math.hypot(offset.x, offset.y, offset.z)).toBeLessThan(1.5);
      expect(distance(predictor.kart, host.karts[1])).toBeLessThan(0.001);
      predictor.decayVisualOffset(3 * FIXED_DT);
    }
    expect(quantizedTimers).toBeGreaterThan(0);
  });

  it('replays quantized pending inputs, held remote inputs and fresh CPU AI bit for bit', () => {
    const initial = snapshot();
    initial.lastAppliedInput[0] = quantizeInput({ ...drive, steer: -0.4 });
    initial.lastAppliedInput[1] = drive;
    initial.lastAppliedInput[2] = quantizeInput({ ...drive, throttle: 0.6, drift: true });
    const predictor = new Predictor(initial, 1);
    const expected = structuredClone(initial.state);
    const pending = new Map<number, InputFrame>();
    for (let tick = 181; tick <= 204; tick++) {
      if (tick % 4 === 0) continue; // replay must hold the last local input
      const input = quantizeInput({ ...drive, steer: Math.sin(tick) * 0.5, useItem: tick === 190 });
      pending.set(tick, input);
      predictor.recordInput(tick, input);
    }
    let local = drive;
    let authoritative!: Snapshot;
    for (let tick = 181; tick <= 204; tick++) {
      local = pending.get(tick) ?? local;
      const inputs = expected.karts.map(kart => !kart.human ? getAIInput(expected, kart.id)
        : kart.id === 1 ? local : initial.lastAppliedInput[kart.id]);
      stepRace(expected, inputs);
      expected.events = [];
      if (tick === 186) authoritative = { ...initial, state: structuredClone(expected), lastAppliedInput: inputs };
    }
    predictor.advanceTo(204);
    expect(JSON.stringify(predictor.state)).toBe(JSON.stringify(expected));
    predictor.reconcile(authoritative);
    expect(predictor.replayTicks).toBe(18);
    expect(predictor.pendingCount).toBe([...pending.keys()].filter(tick => tick > 186).length);
    expect(JSON.stringify(predictor.state)).toBe(JSON.stringify(expected));
    expect(initial.state.tick).toBe(180);
    const copy = predictor.state;
    copy.karts[1].effects.auraTime = 99;
    expect(predictor.state.karts[1].effects.auraTime).toBe(0);
  });

  it('applies roster CPU takeover before sampling and uses the CPU speed rules', () => {
    const initial = snapshot();
    const predictor = new Predictor(initial, 1);
    const players = roster(initial.state);
    players[2].kind = 'cpu';
    players[2].connected = false;
    predictor.setRoster(players);
    const expected = structuredClone(initial.state);
    expected.karts[2].human = false;
    for (let tick = 181; tick <= 195; tick++) {
      predictor.recordInput(tick, drive);
      stepRace(expected, expected.karts.map(kart => !kart.human ? getAIInput(expected, kart.id)
        : kart.id === 1 ? drive : NEUTRAL_INPUT));
      expected.events = [];
    }
    predictor.advanceTo(195);
    expect(predictor.state).toEqual(expected);
    expect(predictor.state.karts[2].human).toBe(false);
  });

  it('honors a CPU snapshot even when it arrives ahead of the disconnect roster', () => {
    const initial = snapshot();
    const predictor = new Predictor(initial, 1);
    predictor.setRoster(roster(initial.state));
    const disconnected = snapshot(183);
    disconnected.state.karts[2].human = false;
    predictor.reconcile(disconnected);
    predictor.advanceTo(184);
    const expected = structuredClone(disconnected.state);
    stepRace(expected, expected.karts.map(kart => kart.human ? NEUTRAL_INPUT : getAIInput(expected, kart.id)));
    expected.events = [];
    expect(predictor.state).toEqual(expected);
  });

  it('bounds replay and pending memory, snaps across long stalls, and rejects stale races/ticks', () => {
    const initial = snapshot();
    const predictor = new Predictor(initial, 1);
    for (let tick = 181; tick <= 300; tick++) predictor.recordInput(tick, drive);
    expect(predictor.pendingCount).toBe(MAX_REPLAY_TICKS);
    predictor.advanceTo(300);
    expect(predictor.tick).toBe(220);
    predictor.reconcile(snapshot(181));
    expect(predictor.replayTicks).toBe(39);
    const before = predictor.state;
    predictor.reconcile(initial);
    predictor.reconcile({ ...snapshot(300), raceId: 2 });
    expect(predictor.state).toEqual(before);
    expect(predictor.reconcile(snapshot(300))).toBe(true);
    expect(predictor.tick).toBe(300);
    expect(predictor.replayTicks).toBe(0);
    expect(predictor.pendingCount).toBe(0);
    expect(predictor.visualOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('decays visual correction with an 80ms time constant and snaps above 1.5m', () => {
    const initial = snapshot();
    const predictor = new Predictor(initial, 1);
    const moved = snapshot(181);
    moved.state.karts[1].x += 1;
    predictor.reconcile(moved);
    expect(predictor.visualOffset.x).toBeCloseTo(-1);
    predictor.decayVisualOffset(0.08);
    expect(predictor.visualOffset.x).toBeCloseTo(-Math.exp(-1), 12);
    predictor.decayVisualOffset(-1);
    predictor.decayVisualOffset(NaN);
    expect(predictor.visualOffset.x).toBeCloseTo(-Math.exp(-1), 12);
    const next = snapshot(182);
    next.state.karts[1].x += 2.2;
    predictor.reconcile(next); // accumulated offset exceeds the threshold
    expect(predictor.visualOffset).toEqual({ x: 0, y: 0, z: 0 });
    expect(predictor.previous.x).toBe(next.state.karts[1].x);
    const exact = snapshot(183);
    exact.state.karts[1].x += 3.7;
    predictor.reconcile(exact);
    expect(predictor.visualOffset.x).toBeCloseTo(-1.5);
  });

  it('discards events from item use and countdown replay, including snapshot events', () => {
    const initial = snapshot();
    initial.state.karts[1].item = 'dash';
    initial.state.events = [{ type: 'pickup', kartId: 1 }];
    const predictor = new Predictor(initial, 1);
    predictor.recordInput(181, { ...drive, useItem: true });
    predictor.advanceTo(181);
    expect(predictor.kart.boostTime).toBeGreaterThan(1);
    expect(predictor.state.events).toEqual([]);
    const countdown = { ...initial, state: createRace(431) };
    countdown.state.tick = 179;
    const start = new Predictor(countdown, 1);
    start.advanceTo(180);
    expect(start.state.phase).toBe('racing');
    expect(start.state.events).toEqual([]);
  });

  it.each([NaN, Infinity, -Infinity])('snaps a non-finite visual correction (%s) to the authoritative pose', value => {
    const initial = snapshot();
    initial.state.karts[1].x = value;
    const predictor = new Predictor(initial, 1);
    const corrected = snapshot(181);
    predictor.reconcile(corrected);
    expect(predictor.visualOffset).toEqual({ x: 0, y: 0, z: 0 });
    expect(predictor.kart).toEqual(corrected.state.karts[1]);
    const { x, y, z, heading } = corrected.state.karts[1];
    expect(predictor.previous).toEqual({ x, y, z, heading });
    predictor.decayVisualOffset(0.08);
    expect(predictor.visualOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('preserves known timer precision inside a wire bucket but accepts authoritative timer changes', () => {
    const initial = snapshot();
    initial.state.karts[1].boostTime = 0.65;
    const predictor = new Predictor(initial, 1);
    predictor.advanceTo(182);
    const precise = predictor.kart.boostTime;
    const decoded = decodeSnapshot(encodeSnapshot(predictor.state, 1, 182 * TICK_MS), initial.state)!;
    expect(decoded.state.karts[1].boostTime).not.toBe(precise);
    predictor.reconcile(decoded);
    expect(predictor.kart.boostTime).toBe(precise);
    predictor.advanceTo(183);
    const corrected = decodeSnapshot(encodeSnapshot(predictor.state, 1, 183 * TICK_MS), initial.state)!;
    corrected.state.karts[1].boostTime = 0; // e.g. authoritative hit cancelled the boost
    predictor.reconcile(corrected);
    expect(predictor.kart.boostTime).toBe(0);
  });

  it.each([
    { entry: 'constructor', rapidUnused: 0 },
    { entry: 'constructor', rapidUnused: 1 },
    { entry: 'reconcile', rapidUnused: 0 },
    { entry: 'reconcile', rapidUnused: 1 },
  ])('matches host rapidDash activation tick by tick with a zero wire timer ($entry, unused=$rapidUnused)', ({ entry, rapidUnused }) => {
    const host = snapshot(601);
    const kart = host.state.karts[1];
    kart.item = 'rapidDash';
    kart.effects.rapidUnused = rapidUnused;
    kart.effects.rapidTime = rapidUnused ? 0 : FIXED_DT;
    const decoded = decodeSnapshot(encodeSnapshot(host.state, host.raceId, host.hostTime), host.state)!;
    expect(decoded.state.karts[1].item).toBe('rapidDash');
    expect(decoded.state.karts[1].effects).toMatchObject({ rapidTime: 0, rapidUnused });
    const predictor = new Predictor(entry === 'constructor' ? decoded : snapshot(600), 1);
    if (entry === 'reconcile') predictor.reconcile(decoded);

    for (const useItem of [true, false, true]) {
      const input = { ...NEUTRAL_INPUT, useItem };
      const tick = host.state.tick + 1;
      predictor.recordInput(tick, input);
      stepRace(host.state, host.state.karts.map(kart => !kart.human ? getAIInput(host.state, kart.id)
        : kart.id === 1 ? input : NEUTRAL_INPUT));
      predictor.advanceTo(tick);
      expect(predictor.tick).toBe(host.state.tick);
      expect(predictor.kart).toMatchObject({ item: kart.item, boostTime: kart.boostTime,
        previousItem: kart.previousItem, effects: { rapidTime: kart.effects.rapidTime, rapidUnused: kart.effects.rapidUnused } });
      if (tick === 602) {
        expect(host.state.events).toContainEqual({ type: 'use', kartId: 1 });
        expect(kart.boostTime).toBe(0.45);
        expect(kart.item).toBe(rapidUnused ? 'rapidDash' : null);
        expect(kart.effects.rapidTime).toBeCloseTo(rapidUnused ? 8 - FIXED_DT : 0);
      }
    }
    expect(decoded.state.karts[1].effects).toMatchObject({ rapidTime: 0, rapidUnused });
  });

  it('does not restart an active rapidDash rounded to zero during replay, but permits a fresh item', () => {
    const initial = snapshot(600);
    initial.state.karts[1].item = 'rapidDash';
    initial.state.karts[1].effects.rapidTime = 0.05;
    initial.state.karts[1].effects.rapidUnused = 0;
    const predictor = new Predictor(initial, 1);
    const nearExpiry = structuredClone(initial);
    nearExpiry.state.tick++;
    nearExpiry.state.karts[1].effects.rapidTime = 0.01;
    const decoded = decodeSnapshot(encodeSnapshot(nearExpiry.state, 1, nearExpiry.hostTime), initial.state)!;
    expect(decoded.state.karts[1].effects.rapidTime).toBe(0);
    predictor.recordInput(602, { ...drive, useItem: true });
    predictor.advanceTo(602);
    predictor.reconcile(decoded);
    expect(predictor.replayTicks).toBe(1);
    expect(predictor.kart.boostTime).toBe(0.45);
    expect(predictor.kart.effects.rapidTime).toBe(0);
    expect(predictor.kart.item).toBeNull();
    expect(decoded.state.karts[1].effects.rapidTime).toBe(0);
    const empty = snapshot(603);
    predictor.reconcile(empty);
    const fresh = snapshot(604);
    fresh.state.karts[1].item = 'rapidDash';
    predictor.reconcile(fresh);
    predictor.recordInput(605, { ...drive, useItem: true });
    predictor.advanceTo(605);
    expect(predictor.kart.effects.rapidTime).toBeCloseTo(8 - FIXED_DT);
  });

  it('retains an unused rapidDash picked up while the item button was already held', () => {
    const initial = snapshot();
    initial.state.karts[1].item = 'rapidDash';
    initial.state.karts[1].previousItem = true;
    const predictor = new Predictor(initial, 1);
    predictor.recordInput(181, { ...drive, useItem: true });
    predictor.advanceTo(181);
    expect(predictor.kart.item).toBe('rapidDash');
    expect(predictor.kart.effects.rapidTime).toBe(0);
    predictor.recordInput(182, drive);
    predictor.recordInput(183, { ...drive, useItem: true });
    predictor.advanceTo(183);
    expect(predictor.kart.effects.rapidTime).toBeCloseTo(8 - FIXED_DT);
  });

  it.each([183, 186])('recognizes a fresh rapidDash at tick %s without an empty-item snapshot', tick => {
    const initial = snapshot();
    initial.state.karts[1].item = 'rapidDash';
    initial.state.karts[1].effects.rapidTime = 0.05;
    initial.state.karts[1].effects.rapidUnused = 0;
    const predictor = new Predictor(initial, 1);
    const fresh = snapshot(tick);
    fresh.state.karts[1].item = 'rapidDash';
    const decoded = decodeSnapshot(encodeSnapshot(fresh.state, fresh.raceId, fresh.hostTime), initial.state)!;
    predictor.reconcile(decoded);
    expect(predictor.kart.effects).toMatchObject({ rapidTime: 0, rapidUnused: 1 });
    predictor.recordInput(tick + 1, { ...drive, useItem: true });
    predictor.advanceTo(tick + 1);
    expect(predictor.kart.effects.rapidTime).toBeCloseTo(8 - FIXED_DT);
  });
});

/** Observe reception after GuestSession has buffered the same datagram. */
async function sessionHarness(latencyMs: number, lossRate = 0, prediction?: boolean) {
  const network = new MockTransport({ latencyMs, lossRate, seed: 92 });
  let receive = (_kind: ChannelKind, _data: WireData) => {};
  let link!: PeerLink;
  const sent: InputPacket[] = [];
  const transport: Transport = {
    host: code => network.host(code),
    async join(code) {
      link = await network.join(code);
      return {
        peerId: link.peerId,
        send(kind, data) { const packet = unpack(data); if (packet) sent.push(packet); link.send(kind, data); },
        close: () => link.close(), onClose: handler => link.onClose(handler),
        onMessage: handler => link.onMessage((kind, data) => { handler(kind, data); receive(kind, data); }),
      };
    },
  };
  const host = await HostSession.create(network, { roomCode: 'AB2X', now: () => network.now });
  const guest = new GuestSession(transport, { now: () => network.now, prediction });
  await guest.join('AB2X');
  for (let i = 0; i < 200; i++) { host.frame(); guest.frame(); network.advance(10); }
  const state = host.startRace(431);
  network.advance(host.startAtHostTime - network.now);
  const step = (input: InputFrame = drive) => {
    guest.tick(input);
    network.advance(TICK_MS);
    const applied = state.karts.map(kart => host.inputSource(kart.id).sample(state, kart.id));
    stepRace(state, applied);
    host.afterTick(state);
    return applied;
  };
  return { network, host, guest, state, sent, step,
    observe: (handler: typeof receive) => { receive = handler; } };
}

describe('GuestSession prediction', () => {
  it.each(['frame', 'tick'] as const)('reconciles only the newest queued snapshot before %s, and clears it on rematch', async boundary => {
    const network = new MockTransport({ latencyMs: 0 });
    const host = await network.host('AB2X');
    let peer!: PeerLink;
    host.onJoin(link => { peer = link; });
    const guest = new GuestSession(network, { now: () => network.now, prediction: true });
    const reconcile = vi.spyOn(Predictor.prototype, 'reconcile');
    try {
      await guest.join('AB2X');
      const initial = snapshot();
      const players = roster(initial.state);
      const send = (data: Parameters<typeof encodeControlMessage>[0]) => peer.send('reliable', encodeControlMessage(data));
      const sendSnapshot = (tick: number) => peer.send('unreliable', encodeSnapshot(snapshot(tick).state, 1, network.now));
      send({ type: 'welcome', trackId: 'meadow', slot: 1, roster: players, hostTime: 0 });
      send({ type: 'race_start', trackId: 'meadow', raceId: 1, seed: 431, roster: players, startAtHostTime: 0 });
      sendSnapshot(180);
      network.advance(0);
      guest.tick(drive);
      guest.frame();
      reconcile.mockClear();

      sendSnapshot(183);
      sendSnapshot(189);
      sendSnapshot(186); // unordered stale packet must not replace the newest
      sendSnapshot(189); // duplicate must not add another replay
      network.advance(0);
      expect(reconcile).not.toHaveBeenCalled();
      if (boundary === 'tick') guest.tick(drive);
      const view = guest.frame()!;
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile.mock.calls[0][0].state.tick).toBe(189);
      expect(guest.predictedState!.tick).toBeGreaterThanOrEqual(189);
      expect(view.state.karts[1].x).toBe(guest.predictedState!.karts[1].x + guest.visualOffset.x);
      expect(view.state.events).toEqual([]);
      guest.tick(drive);
      guest.frame();
      expect(reconcile).toHaveBeenCalledTimes(1);

      sendSnapshot(192);
      send({ type: 'return_lobby' });
      send({ type: 'race_start', trackId: 'meadow', raceId: 2, seed: 432, roster: players, startAtHostTime: 0 });
      network.advance(0);
      guest.frame();
      expect(guest.predictedState!.tick).toBe(0);
      expect(reconcile).toHaveBeenCalledTimes(1);
    } finally {
      reconcile.mockRestore();
      host.close();
    }
  });

  it('defaults on, predicts only the local kart, suppresses simulated events and resets on rematch', async () => {
    const h = await sessionHarness(0);
    try {
      expect(h.guest.predictedState).not.toBeNull();
      for (let i = 0; i < 210; i++) { h.step(); h.guest.frame(); }
      h.state.karts[1].item = 'dash';
      h.state.karts[1].spinTime = 0;
      for (let i = 0; i < 3; i++) { h.step(); h.guest.frame(); }
      h.network.advance(0);
      h.guest.frame();
      h.guest.tick({ ...drive, useItem: true });
      const frame = h.guest.frame()!;
      expect(h.guest.predictedState!.karts[1].boostTime).toBeGreaterThan(1);
      const predicted = h.guest.predictedState!.karts[1];
      const offset = h.guest.visualOffset;
      expect(frame.state.karts[1].x).toBe(predicted.x + offset.x);
      expect(frame.state.karts[1].y).toBe(predicted.y + offset.y);
      expect(frame.state.karts[1].z).toBe(predicted.z + offset.z);
      expect(frame.state.events).toEqual([]);
      expect(h.guest.frame()!.state.events).toEqual([]);
      for (const kart of frame.state.karts.filter(kart => kart.id !== 1)) {
        expect(frame.previous.karts[kart.id]).toEqual({ x: kart.x, y: kart.y, z: kart.z, heading: kart.heading });
      }
      h.network.advance(TICK_MS / 2);
      expect(h.guest.frame()!.alpha).toBeCloseTo(0.5);
      h.host.returnToLobby();
      h.network.advance(0);
      expect(h.guest.predictedState).toBeNull();
      h.host.startRace(432);
      h.network.advance(0);
      expect(h.guest.predictedState!.tick).toBe(0);
      expect(h.guest.replayTicks).toBe(0);
      expect(h.guest.visualOffset).toEqual({ x: 0, y: 0, z: 0 });
    } finally { h.host.close(); }
  });

  it('keeps the exact N4 interpolation and host event path when prediction is disabled', async () => {
    const h = await sessionHarness(60, 0.1, false);
    const buffer = new SnapshotBuffer();
    buffer.push({ raceId: h.host.raceId, state: h.state, hostTime: h.host.startAtHostTime, lastAppliedInput: neutralInputs() });
    h.observe((kind, data) => {
      if (kind !== 'unreliable') return;
      const decoded = decodeSnapshot(data, h.state);
      if (decoded) buffer.push(decoded);
    });
    try {
      for (let tick = 1; tick <= 600; tick++) {
        h.step();
        const frame = h.guest.frame()!;
        const expected = buffer.sample(h.network.now + h.guest.offset - 100)!;
        for (const kart of frame.state.karts) expect(kart).toEqual(expected.karts[kart.id]);
        expect(frame.alpha).toBe(1);
        expect(h.guest.predictedState).toBeNull();
      }
    } finally { h.host.close(); }
  });

  it.each(['fixed', 'ai', 'drift'] as const)('reconciles every snapshot within 0.05m of same-tick host history at RTT 120ms / loss 10% (%s)', async controls => {
    const h = await sessionHarness(60, 0.1);
    const predictions: { source: number; state: RaceState }[] = [];
    const history = new Map<number, RaceState>();
    let lastTick = 0;
    let reconciledTick = 0;
    h.observe((kind, data) => {
      if (kind !== 'unreliable') return;
      const decoded = decodeSnapshot(data, h.state);
      if (!decoded || decoded.state.tick <= lastTick) return;
      lastTick = decoded.state.tick;
    });
    try {
      // Compare equal simulation ticks. Local inputs through the prediction's
      // target tick are already sent; comparing with the delayed source tick
      // would incorrectly count the intentional input lead as position error.
      for (let tick = 1; tick <= 1240; tick++) {
        const input = controls === 'ai' ? { ...getAIInput(h.state, 1), useItem: false }
          : { ...NEUTRAL_INPUT, throttle: 1, steer: controls === 'drift' ? Math.sin(tick * 0.02) * 0.6 : 0,
            drift: controls === 'drift' && tick % 200 < 100 };
        h.step(input);
        history.set(h.state.tick, structuredClone(h.state));
        h.guest.frame();
        if (lastTick > reconciledTick) {
          expect(h.guest.replayTicks).toBeLessThanOrEqual(40);
          if (lastTick <= 1200) predictions.push({ source: lastTick, state: h.guest.predictedState! });
          reconciledTick = lastTick;
        }
      }
      let comparisons = 0;
      for (const prediction of predictions) {
        const expected = history.get(prediction.state.tick);
        expect(expected, `missing host tick ${prediction.state.tick}`).toBeDefined();
        const error = distance(prediction.state.karts[1], expected!.karts[1]);
        expect(error, `${prediction.source} -> ${prediction.state.tick}`).toBeLessThanOrEqual(0.05);
        comparisons++;
      }
      expect(comparisons).toBeGreaterThan(300);
    } finally { h.host.close(); }
  });

  it('keeps every scheduled input at RTT 300ms, including single-tick item pulses', async () => {
    const h = await sessionHarness(150);
    const applied = new Map<number, InputFrame>();
    try {
      expect(h.guest.lead).toBeGreaterThanOrEqual(11);
      for (let tick = 1; tick <= 630; tick++) {
        const input = { ...drive, steer: ((tick % 15) - 7) / 10, useItem: tick === 250 || tick === 400 };
        applied.set(tick, h.step(input)[1]);
        h.guest.frame();
      }
      const packets = h.sent.filter(packet => packet.latestTick >= 30 && packet.latestTick <= 600);
      expect(packets.length).toBeGreaterThan(550);
      for (const packet of packets) {
        for (let index = 0; index < packet.frames.length; index++) {
          expect(applied.get(packet.latestTick - index)).toEqual(packet.frames[index]);
        }
      }
      expect([...applied.values()].filter(input => input.useItem)).toHaveLength(2);
    } finally { h.host.close(); }
  });

  it('raises lead on a slower RTT sample without waiting for the minimum-RTT clock window', async () => {
    const network = new MockTransport({ latencyMs: 0 });
    const host = await network.host('AB2X');
    const guest = new GuestSession(network, { now: () => network.now });
    let peer!: PeerLink;
    let ping = -1;
    let fast = true;
    host.onJoin(link => {
      peer = link;
      peer.onMessage((kind, data) => {
        if (kind !== 'unreliable') return;
        const clock = unpackClock(data);
        if (clock?.kind !== PacketKind.PING) return;
        ping = clock.t0;
        if (fast) peer.send('unreliable', packPong(ping, network.now));
      });
    });
    try {
      await guest.join('AB2X');
      const initial = snapshot();
      peer.send('reliable', encodeControlMessage({ type: 'welcome', trackId: 'meadow', slot: 1,
        roster: roster(initial.state), hostTime: network.now }));
      network.advance(0);
      for (let i = 0; i < 5; i++) { network.advance(100); guest.frame(); network.advance(0); }
      expect(guest.lead).toBe(2);
      fast = false;
      network.advance(500);
      guest.frame();
      network.advance(0);
      const sentAt = ping;
      network.advance(300);
      peer.send('unreliable', packPong(sentAt, sentAt + 150));
      network.advance(0);
      expect(guest.rtt).toBe(0); // minimum sample is still used for clock offset
      expect(guest.lead).toBe(11);
    } finally { host.close(); }
  });

  it('delivers authoritative events exactly once even though prediction also uses the item', async () => {
    const network = new MockTransport({ latencyMs: 0 });
    const host = await network.host('AB2X');
    let peer!: PeerLink;
    host.onJoin(link => { peer = link; });
    const guest = new GuestSession(network, { now: () => network.now });
    await guest.join('AB2X');
    const initial = snapshot();
    const players = roster(initial.state);
    const send = (data: Parameters<typeof encodeControlMessage>[0]) => peer.send('reliable', encodeControlMessage(data));
    send({ type: 'welcome', trackId: 'meadow', slot: 1, roster: players, hostTime: 0 });
    send({ type: 'race_start', trackId: 'meadow', raceId: 1, seed: 431, roster: players, startAtHostTime: 0 });
    initial.state.karts[1].item = 'dash';
    peer.send('unreliable', encodeSnapshot(initial.state, 1, 0));
    network.advance(0);
    guest.tick({ ...drive, useItem: true });
    expect(guest.frame()!.state.events).toEqual([]);
    const events = [{ type: 'use', kartId: 1 } as const];
    send({ type: 'events', raceId: 1, tick: 183, events });
    network.advance(0);
    expect(guest.frame()!.state.events).toEqual(events);
    expect(guest.frame()!.state.events).toEqual([]);
    host.close();
  });
});

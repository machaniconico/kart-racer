import { describe, expect, it, vi } from 'vitest';
import { getAIInput } from '../sim/ai';
import { ROULETTE_TIME } from '../sim/items';
import { createRace, FIXED_DT, startDashBoost, stepRace } from '../sim/race';
import { sampleTrack } from '../sim/track';
import { getTrack } from '../sim/tracks';
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
  it.each([0, 4].flatMap(replay => [-1, 0].map(lastBand => ({ replay, lastBand }))))(
    'restores authoritative lastBand=$lastBand with $replay replay ticks', ({ replay, lastBand }) => {
      const initial = snapshot(180, 'canyon');
      initial.state.karts = [initial.state.karts[1]];
      initial.state.boxes = [];
      const track = getTrack('canyon');
      const sample = sampleTrack(track, track.def.barriers![0]!.from + 5);
      const offset = 4;
      Object.assign(initial.state.karts[0], {
        x: sample.x + sample.nx * offset, z: sample.z + sample.nz * offset, y: sample.y,
        heading: Math.atan2(sample.tx, sample.tz), trackDistance: sample.distance, lateralOffset: offset,
        lastBand: lastBand === -1 ? 0 : -1,
      });
      const predictor = new Predictor(initial, 1);
      predictor.advanceTo(181 + replay);
      expect(predictor.kart.lastBand).toBe(initial.state.karts[0].lastBand);
      const authoritative = structuredClone(initial);
      authoritative.state.tick = 181;
      authoritative.state.karts[0].lastBand = lastBand;
      authoritative.state.events = [{ type: 'hit', kartId: 1, value: 1 }];
      predictor.reconcile(authoritative);
      expect(predictor.replayTicks).toBe(replay);
      expect(predictor.kart.lastBand).toBe(lastBand);
      expect(predictor.state.events).toEqual([]);
      expect(authoritative.state.karts[0].lastBand).toBe(lastBand);
      expect(initial.state.karts[0].lastBand).toBe(lastBand === -1 ? 0 : -1);
    },
  );

  it.each((['tripleDash', 'trap', 'autopilot'] as const).flatMap(item =>
    [false, true].map(earlyStop => ({ item, earlyStop }))))
  ('preserves roulette expiry and latched $item input without replay (earlyStop=$earlyStop)', ({ item, earlyStop }) => {
    const initial = snapshot();
    initial.state.karts.forEach(kart => { kart.human = true; });
    const kart = initial.state.karts[1];
    kart.item = item;
    Object.assign(kart.effects, { rouletteTime: ROULETTE_TIME, charges: item === 'tripleDash' ? 3 : 0 });
    const host = structuredClone(initial.state);
    const predictor = new Predictor(initial, 1);
    let quantizedTimers = 0;
    for (let tick = 181; tick <= 272; tick++) {
      const useItem = tick < 268 ? tick >= (earlyStop ? 199 : 181) : tick === 269;
      const input = { ...NEUTRAL_INPUT, useItem };
      predictor.recordInput(tick, input);
      predictor.advanceTo(tick);
      const inputs = neutralInputs();
      inputs[1] = input;
      stepRace(host, inputs);
      const decoded = decodeSnapshot(encodeSnapshot(host, 1, tick * TICK_MS, inputs), initial.state)!;
      if (decoded.state.karts[1].effects.rouletteTime !== host.karts[1].effects.rouletteTime) quantizedTimers++;
      expect(predictor.reconcile(decoded)).toBe(false);
      expect(predictor.replayTicks).toBe(0);
      expect(predictor.kart.effects.rouletteTime).toBe(host.karts[1].effects.rouletteTime);
      expect(predictor.kart.effects.holding).toBe(host.karts[1].effects.holding);
      expect(predictor.kart.effects.charges).toBe(host.karts[1].effects.charges);
      expect(predictor.kart.item).toBe(host.karts[1].item);
      expect(predictor.kart.previousItem).toBe(host.karts[1].previousItem);
      if (tick < 269) {
        expect(predictor.kart.item).toBe(item);
        expect(predictor.kart.effects.holding).toBe(0);
        expect(predictor.kart.effects.charges).toBe(item === 'tripleDash' ? 3 : 0);
        expect(predictor.kart.effects.autoTime).toBe(0);
      }
    }
    expect(quantizedTimers).toBeGreaterThan(0);
    expect(predictor.kart.effects.rouletteTime).toBe(0);
    if (item === 'tripleDash') expect(predictor.kart.effects.charges).toBe(2);
    else expect(predictor.kart.item).toBeNull();
  });

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

  it('exposes the local-kart displacement of the latest reconcile as lastCorrectionMetres', () => {
    const predictor = new Predictor(snapshot(), 1);
    expect(predictor.lastCorrectionMetres).toBe(0);
    const moved = snapshot(181);
    moved.state.karts[1].x += 0.6;
    moved.state.karts[1].z -= 0.8;
    expect(predictor.reconcile(moved)).toBe(false);
    expect(predictor.lastCorrectionMetres).toBeCloseTo(1, 12);
    // A stale tick is not a reconcile and keeps the previous value.
    expect(predictor.reconcile(snapshot(181))).toBe(false);
    expect(predictor.lastCorrectionMetres).toBeCloseTo(1, 12);
    expect(predictor.reconcile(structuredClone({ ...moved, state: { ...moved.state, tick: 182 } }))).toBe(false);
    expect(predictor.lastCorrectionMetres).toBe(0);
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

  // v20 preserves the held tick count across re-anchors at every start-dash tier boundary.
  it.each([[5, 177], [11, 177], [11, 171], [36, 176], [37, 169], [48, 176]])
  ('predicts the host GO boost of a %i tick hold after a countdown re-anchor at tick %i', (total, snapAt) => {
    const initial = snapshot(0);
    Object.assign(initial.state, { phase: 'countdown', countdown: 3, racingTicks: 0, time: 0 });
    const host = structuredClone(initial.state);
    const predictor = new Predictor(initial, 1);
    const input = (tick: number) => ({ ...NEUTRAL_INPUT, throttle: tick >= 180 - total ? 1 : 0.3 });
    // Snapshots are lost: the prediction stalls 40 ticks ahead of tick 0 while inputs are still sent.
    for (let tick = 1; tick <= 181; tick++) {
      predictor.recordInput(tick, input(tick));
      stepRace(host, host.karts.map(kart => !kart.human ? getAIInput(host, kart.id) : kart.id === 1 ? input(tick) : NEUTRAL_INPUT));
      if (tick === snapAt) {
        const decoded = decodeSnapshot(encodeSnapshot(host, 1, tick * TICK_MS,
          host.karts.map(kart => kart.id === 1 ? input(tick) : NEUTRAL_INPUT)), initial.state)!;
        expect(predictor.reconcile(decoded)).toBe(true);
      }
      predictor.advanceTo(tick);
    }
    expect(predictor.tick).toBe(181);
    expect(host.karts[1].boostTime).toBe(Math.max(0, startDashBoost(total) - FIXED_DT));
    expect(predictor.kart.boostTime).toBe(host.karts[1].boostTime);
  });

  // M12-25 AC3: a guest re-synced just before GO with no record of its own hold (溜め 0 locally) still
  // predicts the host's GO boost, for any gap up to the 40-tick replay limit. `gap` = prediction tick -
  // snapshot tick (input lead + one-way transit; about 17 at RTT 240 ms). "Correction" is the simulated
  // local-kart displacement of each reconcile (Predictor.lastCorrectionMetres), not the blended view.
  //  - fresh: the predictor starts from the tick 177 countdown snapshot; it knows only the wire boostTime.
  //  - skipped: it recorded ticks up to 160 (pressed from 150), then a re-anchor skipped 161..177; the host
  //    InputBuffer repeated the press for INPUT_HOLD_TICKS (161..170), then used neutral until 177.
  // Before the fix: 0.665 m at gap 18, 0.817 m at gap 20 when the hold was dropped.
  it.each((['fresh', 'skipped'] as const).flatMap(scenario => [3, 10, 17, 18, 20, 25, 30, 35, 40].map(gap => ({ scenario, gap }))))
  ('predicts the GO boost after a $scenario re-sync with no hold record, $gap ticks ahead of snapshots', ({ scenario, gap }) => {
    const initial = snapshot(0);
    Object.assign(initial.state, { phase: 'countdown', countdown: 3, racingTicks: 0, time: 0 });
    const host = structuredClone(initial.state);
    const idle = { ...NEUTRAL_INPUT, throttle: 0.3 };
    const press = { ...NEUTRAL_INPUT, throttle: 1 };
    const sent = (tick: number) => tick >= 150 ? press : idle;
    const applied = (tick: number) => scenario === 'skipped' && tick > 170 && tick <= 177 ? NEUTRAL_INPUT : sent(tick);
    const hostStep = () => {
      const input = applied(host.tick + 1);
      stepRace(host, host.karts.map(kart => !kart.human ? getAIInput(host, kart.id) : kart.id === 1 ? input : NEUTRAL_INPUT));
    };
    const encode = () => decodeSnapshot(encodeSnapshot(host, 1, host.tick * TICK_MS,
      host.karts.map(kart => kart.id === 1 ? applied(host.tick) : NEUTRAL_INPUT)), initial.state)!;
    let predictor: Predictor;
    if (scenario === 'fresh') {
      while (host.tick < 177) hostStep();
      predictor = new Predictor(encode(), 1);
    } else {
      predictor = new Predictor(initial, 1);
      for (let tick = 1; tick <= 160; tick++) predictor.recordInput(tick, sent(tick));
      predictor.advanceTo(40);
      while (host.tick < 177) hostStep();
      expect(predictor.reconcile(encode())).toBe(true);
    }
    const corrections: number[] = [];
    for (let tick = 178; tick <= 177 + gap; tick++) predictor.recordInput(tick, press);
    predictor.advanceTo(177 + gap);
    while (host.tick < 300) {
      hostStep();
      predictor.recordInput(host.tick + gap, press);
      predictor.advanceTo(host.tick + gap);
      if (host.tick === 180) expect(host.karts[1].boostTime).toBe(1.0);
      if (host.tick % 3 === 0) {
        expect(predictor.reconcile(encode())).toBe(false);
        corrections.push(predictor.lastCorrectionMetres);
      }
    }
    // Position quantization leaves sub-centimetre replays later in the run; none is a GO correction.
    expect(corrections.filter(metres => metres > 0.01)).toEqual([]);
    expect(Math.max(...corrections)).toBeLessThanOrEqual(0.6);
  });

  it.each(Array.from({ length: 61 }, (_, held) => held))
  ('uses the exact %i-tick host hold with no local history or conflicting prediction', held => {
    const host = snapshot(179);
    Object.assign(host.state, { phase: 'countdown', countdown: FIXED_DT, racingTicks: 0, time: 0 });
    host.state.karts[1].boostTime = held * FIXED_DT;
    const decoded = decodeSnapshot(encodeSnapshot(host.state, 1, host.hostTime, host.lastAppliedInput), host.state)!;
    const fresh = new Predictor(decoded, 1);
    const earlier = structuredClone(host);
    earlier.state.tick = 178;
    earlier.state.countdown = 2 * FIXED_DT;
    earlier.state.karts[1].boostTime = (held === 5 ? 6 : 5) * FIXED_DT;
    const reconciled = new Predictor(earlier, 1);
    reconciled.recordInput(179, NEUTRAL_INPUT);
    reconciled.advanceTo(179);
    reconciled.reconcile(decoded);
    for (const predictor of [fresh, reconciled]) {
      expect(predictor.kart.boostTime).toBe(held * FIXED_DT);
      predictor.advanceTo(180);
      expect(predictor.kart.boostTime).toBe(startDashBoost(held));
    }
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
      send({ type: 'welcome', cpuLevel: 'normal', cpuFill: true, items: true, trackId: 'meadow', laps: 3, slot: 1, roster: players, hostTime: 0 });
      send({ type: 'race_start', cpuLevel: 'normal', cpuFill: true, items: true, trackId: 'meadow', laps: 3, raceId: 1, seed: 431, roster: players, startAtHostTime: 0 });
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
      send({ type: 'race_start', cpuLevel: 'normal', cpuFill: true, items: true, trackId: 'meadow', laps: 3, raceId: 2, seed: 432, roster: players, startAtHostTime: 0 });
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

  it.each(['fixed', 'ai', 'drift'] as const)('reconciles matching input windows within 0.05m at RTT 120ms / loss 10% (%s)', async controls => {
    const h = await sessionHarness(60, 0.1);
    const predictions: { source: number; state: RaceState }[] = [];
    const history = new Map<number, RaceState>();
    const appliedInputs = new Map<number, InputFrame>();
    const sentInputs = new Map<number, InputFrame>();
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
        const applied = h.step(input);
        appliedInputs.set(h.state.tick, applied[1]);
        const packet = h.sent.at(-1);
        packet?.frames.forEach((frame, index) => sentInputs.set(packet.latestTick - index, frame));
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
        // A lost input edge can leave the host holding drift after the guest has
        // released it. Only equal input windows can promise a 5 cm replay bound.
        let input = appliedInputs.get(prediction.source)!;
        let matchingInputs = true;
        for (let tick = prediction.source + 1; tick <= prediction.state.tick; tick++) {
          input = sentInputs.get(tick) ?? input;
          if (JSON.stringify(input) !== JSON.stringify(appliedInputs.get(tick))) matchingInputs = false;
        }
        if (!matchingInputs) continue;
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
      peer.send('reliable', encodeControlMessage({ type: 'welcome', cpuLevel: 'normal', cpuFill: true, items: true, trackId: 'meadow', laps: 3, slot: 1,
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
    send({ type: 'welcome', cpuLevel: 'normal', cpuFill: true, items: true, trackId: 'meadow', laps: 3, slot: 1, roster: players, hostTime: 0 });
    send({ type: 'race_start', cpuLevel: 'normal', cpuFill: true, items: true, trackId: 'meadow', laps: 3, raceId: 1, seed: 431, roster: players, startAtHostTime: 0 });
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

describe('Predictor respawns (guest-local)', () => {
  const chasmTrack = getTrack('chasm');
  const ravine = chasmTrack.def.surfaces.find(zone => zone.kind === 'fall')!;
  const straight = quantizeInput({ ...NEUTRAL_INPUT, throttle: 1 });
  function placed(tick: number, trackId: TrackId, distance: number, extra: Partial<RaceState['karts'][number]> = {}): Snapshot {
    const value = snapshot(tick, trackId);
    const track = getTrack(trackId);
    const p = sampleTrack(track, distance);
    Object.assign(value.state.karts[1], { x: p.x, y: p.y, z: p.z, heading: Math.atan2(p.tx, p.tz),
      trackDistance: distance, lateralOffset: 0, speed: 30, airTime: 0, ...extra });
    return value;
  }

  it('counts a predicted fall once (not again on replay), drops an outstanding offset and never blends from the lip', () => {
    const predictor = new Predictor(placed(180, 'chasm', ravine.from - 3), 1);
    predictor.recordInput(181, straight);
    predictor.advanceTo(181);
    // The host saw the kart 0.6 m to the side: a small correction eases out through the visual offset.
    const host = new Predictor(placed(180, 'chasm', ravine.from - 3), 1);
    host.advanceTo(181);
    const shifted = host.state;
    shifted.karts[1].x += 0.6;
    predictor.reconcile({ ...placed(181, 'chasm', 0), state: shifted });
    expect(Math.hypot(predictor.visualOffset.x, predictor.visualOffset.z)).toBeGreaterThan(0.3);
    expect(predictor.localFallCount).toBe(0);
    predictor.advanceTo(195);
    expect(predictor.localFallCount).toBe(1);
    expect(predictor.kart.trackDistance).toBeCloseTo(ravine.respawnAt!, 0);
    expect(predictor.visualOffset).toEqual({ x: 0, y: 0, z: 0 });
    // The host confirms the same fall, in the replay and in its events batch: still one respawn.
    const hostLine = new Predictor({ ...placed(181, 'chasm', 0), state: shifted }, 1);
    hostLine.advanceTo(188);
    predictor.markFall(183, 189);
    predictor.reconcile({ ...placed(188, 'chasm', 0), state: hostLine.state });
    expect(predictor.localFallCount).toBe(1);
    expect(predictor.visualOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('a large correction without a fall is not a cut (legacy multiplayer behaviour)', () => {
    const predictor = new Predictor(placed(180, 'meadow', 100), 1);
    predictor.advanceTo(184);
    predictor.reconcile(placed(182, 'meadow', 112));
    expect(predictor.lastCorrectionMetres).toBeGreaterThan(5);
    expect(predictor.localFallCount).toBe(0);
  });

  /** A guest predicting slot 1 over a hand-driven wire, with snapshots placed relative to its clock. */
  async function guestOn(trackId: TrackId, first: (tick: number) => Snapshot) {
    const network = new MockTransport({ latencyMs: 0 });
    const host = await network.host('AB2X');
    let peer!: PeerLink;
    host.onJoin(link => { peer = link; });
    const guest = new GuestSession(network, { now: () => network.now, prediction: true });
    await guest.join('AB2X');
    const initial = first(180);
    const players = roster(initial.state);
    const send = (data: Parameters<typeof encodeControlMessage>[0]) => peer.send('reliable', encodeControlMessage(data));
    send({ type: 'welcome', cpuLevel: 'normal', cpuFill: true, items: true, trackId, laps: 3, slot: 1, roster: players, hostTime: 0 });
    send({ type: 'race_start', cpuLevel: 'normal', cpuFill: true, items: true, trackId, laps: 3, raceId: 1, seed: 431, roster: players, startAtHostTime: 0 });
    peer.send('unreliable', encodeSnapshot(initial.state, 1, network.now));
    network.advance(0);
    const snapshotNow = (value: Snapshot) => peer.send('unreliable', encodeSnapshot(value.state, 1, network.now));
    return { network, host, guest, send, snapshotNow };
  }

  it.each([
    ['together: event and snapshot, tick, frame', 'together'],
    ['event first: event, frame, snapshot, tick, frame', 'event-first'],
    ['snapshot first: snapshot, tick, frame, event, frame', 'snapshot-first'],
  ] as const)('reports a host-only short summit ridge respawn exactly when the kart moves (%s)', async (_name, order) => {
    const summitTrack = getTrack('summit');
    const band = summitTrack.def.surfaces.find(zone => zone.kind === 'fall')!;
    // Predicted: centred on the ridge 4 m past the respawn point, so the prediction never falls.
    const h = await guestOn('summit', tick => placed(tick, 'summit', band.respawnAt! + 4));
    try {
      h.guest.tick(straight);
      expect(h.guest.frame()!.respawned).not.toContain(1);
      const tick = h.guest.predictedState!.tick;
      const at = () => h.guest.frame()!;
      const event = () => { h.send({ type: 'events', raceId: 1, tick, events: [{ type: 'fall', kartId: 1 }] }); h.network.advance(0); };
      // The host's kart slid into the band: its snapshot already shows the respawn, 4+ m back.
      const snapshotThenTick = () => {
        h.snapshotNow(placed(tick, 'summit', band.respawnAt!, { speed: 0, spinTime: 1.5 }));
        h.network.advance(TICK_MS);
        h.guest.tick(straight); // Reconciles onto the respawn, then advances a tick.
      };
      const point = sampleTrack(summitTrack, band.respawnAt!);
      const before = h.guest.predictedState!.karts[1]!;
      let cut: ReturnType<typeof at>;
      if (order === 'together') {
        h.send({ type: 'events', raceId: 1, tick, events: [{ type: 'fall', kartId: 1 }] });
        snapshotThenTick();
        cut = at();
      } else if (order === 'event-first') {
        event();
        // The kart has not moved yet: no cut may be spent on the old predicted position.
        const early = at();
        expect(early.respawned).not.toContain(1);
        expect(Math.hypot(before.x - point.x, before.z - point.z)).toBeGreaterThan(3.5);
        snapshotThenTick();
        cut = at();
      } else {
        snapshotThenTick();
        at(); // The reconcile moved the kart before the host's event arrived.
        event();
        cut = at();
      }
      expect(cut.respawned).toContain(1);
      const kart = cut.state.karts.find(entry => entry.id === 1)!;
      expect(Math.hypot(kart.x - point.x, kart.z - point.z)).toBeLessThan(0.5);
      expect(h.guest.visualOffset).toEqual({ x: 0, y: 0, z: 0 });
      expect(cut.previous.karts[1]).toEqual({ x: kart.x, y: kart.y, z: kart.z, heading: kart.heading });
      expect(at().respawned).not.toContain(1); // Consumed exactly once.
    } finally {
      h.host.close();
    }
  });

  it('reports a pending host fall once after a re-anchor (> 40 ticks) onto post-fall snapshots, then nothing', async () => {
    const summitTrack = getTrack('summit');
    const band = summitTrack.def.surfaces.find(zone => zone.kind === 'fall')!;
    const h = await guestOn('summit', tick => placed(tick, 'summit', band.respawnAt! + 4));
    try {
      h.guest.tick(straight);
      expect(h.guest.frame()!.respawned).not.toContain(1);
      const tick = h.guest.predictedState!.tick;
      // The fall's event arrives, then the link stalls: no snapshot yet, so the cut stays pending.
      h.send({ type: 'events', raceId: 1, tick, events: [{ type: 'fall', kartId: 1 }] });
      h.network.advance(0);
      expect(h.guest.frame()!.respawned).not.toContain(1);
      // The backlog lands at once, all after the respawn and the newest 60 ticks on: a re-anchor.
      for (const later of [3, 6, 30, 45, 60]) {
        h.snapshotNow(placed(tick + later, 'summit', band.respawnAt! + later * 0.05, { speed: 3, spinTime: 1.5 }));
      }
      // Render after the backlog: frame() itself reconciles, re-anchors (dropping the input tick) and
      // shows the local kart from an interpolation pair that is entirely post-fall.
      h.network.advance(300);
      const cut = h.guest.frame()!;
      expect(h.guest.predictedState!.tick).toBe(tick + 60);
      expect(cut.respawned).toEqual([1]);
      const kart = cut.state.karts.find(entry => entry.id === 1)!;
      expect(Math.hypot(kart.x - sampleTrack(summitTrack, band.respawnAt!).x, kart.z - sampleTrack(summitTrack, band.respawnAt!).z))
        .toBeLessThan(4);
      expect(h.guest.frame()!.respawned).toEqual([]);
    } finally {
      h.host.close();
    }
  });

  it('a re-anchor without any fall is not a cut (legacy multiplayer behaviour)', async () => {
    const h = await guestOn('meadow', tick => placed(tick, 'meadow', 100));
    try {
      h.guest.tick(straight);
      h.guest.frame();
      const tick = h.guest.predictedState!.tick;
      for (const later of [3, 30, 60]) h.snapshotNow(placed(tick + later, 'meadow', 100 + later * 0.5));
      h.network.advance(300);
      expect(h.guest.frame()!.respawned).toEqual([]);
      expect(h.guest.predictedState!.tick).toBe(tick + 60);
    } finally {
      h.host.close();
    }
  });

  it('reports a fall found in a reconcile replay: tick N, snapshot, tick N+1 (replay falls), frame', async () => {
    const h = await guestOn('chasm', tick => placed(tick, 'chasm', ravine.from - 6));
    try {
      h.guest.tick(straight);
      expect(h.guest.frame()!.respawned).not.toContain(1);
      const tick = h.guest.predictedState!.tick;
      // The host has the kart 5 m further on, right at the lip: the replay to N+1 drops it in.
      h.snapshotNow(placed(tick - 1, 'chasm', ravine.from - 0.2));
      h.network.advance(TICK_MS);
      h.guest.tick(straight);
      const cut = h.guest.frame()!;
      expect(cut.respawned).toContain(1);
      expect(cut.state.karts.find(entry => entry.id === 1)!.trackDistance).toBeCloseTo(ravine.respawnAt!, 0);
      expect(h.guest.visualOffset).toEqual({ x: 0, y: 0, z: 0 });
      expect(h.guest.frame()!.respawned).not.toContain(1);
    } finally {
      h.host.close();
    }
  });
});

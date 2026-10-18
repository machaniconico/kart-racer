import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAIInput } from './ai';
import { validateTrackDef } from './corridor';
import { slopeCourse } from './elevation.fixture';
import { getRank, raceProgress } from './laps';
import { createRace, FIXED_DT, NEUTRAL_INPUT, stepRace } from './race';
import { insideZone } from './surfaces';
import { buildTrack, sampleTrack, surfaceHeightAt } from './track';
import * as tracks from './tracks';
import type { KartState, Track, TrackDef } from './types';

afterEach(() => vi.restoreAllMocks());
const throttle = { ...NEUTRAL_INPUT, throttle: 1 };
const fall = { kind: 'fall' as const, from: 100, to: 120, offsetMin: 7.2, offsetMax: 10.5, respawnAt: 80 };
function course(extra: Partial<TrackDef> = {}): Track {
  return buildTrack({ ...slopeCourse(0), physics: {}, roadHalfWidth: 7.2, wallHalfWidth: 10.5,
    surfaces: [fall], ...extra });
}
function place(track: Track, kart: KartState, distance: number, offset = 0): void {
  const sample = sampleTrack(track, distance);
  Object.assign(kart, { x: sample.x + sample.nx * offset, z: sample.z + sample.nz * offset,
    y: surfaceHeightAt(track, distance, offset), heading: Math.atan2(sample.tx, sample.tz),
    trackDistance: distance, lateralOffset: offset });
}
function race(track: Track, distance = 110, offset = 8) {
  vi.spyOn(tracks, 'getTrack').mockReturnValue(track);
  const state = createRace(1, { karts: 1, itemBoxes: false });
  state.phase = 'racing';
  const kart = state.karts[0]!;
  place(track, kart, distance, offset);
  return { state, kart };
}

describe('grounded fall and respawn', () => {
  it('sets the centreline pose directly and clears motion state with one fall event', () => {
    const track = course();
    validateTrackDef(track.def);
    const { state, kart } = race(track);
    const keys = Object.keys(kart);
    Object.assign(kart, { speed: 12, steer: 0.7, spinTime: 0.3, boostTime: 1, driftTime: 0.7,
      driftDirection: 1, previousDrift: true, hopTime: 0.3, lastBand: 4, hitCooldown: 0.6 });
    stepRace(state, [{ ...throttle, drift: true }]);
    const sample = sampleTrack(track, 80);
    expect(kart).toMatchObject({ x: sample.x, y: sample.y, z: sample.z,
      heading: Math.atan2(sample.tx, sample.tz), trackDistance: 80, lateralOffset: 0,
      speed: 0, spinTime: 1.5, steer: 0, boostTime: 0, driftTime: 0, driftDirection: 0,
      previousDrift: false, hopTime: 0, airTime: 0, lastBand: -1, hitCooldown: 0 });
    expect(state.events).toEqual([{ type: 'fall', kartId: 0 }]);
    expect(Object.keys(kart)).toEqual(keys);
    stepRace(state, [throttle]);
    expect(state.events).toEqual([]);
    expect(kart.speed).toBe(0);
  });

  it('catches sideways entry without crossing the longitudinal start', () => {
    const track = course();
    const { state, kart } = race(track, 110, 7.19);
    kart.heading = Math.PI;
    kart.speed = 10;
    stepRace(state, [NEUTRAL_INPUT]);
    expect(state.events).toEqual([{ type: 'fall', kartId: 0 }]);
    expect(kart.trackDistance).toBe(80);
  });

  it('catches the landing tick but leaves airborne crossings alone', () => {
    const track = course({ surfaces: [{ ...fall, to: 114 }] });
    const { state, kart } = race(track);
    kart.airTime = 0.4;
    kart.speed = 30;
    for (let tick = 0; tick < 25; tick++) {
      stepRace(state, [NEUTRAL_INPUT]);
      expect(state.events.filter(event => event.type === 'fall')).toEqual([]);
    }
    expect(kart.trackDistance).toBeGreaterThan(114);
    place(track, kart, 110, 8);
    kart.airTime = FIXED_DT;
    stepRace(state, [NEUTRAL_INPUT]);
    expect(state.events).toEqual([{ type: 'fall', kartId: 0 }]);
    expect(kart.airTime).toBe(0);
  });

  it('ignores fall without physics and after the finish', () => {
    for (const finished of [false, true]) {
      const track = course({ physics: finished ? {} : undefined });
      const { state, kart } = race(track);
      if (finished) kart.finishTime = 1;
      stepRace(state, [NEUTRAL_INPUT]);
      expect(state.events.filter(event => event.type === 'fall')).toEqual([]);
      expect(kart.trackDistance).toBeGreaterThanOrEqual(110);
      expect(kart.trackDistance).toBeLessThan(111);
    }
  });

  it.each([true, false])('preserves lapValid=%s and debits rewound distance and rank', lapValid => {
    const track = course();
    const { state, kart } = race(track);
    Object.assign(kart, { startedLap: true, lapProgress: 110, nextCheckpoint: 1, lap: 1, lapValid, speed: 10 });
    state.karts.push({ ...structuredClone(kart), id: 1, lapProgress: 95 });
    state.karts[1]!.speed = 0;
    place(track, state.karts[1]!, 95);
    expect(getRank(state, 0)).toBe(1);
    stepRace(state, [NEUTRAL_INPUT, NEUTRAL_INPUT]);
    expect(kart).toMatchObject({ lapValid, lap: 1, lapProgress: 80, nextCheckpoint: 1, finishTime: null });
    expect(raceProgress(track, kart)).toBe(track.length + 80);
    expect(getRank(state, 0)).toBe(2);
  });

  it('credits signed respawn distance without crossing a gate, using the nearest lap copy', () => {
    const track = course({ surfaces: [{ ...fall, respawnAt: 130 }] });
    validateTrackDef(track.def);
    const { state, kart } = race(track);
    Object.assign(kart, { startedLap: true, lapProgress: 110, nextCheckpoint: 1 });
    stepRace(state, [NEUTRAL_INPUT]);
    expect(kart).toMatchObject({ trackDistance: 130, lapProgress: 130, lap: 0, nextCheckpoint: 1, lapValid: true });
    // Defensive sim check for a malformed seam zone: use the closest copy, without earning a lap.
    const seam = course({ surfaces: [{ ...fall, from: track.length - 10, to: 5, respawnAt: 2 }] });
    const second = race(seam, seam.length - 5, 8);
    Object.assign(second.kart, { startedLap: true, lapProgress: seam.length - 5, nextCheckpoint: 0 });
    stepRace(second.state, [NEUTRAL_INPUT]);
    expect(second.kart.trackDistance).toBeCloseTo(seam.length + 2, 10);
    expect(second.kart.lap).toBe(0);
    expect(second.kart.lapProgress).toBeCloseTo(seam.length + 2, 10);
    const rewind = course({ surfaces: [{ ...fall, from: 1, to: 5, respawnAt: track.length - 2 }] });
    const third = race(rewind, 3, 8);
    Object.assign(third.kart, { startedLap: true, lapProgress: 3 });
    stepRace(third.state, [NEUTRAL_INPUT]);
    expect(third.kart.trackDistance).toBeCloseTo(-2, 10);
    expect(third.kart.lapProgress).toBeCloseTo(-2, 10);
  });

  it.each([-0.25, 0.25])('tracks the same phased gates as respawn validation (%s)', checkpointPhase => {
    for (const physics of [undefined, {}]) {
      const track = course({ checkpointPhase, physics, surfaces: [] });
      validateTrackDef(track.def);
      expect(track.checkpointDistances).toEqual(Array.from({ length: track.def.checkpointCount }, (_, i) =>
        (i === 0 || physics === undefined ? i : i + checkpointPhase) * track.length / track.def.checkpointCount));
      const gate = (1 + checkpointPhase) * track.length / track.def.checkpointCount;
      const { state, kart } = race(track, gate - 0.1, 0);
      Object.assign(kart, { startedLap: true, nextCheckpoint: 1, lapProgress: gate - 0.1, speed: 20 });
      stepRace(state, [throttle]);
      expect(kart.nextCheckpoint).toBe(physics === undefined ? 1 : 2);
      expect(kart.lapValid).toBe(true);
    }
  });

  it.each([80, 160])('finishes in exactly three start crossings after respawning at %s', respawnAt => {
    const track = course({ surfaces: [{ ...fall, respawnAt }] });
    validateTrackDef(track.def);
    const { state, kart } = race(track, 40, 0);
    Object.assign(kart, { startedLap: true, lapProgress: 40, nextCheckpoint: 1 });
    let injected = false;
    const laps: number[] = [];
    let startCrossings = 0;
    let falls = 0;
    let finishes = 0;
    for (let tick = 0; tick < 12000 && state.phase !== 'finished'; tick++) {
      if (!injected && kart.trackDistance >= 105 && kart.trackDistance < 110) {
        place(track, kart, kart.trackDistance, 8);
        injected = true;
      }
      const previousDistance = kart.trackDistance;
      stepRace(state, [getAIInput(state, 0)]);
      if (previousDistance - kart.trackDistance > track.length / 2) startCrossings++;
      expect(kart.lapValid).toBe(true);
      for (const event of state.events) {
        if (event.type === 'fall') falls++;
        if (event.type === 'lap') laps.push(event.value!);
        if (event.type === 'finish') finishes++;
      }
    }
    expect(falls).toBe(1);
    expect(laps).toEqual([1, 2, 3]);
    expect(startCrossings).toBe(3);
    expect(finishes).toBe(1);
    expect(state.phase).toBe('finished');
    expect(kart.lap).toBe(3);
  });

  it.each(['ample', 'minimum'] as const)('clears the next valley from a respawn with %s runway and no boost', runway => {
    const minimumRunway = (42 / 1.8) ** 2 / (2 * 19.9) * 1.3;
    const respawnAt = runway === 'minimum' ? 150 - minimumRunway : 80;
    const validated = course({ surfaces: [{ ...fall, respawnAt },
      { kind: 'jump', from: 150, to: 152, duration: 1.8, height: 6 },
      { ...fall, from: 158, to: 192, respawnAt: 200 },
    ] });
    validateTrackDef(validated.def);
    if (runway === 'minimum') {
      expect(() => validateTrackDef({ ...validated.def, surfaces: [
        { ...fall, respawnAt: respawnAt + 0.001 }, ...validated.def.surfaces.slice(1),
      ] })).toThrow(/runway/);
    }
    // Full-width synthetic gap isolates the sim's flight/landing contract from shoulder geometry.
    const track = course({ surfaces: [...validated.def.surfaces.slice(0, 2),
      { kind: 'fall', from: 158, to: 192, respawnAt: 200 },
    ] });
    const { state, kart } = race(track);
    kart.human = false;
    state.cpuLevel = 'easy';
    stepRace(state, [throttle]);
    expect(kart.trackDistance).toBe(respawnAt);
    expect(kart.speed).toBe(0);
    let crossedAirborne = false;
    let landed = false;
    for (let tick = 0; tick < 600; tick++) {
      stepRace(state, [throttle]);
      expect(kart.boostTime).toBe(0);
      expect(state.events.filter(event => event.type === 'fall')).toEqual([]);
      if (insideZone(track, 'fall', kart.trackDistance, 0)) {
        crossedAirborne = true;
        expect(kart.airTime).toBeGreaterThan(0);
      }
      if (crossedAirborne && kart.airTime === 0) { landed = true; break; }
    }
    expect(crossedAirborne).toBe(true);
    expect(landed).toBe(true);
    expect(kart.trackDistance).toBeGreaterThan(192);
  });
});

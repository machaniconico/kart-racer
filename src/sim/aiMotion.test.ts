import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAIInput } from './ai';
import { validateTrackDef } from './corridor';
import { slopeCourse } from './elevation.fixture';
import { getAiLineOffset } from './itemAi';
import { createRace, stepRace } from './race';
import * as race from './race';
import { racingLineOffset } from './surfaces';
import { buildTrack, sampleTrack } from './track';
import * as tracks from './tracks';
import { LEGACY_MEADOW } from './tracks/legacyMeadow.fixture';
import { measureCpuLaps } from './tracks/shapeMetrics';
import { CPU_LEVELS } from './types';
import type { Barrier, RaceState, Track, TrackDef } from './types';

// One sweep band and one gate band on the first straight, with distance ranges that do not overlap.
const SWEEP: Barrier = { from: 60, to: 100, center: 0, halfWidth: 1.2, taper: 4,
  motion: { kind: 'sweep', amplitude: 4.0, period: 6, phase: 0 } };
const GATE: Barrier = { from: 180, to: 210, center: 0, halfWidth: 3.6, taper: 8,
  motion: { kind: 'gate', amplitude: 0, period: 5, phase: 0, minWidth: 1.2 } };
const GATE_APPROACH = 30;

function motionDef(): TrackDef {
  return {
    ...LEGACY_MEADOW, scale: 1, checkpointCount: 2,
    controlPoints: [
      [-150, 3, 0], [-100, 3, 0], [-50, 3, 0], [0, 3, 0],
      [50, 3, 0], [100, 3, 0], [150, 3, 0], [150, 3, 100], [-150, 3, 100],
    ],
    // Keep the extra rows clear of the sweep and gate; runRace removes all items.
    boxRows: [0.02, 0.12, 0.30, 0.36, 0.47, 0.58, 0.695, 0.81],
    surfaces: [], barriers: [SWEEP, GATE],
    // The line passes outside every exclusion at all motion phases (sweep reaches ±6.15, gate ±4.55).
    racingLine: [
      { distance: 50, offset: 7.5 }, { distance: 110, offset: 7.5 },
      { distance: 170, offset: 6 }, { distance: 220, offset: 6 },
    ],
  };
}

interface RunResult { readonly state: RaceState; readonly bandHits: number; readonly slowTicks: string[] }

function runRace(track: Track, seed: number): RunResult {
  vi.spyOn(tracks, 'getTrack').mockReturnValue(track);
  const state = createRace(seed, { racers: [] });
  // buildTrack requires eight box rows, so the story's `boxRows: []` is realised by removing the boxes:
  // without items no spin can stand in for a band hit.
  state.boxes = [];
  let bandHits = 0;
  const slowTicks: string[] = [];
  for (let tick = 0; tick < 60 * 240 && state.phase !== 'finished'; tick++) {
    stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
    bandHits += state.events.filter(event => event.type === 'hit' && event.value === 1).length;
    if (state.phase !== 'racing') continue;
    for (const kart of state.karts) {
      if (kart.finishTime !== null || kart.spinTime > 0) continue;
      const toGate = GATE.from - kart.trackDistance;
      if (toGate > 0 && toGate <= GATE_APPROACH && kart.speed < 8) {
        slowTicks.push(`kart ${kart.id} tick ${state.racingTicks} d ${kart.trackDistance.toFixed(1)} v ${kart.speed.toFixed(2)}`);
      }
    }
  }
  return { state, bandHits, slowTicks };
}

const digest = (state: RaceState): string => createHash('sha256').update(JSON.stringify(state)).digest('hex');

afterEach(() => vi.restoreAllMocks());

describe('CPU arrival-time avoidance on moving bands', () => {
  const def = motionDef();
  it('builds a valid synthetic sweep + gate course', () => {
    expect(() => validateTrackDef(def)).not.toThrow();
  });

  it.each([1, 42, 98765])('seed %i: 8 CPUs finish 3 laps, ≤ 4 band hits, never stall before the gate', (seed) => {
    const track = buildTrack(def);
    const first = runRace(track, seed);
    expect(first.state.phase).toBe('finished');
    expect(first.state.karts).toHaveLength(8);
    expect(first.state.karts.every(kart => kart.lap === 3 && kart.finishTime !== null)).toBe(true);
    expect(first.bandHits).toBeLessThanOrEqual(4);
    expect(first.slowTicks).toEqual([]);
    const second = runRace(track, seed);
    expect(digest(second.state)).toBe(digest(first.state));
  }, 60_000);
});

function jumpCourse(gate: 'duration' | 'fall' | 'legacy'): TrackDef {
  return {
    ...slopeCourse(0), physics: {},
    racingLine: [{ distance: 0, offset: 2 }, { distance: 300, offset: 2 },
      { distance: 450, offset: -2 }, { distance: 750, offset: -2 }],
    surfaces: [
      { kind: 'jump', from: 150, to: 152, ...(gate === 'duration' ? { duration: 1.4, height: 4 } : {}) },
      { kind: 'jump', from: 600, to: 602, ...(gate === 'duration' ? { duration: 1.8, height: 6 } : {}) },
      ...(gate === 'fall' ? [{ kind: 'fall' as const, from: 160, to: 170,
        offsetMin: 9.36, offsetMax: 13.65, respawnAt: 180 }] : []),
    ],
  };
}

describe('gated CPU jump alignment', () => {
  it.each(['duration', 'fall'] as const)('%s gate: every launch stays within 1 m for all seeds and levels', gate => {
    const def = jumpCourse(gate);
    validateTrackDef(def);
    const track = buildTrack(def);
    vi.spyOn(tracks, 'getTrack').mockReturnValue(track);
    for (const cpuLevel of CPU_LEVELS) for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { racers: [], cpuLevel, itemBoxes: false });
      let launches = 0;
      let maxError = 0;
      let falls = 0;
      for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
        const grounded = state.karts.map(kart => kart.airTime === 0 && kart.finishTime === null);
        stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
        falls += state.events.filter(event => event.type === 'fall').length;
        for (const kart of state.karts) if (grounded[kart.id] && kart.airTime > 0) {
          launches++;
          maxError = Math.max(maxError, Math.abs(kart.lateralOffset - racingLineOffset(track, kart.trackDistance)));
        }
      }
      expect(state.karts.every(kart => kart.lap === 3 && kart.finishTime !== null)).toBe(true);
      expect(launches, `${gate} ${cpuLevel} seed ${seed}`).toBe(48);
      expect(maxError, `${gate} ${cpuLevel} seed ${seed}`).toBeLessThanOrEqual(1);
      expect(falls, `${gate} ${cpuLevel} seed ${seed}`).toBe(0);
    }
  }, 60_000);

  it('does not opt a legacy jump into alignment merely because physics or height is present', () => {
    const def = jumpCourse('legacy');
    const legacy = buildTrack({ ...def, physics: undefined });
    const physicsOnly = buildTrack({ ...def, surfaces: def.surfaces.map(zone => ({ ...zone, height: 4 })) });
    const getTrack = vi.spyOn(tracks, 'getTrack').mockReturnValue(legacy);
    const state = createRace(42, { racers: [] });
    const kart = state.karts[0]!;
    const at = sampleTrack(legacy, 110);
    Object.assign(kart, { x: at.x, y: at.y, z: at.z, trackDistance: 110, lateralOffset: 0,
      heading: Math.atan2(at.tx, at.tz), speed: 30 });
    const input = getAIInput(state, kart.id);
    getTrack.mockReturnValue(physicsOnly);
    expect(getAIInput(state, kart.id)).toEqual(input);
    for (const gate of ['duration', 'fall'] as const) {
      getTrack.mockReturnValue(buildTrack({ ...jumpCourse(gate), physics: undefined }));
      expect(getAIInput(state, kart.id), `${gate} without physics`).toEqual(input);
    }
    getTrack.mockReturnValue(buildTrack(jumpCourse('duration')));
    expect(getAIInput(state, kart.id).steer).not.toBe(input.steer);
  });

  it.each([-6, 6])('settles from offset %i and an active drift across the lap seam', offset => {
    const base = slopeCourse(0);
    // Put the seam in the middle of the straight, with takeoff 10 m into the next lap.
    const def: TrackDef = { ...base, physics: {},
      controlPoints: [...base.controlPoints.slice(20), ...base.controlPoints.slice(0, 20)],
      racingLine: [{ distance: 0, offset: 2 }],
      surfaces: [{ kind: 'jump', from: 10, to: 12, duration: 1.6, height: 5 }] };
    validateTrackDef(def);
    const track = buildTrack(def);
    vi.spyOn(tracks, 'getTrack').mockReturnValue(track);
    for (const speed of [20, 36, 60]) {
      const state = createRace(42, { racers: [], karts: 1, itemBoxes: false });
      state.phase = 'racing';
      const kart = state.karts[0]!;
      const distance = track.length + 10 - Math.max(60, speed * 2);
      const at = sampleTrack(track, distance);
      Object.assign(kart, { x: at.x + at.nx * offset, y: at.y, z: at.z + at.nz * offset,
        trackDistance: distance, lateralOffset: offset, heading: Math.atan2(at.tx, at.tz), speed,
        driftDirection: Math.sign(offset), driftTime: 1, previousDrift: true,
        // Keep legacy weave near its maximum at takeoff so this catches the HEAD AI.
        aiPhase: Math.PI / 2 });
      const before = digest(state);
      expect(getAIInput(state, kart.id).drift).toBe(false);
      expect(digest(state)).toBe(before);
      for (let tick = 0; tick < 600 && kart.airTime === 0; tick++) {
        stepRace(state, [getAIInput(state, kart.id)]);
      }
      expect(kart.airTime, `speed ${speed}`).toBe(1.6);
      expect(Math.abs(kart.lateralOffset - racingLineOffset(track, kart.trackDistance)), `speed ${speed}`)
        .toBeLessThanOrEqual(1);
    }
  });

  it.each(['barrier', 'split'] as const)('uses the weave-free %s target at the requested distance', kind => {
    const def: TrackDef = { ...slopeCourse(0), physics: {},
      surfaces: [{ kind: 'jump', from: 160, to: 162, duration: 1.4 }],
      barriers: [{ from: 120.95, to: 179.05, center: 0, halfWidth: 1.2, taper: 4 }],
      ...(kind === 'split' ? { splits: [{ from: 120, to: 180, lanes: [
        { offsetMin: -9, offsetMax: -3, risk: 0 }, { offsetMin: 3, offsetMax: 9, risk: 1 },
      ] }] } : {}),
    };
    validateTrackDef(def);
    const track = buildTrack(def);
    vi.spyOn(tracks, 'getTrack').mockReturnValue(track);
    const state = createRace(1, { racers: [], karts: 1, itemBoxes: false });
    const kart = state.karts[0]!;
    const at = sampleTrack(track, 140);
    const offset = kind === 'split' ? -5 : 5;
    Object.assign(kart, { x: at.x + at.nx * offset, y: at.y, z: at.z + at.nz * offset,
      trackDistance: 140, lateralOffset: offset, heading: Math.atan2(at.tx, at.tz), speed: 30, aiPhase: 0 });
    const before = digest(state);
    // Barrier clearance = halfWidth + kart radius + steering margin; split chooses the risky right lane.
    const expectedOffset = kind === 'split' ? 6 : 1.2 + 0.95 + 0.95 + 0.6;
    expect(getAiLineOffset(state, kart, { weave: false, distance: 150 })).toBeCloseTo(expectedOffset, 12);
    if (kind === 'barrier') expect(getAiLineOffset(state, kart, { weave: false, distance: 200 })).toBe(0);
    const target = sampleTrack(track, 140 + 7.5 + 30 * 0.24);
    const desired = Math.atan2(target.x + target.nx * expectedOffset - kart.x,
      target.z + target.nz * expectedOffset - kart.z);
    const error = Math.atan2(Math.sin(desired - kart.heading), Math.cos(desired - kart.heading));
    expect(getAIInput(state, kart.id).steer).toBeCloseTo(Math.max(-1, Math.min(1, error * 2.3)), 12);
    expect(digest(state)).toBe(before);
  });

  it.each([-1, 1])('enters a bounded jump even when the racing line is outside its lane (side %i)', side => {
    const def: TrackDef = { ...slopeCourse(0), physics: {}, racingLine: [{ distance: 0, offset: -6 * side }],
      surfaces: [{ kind: 'jump', from: 150, to: 152, duration: 1.4,
        offsetMin: side > 0 ? 2 : -4, offsetMax: side > 0 ? 4 : -2 }] };
    validateTrackDef(def);
    const track = buildTrack(def);
    vi.spyOn(tracks, 'getTrack').mockReturnValue(track);
    const state = createRace(1, { racers: [], karts: 1, itemBoxes: false });
    state.phase = 'racing';
    const kart = state.karts[0]!;
    const at = sampleTrack(track, 80);
    Object.assign(kart, { x: at.x, y: at.y, z: at.z, trackDistance: 80, lateralOffset: 0,
      heading: Math.atan2(at.tx, at.tz), speed: 30 });
    for (let tick = 0; tick < 300 && kart.trackDistance < 155 && kart.airTime === 0; tick++) {
      stepRace(state, [getAIInput(state, kart.id)]);
    }
    expect(kart.airTime).toBe(1.4);
    expect(kart.lateralOffset).toBeGreaterThanOrEqual(def.surfaces[0]!.offsetMin!);
    expect(kart.lateralOffset).toBeLessThanOrEqual(def.surfaces[0]!.offsetMax!);
    expect(Math.abs(kart.lateralOffset - 2 * side)).toBeLessThanOrEqual(1);
  });
});

describe('CPU lap fall measurement', () => {
  it('requires an explicit fall budget for any course containing falls', () => {
    vi.spyOn(tracks, 'getTrack').mockReturnValue(buildTrack(jumpCourse('fall')));
    expect(() => measureCpuLaps('meadow')).toThrow(/fallBudget/);
    expect(() => measureCpuLaps('meadow', { maxTicks: 1, fallBudget: 0 })).not.toThrow();
  });

  it('includes the total band hits in passed, with an overridable legacy maximum', () => {
    vi.spyOn(race, 'stepRace').mockImplementation(state => {
      state.phase = 'finished';
      for (const kart of state.karts) Object.assign(kart, { lap: 3, lapTimes: [1, 1, 1], finishTime: 3 });
      state.events = [{ type: 'hit', kartId: 0, value: 1 }];
    });
    const options = { seeds: [1, 42], cpuLevels: ['normal'] as const };
    const [overBudget] = measureCpuLaps('meadow', options);
    expect(overBudget!.runs.every(run => run.finished && run.bandHits === 1)).toBe(true);
    expect(overBudget!.bandHits).toBe(2);
    expect(overBudget!.wallHits).toBe(0);
    expect(overBudget!.falls).toBe(0);
    expect(overBudget!.passed).toBe(false);
    expect(measureCpuLaps('meadow', { ...options, bandHitBudget: 2 })[0]!.passed).toBe(true);
    expect(measureCpuLaps('meadow', { ...options, seeds: [1] })[0]!.passed).toBe(true);
    expect(measureCpuLaps('meadow', { ...options, seeds: [1], bandHitBudget: 0 })[0]!.passed).toBe(false);
  });

  it('counts real falls per seed and checks the mean budget independently at each difficulty', () => {
    // An unavoidable full-width synthetic gap isolates counting from shoulder avoidance (as in fall.test.ts).
    const def: TrackDef = { ...slopeCourse(0), physics: {},
      surfaces: [{ kind: 'fall', from: 150, to: 160, respawnAt: 170 }] };
    vi.spyOn(tracks, 'getTrack').mockReturnValue(buildTrack(def));
    const results = measureCpuLaps('meadow', { fallBudget: 24 });
    expect(results.map(result => result.cpuLevel)).toEqual(CPU_LEVELS);
    for (const result of results) {
      expect(result.runs.map(run => run.seed)).toEqual([1, 42, 98765]);
      expect(result.runs.every(run => run.finished && run.falls === 24)).toBe(true);
      expect(result.falls).toBe(72);
      expect(result.meanFalls).toBe(24);
      expect(result.wallHits).toBe(0);
      expect(result.passed).toBe(true);
    }
    const [overBudget] = measureCpuLaps('meadow', { seeds: [1], cpuLevels: ['normal'], fallBudget: 23 });
    expect(overBudget!.runs[0]!.finished).toBe(true);
    expect(overBudget!.meanFalls).toBe(24);
    expect(overBudget!.passed).toBe(false);
  }, 60_000);

  it('fails incomplete runs at the tick ceiling even if the fall budget passes', () => {
    const [result] = measureCpuLaps('meadow', { seeds: [1], cpuLevels: ['normal'], maxTicks: 180, fallBudget: 0 });
    expect(result!.runs[0]!.state.tick).toBe(180);
    expect(result!.runs[0]!.finished).toBe(false);
    expect(result!.falls).toBe(0);
    expect(result!.passed).toBe(false);
  });
});

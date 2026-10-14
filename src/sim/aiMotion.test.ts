import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAIInput } from './ai';
import { validateTrackDef } from './corridor';
import { createRace, stepRace } from './race';
import { buildTrack } from './track';
import * as tracks from './tracks';
import type { Barrier, RaceState, Track, TrackDef } from './types';

// One sweep band and one gate band on the first straight, with distance ranges that do not overlap.
const SWEEP: Barrier = { from: 60, to: 100, center: 0, halfWidth: 1.2, taper: 4,
  motion: { kind: 'sweep', amplitude: 4.0, period: 6, phase: 0 } };
const GATE: Barrier = { from: 180, to: 210, center: 0, halfWidth: 3.6, taper: 8,
  motion: { kind: 'gate', amplitude: 0, period: 5, phase: 0, minWidth: 1.2 } };
const GATE_APPROACH = 30;

function motionDef(): TrackDef {
  return {
    ...tracks.TRACKS.meadow, scale: 1, checkpointCount: 2,
    controlPoints: [
      [-150, 3, 0], [-100, 3, 0], [-50, 3, 0], [0, 3, 0],
      [50, 3, 0], [100, 3, 0], [150, 3, 0], [150, 3, 100], [-150, 3, 100],
    ],
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
  // buildTrack requires four box rows, so the story's `boxRows: []` is realised by removing the boxes:
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

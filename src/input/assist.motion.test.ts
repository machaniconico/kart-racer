import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateTrackDef } from '../sim/corridor';
import { DEFAULT_LAPS } from '../sim/laps';
import { createRace, stepRace } from '../sim/race';
import { buildTrack, sampleTrack } from '../sim/track';
import * as tracks from '../sim/tracks';
import type { InputFrame, TrackDef } from '../sim/types';
import { applySteerAssist } from './assist';

// M3-07: the assist on moving bands. The synthetic course of M3-03 (src/sim/aiMotion.test.ts):
// a small oval in the manner of surfaces.test.ts's syntheticTrack. Item
// boxes are removed from the race state (a course needs 24), so no item spins the kart. Three
// checkpoints keep every gate 10 m clear of the band tips. Measured per lap (offsets -3 / 0 / 3):
// bands 0,0,0 and walls 2,1,2 / 2,1,2 / 1,1,2 (assist OFF: bands 1,1,0, walls 2,1,2, in 156 s
// against 85 s); assist.ts needed no change.
afterEach(() => vi.restoreAllMocks());

const input: InputFrame = { steer: 0, throttle: 1, brake: false, drift: false, useItem: false };

// One sweep band and one gate band on the first straight, with distance ranges that do not overlap.
const def: TrackDef = {
  ...tracks.TRACKS.meadow, scale: 1, checkpointCount: 3,
  controlPoints: [
    [-150, 3, 0], [-100, 3, 0], [-50, 3, 0], [0, 3, 0],
    [50, 3, 0], [100, 3, 0], [150, 3, 0], [150, 3, 100], [-150, 3, 100],
  ],
  // Keep the extra rows clear of the sweep and gate before drive removes all items.
  boxRows: [0.02, 0.12, 0.30, 0.36, 0.47, 0.58, 0.695, 0.81],
  surfaces: [], racingLine: [],
  barriers: [
    { from: 60, to: 100, center: 0, halfWidth: 1.2, taper: 4, motion: { kind: 'sweep', amplitude: 4, period: 6, phase: 0 } },
    { from: 180, to: 210, center: 0, halfWidth: 3.6, taper: 8, motion: { kind: 'gate', amplitude: 0, period: 5, phase: 0, minWidth: 1.2 } },
  ],
};

/**
 * One solo kart, no steering, full throttle, for three laps from lateral offset `offset`. Hits per lap,
 * split at the tick kart.lap changes (the run from the grid to the line counts toward lap 1). Wall
 * hits carry no value (race.ts), band hits value 1, pits value 2.
 */
function drive(offset: number, assisted: boolean) {
  validateTrackDef(def);
  const track = buildTrack(def);
  vi.spyOn(tracks, 'getTrack').mockReturnValue(track);
  const state = createRace(1);
  state.phase = 'racing';
  state.karts = [state.karts[0]!];
  state.boxes = [];
  const kart = state.karts[0]!;
  const sample = sampleTrack(track, kart.trackDistance);
  Object.assign(kart, { human: true, x: sample.x + sample.nx * offset, y: sample.y, z: sample.z + sample.nz * offset,
    heading: Math.atan2(sample.tx, sample.tz), lateralOffset: offset });
  const band = Array.from({ length: DEFAULT_LAPS }, () => 0);
  const wall = Array.from({ length: DEFAULT_LAPS }, () => 0);
  while (kart.finishTime === null && state.tick < 60 * 60 * 10) {
    const lap = Math.min(kart.lap, DEFAULT_LAPS - 1);
    stepRace(state, [assisted ? applySteerAssist(state, kart, input, 1) : input]);
    for (const event of state.events) {
      if (event.type !== 'hit') continue;
      if (event.value === 1) band[lap]!++;
      else if ((event.value ?? 0) === 0) wall[lap]!++;
    }
  }
  const hash = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  return { band, wall, finished: kart.finishTime !== null, laps: kart.lap, time: state.time, hash };
}

describe('M3-07 assist on moving bands', () => {
  it.each([-3, 0, 3])('start offset %d: three laps without input, at most 1 band hit and 2 wall hits per lap, deterministic', (offset) => {
    const first = drive(offset, true);
    const second = drive(offset, true);
    const off = drive(offset, false);
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    const report = JSON.stringify({ offset, on: { ...first, hash: undefined }, off: { ...off, hash: undefined } });
    expect(first.finished, report).toBe(true);
    for (const hits of first.band) expect(hits, report).toBeLessThanOrEqual(1);
    for (const hits of first.wall) expect(hits, report).toBeLessThanOrEqual(2);
    // The course must matter: without the assist the kart hits more bands or walls.
    expect(sum(off.band) > sum(first.band) || sum(off.wall) > sum(first.wall), report).toBe(true);
    expect(second.hash).toBe(first.hash);
  });
});

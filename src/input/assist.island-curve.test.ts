import { afterEach, describe, expect, it, vi } from 'vitest';
import { stepRace } from '../sim/race';
import { buildTrack } from '../sim/track';
import { islandSplit } from '../sim/tracks/features';
import type { RaceState } from '../sim/types';
import { applySteerAssist } from './assist';
import { courses, fuzz, input, onStraight, RUNS } from './assist.island.fixtures';

// M2-03 fuzz in its own file so vitest runs it in a parallel worker (helpers: assist.island.fixtures.ts).
afterEach(() => vi.restoreAllMocks());

describe('M2-03 one island on a radius-40 curve', () => {
  it(`never adds band hits over OFF (${RUNS} runs)`, () => {
    const { worse, totals } = fuzz(0x1514d, true, 0, RUNS);
    // M4.5-05 baseline after M4.5-04 (004fe5a), 500 runs: worse 0;
    // ON/OFF bands 48/123, walls 506/561 (combined hits 554/684).
    console.info(`[M4.5-05 curve fuzz] ${JSON.stringify(totals)}`);
    expect(totals.onBand, JSON.stringify(totals)).toBeLessThanOrEqual(48);
    expect(totals.onWall, JSON.stringify(totals)).toBeLessThanOrEqual(506);
    expect(totals).toMatchObject({ offBand: 123, offWall: 561 });
    expect(worse, JSON.stringify(totals)).toEqual([]);
    expect(totals.onBand, JSON.stringify(totals)).toBeLessThan(totals.offBand);
  });
});

// Original curve fuzz i=77 (seed 0x1514d): held island-side steer from the outer lane.
// Pin the geometry so the regression remains covered if the layout generator changes.
it.each([-1, 1])('does not add inward steer before the i=77 island hit, mirrored side %i, including JSON replay', side => {
  const base = courses[1]!.def;
  const track = buildTrack({ ...base,
    controlPoints: base.controlPoints.map(([x, y, z]) => [side * x, y, z]),
    ...islandSplit({ from: 145, to: 207.5925752625335, islandHalf: 5.102952332235873,
      laneWidth: 11.795029012486339, taper: 10.205904664471745, scenery: 'rock', risky: 'inner', bend: 1 }),
  });
  const { state, kart } = onStraight(track, 138.87395473313518, side * -8.250613969219215);
  kart.heading += side * -0.2464152214402033;
  kart.speed = 15.48314824514091;
  const frame = Object.freeze({ ...input, steer: side * 0.3 });
  let restored: RaceState = JSON.parse(JSON.stringify(state));
  let bandHits = 0;
  for (let tick = 0; tick < 100; tick++) {
    const before = JSON.stringify(state);
    const corrected = applySteerAssist(state, kart, frame, 1);
    expect(corrected.steer * side, `tick ${tick}`).toBeLessThanOrEqual(0.3);
    expect({ ...corrected, steer: frame.steer }).toEqual(frame);
    expect(JSON.stringify(state)).toBe(before);
    const replayInput = applySteerAssist(restored, restored.karts[0]!, frame, 1);
    expect(replayInput).toEqual(corrected);
    stepRace(state, [corrected]);
    stepRace(restored, [replayInput]);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(state));
    if (tick % 17 === 0) restored = JSON.parse(JSON.stringify(restored));
    bandHits += state.events.filter(event => event.type === 'hit' && event.value === 1).length;
  }
  expect(kart.trackDistance).toBeGreaterThan(180);
  // Holding this steer hits the island even with assist OFF; assist must not add another hit.
  expect(bandHits).toBe(1);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fuzz, RUNS } from './assist.island.fixtures';

// M2-03 fuzz in its own file so vitest runs it in a parallel worker (helpers: assist.island.fixtures.ts).
afterEach(() => vi.restoreAllMocks());

describe('M2-03 island and two pillars', () => {
  it(`never adds band hits over OFF (${RUNS} runs)`, () => {
    const { worse, totals } = fuzz(0x1514f, null, 2, RUNS);
    // M4.5-05 baseline after M4.5-04 (004fe5a), 500 runs: worse 1 (i=153);
    // ON/OFF bands 105/193, walls 475/510 (combined hits 580/703).
    console.info(`[M4.5-05 dense fuzz] ${JSON.stringify(totals)}`);
    expect(totals.onBand, JSON.stringify(totals)).toBeLessThanOrEqual(105);
    expect(totals.onWall, JSON.stringify(totals)).toBeLessThanOrEqual(475);
    expect(totals).toMatchObject({ offBand: 193, offWall: 510 });
    expect(worse, JSON.stringify(totals)).toEqual([]);
    expect(totals.onBand, JSON.stringify(totals)).toBeLessThan(totals.offBand);
  });
});

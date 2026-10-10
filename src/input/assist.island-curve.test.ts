import { afterEach, describe, expect, it, vi } from 'vitest';
import { fuzz, RUNS } from './assist.island.fixtures';

// M2-03 fuzz in its own file so vitest runs it in a parallel worker (helpers: assist.island.fixtures.ts).
afterEach(() => vi.restoreAllMocks());

describe('M2-03 one island on a radius-40 curve', () => {
  it(`never adds band hits over OFF (${RUNS} runs)`, () => {
    const { worse, totals } = fuzz(0x1514d, true, 0, RUNS);
    expect(worse, JSON.stringify(totals)).toEqual([]);
    expect(totals.onBand, JSON.stringify(totals)).toBeLessThan(totals.offBand);
  });
});

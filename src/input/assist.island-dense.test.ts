import { afterEach, describe, expect, it, vi } from 'vitest';
import { fuzz, RUNS } from './assist.island.fixtures';

// M2-03 fuzz in its own file so vitest runs it in a parallel worker (helpers: assist.island.fixtures.ts).
afterEach(() => vi.restoreAllMocks());

describe('M2-03 island and two pillars', () => {
  it(`adds band hits over OFF in at most 3 % of layouts (${RUNS} runs)`, () => {
    const { worse, totals } = fuzz(0x1514f, null, 2, RUNS);
    expect(worse.length, [JSON.stringify(totals), ...worse].join('\n')).toBeLessThanOrEqual(Math.floor(RUNS * 0.03));
    expect(totals.onBand, JSON.stringify(totals)).toBeLessThan(totals.offBand);
  });
});

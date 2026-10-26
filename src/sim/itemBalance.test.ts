import { describe, expect, it } from 'vitest';
import { ITEM_ORDER, MEASURE_SEEDS, measureCpuCourse, measureEffectDurations, summarizeItems } from './measure.test';
import type { ItemRun } from './measure.test';
import type { ItemType } from './itemTypes';
import { TRACK_IDS } from './tracks';

describe('M12 item balance (C3 thresholds, M12-23)', () => {
  it('keeps five observations from 20 courses, three seeds and eight CPUs over three laps within the C3 targets', () => {
    const runs: ItemRun[] = [];
    for (const trackId of TRACK_IDS) {
      const course = measureCpuCourse(trackId);
      expect(course.runs.map(run => run.seed)).toEqual([...MEASURE_SEEDS]);
      for (const run of course.runs) {
        expect(run.drawsByRank).toHaveLength(8);
        expect(run.drawsByRank.every(row => row.length === ITEM_ORDER.length)).toBe(true);
        expect(run.hitsByRank).toHaveLength(8);
        expect(run.winner).toBeGreaterThanOrEqual(0);
        expect(run.winner).toBeLessThan(8);
      }
      runs.push(...course.runs);
    }
    expect(runs).toHaveLength(TRACK_IDS.length * MEASURE_SEEDS.length);
    const report = summarizeItems(runs);
    console.info(`M12_ITEM_BALANCE_JSON ${JSON.stringify(report)}`);
    // The sim is deterministic, so these sums are fixed for a given build: no flake margin is needed.
    const draws = (rank: number, item: ItemType) => report.drawsByRank[rank - 1]![ITEM_ORDER.indexOf(item)]!;
    expect(report.firstPlaceDefensive.ratio).toBeGreaterThanOrEqual(0.8);
    for (const item of ['seeker', 'skycomet', 'storm', 'autopilot'] as const) expect(draws(1, item), item).toBe(0);
    expect(report.lastTwoComeback.ratio).toBeGreaterThanOrEqual(0.75);
    for (const item of ['trap', 'decoy', 'ink'] as const) expect(draws(7, item) + draws(8, item), item).toBe(0);
    expect(report.firstPlaceHitRatio.ratio).toBeGreaterThanOrEqual(0.6);
    expect(report.firstPlaceHitRatio.ratio).toBeLessThanOrEqual(1.5);
    expect(report.firstLapLeaderWinRate.ratio).toBeGreaterThanOrEqual(0.35);
    expect(report.firstLapLeaderWinRate.ratio).toBeLessThanOrEqual(0.6);
  }, 600_000);

  it('measures active effects on human karts instead of copying duration constants', () => {
    const durations = measureEffectDurations();
    expect(Object.keys(durations)).toEqual(['ink', 'aura', 'shrink', 'autopilot']);
    expect(Object.values(durations).every(value => Number.isFinite(value) && value > 0)).toBe(true);
    // C3 caps (seconds). Before M12-23: ink 4, aura 7, shrink 5, autopilot 4.
    expect(durations.ink).toBeLessThanOrEqual(2.4);
    expect(durations.aura).toBeLessThanOrEqual(6);
    expect(durations.shrink).toBeLessThanOrEqual(4);
    expect(durations.autopilot).toBeLessThanOrEqual(5);
  });

  it('uses draw-weighted rates and the mean of ranks 2-4, with explicit missing denominators', () => {
    const drawsByRank = Array.from({ length: 8 }, () => ITEM_ORDER.map(() => 0));
    drawsByRank[0]![ITEM_ORDER.indexOf('trap')] = 3;
    drawsByRank[0]![ITEM_ORDER.indexOf('seeker')] = 1;
    drawsByRank[6]![ITEM_ORDER.indexOf('aura')] = 2;
    drawsByRank[7]![ITEM_ORDER.indexOf('ink')] = 1;
    const run: ItemRun = { seed: 1, drawsByRank, hitsByRank: [4, 3, 6, 3, 0, 0, 0, 0],
      pickups: 7, firstLapLeader: 7, winner: 7 };
    const report = summarizeItems([run, { ...run, winner: 0 }]);
    expect(report.firstPlaceDefensive.ratio).toBe(3 / 4);
    expect(report.lastTwoComeback.ratio).toBe(2 / 3);
    expect(report.firstPlaceHitRatio.ratio).toBe(1);
    expect(report.firstLapLeaderWinRate).toEqual({ wins: 1, races: 2, ratio: 0.5 });
    const empty = summarizeItems([]);
    expect(empty.firstPlaceDefensive.ratio).toBeNull();
    expect(empty.lastTwoComeback.ratio).toBeNull();
    expect(empty.firstPlaceHitRatio.ratio).toBeNull();
    expect(empty.firstLapLeaderWinRate.ratio).toBeNull();
  });
});

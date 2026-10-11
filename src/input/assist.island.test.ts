import { afterEach, describe, expect, it, vi } from 'vitest';
import { KART_RADIUS } from '../sim/corridor';
import { applySteerAssist } from './assist';
import { fuzz, input, islandCourse, onStraight, run, RUNS, seeded } from './assist.island.fixtures';

// M2-03: one island on a straight, and island entry. The curve and dense fuzz run in their own
// files (assist.island-curve / assist.island-dense) so vitest spreads them over workers.
afterEach(() => vi.restoreAllMocks());

describe('M2-03 one island on a straight', () => {
  it(`never adds band hits over OFF (${RUNS} runs)`, () => {
    const { worse, totals } = fuzz(0x1514d, false, 0, RUNS);
    expect(worse, JSON.stringify(totals)).toEqual([]);
    expect(totals.onBand, JSON.stringify(totals)).toBeLessThan(totals.offBand);
  });
});

describe('M2-03 island entry', () => {
  // Head-on entries without input: 40-55 m before the split (the lane-selection approach is 35 m),
  // within 0.5 m and 1° of the island's axis. Lanes are 6-12 m wide (CANYON is 11.7), so the approach is at least
  // 4.95 m wide (islandHalf 5 + R + lane 6 - 7; a 3.6 m approach pins a centred kart until the ramp). Each run ends at from + 10.
  it('enters a lane without input from 100 head-on approaches, never striking the nose', () => {
    const { random, between } = seeded(0x2050e);
    const failures: string[] = [];
    for (let i = 0; i < 100; i++) {
      const curve = random() < 0.5;
      const { track, from, islandHalf } = islandCourse(between, curve, 0, 6);
      const start = from - between(40, 55);
      const speed = between(12, 32);
      const offset = between(-0.5, 0.5);
      const heading = between(-1, 1) * Math.PI / 180;
      const { kart, headOn } = run(track, start, offset, heading, speed, 0, true, 8 * 60, racer => racer.trackDistance >= from + 10);
      if (kart.trackDistance < from + 10 || Math.abs(kart.lateralOffset) < islandHalf + KART_RADIUS || headOn > 0) {
        failures.push(JSON.stringify({ i, curve, islandHalf, start, speed, offset, heading, distance: kart.trackDistance, lateral: kart.lateralOffset, headOn }));
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps the input direction near an island', () => {
    const { between } = seeded(0x51de);
    const { track, from } = islandCourse(between, false, 0);
    for (const distance of [from - 40, from - 10, from + 20]) {
      for (const offset of [-6, -1, 0, 1, 6]) {
        for (const heading of [-0.3, 0, 0.3]) {
          const { state, kart } = onStraight(track, distance, offset);
          kart.heading += heading;
          for (const steer of [-0.5, -0.05, 0.05, 0.5]) {
            expect(applySteerAssist(state, kart, { ...input, steer }, 1).steer * steer).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });
});

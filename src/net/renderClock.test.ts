import { describe, expect, it } from 'vitest';
import {
  BASE_RENDER_DELAY_MS, DELAY_SLEW, JITTER_DEADBAND_MS, JITTER_WINDOW_MS, JitterEstimator,
  MAX_RENDER_DELAY_MS, MIN_JITTER_SAMPLES, OFFSET_SLEW, RenderClock,
} from './renderClock';

function mulberry32(seed: number): () => number {
  return () => {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

describe('JitterEstimator', () => {
  it('exports the specified timing constants', () => {
    expect([BASE_RENDER_DELAY_MS, MAX_RENDER_DELAY_MS, JITTER_WINDOW_MS, MIN_JITTER_SAMPLES,
      JITTER_DEADBAND_MS, DELAY_SLEW, OFFSET_SLEW]).toEqual([100, 250, 3000, 10, 2, 0.05, 0.05]);
  });

  it('always targets 100 ms for fixed 60 ms lateness with tiny floating-point variation', () => {
    const estimator = new JitterEstimator();
    const random = mulberry32(42);
    expect(estimator.target(0)).toBe(100);
    for (let now = 0; now <= 6000; now += 50) {
      estimator.observe(60 + (random() * 2 - 1) * 1e-9, now);
      expect(estimator.target(now)).toBe(100);
    }
  });

  it.each([1, 42, 314])('targets 160–190 ms for two seconds of uniform ±40 ms jitter (seed %i)', seed => {
    const estimator = new JitterEstimator();
    const shifted = new JitterEstimator();
    const random = mulberry32(seed);
    for (let now = 0; now < 2000; now += 50) {
      const lateness = 60 + (random() * 2 - 1) * 40;
      estimator.observe(lateness, now);
      shifted.observe(lateness - 4321, now);
    }
    expect(estimator.target(2000)).toBeGreaterThanOrEqual(160);
    expect(estimator.target(2000)).toBeLessThanOrEqual(190);
    expect(shifted.target(2000)).toBe(estimator.target(2000));
  });

  it('requires ten samples, retaining the inclusive three-second window boundary', () => {
    const estimator = new JitterEstimator();
    for (let i = 0; i < 9; i++) estimator.observe(i * 10, 0);
    expect(estimator.target(0)).toBe(100);
    estimator.observe(90, 0);
    expect(estimator.target(0)).toBe(190);
    expect(estimator.target(3000)).toBe(190);
    expect(estimator.target(3001)).toBe(100);
  });

  it('expires old jitter while continuing to receive stable samples', () => {
    const estimator = new JitterEstimator();
    for (let i = 0; i < 10; i++) estimator.observe(i * 10, 0);
    for (let i = 0; i < 10; i++) estimator.observe(60, 3001 + i * 50);
    expect(estimator.target(3500)).toBe(100);
  });

  it('uses nearest-rank p95 minus the minimum, rounds, and ignores the top five percent', () => {
    const estimator = new JitterEstimator();
    for (let i = 0; i < 18; i++) estimator.observe(-20 + i, 0);
    estimator.observe(50.6, 0);
    estimator.observe(1000, 0);
    expect(estimator.target(0)).toBe(171);
  });

  it.each([[1.99, 100], [2, 102], [2.49, 102], [2.5, 103], [1000, 250]])(
    'applies the deadband and delay limit for %f ms of jitter', (jitter, expected) => {
      const estimator = new JitterEstimator();
      estimator.observe(60, 0);
      for (let i = 1; i < 10; i++) estimator.observe(60 + jitter, 0);
      expect(estimator.target(0)).toBe(expected);
    },
  );

  it('ignores non-finite observations without counting them or discarding valid history', () => {
    const estimator = new JitterEstimator();
    for (let i = 0; i < 9; i++) estimator.observe(i * 10, 0);
    for (const invalid of [NaN, Infinity, -Infinity]) {
      estimator.observe(invalid, 10000);
      estimator.observe(1000, invalid);
      expect(estimator.target(invalid)).toBe(100);
    }
    expect(estimator.target(0)).toBe(100);
    estimator.observe(90, 0);
    expect(estimator.target(0)).toBe(190);
  });
});

describe('RenderClock', () => {
  it('uses the supplied offset and delay with zero elapsed time on its first advance', () => {
    const clock = new RenderClock(25, 150);
    expect(clock.hostTime(1000)).toBe(875);
    clock.advance(1000, 100, 250);
    expect(clock.offsetMs).toBe(25);
    expect(clock.delayMs).toBe(150);
    expect(clock.hostTime(1000)).toBe(875);
    clock.advance(1020, 100, 250);
    expect(clock.offsetMs).toBe(26);
    expect(clock.delayMs).toBe(151);
    expect(clock.hostTime(1020)).toBe(895);
  });

  it('reaches 200 ms from 100 ms after 2000 ms within one 60 Hz frame', () => {
    const clock = new RenderClock(0);
    const frameMs = 1000 / 60;
    clock.advance(0, 0, 100);
    let reachedAt = 0;
    for (let frame = 1; frame <= 121; frame++) {
      const now = frame * frameMs;
      clock.advance(now, 0, 200);
      expect(clock.delayMs).toBeCloseTo(Math.min(200, 100 + now * 0.05), 9);
      if (clock.delayMs === 200) {
        reachedAt = now;
        break;
      }
    }
    expect(reachedAt).toBeGreaterThanOrEqual(1983);
    expect(reachedAt).toBeLessThanOrEqual(2017);
    clock.advance(3000, 0, 100);
    expect(clock.delayMs).toBeCloseTo(200 - (3000 - reachedAt) * 0.05, 9);
  });

  it.each([-20, 20])('absorbs a %i ms offset step in exactly 400 ms', step => {
    const clock = new RenderClock(75);
    clock.advance(1000, 75, 100);
    for (let elapsed = 20; elapsed <= 400; elapsed += 20) {
      clock.advance(1000 + elapsed, 75 + step, 100);
      expect(clock.offsetMs).toBeCloseTo(75 + step * elapsed / 400, 9);
    }
    clock.advance(1500, 75 + step, 100);
    expect(clock.offsetMs).toBe(75 + step);
  });

  it.each([1, 42, 314])('keeps 1000 randomized frames monotonic at 90–110%% speed (seed %i)', seed => {
    const clock = new RenderClock(0);
    const random = mulberry32(seed);
    let now = 0;
    clock.advance(now, 0, 100);
    let previous = clock.hostTime(now);
    for (let frame = 0; frame < 1000; frame++) {
      const elapsed = 5 + random() * 30;
      now += elapsed;
      clock.advance(now, random() * 400 - 200, 100 + random() * 150);
      const current = clock.hostTime(now);
      const delta = current - previous;
      expect(delta).toBeGreaterThanOrEqual(0);
      // Arithmetic on accumulated timestamps can differ by a few ulps.
      expect(delta).toBeGreaterThanOrEqual(0.9 * elapsed - 1e-9);
      expect(delta).toBeLessThanOrEqual(1.1 * elapsed + 1e-9);
      expect(clock.delayMs).toBeGreaterThanOrEqual(100);
      expect(clock.delayMs).toBeLessThanOrEqual(250);
      previous = current;
    }
  });

  it.each([[-1000, 250, 0.9], [1000, 100, 1.1]])(
    'covers the speed boundary for offset %i and delay %i', (offset, delay, speed) => {
      const clock = new RenderClock(0, 175);
      clock.advance(0, offset, delay);
      const previous = clock.hostTime(0);
      clock.advance(100, offset, delay);
      expect(clock.hostTime(100) - previous).toBeCloseTo(100 * speed, 9);
    },
  );

  it('holds host time for reversed or repeated timestamps and never spends elapsed time twice', () => {
    const clock = new RenderClock(0);
    clock.advance(1000, 0, 100);
    expect(clock.hostTime(1000)).toBe(900);
    clock.advance(1100, -100, 200);
    expect(clock.hostTime(1100)).toBe(990);
    for (const now of [1050, 1000, 900, 1100]) {
      clock.advance(now, -100, 200);
      expect(clock.hostTime(now)).toBe(990);
      expect(clock.offsetMs).toBe(-5);
      expect(clock.delayMs).toBe(105);
    }
    clock.advance(1120, -100, 200);
    expect(clock.offsetMs).toBe(-6);
    expect(clock.delayMs).toBe(106);
    expect(clock.hostTime(1120)).toBe(1008);
  });

  it('clamps both initial and target delays to 100–250 ms', () => {
    const clock = new RenderClock(0, 0);
    expect(clock.delayMs).toBe(100);
    clock.advance(0, 0, 1000);
    clock.advance(10000, 0, 1000);
    expect(clock.delayMs).toBe(250);
    clock.advance(20000, 0, -1000);
    expect(clock.delayMs).toBe(100);
    clock.reset(0, 1000);
    expect(clock.delayMs).toBe(250);
  });

  it('reset restores offset, delay, first-advance timing, and the host-time floor', () => {
    const clock = new RenderClock(50, 200);
    clock.advance(10000, 100, 250);
    clock.advance(11000, 100, 250);
    expect(clock.hostTime(11000)).toBe(10850);
    clock.reset(-20);
    expect(clock.offsetMs).toBe(-20);
    expect(clock.delayMs).toBe(100);
    expect(clock.hostTime(0)).toBe(-120);
    clock.advance(500, 500, 250);
    expect(clock.offsetMs).toBe(-20);
    expect(clock.delayMs).toBe(100);
    clock.reset(30, 180);
    expect(clock.offsetMs).toBe(30);
    expect(clock.delayMs).toBe(180);
    expect(clock.hostTime(0)).toBe(-150);
  });
});

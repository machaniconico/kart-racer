import { describe, expect, it } from 'vitest';
import { boostFov, racingEffectsKart, type BoostFovInput } from './cameraFov';
import { speedLineOpacity, SpeedLines } from './speedLines';

const racing: BoostFovInput = { boostTime: 1, phase: 'racing', reducedMotion: false };
const idle: BoostFovInput = { boostTime: 0, phase: 'racing', reducedMotion: false };
const DT = 1 / 60;

function run(start: number, input: BoostFovInput, seconds: number): number {
  let fov = start;
  for (let i = 0; i < Math.round(seconds / DT); i++) fov = boostFov(fov, input, DT);
  return fov;
}

describe('boostFov', () => {
  it('is exactly 58 at tick 0 and during the countdown, even with boostTime > 0', () => {
    expect(boostFov(58, { ...racing, phase: 'countdown' }, DT)).toBe(58);
    expect(run(58, { ...racing, phase: 'countdown' }, 2)).toBe(58);
    expect(boostFov(58, idle, 0)).toBe(58);
  });
  it('reaches >= 64.5 within 0.15 s of boost start and never exceeds 66', () => {
    expect(run(58, racing, 0.15)).toBeGreaterThanOrEqual(64.5);
    expect(run(58, racing, 3)).toBeLessThanOrEqual(66);
  });
  it('is back to <= 58.2 within 0.40 s after the boost ends', () => {
    const peak = run(58, racing, 1);
    expect(run(peak, idle, 0.4)).toBeLessThanOrEqual(58.2);
  });
  it('returns to <= 58.2 0.40 s after boost end even while the kart is still fast', () => {
    const peak = run(58, racing, 1);
    // Real sim: speed stays ~38.6 m/s after the boost ends; speed must not hold the FOV up.
    expect(run(peak, idle, 0.4)).toBeLessThanOrEqual(58.2);
  });
  it('stays 58 under reduced motion and outside the racing phase', () => {
    expect(run(65, { ...racing, reducedMotion: true }, 1)).toBe(58);
    expect(boostFov(65, { ...racing, phase: 'finished' }, DT)).toBe(58);
  });
});

describe('speedLineOpacity', () => {
  it('follows clamp((speed-30)/14) x (boost ? 1 : 0.5)', () => {
    expect(speedLineOpacity(30, 1, false)).toBe(0);
    expect(speedLineOpacity(44, 1, false)).toBe(1);
    expect(speedLineOpacity(44, 0, false)).toBe(0.5);
    expect(speedLineOpacity(37, 1, false)).toBeCloseTo(0.5, 10);
    expect(speedLineOpacity(80, 1, false)).toBe(1);
  });
  it('is hidden under reduced motion', () => {
    expect(speedLineOpacity(60, 1, true)).toBe(0);
  });
});

describe('SpeedLines', () => {
  it('is inert without a DOM parent', () => {
    const lines = new SpeedLines({ parentElement: null } as unknown as HTMLCanvasElement);
    expect(() => { lines.resize(640, 360); lines.update(1); lines.dispose(); }).not.toThrow();
  });
});

describe('racingEffectsKart', () => {
  const kart = { boostTime: 1, effects: { autoTime: 2, auraTime: 3, shrinkTime: 4 } } as never;
  it('zeroes boost, autopilot and aura timers outside racing only', () => {
    for (const phase of ['countdown', 'finished'] as const) {
      const shown = racingEffectsKart(kart, phase);
      expect([shown.boostTime, shown.effects.autoTime, shown.effects.auraTime]).toEqual([0, 0, 0]);
      expect(shown.effects.shrinkTime).toBe(4);
    }
    expect(racingEffectsKart(kart, 'racing')).toBe(kart);
  });
});

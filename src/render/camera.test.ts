import { describe, expect, it } from 'vitest';
import { LOOK_AHEAD_MAX, lookAheadOffset, trackTurn } from './cameraLookAhead';

describe('camera look-ahead', () => {
  it('is zero on a straight', () => {
    expect(lookAheadOffset(trackTurn(0, 1, 0, 1), false)).toBe(0);
  });
  it('is mirror-symmetric for left and right curves', () => {
    const a = 0.3;
    const left = lookAheadOffset(trackTurn(0, 1, Math.sin(a), Math.cos(a)), false);
    const right = lookAheadOffset(trackTurn(0, 1, -Math.sin(a), Math.cos(a)), false);
    expect(left).not.toBe(0);
    expect(left).toBeCloseTo(-right, 10);
  });
  it('never exceeds the cap', () => {
    for (const a of [0.5, 1, 2, 3, -3]) expect(Math.abs(lookAheadOffset(a, false))).toBeLessThanOrEqual(LOOK_AHEAD_MAX);
    expect(Math.abs(lookAheadOffset(3, false))).toBe(LOOK_AHEAD_MAX);
  });
  it('is zero under reduced motion', () => {
    expect(lookAheadOffset(1, true)).toBe(0);
  });
  it('drops the look-ahead when facing against the track and fades it when sideways', () => {
    expect(lookAheadOffset(0.4, false, -1)).toBe(0);
    expect(lookAheadOffset(0.4, false, 0.2)).toBe(0);
    expect(Math.abs(lookAheadOffset(0.4, false, 0.5))).toBeLessThan(Math.abs(lookAheadOffset(0.4, false, 1)));
    expect(lookAheadOffset(0.4, false, 1)).toBe(lookAheadOffset(0.4, false));
  });
});

import { describe, expect, it } from 'vitest';
import { barrierCenterAt, barrierHalfWidthAt, corridorAt, exclusionAt, freeIntervalFor, KART_RADIUS,
  validateCoursePlayability, validateTrackDef, widthAt } from './corridor';
import { KART_RADIUS as RACE_RADIUS } from './race';
import { buildTrack, rollAt, slopeAt } from './track';
import { bankCourse, figureEightCourse, figureEightCrossings, slopeCourse } from './elevation.fixture';
import { getTrack, TRACK_IDS, TRACKS } from './tracks';
import { LEGACY_MEADOW } from './tracks/legacyMeadow.fixture';
import type { Barrier, BarrierMotion, SurfaceZone, TrackDef } from './types';

// Synthetic corridor cases keep their original dimensions, independent of MEADOW's layout.
const base: TrackDef = { ...LEGACY_MEADOW, roadHalfWidth: 7.2, wallHalfWidth: 10.5, boxLanes: [-4.1, 0, 4.1],
  // Corridor-only fixtures have flat landings; the real course is tested separately.
  controlPoints: LEGACY_MEADOW.controlPoints.map(([x, , z]) => [x, 0, z]),
};
const legacyMeadow = buildTrack(LEGACY_MEADOW);
const length = legacyMeadow.length;
const band: Barrier = { from: 25, to: 40, center: 0, halfWidth: 2, taper: 4 };
const fixture = (overrides: Partial<TrackDef> = {}): TrackDef => ({ ...base, ...overrides });
const syntheticDef = (overrides: Partial<TrackDef> = {}): TrackDef => ({
  ...base, scale: 1, checkpointCount: 1,
  controlPoints: [
    [-150, 3, 0], [-100, 3, 0], [-50, 3, 0], [0, 3, 0],
    [50, 3, 0], [100, 3, 0], [150, 3, 0], [150, 3, 100], [-150, 3, 100],
  ],
  boxRows: [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.85], surfaces: [], racingLine: [], ...overrides,
});

describe('widthAt', () => {
  it('interpolates continuously across the lap seam every 0.5 m', () => {
    const track = buildTrack(fixture({ widthKeys: [
      { distance: 10, roadHalfWidth: 5, wallHalfWidth: 8 },
      { distance: length - 10, roadHalfWidth: 9, wallHalfWidth: 12 },
    ] }));
    for (let d = -20; d < length + 20; d += 0.5) {
      const a = widthAt(track, d);
      const b = widthAt(track, d + 0.5);
      expect(Math.abs(b.roadHalfWidth - a.roadHalfWidth)).toBeLessThanOrEqual(0.5 * 0.5);
      expect(Math.abs(b.wallHalfWidth - a.wallHalfWidth)).toBeLessThanOrEqual(0.5 * 0.5);
    }
    expect(widthAt(track, 0)).toEqual({ roadHalfWidth: 7, wallHalfWidth: 10 });
    expect(widthAt(track, length)).toEqual(widthAt(track, 0));
    expect(widthAt(track, -0.5)).toEqual(widthAt(track, length - 0.5));
  });

  it.each([undefined, [], [0], [10, length - 10], [0, length]])(
    'preserves constant widths with exact equality (keys %j)', distances => {
      const track = buildTrack(fixture({ widthKeys: distances?.map(distance => ({
        distance, roadHalfWidth: base.roadHalfWidth, wallHalfWidth: base.wallHalfWidth,
      })) }));
      for (let d = -10; d <= length + 10; d += 0.5) {
        const width = widthAt(track, d);
        expect(width.roadHalfWidth).toBe(track.def.roadHalfWidth);
        expect(width.wallHalfWidth).toBe(track.def.wallHalfWidth);
      }
    },
  );

  it('interpolates internal segments and accepts matching zero/length endpoints', () => {
    const def = fixture({ widthKeys: [
      { distance: 0, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
      { distance: 20, roadHalfWidth: 4.2, wallHalfWidth: 7.5 },
      { distance: length, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
    ] });
    expect(widthAt(buildTrack(def), 10)).toEqual({ roadHalfWidth: 5.7, wallHalfWidth: 9 });
    expect(() => validateTrackDef(def)).not.toThrow();
  });
});

describe('exclusionAt', () => {
  const track = legacyMeadow;

  it('uses the simulation kart radius', () => { expect(KART_RADIUS).toBe(RACE_RADIUS); });

  it('has continuous, monotone semicircle and taper widths at 0.1 m steps', () => {
    const at = (d: number) => exclusionAt(track, band, d, 0)!.halfWidth;
    expect(at(band.from - KART_RADIUS)).toBe(0);
    expect(at(band.from)).toBe(KART_RADIUS);
    expect(at(band.from + band.taper!)).toBe(band.halfWidth + KART_RADIUS);
    const points = Array.from({ length: 50 }, (_, i) => band.from - KART_RADIUS + i * 0.1);
    points.push(band.from + band.taper!);
    points.sort((a, b) => a - b);
    for (let i = 1; i < points.length; i++) {
      const delta = at(points[i]!) - at(points[i - 1]!);
      expect(delta).toBeGreaterThanOrEqual(-1e-12);
      expect(delta).toBeLessThanOrEqual(0.6);
    }
    expect(exclusionAt(track, band, band.from - KART_RADIUS - 0.01, 0)).toBeNull();
    expect(exclusionAt(track, band, band.to + KART_RADIUS + 0.01, 0)).toBeNull();
  });

  it('mirrors the rear cap and taper', () => {
    for (let i = 0; i <= 49; i++) {
      const delta = -KART_RADIUS + i * 0.1;
      const front = exclusionAt(track, band, band.from + delta, 0)!;
      const rear = exclusionAt(track, band, band.to - delta, 0)!;
      expect(front.halfWidth).toBeCloseTo(rear.halfWidth, 6);
    }
    expect(exclusionAt(track, band, band.to, 0)!.halfWidth).toBe(KART_RADIUS);
    expect(exclusionAt(track, band, band.to + KART_RADIUS, 0)!.halfWidth).toBe(0);
  });

  it('returns longitudinal normals for nose-on hits and lateral taper normals', () => {
    const front = exclusionAt(track, band, band.from - KART_RADIUS + 0.1, 0)!;
    const normal = front.normalAt(band.center);
    expect(normal.d).toBeLessThan(-0.9);
    expect(normal.offset).toBe(0);
    const rear = exclusionAt(track, band, band.to + KART_RADIUS - 0.1, 0)!;
    expect(rear.normalAt(band.center).d).toBeGreaterThan(0.9);
    for (const d of [band.from + 2, band.to - 2]) {
      const side = exclusionAt(track, band, d, 0)!;
      for (const offset of [side.min, side.max]) {
        const n = side.normalAt(offset);
        expect(Math.abs(n.offset)).toBeGreaterThan(0.85);
        expect(Math.hypot(n.d, n.offset)).toBeCloseTo(1, 14);
        expect(Math.sign(n.offset)).toBe(Math.sign(offset - band.center));
        expect(Math.sign(n.d)).toBe(d < (band.from + band.to) / 2 ? -1 : 1);
      }
    }
    for (const offset of [front.min, front.max]) {
      const n = front.normalAt(offset);
      expect(Math.hypot(n.d, n.offset)).toBeCloseTo(1, 14);
      expect(n.d).toBeCloseTo(-0.85 / KART_RADIUS, 12);
    }
    const body = exclusionAt(track, band, 32, 0)!;
    expect(body.normalAt(body.min)).toEqual({ d: -0, offset: -1 });
    expect(body.normalAt(body.max)).toEqual({ d: -0, offset: 1 });
  });

  it('handles negative distances, seam-crossing bands, and short symmetric tapers', () => {
    const wrapped = { ...band, from: length - 8, to: 8 };
    expect(exclusionAt(track, wrapped, 0, 0)!.halfWidth).toBe(2.95);
    expect(exclusionAt(track, wrapped, length, 0)!.halfWidth).toBe(2.95);
    expect(exclusionAt(track, wrapped, -1, 0)!.halfWidth)
      .toBe(exclusionAt(track, wrapped, length - 1, 0)!.halfWidth);
    expect(exclusionAt(track, wrapped, length / 2, 0)).toBeNull();
    const short = { ...band, to: band.from + 3 };
    expect(exclusionAt(track, short, band.from + 1.5, 0)!.halfWidth).toBe(0.75 + KART_RADIUS);
    expect(exclusionAt(track, short, short.from + 1, 0)!.halfWidth)
      .toBe(exclusionAt(track, short, short.to - 1, 0)!.halfWidth);
  });

  it('keeps a motionless barrier bit-identical at every supplied time', () => {
    const staticTrack = buildTrack(syntheticDef({ barriers: [band] }));
    for (const time of [-5, 0, 1, 100]) {
      for (const d of [band.from - 0.5, band.from + 2, 32, band.to + 0.5]) {
        const actual = exclusionAt(track, band, d, time)!;
        const expected = exclusionAt(track, band, d, 0)!;
        expect(actual.halfWidth).toBe(expected.halfWidth);
        expect(actual.min).toBe(expected.min);
        expect(actual.max).toBe(expected.max);
        expect(actual.normalAt(0)).toEqual(expected.normalAt(0));
        expect(corridorAt(staticTrack, d, time)).toEqual(corridorAt(staticTrack, d, 0));
      }
      expect(barrierCenterAt({ ...band, center: -0 }, time)).toBe(-0);
      expect(barrierHalfWidthAt(band, time)).toBe(band.halfWidth);
    }
  });
});

describe('deterministic barrier motion', () => {
  const band: Barrier = { from: 125, to: 145, center: 1.25, halfWidth: 2, taper: 4 };
  const sweep: BarrierMotion = { kind: 'sweep', amplitude: 2.75, period: 8, phase: 0 };
  const gate: BarrierMotion = { kind: 'gate', amplitude: 0, period: 8, phase: 0, minWidth: 0.35 };

  it.each([sweep, gate])('matches the static corridor exactly at time zero ($kind)', motion => {
    const stationary = buildTrack(syntheticDef({ barriers: [band] }));
    const moving = buildTrack(syntheticDef({ barriers: [{ ...band, motion }] }));
    for (let d = band.from - 2; d <= band.to + 2; d += 0.125) {
      expect(corridorAt(moving, d, 0)).toEqual(corridorAt(stationary, d, 0));
    }
  });

  it('reaches the sweep amplitude after a quarter-period and moves noses and tapers with it', () => {
    const moving = { ...band, motion: sweep };
    const time = sweep.period / 4;
    const center = band.center + sweep.amplitude;
    expect(barrierCenterAt(moving, time)).toBeCloseTo(center, 12);
    expect(barrierHalfWidthAt(moving, time)).toBe(band.halfWidth);
    const track = buildTrack(syntheticDef({ barriers: [moving] }));
    const shifted = { ...band, center };
    const stationary = buildTrack(syntheticDef({ barriers: [shifted] }));
    for (const d of [band.from - 0.5, band.from + 2, 135, band.to - 2, band.to + 0.5]) {
      const actual = exclusionAt(track, moving, d, time)!;
      const expected = exclusionAt(track, shifted, d, 0)!;
      expect(actual.min).toBe(expected.min);
      expect(actual.max).toBe(expected.max);
      expect(actual.normalAt(center - 0.5)).toEqual(expected.normalAt(center - 0.5));
      expect(corridorAt(track, d, time)).toEqual(corridorAt(stationary, d, 0));
    }
  });

  it('reaches the gate minimum half-width after a half-period, including taper normals', () => {
    const moving = { ...band, motion: gate };
    const time = gate.period / 2;
    expect(barrierCenterAt(moving, time)).toBe(band.center);
    expect(barrierHalfWidthAt(moving, time)).toBeCloseTo(gate.minWidth!, 12);
    const track = buildTrack(syntheticDef({ barriers: [moving] }));
    for (const d of [band.from - 0.5, band.from + 2, 135, band.to - 2, band.to + 0.5]) {
      const actual = exclusionAt(track, moving, d, time)!;
      const expected = exclusionAt(track, { ...band, halfWidth: gate.minWidth! }, d, 0)!;
      expect(actual.min).toBeCloseTo(expected.min, 12);
      expect(actual.max).toBeCloseTo(expected.max, 12);
      expect(actual.normalAt(actual.min).d).toBeCloseTo(expected.normalAt(expected.min).d, 12);
      expect(actual.normalAt(actual.min).offset).toBeCloseTo(expected.normalAt(expected.min).offset, 12);
    }
  });

  it.each([sweep, gate])('is repeatable after JSON restoration and out-of-order queries ($kind)', motion => {
    const moving = { ...band, motion: { ...motion, phase: -0.37 } };
    const def = syntheticDef({ barriers: [moving] });
    const before = JSON.stringify(def);
    const track = buildTrack(def);
    const restored = buildTrack(JSON.parse(before));
    for (const time of [13.5, 0, -2, 4, 13.5]) {
      expect(corridorAt(track, 135, time)).toEqual(corridorAt(restored, 135, time));
      expect(barrierCenterAt(moving, time + motion.period)).toBeCloseTo(barrierCenterAt(moving, time), 12);
      expect(barrierHalfWidthAt(moving, time + motion.period)).toBeCloseTo(barrierHalfWidthAt(moving, time), 12);
    }
    expect(JSON.stringify(def)).toBe(before);
  });
});

describe('moving barrier validation', () => {
  const band: Barrier = { from: 125, to: 145, center: 0, halfWidth: 2, taper: 4 };
  const sweep: BarrierMotion = { kind: 'sweep', amplitude: 2, period: 8, phase: 0 };
  const gate: BarrierMotion = { kind: 'gate', amplitude: 0, period: 8, phase: 0, minWidth: 0.5 };
  const withMotion = (motion: BarrierMotion): TrackDef => syntheticDef({ barriers: [{ ...band, motion }] });

  it.each([sweep, gate])('accepts safe $kind motion without mutating its JSON', motion => {
    const def = withMotion(motion);
    const before = JSON.stringify(def);
    expect(() => validateTrackDef(def)).not.toThrow();
    expect(() => validateTrackDef(JSON.parse(before))).not.toThrow();
    expect(JSON.stringify(def)).toBe(before);
  });

  it.each([
    { ...sweep, period: 0 }, { ...sweep, period: -1 },
    { ...sweep, period: Infinity }, { ...sweep, period: NaN },
    { ...sweep, amplitude: -0.01 }, { ...sweep, amplitude: Infinity }, { ...sweep, amplitude: NaN },
    { ...sweep, phase: Infinity }, { ...sweep, phase: -Infinity }, { ...sweep, phase: NaN },
    { ...gate, minWidth: undefined }, { ...gate, minWidth: -0.01 }, { ...gate, minWidth: 0 },
    { ...gate, minWidth: 2.01 }, { ...gate, minWidth: Infinity }, { ...gate, minWidth: NaN },
    { ...gate, amplitude: -0.01 },
  ])('rejects invalid motion fields (%j)', motion => {
    expect(() => validateTrackDef(withMotion(motion))).toThrow(RangeError);
  });

  it.each([sweep, gate])('enforces the 6 m/s edge-speed limit for $kind', motion => {
    const distance = motion.kind === 'sweep' ? 2 * motion.amplitude : band.halfWidth - motion.minWidth!;
    const period = Math.PI * distance / 6;
    expect(() => validateTrackDef(withMotion({ ...motion, period }))).not.toThrow();
    expect(() => validateTrackDef(withMotion({ ...motion, period: period * 0.999 }))).toThrow(RangeError);
    expect(() => validateTrackDef(withMotion({ ...motion, period: period * 0.999 }))).toThrow(/edge speed/);
  });

  it('accepts a gate whose minimum equals its static half-width', () => {
    expect(() => validateTrackDef(withMotion({ ...gate, minWidth: band.halfWidth }))).not.toThrow();
  });

  it.each([Math.PI / 32, -Math.PI / 32])('samples a sweep peak missed by the period/32 grid (phase %s)', phase => {
    const motion = { ...sweep, amplitude: 40, period: 64, phase };
    const def = syntheticDef({ roadHalfWidth: 3.6, wallHalfWidth: 5.44,
      barriers: [{ ...band, center: -40, motion }] });
    const track = buildTrack(def);
    const widest = (time: number): number => Math.max(...corridorAt(track, 135, time)
      .map(interval => interval.max - interval.min));
    for (let time = 0; time <= motion.period; time += motion.period / 32) {
      expect(widest(time)).toBeGreaterThan(2 * KART_RADIUS + 0.6 + 0.05);
    }
    const peak = (Math.PI / 2 - phase) * motion.period / (2 * Math.PI);
    expect(widest(peak)).toBeLessThan(2 * KART_RADIUS + 0.6);
    expect(() => validateTrackDef(def)).toThrow(RangeError);
    expect(() => validateTrackDef(def)).toThrow(/free interval/);
  });

  it('checks a gate that starts narrow and blocks the passage when it widens', () => {
    const def = syntheticDef({ roadHalfWidth: 3.6, wallHalfWidth: 6.4,
      barriers: [{ ...band, halfWidth: 3, taper: 6, motion: { ...gate, phase: Math.PI } }] });
    expect(corridorAt(buildTrack(def), 135, 0).some(interval => interval.max - interval.min >= 2.55)).toBe(true);
    expect(() => validateTrackDef(def)).toThrow(RangeError);
    expect(() => validateTrackDef(def)).toThrow(/free interval/);
  });

  it('checks interpolated racing-line points at later times', () => {
    const def = syntheticDef({ racingLine: [{ distance: 100, offset: 0 }, { distance: 160, offset: 0 }],
      barriers: [{ ...band, center: 4, motion: { ...sweep, amplitude: 4 } }] });
    expect(() => validateTrackDef({ ...def, barriers: [{ ...band, center: 4 }] })).not.toThrow();
    expect(() => validateTrackDef(def)).toThrow(RangeError);
    expect(() => validateTrackDef(def)).toThrow(/racingLine/);
  });

  it('checks start-grid slots at later times', () => {
    const track = buildTrack(syntheticDef());
    const start = track.length - 8 - 3 * 4.5;
    const barrier = { ...band, from: start - 2, to: start + 2, center: 6, halfWidth: 0.5, taper: 2 };
    expect(() => validateTrackDef(syntheticDef({ barriers: [barrier] }))).not.toThrow();
    const def = syntheticDef({ barriers: [{ ...barrier, motion: { ...sweep, amplitude: 4 } }] });
    expect(() => validateTrackDef(def)).toThrow(RangeError);
    expect(() => validateTrackDef(def)).toThrow(/start grid slot/);
  });

  it('checks boxes at intermediate grid times, not just the quarter-period extrema', () => {
    const length = buildTrack(syntheticDef()).length;
    const moving = { ...band, center: -4, halfWidth: 0.1,
      motion: { ...sweep, amplitude: 8, period: 16 } };
    const def = syntheticDef({ boxRows: [135 / length, ...syntheticDef().boxRows.slice(1)], boxLanes: [0, 8, 9], barriers: [moving] });
    const track = buildTrack(def);
    for (const time of [0, 4, 8, 12, 16]) {
      const exclusion = exclusionAt(track, moving, 135, time)!;
      expect(def.boxLanes.every(offset => offset < exclusion.min || offset > exclusion.max)).toBe(true);
    }
    expect(() => validateTrackDef({ ...def, barriers: [{ ...moving, motion: undefined }] })).not.toThrow();
    expect(() => validateTrackDef(def)).toThrow(RangeError);
    expect(() => validateTrackDef(def)).toThrow(/item box/);
  });

  it.each([140, 145 + 2 * KART_RADIUS - 0.01, 145 + 2 * KART_RADIUS])(
    'rejects overlapping moving ranges including noses (second from %s)', from => {
      const def = syntheticDef({ barriers: [{ ...band, motion: sweep },
        { ...band, from, to: from + 20, center: 7, motion: gate }] });
      expect(() => validateTrackDef(def)).toThrow(RangeError);
      expect(() => validateTrackDef(def)).toThrow(/moving barrier.*overlap/);
    },
  );

  it('rejects moving ranges that overlap across the lap seam', () => {
    const length = buildTrack(syntheticDef()).length;
    expect(() => validateTrackDef(syntheticDef({ barriers: [
      { ...band, from: length - 20, to: 20, motion: sweep },
      { ...band, from: 21, to: 40, motion: gate },
    ] }))).toThrow(/moving barrier.*overlap/);
  });

  it('accepts separated moving bands with different periods and overlapping static bands', () => {
    expect(() => validateTrackDef(syntheticDef({ barriers: [{ ...band, motion: sweep },
      { ...band, from: band.to + 2 * KART_RADIUS + 0.01, to: 170, motion: { ...gate, period: 13.5 } },
    ] }))).not.toThrow();
    expect(() => validateTrackDef(syntheticDef({ barriers: [band, { ...band, motion: gate }] }))).not.toThrow();
  });
});

describe('spin-zone validation', () => {
  const spin: SurfaceZone = { kind: 'spin', from: 125, to: 135, offsetMin: -5, offsetMax: 5, rate: 1 };
  const withSpin = (zone: SurfaceZone): TrackDef => syntheticDef({ surfaces: [zone] });

  it.each([-1.5, -0.01, 0.01, 1.5])('accepts a straight disc with rate %s rad/s', rate => {
    const def = withSpin({ ...spin, rate });
    const json = JSON.stringify(def);
    expect(() => validateTrackDef(def)).not.toThrow();
    expect(JSON.stringify(def)).toBe(json);
  });

  it.each([undefined, 0, -1.50001, 1.50001, NaN, Infinity, -Infinity])('rejects spin rate %s', rate => {
    expect(() => validateTrackDef(withSpin({ ...spin, rate }))).toThrow(RangeError);
  });

  it.each([
    { ...spin, offsetMin: undefined }, { ...spin, offsetMax: undefined },
    { ...spin, offsetMin: NaN }, { ...spin, offsetMax: Infinity },
    { ...spin, offsetMax: 4.9 }, { ...spin, offsetMax: -5 },
    { ...spin, to: spin.from + 30.01, offsetMax: spin.offsetMin! + 30.01 },
    { ...spin, to: spin.from }, { ...spin, from: 135, to: 125 },
  ])('rejects invalid spin diameter or offsets (%j)', zone => {
    expect(() => validateTrackDef(withSpin(zone))).toThrow(RangeError);
  });

  it('rejects a spin on a curve', () => {
    const def = fixture({ surfaces: [spin], racingLine: [] });
    expect(() => validateTrackDef(def)).toThrow(RangeError);
    expect(() => validateTrackDef(def)).toThrow(/curvature radius/);
  });

  it.each([120, 135.5])('rejects barrier body or nose overlap (barrier from %s)', from => {
    const def = syntheticDef({ surfaces: [spin], barriers: [
      { from, to: from + 20, center: 0, halfWidth: 2, taper: 4 },
    ] });
    expect(() => validateTrackDef(def)).toThrow(RangeError);
    expect(() => validateTrackDef(def)).toThrow(/spin.*barrier exclusion/);
  });

  it('checks barrier overlap throughout the motion cycle while allowing a separated disc', () => {
    const barrier: Barrier = { from: 120, to: 145, center: 8, halfWidth: 2, taper: 4 };
    const def = syntheticDef({ surfaces: [spin], barriers: [barrier] });
    expect(() => validateTrackDef(def)).not.toThrow();
    const moving = { ...barrier, motion: { kind: 'sweep' as const, amplitude: 6, period: 8, phase: 0 } };
    expect(() => validateTrackDef({ ...def, barriers: [moving] })).toThrow(RangeError);
    expect(() => validateTrackDef({ ...def, barriers: [moving] })).toThrow(/spin.*barrier exclusion/);
  });

  it('allows a barrier near the disc corner when its exclusion stays outside the circle', () => {
    expect(() => validateTrackDef(syntheticDef({ surfaces: [spin], barriers: [
      { from: 134, to: 154, center: 4.9, halfWidth: 0.1, taper: 4 },
    ] }))).not.toThrow();
  });
});

describe('corridorAt and freeIntervalFor', () => {
  it('uses the local wall width and returns the whole corridor without barriers', () => {
    const track = buildTrack(fixture({ widthKeys: [{ distance: 10, roadHalfWidth: 4, wallHalfWidth: 6 }] }));
    expect(corridorAt(track, 20, 0)).toEqual([{ min: -6, max: 6 }]);
  });

  it('subtracts overlapping barriers as a union, regardless of order', () => {
    const barriers = [band, { ...band, center: 3 }];
    const expected = [{ min: -10.5, max: -2.95 }, { min: 5.95, max: 10.5 }];
    expect(corridorAt(buildTrack(fixture({ barriers })), 32, 0)).toEqual(expected);
    expect(corridorAt(buildTrack(fixture({ barriers: [...barriers].reverse() })), 32, 0)).toEqual(expected);
  });

  it('clips to walls, drops covered intervals, and preserves disjoint intervals', () => {
    expect(corridorAt(buildTrack(fixture({ barriers: [{ ...band, center: -10 }] })), 32, 0))
      .toEqual([{ min: -7.05, max: 10.5 }]);
    expect(corridorAt(buildTrack(fixture({ barriers: [{ ...band, center: 30 }] })), 32, 0))
      .toEqual([{ min: -10.5, max: 10.5 }]);
    expect(corridorAt(buildTrack(fixture({ barriers: [{ ...band, halfWidth: 20, taper: 2 }] })), 32, 0))
      .toEqual([]);
    const split = corridorAt(buildTrack(fixture({ barriers: [{ ...band, center: -4 }, { ...band, center: 4 }] })), 32, 0);
    expect(split).toEqual([{ min: -10.5, max: -6.95 }, { min: -4 + 2.95, max: 4 - 2.95 },
      { min: 6.95, max: 10.5 }]);
  });

  it('chooses the containing or closest original interval, with deterministic ties', () => {
    const intervals = [{ min: -10, max: -3 }, { min: 3, max: 10 }];
    for (const offset of [-20, -10, -4, -3, -1, 0]) expect(freeIntervalFor(intervals, offset)).toBe(intervals[0]);
    for (const offset of [1, 3, 4, 10, 20]) expect(freeIntervalFor(intervals, offset)).toBe(intervals[1]);
    expect(freeIntervalFor([], 0)).toBeUndefined();
  });
});

describe('validateTrackDef', () => {
  const band: Barrier = { from: 125, to: 140, center: 0, halfWidth: 2, taper: 4 };
  const fixture = (overrides: Partial<TrackDef> = {}): TrackDef => ({
    ...base, checkpointCount: 1, boxRows: [0.35, 0.45, 0.5, 0.6, 0.65, 0.7, 0.8, 0.85], ...overrides,
  });
  it.each(TRACK_IDS)('accepts the existing %s definition without changing its JSON', id => {
    const def = TRACKS[id];
    const before = JSON.stringify(def);
    expect(() => validateTrackDef(def)).not.toThrow();
    expect(JSON.stringify(def)).toBe(before);
    // layoutVersion is pinned by each course's own test file (meadow/canyon/neon/snowpeak.test.ts).
  });

  it('accepts a safe band and leaves mutable input unchanged', () => {
    const def = fixture({ barriers: [band] });
    const before = JSON.stringify(def);
    expect(() => validateTrackDef(def)).not.toThrow();
    expect(JSON.stringify(def)).toBe(before);
  });

  it.each(['roadHalfWidth', 'wallHalfWidth'] as const)('rejects excessive %s key slope', field => {
    expect(() => validateTrackDef(fixture({ widthKeys: [
      { distance: 0, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
      { distance: 1, roadHalfWidth: 7.2, wallHalfWidth: 10.5, [field]: base[field] + 0.36 },
    ] }))).toThrow(/slope/);
  });

  it('checks key slope across the seam and rejects mismatching zero/length keys', () => {
    expect(() => validateTrackDef(fixture({ widthKeys: [
      { distance: 0.5, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
      { distance: length - 0.5, roadHalfWidth: 8, wallHalfWidth: 11.3 },
    ] }))).toThrow(/slope/);
    expect(() => validateTrackDef(fixture({ widthKeys: [
      { distance: 0, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
      { distance: length, roadHalfWidth: 7.3, wallHalfWidth: 10.6 },
    ] }))).toThrow(/widthKeys/);
  });

  it('rejects a road half-width below 3.6 m, in defaults and keys', () => {
    expect(() => validateTrackDef(fixture({ roadHalfWidth: 3.59 }))).toThrow(/roadHalfWidth/);
    expect(() => validateTrackDef(fixture({ widthKeys: [{ distance: 0, roadHalfWidth: 3.59, wallHalfWidth: 10.5 }] })))
      .toThrow(/roadHalfWidth/);
  });

  it('rejects a taper under 2 m and a barrier slope above 0.5', () => {
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, taper: 1.99 }] }))).toThrow(/taper/);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, halfWidth: 2.01 }] }))).toThrow(/halfWidth \/ taper/);
  });

  it('rejects a location with no passage of width 2R + 0.6', () => {
    const def = fixture({ roadHalfWidth: 3.6, wallHalfWidth: 5.4,
      barriers: [{ ...band, halfWidth: 2, taper: 4 }] });
    expect(corridorAt(buildTrack(def), 132, 0).every(interval => interval.max - interval.min < 2 * KART_RADIUS + 0.6))
      .toBe(true);
    expect(() => validateTrackDef(def)).toThrow(/free interval/);
  });

  it('accepts the exact passage threshold and a narrow gap when another lane is wide enough', () => {
    expect(() => validateTrackDef(fixture({ roadHalfWidth: 3.6, wallHalfWidth: 5.5, barriers: [band] }))).not.toThrow();
    expect(() => validateTrackDef(fixture({ roadHalfWidth: 3.6, wallHalfWidth: 5.45, barriers: [band] })))
      .toThrow(/free interval/);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, center: 7 }] }))).not.toThrow();
  });

  it('rejects a racing-line anchor in an exclusion and a crossing between safe anchors', () => {
    expect(() => validateTrackDef(fixture({ barriers: [band], racingLine: [{ distance: 132, offset: 0 }] })))
      .toThrow(/racingLine/);
    expect(() => validateTrackDef(fixture({ barriers: [band], racingLine: [
      { distance: 120, offset: 0 }, { distance: 145, offset: 0 },
    ] }))).toThrow(/racingLine/);
  });

  it('checks the effective racing line after the simulation clamps its offset', () => {
    expect(() => validateTrackDef(fixture({
      racingLine: [{ distance: 0, offset: 7.1 }],
      barriers: [{ from: 128, to: 143, center: 6, halfWidth: 0.1 }],
    }))).toThrow(/racingLine/);
  });

  it.each(Array.from({ length: 8 }, (_, slot) => slot))('rejects occupied start grid slot %i', slot => {
    const d = length - 8 - Math.floor(slot / 2) * 4.5;
    const barrier: Barrier = { from: d - 2, to: d + 2, center: slot % 2 === 0 ? -2 : 2, halfWidth: 0.5, taper: 2 };
    expect(() => validateTrackDef(fixture({ barriers: [barrier] }))).toThrow(new RegExp(`start grid slot ${slot}`));
  });

  it.each(Array.from({ length: 24 }, (_, box) => box))('rejects occupied item box %i', box => {
    const d = base.boxRows[Math.floor(box / 3)]! * length;
    const barrier: Barrier = { from: d - 2, to: d + 2, center: base.boxLanes[box % 3]!, halfWidth: 0.5, taper: 2 };
    expect(() => validateTrackDef(fixture({ barriers: [barrier], boxRows: base.boxRows }))).toThrow(/item box/);
  });

  it('rejects a gate within ±10 m of either tip, also across the seam', () => {
    const gate = length / base.checkpointCount;
    for (const barrier of [
      { ...band, from: gate + 9, to: gate + 24, center: 7 },
      { ...band, from: gate - 24, to: gate - 9, center: 7 },
      { ...band, from: length - 20, to: length - 5, center: 7 },
      { ...band, from: 10, to: 25, center: 7 },
    ]) expect(() => validateTrackDef(fixture({ barriers: [barrier], checkpointCount: base.checkpointCount })))
      .toThrow(/checkpoint gate/);
  });

  it('applies checkpointPhase only to non-start gates', () => {
    const gateBand = { ...band, from: 25, to: 40 };
    expect(() => validateTrackDef(fixture({ barriers: [band] }))).not.toThrow();
    expect(() => validateTrackDef(fixture({ barriers: [gateBand], checkpointCount: 12, checkpointPhase: -0.3 })))
      .toThrow(/checkpoint gate/);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, from: 5, to: 20, center: 7 }], checkpointPhase: 0.4 })))
      .toThrow(/checkpoint gate/);
  });

  it('checks critical taper endpoints between the 0.5 m sampling locations', () => {
    const tinyPeak: Barrier = { from: 125.1, to: 129.4, halfWidth: 1.05, center: 0, taper: 2.1 };
    const def = fixture({ roadHalfWidth: 3.6, wallHalfWidth: 4.49, barriers: [tinyPeak] });
    expect(corridorAt(buildTrack(def), 127, 0)[0]!.max + 4.49).toBeGreaterThan(2.5);
    expect(() => validateTrackDef(def)).toThrow(/free interval/);
  });

  // At d=132.25 the two facing caps have equal longitudinal radius 0.5.
  // Their combined lateral extent is exactly 2*sqrt(R² - 0.5²).
  const noseFixture = (minimum: number): TrackDef => {
    const center = (minimum + 2 * Math.sqrt(KART_RADIUS ** 2 - 0.5 ** 2)) / 2;
    return fixture({ roadHalfWidth: 3.6, wallHalfWidth: 3.6, barriers: [
      { from: 120, to: 131.75, center: -center, halfWidth: 0.1, taper: 2 },
      { from: 132.75, to: 145, center, halfWidth: 0.1, taper: 2 },
    ] });
  };
  const taperFixture = (minimum: number): TrackDef => {
    const center = (minimum + 2 * (KART_RADIUS + 1.05)) / 2;
    return fixture({ roadHalfWidth: 3.6, wallHalfWidth: 6, barriers: [-center, center].map(center => ({
      from: 130.15, to: 134.35, center, halfWidth: 1.05, taper: 2.1,
    })) });
  };
  // The widest route switches sides inside the overlapping tapers. With a
  // shifted right barrier the crossing is no longer at the taper midpoint.
  const crossingTaperFixture = (minimum: number, from = 130.25, shift = 0): TrackDef =>
    fixture({ roadHalfWidth: 3.6, wallHalfWidth: minimum + 2 + KART_RADIUS + 0.5 + shift / 2,
      barriers: [
        { from: from - 10, to: from + 2, center: -2, halfWidth: 1, taper: 2 },
        { from, to: from + 12, center: 2 + shift, halfWidth: 1, taper: 2 },
      ] });

  it.each([[130.25, 0], [130, 0], [130.25, 0.2], [130, 0.2]])(
    'rejects crossing taper valleys independently of scan alignment (%s, shift %s)', (from, shift) => {
      for (const minimum of [2.425, 2.5]) {
        const def = crossingTaperFixture(minimum, from, shift);
        const widths = corridorAt(buildTrack(def), from + 1 - shift, 0).map(interval => interval.max - interval.min);
        expect(Math.max(...widths)).toBeCloseTo(minimum, 10);
        expect(() => validateTrackDef(def)).toThrow(/free interval/);
      }
    },
  );

  it('rejects the M1 critic counterexample: a 2.45 m gap hidden between 0.5 m samples', () => {
    const def = noseFixture(2.45);
    const track = buildTrack(def);
    for (let d = 0; d < length; d += 0.5) {
      expect(Math.max(...corridorAt(track, d, 0).map(interval => interval.max - interval.min)))
        .toBeGreaterThanOrEqual(2.5);
    }
    expect(Math.max(...corridorAt(track, 132.25, 0).map(interval => interval.max - interval.min)))
      .toBeCloseTo(2.45, 10);
    expect(() => validateTrackDef(def)).toThrow(/free interval/);
  });

  it.each([
    ['taper breakpoints', taperFixture], ['interior of the noses', noseFixture],
    ['crossing tapers', crossingTaperFixture],
    ['asymmetric crossing tapers', (minimum: number) => crossingTaperFixture(minimum, 130.25, 0.2)],
  ] as const)(
    'places the rejection boundary within 0.06 m of the analytic minimum (%s)', (_label, makeDef) => {
      let rejected = 2.4;
      let accepted = 2.7;
      for (let i = 0; i < 12; i++) {
        const minimum = (accepted + rejected) / 2;
        try { validateTrackDef(makeDef(minimum)); accepted = minimum; }
        catch (error) { expect(String(error)).toMatch(/free interval/); rejected = minimum; }
      }
      expect(Math.abs(accepted - 2.5)).toBeLessThanOrEqual(0.06);
      expect(accepted).toBeGreaterThanOrEqual(2.5);
      expect(accepted).toBeCloseTo(2.55, 2);
    },
  );

  const island: Barrier = { from: 120 + KART_RADIUS, to: 160 - KART_RADIUS,
    center: 0, halfWidth: 2, taper: 8, scenery: 'rock' };
  const split = { from: 120, to: 160, lanes: [
    { offsetMin: -10, offsetMax: -3, risk: 0 as const },
    { offsetMin: 3, offsetMax: 10, risk: 1 as const },
  ] };
  const splitFixture = (overrides: Partial<TrackDef> = {}): TrackDef =>
    fixture({ barriers: [island], splits: [split], ...overrides });

  it('accepts a contained island with two lanes and 35 m of unsplit approach', () => {
    expect(() => validateTrackDef(splitFixture())).not.toThrow();
  });

  it('rejects a split with the wrong free interval count', () => {
    expect(() => validateTrackDef(splitFixture({ barriers: [] }))).toThrow(/split free interval count/);
  });

  it('rejects narrow lanes, lanes outside their corridor, and two lanes in one corridor', () => {
    const left = split.lanes[0]!;
    expect(() => validateTrackDef(splitFixture({ splits: [{ ...split, lanes: [left,
      { ...split.lanes[1]!, offsetMin: 6.51 }] }] }))).toThrow(/split lane width/);
    expect(() => validateTrackDef(splitFixture({ splits: [{ ...split, lanes: [left,
      { ...split.lanes[1]!, offsetMin: 2.9 }] }] }))).toThrow(/distinct free intervals/);
    expect(() => validateTrackDef(splitFixture({ splits: [{ ...split, lanes: [left, left] }] })))
      .toThrow(/distinct free intervals/);
  });

  it('rejects a split approach with a second interval, including a short cap between scan points', () => {
    const blocker = { from: 119.2, to: 119.3, center: 7, halfWidth: 0.1, taper: 2 };
    expect(() => validateTrackDef(splitFixture({ barriers: [island, blocker] }))).toThrow(/split.*count|split approach/);
    expect(() => validateTrackDef(splitFixture({ barriers: [island, { ...band, from: 102, to: 108, center: 7 }] })))
      .toThrow(/split approach/);
  });

  it('rejects an island that extends outside its split or has no split', () => {
    expect(() => validateTrackDef(splitFixture({ barriers: [{ ...island, to: 163 }] }))).toThrow(/island.*contained/);
    expect(() => validateTrackDef(fixture({ barriers: [island] }))).toThrow(/island.*contained/);
  });

  const pit = { kind: 'pit' as const, from: 158, to: 166, offsetMin: -5, offsetMax: -3 };
  const jump = { kind: 'jump' as const, from: 150, to: 152, offsetMin: -5, offsetMax: -3 };

  it('accepts a pit and matching jump, including exact spacing and clear-speed limits', () => {
    expect(() => validateTrackDef(fixture({ surfaces: [jump, pit] }))).not.toThrow();
    for (const [gap, speed] of [[4, 15], [12, 26]]) {
      expect(() => validateTrackDef(fixture({ surfaces: [jump,
        { ...pit, from: jump.from + gap!, to: jump.from + 0.8 * speed! }] }))).not.toThrow();
    }
  });

  it('requires a jump 4–12 m before the pit covering its full lateral range', () => {
    expect(() => validateTrackDef(fixture({ surfaces: [pit] }))).toThrow(/pit needs a jump/);
    for (const gap of [3.99, 12.01]) {
      expect(() => validateTrackDef(fixture({ surfaces: [{ ...jump, from: pit.from - gap }, pit] })))
        .toThrow(/4–12 m/);
    }
    expect(() => validateTrackDef(fixture({ surfaces: [{ ...jump, offsetMax: -3.01 }, pit] })))
      .toThrow(/covering its lateral range/);
  });

  it.each([14.99, 26.01])('rejects a pit requiring a clear speed of %s m/s', speed => {
    expect(() => validateTrackDef(fixture({ surfaces: [jump, { ...pit, to: jump.from + 0.8 * speed }] })))
      .toThrow(/pit clear speed/);
  });

  it('rejects pit overlap with a barrier body while allowing the neighboring lane', () => {
    // Noses outside the jump guard; only the body touches the pit lane.
    const barrier = { ...band, from: 130, to: 195, center: -1, halfWidth: 2 };
    expect(() => validateTrackDef(fixture({ barriers: [barrier], surfaces: [jump, pit] })))
      .toThrow(/pit.*barrier exclusion/);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...barrier, center: 1 }], surfaces: [jump, pit] })))
      .not.toThrow();
  });

  it('uses the road width at takeoff when a jump has no explicit lateral range', () => {
    expect(() => validateTrackDef(fixture({ surfaces: [
      { kind: 'jump', from: 150, to: 152 }, { kind: 'pit', from: 158, to: 166 },
    ] }))).not.toThrow();
    expect(() => validateTrackDef(fixture({ widthKeys: [
      { distance: 150, roadHalfWidth: 3.6, wallHalfWidth: 10.5 },
      { distance: 158, roadHalfWidth: 5, wallHalfWidth: 10.5 },
    ], surfaces: [{ kind: 'jump', from: 150, to: 152 }, { kind: 'pit', from: 158, to: 166 }] })))
      .toThrow(/covering its lateral range/);
  });

  it('rejects a gate inside a pit, honoring checkpointPhase and the fixed start gate', () => {
    const gate = 3 * length / 12;
    const offset = gate - 162;
    const surfaces = [jump, pit].map(zone => ({ ...zone, from: zone.from + offset, to: zone.to + offset }));
    expect(() => validateTrackDef(fixture({ surfaces, checkpointCount: 12 }))).toThrow(/pit.*checkpoint gate/);
    expect(() => validateTrackDef(fixture({ surfaces, checkpointCount: 12, checkpointPhase: 0.3 }))).not.toThrow();
    expect(() => validateTrackDef(fixture({ surfaces: [
      { ...jump, from: length - 12, to: length - 10 }, { ...pit, from: length - 4, to: 4 },
    ], checkpointPhase: 0.3 }))).toThrow(/pit.*checkpoint gate/);
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite geometry (%s) before JSON cloning', value => {
    expect(() => validateTrackDef(fixture({ roadHalfWidth: value }))).toThrow(RangeError);
    expect(() => validateTrackDef(fixture({ widthKeys: [{ distance: value, roadHalfWidth: 7.2, wallHalfWidth: 10.5 }] })))
      .toThrow(RangeError);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, halfWidth: value }] }))).toThrow(RangeError);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, center: value }] }))).toThrow(RangeError);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, taper: value }] }))).toThrow(RangeError);
  });

  it('rejects duplicate keys, inverted widths, and zero-length bands', () => {
    expect(() => validateTrackDef(fixture({ widthKeys: [
      { distance: 10, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
      { distance: 10, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
    ] }))).toThrow(/strictly increasing/);
    expect(() => validateTrackDef(fixture({ wallHalfWidth: 7 }))).toThrow(/wallHalfWidth/);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, to: band.from }] }))).toThrow(/endpoints/);
  });
});

describe('validateTrackDef elevation', () => {
  const eight = figureEightCourse();
  const crossing = figureEightCrossings(eight);
  const flat = slopeCourse(0);
  const flatLength = buildTrack(flat).length;
  const reject = (def: TrackDef, message: RegExp): void => {
    expect(() => validateTrackDef(def)).toThrow(RangeError);
    expect(() => validateTrackDef(def)).toThrow(message);
  };
  // Only XZ geometry changes arc lengths; keep the upper deck centred on its pass.
  const crossingGeometry = (controlPoints: TrackDef['controlPoints']): TrackDef => {
    const def = { ...eight, controlPoints };
    const { upper } = figureEightCrossings(def);
    return { ...def, decks: [{ from: upper - 20, to: upper + 20 }] };
  };
  const nearbyDeck = (height: number): TrackDef => syntheticDef({
    samplesPerSegment: 1, decks: [{ from: 80, to: 120 }],
    controlPoints: [
      [-100, height, 0], [0, height, 0], [100, height, 0], [150, height, 0],
      [180, height / 2, 15], [150, 0, 30], [100, 0, 30], [0, 0, 30],
      [-100, 0, 30], [-150, 0, 30], [-180, height / 2, 15], [-150, height, 0],
    ],
  });
  const landingCourse = (grade: number): TrackDef => syntheticDef({
    samplesPerSegment: 1, surfaces: [{ kind: 'jump', from: 38, to: 40 }],
    controlPoints: [
      [0, 0, 0], [40, -0.8, 0], [60, -1.2, 0], [70, -1.2 + 10 * grade, 0],
      [100, -1.2 + 10 * grade, 0], [150, 0, 50], [100, 0, 100], [0, 0, 100],
    ],
  });

  it.each([
    ['figure eight', eight], ['bank 0.3', bankCourse(0.3)], ['slope 0.3', slopeCourse(0.3)],
  ] as const)('accepts %s and its JSON round trip without mutation', (_name, def) => {
    const before = JSON.stringify(def);
    expect(() => validateTrackDef(def)).not.toThrow();
    expect(() => validateTrackDef(JSON.parse(before))).not.toThrow();
    expect(JSON.stringify(def)).toBe(before);
  });

  it('accepts exact 0.30 slopes and 12 m / 45 degree crossings in sampled polylines', () => {
    // One sample per control point isolates the exact bounds from spline overshoot.
    expect(() => validateTrackDef({ ...slopeCourse(0.3), samplesPerSegment: 1 })).not.toThrow();
    for (const angle of [45, 90]) {
      const def = { ...eight, samplesPerSegment: 1, controlPoints: eight.controlPoints.map(([x, y, z]) =>
        [x / Math.tan(angle * Math.PI / 360), y * 12 / 12.5, z] as const) };
      const upper = buildTrack(def).samples.find(sample => sample.x === 0 && sample.z === 0 && sample.y === 12)!.distance;
      expect(() => validateTrackDef({ ...def, decks: [{ from: upper - 20, to: upper + 20 }] })).not.toThrow();
    }
  });

  it('rejects a slope of 0.35', () => {
    reject(slopeCourse(0.35), /slope.*0.30/);
    reject(slopeCourse(-0.35), /slope.*0.30/);
  });

  it('rejects a roll of 0.40', () => {
    reject(bankCourse(0.40), /roll.*0.35/);
    reject(bankCourse(-0.40), /roll.*0.35/);
  });

  it('rejects twist of 0.03 rad/m between keys and across the seam', () => {
    reject({ ...flat, bankKeys: [{ distance: 0, roll: 0 }, { distance: 10, roll: 0.3 }] }, /twist/);
    reject({ ...flat, bankKeys: [{ distance: 5, roll: 0 }, { distance: flatLength - 5, roll: 0.3 }] }, /twist/);
  });

  it('rejects mismatching rolls at zero and length', () => {
    reject({ ...flat, bankKeys: [{ distance: 0, roll: 0 }, { distance: flatLength, roll: 0.1 }] }, /must match/);
  });

  it('rejects a crossing centreline height difference of 11 m', () => {
    reject(crossingGeometry(eight.controlPoints.map(([x, y, z]) => [x, y * 11 / 12.5, z])), /height.*12 m/);
  });

  it('rejects deck/outside samples 30 m apart with a 7.9 m height difference, without a crossing', () => {
    const def = nearbyDeck(7.9);
    const track = buildTrack(def);
    const upper = track.samples[1]!;
    const lower = track.samples[7]!;
    expect(Math.hypot(upper.x - lower.x, upper.z - lower.z)).toBe(30);
    expect(upper.y - lower.y).toBe(7.9);
    expect(Math.min(lower.distance - upper.distance, track.length - lower.distance + upper.distance)).toBeGreaterThan(31.8);
    reject(def, /deck surface height.*8 m/);
    expect(() => validateTrackDef(nearbyDeck(8))).not.toThrow();
  });

  it('rejects a crossing angle of 30 degrees', () => {
    const xScale = 1 / Math.tan(Math.PI / 12);
    reject(crossingGeometry(eight.controlPoints.map(([x, y, z]) => [x * xScale, y, z])), /angle.*45/);
  });

  it('rejects a lower crossing approach slope of 0.15', () => {
    const def = crossingGeometry(eight.controlPoints.map(([x, y, z]) =>
      [x, y === 0 && Math.abs(x) <= 15 && Math.abs(z) <= 15 ? 0.15 * (x + z) * Math.SQRT1_2 : y, z]));
    expect(slopeAt(buildTrack(def), crossing.lower)).toBeGreaterThan(0.10);
    reject(def, /crossing slope/);
  });

  it('rejects roll 0.2 on the upper crossing approach, including a peak between samples', () => {
    const peak = crossing.upper + 0.3;
    const def = { ...eight, bankKeys: [
      { distance: peak - 10, roll: 0 }, { distance: peak, roll: 0.2 }, { distance: peak + 10, roll: 0 },
    ] };
    expect(rollAt(buildTrack(def), peak)).toBeCloseTo(0.2, 12);
    reject(def, /crossing roll/);
  });

  it('rejects a checkpoint gate 20 m from either crossing pass', () => {
    for (const start of [2, 15]) {
      const controlPoints = [...eight.controlPoints.slice(start), ...eight.controlPoints.slice(0, start)];
      const def = { ...eight, checkpointCount: 1, controlPoints };
      const track = buildTrack(def);
      const upperIndex = (3 - start + controlPoints.length) % controlPoints.length;
      const upper = track.samples[upperIndex * def.samplesPerSegment]!.distance;
      reject({ ...def, decks: [{ from: upper - 20, to: upper + 20 }] }, /checkpoint gate.*25 m/);
    }
  });

  it('rejects an upper crossing pass without a declared deck', () => {
    reject({ ...eight, decks: undefined }, /upper crossing.*deck/);
    reject({ ...eight, decks: [] }, /upper crossing.*deck/);
  });

  it('rejects overlapping decks, including across the seam', () => {
    reject({ ...eight, decks: [...eight.decks!, { from: crossing.upper, to: crossing.upper + 30 }] }, /deck.*overlap/);
    reject({ ...flat, decks: [{ from: flatLength - 10, to: 10 }, { from: 5, to: 15 }] }, /deck.*overlap/);
    reject({ ...flat, decks: [{ from: 0, to: flatLength }, { from: 50, to: 60 }] }, /deck.*overlap/);
  });

  it('rejects takeoff -0.02 followed by landing -0.10 and accepts the -0.05 difference boundary', () => {
    const def = landingCourse(-0.10);
    const track = buildTrack(def);
    expect(slopeAt(track, 40)).toBeCloseTo(-0.02, 12);
    expect(slopeAt(track, 60)).toBeCloseTo(-0.10, 12);
    reject(def, /jump landing slope/);
    expect(() => validateTrackDef(landingCourse(-0.07))).not.toThrow();
  });

  it('checks landing slopes across the lap seam', () => {
    const original = landingCourse(-0.10);
    const controlPoints = [...original.controlPoints.slice(3), ...original.controlPoints.slice(0, 3)];
    const def = { ...original, controlPoints };
    const to = buildTrack(def).samples[controlPoints.length - 2]!.distance;
    reject({ ...def, surfaces: [{ kind: 'jump', from: to - 2, to }] }, /jump landing slope/);
  });

  it('accepts all three CANYON jumps with downhill takeoffs', () => {
    const track = getTrack('canyon');
    const jumps = track.def.surfaces.filter(zone => zone.kind === 'jump');
    expect(jumps).toHaveLength(3);
    for (const jump of jumps) {
      const takeoff = slopeAt(track, jump.to);
      expect(takeoff).toBeLessThan(0);
      for (const sample of track.samples) {
        const gap = (sample.distance - jump.to + track.length) % track.length;
        if (gap > 0 && gap <= 40) expect(slopeAt(track, sample.distance)).toBeGreaterThanOrEqual(takeoff - 0.05);
      }
      expect(slopeAt(track, jump.to + 40)).toBeGreaterThanOrEqual(takeoff - 0.05);
    }
    expect(() => validateTrackDef(track.def)).not.toThrow();
  });

  it.each(TRACK_IDS)('preserves %s validation with original motions and with motions removed', id => {
    const original = TRACKS[id];
    for (const def of [original, { ...original, barriers: original.barriers?.map(({ motion: _motion, ...barrier }) => barrier) }]) {
      const before = JSON.stringify(def);
      expect(() => validateTrackDef(def)).not.toThrow();
      // A course with decks needs them to separate its crossing levels, so stripping them is not
      // a valid variant there; only deck-free courses must stay valid without banks and decks.
      if (!def.decks?.length) expect(() => validateTrackDef({ ...def, bankKeys: [], decks: [] })).not.toThrow();
      expect(JSON.stringify(def)).toBe(before);
    }
  });

  it('accepts the roll and twist limits, matching seam keys, and a single constant bank key', () => {
    expect(() => validateTrackDef(bankCourse(0.35))).not.toThrow();
    expect(() => validateTrackDef({ ...flat, bankKeys: [{ distance: 0, roll: -0.35 }] })).not.toThrow();
    expect(() => validateTrackDef({ ...flat, bankKeys: [
      { distance: 5, roll: 0 }, { distance: flatLength - 5, roll: 0.2 },
    ] })).not.toThrow();
  });

  it.each([NaN, Infinity, -Infinity, -1, flatLength + 1])('rejects invalid bank/deck distances (%s)', distance => {
    reject({ ...flat, bankKeys: [{ distance, roll: 0 }] }, /bankKeys distance/);
    reject({ ...flat, decks: [{ from: distance, to: 10 }] }, /deck from/);
    reject({ ...flat, decks: [{ from: 10, to: distance }] }, /deck to/);
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite roll (%s) before JSON restoration', roll => {
    reject({ ...flat, bankKeys: [{ distance: 0, roll }] }, /bankKeys roll/);
  });

  it.each([10, 9])('rejects duplicate or decreasing bank distances (%s)', distance => {
    reject({ ...flat, bankKeys: [{ distance: 10, roll: 0 }, { distance, roll: 0 }] }, /strictly increasing/);
  });
});

describe('validateCoursePlayability', () => {
  const band: Barrier = { from: 125, to: 140, center: 0, halfWidth: 2, taper: 4 };
  const fixture = (overrides: Partial<TrackDef> = {}): TrackDef => ({
    ...base, checkpointCount: 1, boxRows: [0.35, 0.45, 0.5, 0.6, 0.65, 0.7, 0.8, 0.85], ...overrides,
  });
  const validateAll = (def: TrackDef): void => {
    validateTrackDef(def);
    validateCoursePlayability(def);
  };

  it('is not part of validateTrackDef, so synthetic layouts may break playability rules', () => {
    const jump = { kind: 'jump' as const, from: 160, to: 164, offsetMin: -1, offsetMax: 1 };
    const cases = [
      fixture({ barriers: [{ ...band, from: length - 25, to: 25, center: 7 }] }),
      fixture({ barriers: [band], boxRows: [(band.from - KART_RADIUS - 7.49) / length, ...fixture().boxRows.slice(1)] }),
      fixture({ barriers: [{ ...band, from: 150, to: 160 }], surfaces: [jump] }),
    ];
    for (const def of cases) {
      expect(() => validateTrackDef(def)).not.toThrow();
      expect(() => validateCoursePlayability(def)).toThrow();
    }
  });

  // Registry coverage lives here because tracks.test.ts is outside M2-01's file lock.
  it.each(TRACK_IDS)('accepts registered course %s without changing its JSON', id => {
    const def = TRACKS[id];
    const before = JSON.stringify(def);
    expect(() => validateTrackDef(def)).not.toThrow();
    expect(() => validateCoursePlayability(def)).not.toThrow();
    expect(JSON.stringify(def)).toBe(before);
  });

  it('rejects a split that crosses the start line and accepts one that ends on it', () => {
    const lanes = [{ offsetMin: -7, offsetMax: -3, risk: 0 }, { offsetMin: 3, offsetMax: 7, risk: 0 }] as const;
    const across = fixture({ splits: [{ from: length - 30, to: 30, lanes }] });
    expect(() => validateCoursePlayability(across)).toThrow(RangeError);
    expect(() => validateCoursePlayability(across)).toThrow('split must not cross the start line');
    expect(() => validateCoursePlayability(fixture({ splits: [{ from: length - 60, to: 0, lanes }] }))).not.toThrow();
    expect(() => validateCoursePlayability(fixture({ splits: [{ from: 0, to: 60, lanes }] }))).not.toThrow();
  });

  it('rejects a wrapped band across the protected start even when both noses clear the gates', () => {
    const def = fixture({ barriers: [{ ...band, from: length - 25, to: 25, center: 7 }] });
    expect(() => validateAll(def)).toThrow(/start grid/);
    expect(() => validateCoursePlayability(def)).toThrow(/start grid/);
  });

  it('protects the whole 100 m ahead of every grid row, including the lap seam and cap', () => {
    const barrier = { ...band, from: 92 + KART_RADIUS, to: 110, center: 7 };
    const def = fixture({ barriers: [barrier] });
    // The first grid row is L-8, so its 100 m endpoint is 92. Other rows see a shorter reach.
    expect(() => validateAll(def)).toThrow(/start grid slot 0.*100 m/);
    expect(() => validateAll(fixture({ barriers: [{ ...barrier, from: barrier.from + 0.001 }] })))
      .not.toThrow();
    expect(() => validateAll(fixture({ barriers: [{ ...band, center: 7, from: length - 40, to: length - 21.5 }] })))
      .toThrow(/start grid slot 6/);
  });

  it('requires 8 m from item rows to the expanded band, even when boxes miss it laterally', () => {
    const row = (band.from - KART_RADIUS - 8) / length;
    expect(() => validateAll(fixture({ barriers: [band], boxRows: [row, ...fixture().boxRows.slice(1)] })))
      .not.toThrow();
    for (const gap of [7.49, 7.99]) {
      const def = fixture({ barriers: [band], boxRows: [(band.from - KART_RADIUS - gap) / length, ...fixture().boxRows.slice(1)] });
      expect(() => validateAll(def)).toThrow(/item box row.*8 m/);
    }
    expect(() => validateAll(fixture({ barriers: [{ ...band, center: 9 }],
      boxRows: [132 / length, ...fixture().boxRows.slice(1)] }))).toThrow(/item box row.*8 m/);
  });

  it.each([-10, 40])('rejects an overlapping nose at jump.from %+i and permits a separate lane', delta => {
    const jump = { kind: 'jump' as const, from: 160, to: 164, offsetMin: -1, offsetMax: 1 };
    const barrier = { ...band, from: jump.from + delta, to: jump.from + delta + 10 };
    const def = fixture({ barriers: [barrier], surfaces: [jump] });
    expect(() => validateAll(def)).toThrow(/jump.*nose/);
    expect(() => validateAll(fixture({ barriers: [{ ...barrier, center: 5 }], surfaces: [jump] })))
      .not.toThrow();
    const fullWidth = { kind: 'jump' as const, from: 160, to: 164 };
    expect(() => validateAll(fixture({ barriers: [{ ...barrier, center: 5 }], surfaces: [fullWidth] })))
      .toThrow(/jump.*nose/);
  });
});

import { describe, expect, it } from 'vitest';
import { widthAt } from '../corridor';
import { buildTrack } from '../track';
import type { Track } from '../types';
import { getTrack, TRACK_IDS } from './index';
import { LEGACY_MEADOW } from './legacyMeadow.fixture';
import { curvatureProfile, dirtCoverage, elevationRange, findCompoundCorners, findHairpins, findSCurves,
  maxSlope, minCurvatureRadius, S_CURVE_DEADBAND } from './shapeMetrics';

// A turtle path of straights and arcs (positive angle turns left, from +x toward +z), walked
// in ~1 m steps. Heading changes are averaged over 15 m, a clothoid-like easing, so the
// Catmull-Rom spline through the points carries no curvature spikes at segment joins.
// The 'closeX' / 'closeZ' straights are solved so the loop returns to the origin; they must
// run along -x and -z respectively and stay longer than the easing.
type Segment = { straight: number } | { radius: number; angle: number } | 'closeX' | 'closeZ';
const EASING = 15;

function walk(segments: readonly Segment[], closeX: number, closeZ: number): [number, number][] {
  const steps: { length: number; turn: number }[] = [];
  for (const segment of segments) {
    if (segment === 'closeX' || segment === 'closeZ' || 'straight' in segment) {
      const distance = segment === 'closeX' ? closeX : segment === 'closeZ' ? closeZ : segment.straight;
      const count = Math.max(1, Math.round(distance));
      for (let i = 0; i < count; i++) steps.push({ length: distance / count, turn: 0 });
    } else {
      const turn = segment.angle * Math.PI / 180;
      const count = Math.max(1, Math.round(segment.radius * Math.abs(turn)));
      for (let i = 0; i < count; i++) steps.push({ length: segment.radius * Math.abs(turn) / count, turn: turn / count });
    }
  }
  const n = steps.length;
  const half = (EASING - 1) / 2;
  const points: [number, number][] = [];
  let x = 0; let z = 0; let heading = 0;
  for (let i = 0; i < n; i++) {
    let turn = 0;
    for (let k = -half; k <= half; k++) turn += steps[(i + k + n) % n]!.turn / EASING;
    points.push([x, z]);
    x += Math.cos(heading + turn / 2) * steps[i]!.length;
    z += Math.sin(heading + turn / 2) * steps[i]!.length;
    heading += turn;
  }
  return [...points, [x, z]];
}

function course(segments: readonly Segment[]): Track {
  let closeX = 50; let closeZ = 50;
  let points = walk(segments, closeX, closeZ);
  for (let i = 0; i < 8; i++) {
    const [ex, ez] = points[points.length - 1]!;
    closeX += ex; closeZ += ez;
    points = walk(segments, closeX, closeZ);
  }
  const [lx, lz] = points.pop()!;
  expect(Math.hypot(lx, lz)).toBeLessThan(1e-3);
  return buildTrack({ ...LEGACY_MEADOW, scale: 1, samplesPerSegment: 2, roadHalfWidth: 8, wallHalfWidth: 10,
    controlPoints: points.map(([x, z]) => [x, 0, z]) });
}

// The first corner is under test; the second completes the half turn so the return runs along -x.
const rectangle = (corner: readonly { radius: number; angle: number }[], radius = 100) => course([
  { straight: 200 }, ...corner, { straight: 150 },
  { radius, angle: 180 - corner.reduce((sum, arc) => sum + arc.angle, 0) },
  'closeX', { radius, angle: 90 }, 'closeZ', { radius, angle: 90 },
]);
// Wall half-width 10, so a hairpin radius must lie in [12.5, 18].
// Symmetric, so only the -x return straight needs solving.
const stadium = (radius: number) => course([
  { straight: 150 }, { radius, angle: 180 }, 'closeX', { radius, angle: 180 },
]);
const chicane = (counterRadius: number) => course([
  { straight: 100 }, { radius: 30, angle: 50 }, { radius: counterRadius, angle: -100 },
  { radius: 30, angle: 100 }, { radius: counterRadius, angle: -100 }, { radius: 30, angle: 50 },
  { straight: 100 }, { radius: 100, angle: 90 }, { straight: 150 }, { radius: 100, angle: 90 },
  'closeX', { radius: 100, angle: 90 }, 'closeZ', { radius: 100, angle: 90 },
]);
const straight = buildTrack({ ...LEGACY_MEADOW, scale: 1, samplesPerSegment: 8,
  controlPoints: [[0, 0, 0], [100, 10, 0], [200, 20, 0], [300, 30, 0]] });

describe('curvatureProfile', () => {
  it('measures a constant-radius arc and a zero-curvature straight', () => {
    const track = stadium(15);
    const radii = curvatureProfile(track).map(point => 1 / Math.abs(point.curvature));
    expect(Math.min(...radii)).toBeGreaterThan(14.5);
    expect(radii.filter(radius => radius < 15.1).length).toBeGreaterThan(20);
    expect(curvatureProfile(straight).every(point => point.curvature === 0)).toBe(true);
  });
});

describe('findHairpins', () => {
  it('finds both 180° ends of a stadium whose radius sits in the wall band', () => {
    const hairpins = findHairpins(stadium(15));
    expect(hairpins).toHaveLength(2);
    for (const hairpin of hairpins) {
      expect(hairpin.turn).toBeGreaterThanOrEqual(150 * Math.PI / 180);
      const wall = widthAt(stadium(15), hairpin.at).wallHalfWidth;
      expect(hairpin.minRadius).toBeGreaterThanOrEqual(wall + 2.5);
      expect(hairpin.minRadius).toBeLessThanOrEqual(wall + 8);
    }
  });

  it('judges each 120 m window by its own radius, so a too-tight neighbour cannot veto a hairpin', () => {
    // A 15 m hairpin, 60 m of straight, then an 11 m hairpin (below the 12.5 m band) the other way.
    const track = course([
      { straight: 100 }, { radius: 15, angle: 180 }, { straight: 60 }, { radius: 11, angle: -180 },
      { straight: 150 }, { radius: 66, angle: -90 }, 'closeZ', { radius: 66, angle: -90 }, 'closeX',
      { radius: 50, angle: -180 },
    ]);
    const hairpins = findHairpins(track);
    expect(hairpins).toHaveLength(1);
    expect(hairpins[0]!.minRadius).toBeCloseTo(15, 0);
    expect(hairpins[0]!.turn).toBeGreaterThanOrEqual(150 * Math.PI / 180);
  });

  it('uses the wall half-width at the hairpin, not the base value', () => {
    const base = stadium(15);
    const wide = buildTrack({ ...base.def, widthKeys: [{ distance: 0, roadHalfWidth: 14, wallHalfWidth: 16 }] });
    expect(findHairpins(wide)).toHaveLength(0);
  });

  it('rejects ends that are too wide or too tight for the band, 90° corners and straights', () => {
    expect(findHairpins(stadium(40))).toHaveLength(0);
    expect(findHairpins(stadium(11))).toHaveLength(0);
    expect(findHairpins(rectangle([{ radius: 15, angle: 90 }], 15))).toHaveLength(0);
    expect(findHairpins(straight)).toHaveLength(0);
  });
});

describe('findSCurves', () => {
  it('finds a triple chicane with four reversals inside 300 m', () => {
    const curves = findSCurves(chicane(30));
    expect(curves).toHaveLength(1);
    expect(curves[0]!.reversals).toBeGreaterThanOrEqual(3);
    for (const bend of curves[0]!.bends) expect(bend.minRadius).toBeLessThanOrEqual(70);
  });

  it('also tries shorter candidates when wide bends bracket the chicane', () => {
    // Four alternating 30 m bends between two 90 m bends: five reversals inside 300 m, but only
    // the three between the 30 m bends form an S-curve.
    const curves = findSCurves(course([
      { straight: 100 }, { radius: 90, angle: 40 }, { radius: 30, angle: -80 }, { radius: 30, angle: 80 },
      { radius: 30, angle: -80 }, { radius: 30, angle: 80 }, { radius: 90, angle: -40 },
      { straight: 100 }, { radius: 100, angle: 90 }, { straight: 150 }, { radius: 100, angle: 90 },
      'closeX', { radius: 100, angle: 90 }, 'closeZ', { radius: 100, angle: 90 },
    ]));
    expect(curves).toHaveLength(1);
    expect(curves[0]!.reversals).toBe(3);
    for (const bend of curves[0]!.bends) expect(bend.minRadius).toBeCloseTo(30, 0);
  });

  it('measures the span from the first bend to the last, wherever the slack falls', () => {
    // A lone 30° bend 140 m before three tight bends: the 300 m are all used before the last
    // reversal, so a window centred on the reversals would cut off the first bend.
    const curves = findSCurves(course([
      { straight: 100 }, { radius: 30, angle: 30 }, { straight: 140 }, { radius: 30, angle: -50 },
      { radius: 30, angle: 50 }, { radius: 30, angle: -30 },
      { straight: 100 }, { radius: 100, angle: 90 }, { straight: 150 }, { radius: 100, angle: 90 },
      'closeX', { radius: 100, angle: 90 }, 'closeZ', { radius: 100, angle: 90 },
    ]));
    expect(curves).toHaveLength(1);
    expect(curves[0]!.reversals).toBe(3);
    expect(curves[0]!.to - curves[0]!.from).toBeLessThanOrEqual(300);
    expect(curves[0]!.to - curves[0]!.from).toBeGreaterThan(200);
    // Short eased bends never reach a full plateau; the spline lands within 1 m of 30 m.
    for (const bend of curves[0]!.bends) expect(Math.abs(bend.minRadius - 30)).toBeLessThan(1);
  });

  it('does not count counter-bends inside the 1/200 deadband as reversals', () => {
    expect(S_CURVE_DEADBAND).toBe(1 / 200);
    expect(findSCurves(chicane(260))).toHaveLength(0);
  });

  it('rejects bends wider than 70 m, single-direction loops and straights', () => {
    expect(findSCurves(chicane(90))).toHaveLength(0);
    expect(findSCurves(stadium(15))).toHaveLength(0);
    expect(findSCurves(rectangle([{ radius: 100, angle: 90 }]))).toHaveLength(0);
    expect(findSCurves(straight)).toHaveLength(0);
  });
});

describe('findCompoundCorners', () => {
  const compound = () => rectangle([{ radius: 20, angle: 60 }, { radius: 45, angle: 60 }]);

  it('finds one corner whose two curvature maxima differ by at least 25% in radius', () => {
    const corners = findCompoundCorners(compound());
    expect(corners).toHaveLength(1);
    expect(Math.abs(corners[0]!.turn)).toBeGreaterThanOrEqual(Math.PI / 2 - 0.05);
    expect(corners[0]!.peakRadii[0]).toBeCloseTo(20, 0);
    expect(corners[0]!.peakRadii[1]).toBeCloseTo(45, 0);
  });

  it('keeps a corner whole through a stretch inside the S-curve deadband', () => {
    // The 260 m middle arc has |κ| < 1/200 but the same sign, so it does not split the corner.
    const corners = findCompoundCorners(rectangle([{ radius: 20, angle: 50 }, { radius: 260, angle: 20 },
      { radius: 45, angle: 50 }]));
    expect(corners).toHaveLength(1);
    expect(corners[0]!.peakRadii[0]).toBeCloseTo(20, 0);
    expect(corners[0]!.peakRadii[1]).toBeCloseTo(45, 0);
  });

  it('counts a shallow middle maximum between wider arcs as a maximum', () => {
    // 20 -> 42 -> 35 -> 42 -> 20 m: the 35 m arc is a maximum although both sides are tighter.
    const corners = findCompoundCorners(rectangle([{ radius: 20, angle: 35 }, { radius: 42, angle: 20 },
      { radius: 35, angle: 30 }, { radius: 42, angle: 20 }, { radius: 20, angle: 35 }], 60));
    expect(corners).toHaveLength(1);
    expect(corners[0]!.peakRadii[1]).toBeGreaterThanOrEqual(1.25 * corners[0]!.peakRadii[0]);
  });

  it('compares maxima cyclically when one same-sign section covers the whole lap', () => {
    // An egg-shaped oval: every sample turns the same way, maxima of about 29.2 m and 43.6 m.
    const points = Array.from({ length: 360 }, (_, i) => {
      const t = i * Math.PI / 180;
      return [100 * Math.cos(t), 0, 60 * Math.sin(t) * (1 + 0.1 * Math.cos(t))] as const;
    });
    for (const shift of [0, 20]) {
      const track = buildTrack({ ...LEGACY_MEADOW, scale: 1, samplesPerSegment: 1,
        controlPoints: [...points.slice(shift), ...points.slice(0, shift)] });
      const corners = findCompoundCorners(track);
      expect(corners).toHaveLength(1);
      expect(corners[0]!.peakRadii[0]).toBeCloseTo(29.166, 1);
      expect(corners[0]!.peakRadii[1]).toBeCloseTo(43.563, 1);
    }
  });

  it('rejects constant-radius corners, close radii and straights', () => {
    expect(findCompoundCorners(rectangle([{ radius: 30, angle: 90 }]))).toHaveLength(0);
    expect(findCompoundCorners(rectangle([{ radius: 30, angle: 60 }, { radius: 33, angle: 60 }]))).toHaveLength(0);
    expect(findCompoundCorners(straight)).toHaveLength(0);
  });
});

describe('scalar metrics', () => {
  it('reports curvature radius, elevation range and slope', () => {
    expect(minCurvatureRadius(stadium(15))).toBeCloseTo(15, 0);
    expect(minCurvatureRadius(straight)).toBe(Infinity);
    expect(elevationRange(stadium(15))).toEqual({ min: 0, max: 0, range: 0 });
    expect(maxSlope(stadium(15))).toBe(0);
    const { min, max, range } = elevationRange(straight);
    expect(range).toBe(max - min);
    expect(range).toBeGreaterThanOrEqual(30);
    expect(range).toBeLessThan(33);
    expect(maxSlope(straight)).toBeGreaterThanOrEqual(0.1);
    expect(maxSlope(straight)).toBeLessThan(0.15);
  });

  it.each(TRACK_IDS)('runs on registered course %s without throwing', id => {
    const track = getTrack(id);
    expect(() => [findHairpins(track), findSCurves(track), findCompoundCorners(track)]).not.toThrow();
    expect(minCurvatureRadius(track)).toBeGreaterThan(0);
    expect(Number.isFinite(elevationRange(track).range)).toBe(true);
    expect(Number.isFinite(maxSlope(track))).toBe(true);
  });
});

describe('dirtCoverage', () => {
  it('weights dirt by the share of road width it covers', () => {
    const base = getTrack('meadow');
    const quarter = base.length / 4;
    const track = buildTrack({ ...base.def, surfaces: [
      { kind: 'dirt', from: 0, to: quarter },
      { kind: 'dirt', from: quarter, to: 2 * quarter, offsetMin: 0 },
    ] });
    expect(dirtCoverage(track)).toBeCloseTo(0.375, 2);
    expect(dirtCoverage(buildTrack({ ...base.def, surfaces: [] }))).toBe(0);
  });
});

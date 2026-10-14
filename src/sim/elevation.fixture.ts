import { buildTrack } from './track';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './tracks/widths';
import type { TrackDef } from './types';

/**
 * Synthetic elevation courses for the M4 tests. They are deliberately not registered
 * (TRACK_IDS / TRACKS / COURSE_FINGERPRINT stay unchanged); tests mock getTrack.
 * None has bands, islands or surface zones; each has four gates and 24 boxes.
 */

type Point = readonly [x: number, y: number, z: number];

const SAMPLES_PER_SEGMENT = 16;

function course(name: string, controlPoints: readonly Point[], extra: Partial<TrackDef> = {}): TrackDef {
  return {
    id: 'meadow', name, controlPoints, scale: 1, samplesPerSegment: SAMPLES_PER_SEGMENT,
    roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH, checkpointCount: 4,
    boxRows: [0.02, 0.12, 0.24, 0.36, 0.47, 0.58, 0.695, 0.81], boxLanes: [-5.33, 0, 5.33],
    racingLine: [], surfaces: [], themeId: 'meadow', ...extra,
  };
}

/** Stadium geometry: 300 m straights, radius-50 semicircular corners, control points every ~5 m. */
const STRAIGHT_HALF = 150;
const STRAIGHT_STEP = 5;
const CORNER_RADIUS = 50;
const CORNER_STEPS = 32;
/** One sample per control point: sample grades are then chord grades and never exceed the ramp. */
const STADIUM_SAMPLES = 1;
/** Each straight keeps its last 10 m at the end heights, so the corners stay exactly flat. */
const RAMP_HALF = 140;
/** Quadratic easing at each end of the ramp keeps the grade continuous (no spline overshoot). */
const EASE = 20;
const STRAIGHT_POINTS = 2 * STRAIGHT_HALF / STRAIGHT_STEP;
/** Height gained by slopeCourse per unit grade: the right corner sits at SLOPE_RISE × grade. */
export const SLOPE_RISE = 2 * RAMP_HALF - EASE;
/** Control point indices: bottom straight 0, right corner 60, top straight 92, left corner 152. */
const RIGHT = STRAIGHT_POINTS;
const TOP = RIGHT + CORNER_STEPS;
const LEFT = TOP + STRAIGHT_POINTS;
/** Exact grade holds where four consecutive control points are collinear on the ramp: |x| ≤ 110. */
const EXACT_HALF = 110;

/**
 * Stadium: the bottom straight runs +x along z = 0 from x = −150, the right corner turns left
 * around (150, 50), the top straight runs −x along z = 100 and the left corner closes the loop.
 * Dense, evenly spaced control points keep the uniform spline on the intended geometry.
 * height(x) is the straight height; the right corner sits at height(150), the left at height(−150).
 */
function stadium(height: (x: number) => number): Point[] {
  const points: Point[] = [];
  const corner = (cx: number, from: number, y: number): void => {
    for (let k = 0; k < CORNER_STEPS; k++) {
      const angle = from + Math.PI * k / CORNER_STEPS;
      points.push([cx + CORNER_RADIUS * Math.cos(angle), y, CORNER_RADIUS + CORNER_RADIUS * Math.sin(angle)]);
    }
  };
  for (let i = 0; i < STRAIGHT_POINTS; i++) {
    const x = -STRAIGHT_HALF + STRAIGHT_STEP * i;
    points.push([x, height(x), 0]);
  }
  corner(STRAIGHT_HALF, -Math.PI / 2, height(STRAIGHT_HALF));
  for (let i = 0; i < STRAIGHT_POINTS; i++) {
    const x = STRAIGHT_HALF - STRAIGHT_STEP * i;
    points.push([x, height(x), 2 * CORNER_RADIUS]);
  }
  corner(-STRAIGHT_HALF, Math.PI / 2, height(-STRAIGHT_HALF));
  return points;
}

/**
 * Stadium whose bottom straight climbs at +grade (driving +x) and whose top straight descends
 * at −grade (driving −x). The ramp spans |x| ≤ 140 and eases in and out over 20 m, rising
 * SLOPE_RISE × grade; both corners are exactly flat. grade 0 is a flat course at y = 0.
 */
export function slopeCourse(grade: number): TrackDef {
  const height = (x: number): number => {
    const s = Math.max(0, Math.min(2 * RAMP_HALF, x + RAMP_HALF));
    if (s < EASE) return grade * s * s / (2 * EASE);
    if (s > 2 * RAMP_HALF - EASE) return grade * (SLOPE_RISE - (2 * RAMP_HALF - s) ** 2 / (2 * EASE));
    return grade * (s - EASE / 2);
  };
  return course(`SLOPE ${grade}`, stadium(height), { samplesPerSegment: STADIUM_SAMPLES });
}

export interface StadiumSections {
  readonly length: number;
  /** Exact +grade span of the bottom straight, in driving order. */
  readonly up: readonly [from: number, to: number];
  /** Exact −grade span of the top straight, in driving order. */
  readonly down: readonly [from: number, to: number];
  readonly rightCorner: readonly [from: number, to: number];
  readonly leftCorner: readonly [from: number, to: number];
}

/** Arc-length spans of a stadium course (slopeCourse / bankCourse). */
export function stadiumSections(def: TrackDef): StadiumSections {
  const track = buildTrack(def);
  const at = (point: number): number => point === LEFT + CORNER_STEPS ? track.length
    : track.samples[point * def.samplesPerSegment]!.distance;
  const offset = (STRAIGHT_HALF - EXACT_HALF) / STRAIGHT_STEP;
  return {
    length: track.length,
    up: [at(offset), at(RIGHT - offset)],
    down: [at(TOP + offset), at(LEFT - offset)],
    rightCorner: [at(RIGHT), at(TOP)],
    leftCorner: [at(LEFT), at(LEFT + CORNER_STEPS)],
  };
}

/**
 * Flat stadium with the right corner (radius 50) banked at roll; the bank ramps over
 * 20 m of straight on each side (twist |roll| / 20 ≤ 0.0175 rad/m for |roll| ≤ 0.35).
 * Positive roll raises the +offset side, which is the outside of this left-hand corner.
 */
export function bankCourse(roll: number): TrackDef {
  const base = course(`BANK ${roll}`, stadium(() => 0), { samplesPerSegment: STADIUM_SAMPLES });
  const { rightCorner: [from, to], length } = stadiumSections(base);
  return {
    ...base,
    bankKeys: [
      { distance: 0, roll: 0 },
      { distance: from - 20, roll: 0 },
      { distance: from, roll },
      { distance: to, roll },
      { distance: to + 20, roll: 0 },
      { distance: length, roll: 0 },
    ],
  };
}

/**
 * Lobe radius of the figure eight; each lobe is a 270° arc tangent to both diagonals, so the
 * diagonals run R = 60 m from the crossing to each lobe. That keeps more than 31.8 m of straight
 * beyond each deck end, where validateTrackDef pairs deck samples with same-height road nearby.
 */
const LOBE_RADIUS = 60;
/** Seven steps keep the 26-point loop (upper pass at index 3, lower at 16) that corridor.test.ts rotates. */
const LOBE_STEPS = 7;
/** Height of the second (upper) pass over the XZ origin. */
export const FIGURE_EIGHT_UPPER_Y = 12.5;
/** Loop index where the course starts, and control point indices of the two passes. */
const START = 10;
const UPPER_PASS = 13 - START;
const LOWER_PASS = 26 - START;

/**
 * Figure eight crossing itself at the XZ origin at 90°: the first pass (along +x+z) at
 * y = 0 and the second (along −x+z) at y = 12.5. The diagonals are flat for 60 m on each
 * side of the crossing; each lobe changes height with a half-cosine profile
 * (max grade ≈ 12.5 × π / 2 / 283 ≈ 0.07). The start sits in the right lobe so every gate
 * stays more than 25 m from both crossings. decks covers ±20 m of the upper pass.
 */
export function figureEightCourse(): TrackDef {
  const r = LOBE_RADIUS;
  const diagonal = Math.SQRT1_2;
  const lobe = (cx: number, start: number, direction: number, from: number, to: number): Point[] =>
    Array.from({ length: LOBE_STEPS + 1 }, (_, k) => {
      const angle = (start + direction * 270 / LOBE_STEPS * k) * Math.PI / 180;
      const y = from + (to - from) * (1 - Math.cos(Math.PI * k / LOBE_STEPS)) / 2;
      return [cx + r * Math.cos(angle), y, r * Math.sin(angle)] as const;
    });
  const along = (s: number, dx: number, y: number): Point => [s * diagonal * dx, y, s * diagonal];
  const upperY = FIGURE_EIGHT_UPPER_Y;
  // Right lobe clockwise from its +x+z tangent point (135°) to its +x−z tangent point (−135°).
  const right = lobe(r * Math.SQRT2, 135, -1, 0, upperY);
  // Left lobe counter-clockwise from its −x+z tangent point (45°) to its −x−z tangent point (315°).
  const left = lobe(-r * Math.SQRT2, 45, 1, upperY, 0);
  // Loop indices: lower pass 0, right lobe 3–10, upper pass 13, left lobe 16–23.
  const loop: Point[] = [
    along(0, 1, 0), along(20, 1, 0), along(40, 1, 0), ...right,
    along(-40, -1, upperY), along(-20, -1, upperY), along(0, -1, upperY), along(20, -1, upperY), along(40, -1, upperY),
    ...left, along(-40, 1, 0), along(-20, 1, 0),
  ];
  // Start where the right lobe ends, 60 m before the upper pass (about length / 13).
  const controlPoints = [...loop.slice(START), ...loop.slice(0, START)];
  const base = course('FIGURE EIGHT', controlPoints);
  const upper = buildTrack(base).samples[UPPER_PASS * SAMPLES_PER_SEGMENT]!.distance;
  return { ...base, decks: [{ from: upper - 20, to: upper + 20 }] };
}

/** Arc-length distances of the lower (y = 0) and upper (y = 12.5) passes over the origin. */
export function figureEightCrossings(def: TrackDef): { lower: number; upper: number } {
  const track = buildTrack(def);
  return {
    lower: track.samples[LOWER_PASS * SAMPLES_PER_SEGMENT]!.distance,
    upper: track.samples[UPPER_PASS * SAMPLES_PER_SEGMENT]!.distance,
  };
}

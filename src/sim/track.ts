import type { TrackProjection, TrackSample } from './types';

export const ROAD_HALF_WIDTH = 7.2;
export const WALL_HALF_WIDTH = 10.5;
const CONTROL_POINTS = [
  [0, 0.7, 82], [46, 2, 74], [87, 7.2, 47], [91, 8.5, 2],
  [65, 4.5, -27], [86, 1.5, -70], [32, 0.8, -91], [-26, 0.4, -86],
  [-75, 2.5, -62], [-91, 6.4, -10], [-68, 4, 38], [-31, 1.2, 58],
];
const SEGMENT_SAMPLES = 32;

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return 0.5 * (2 * p1 + (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

/** Closed, arc-length indexed Catmull-Rom course; all geometry comes from this table. */
export const TRACK_SAMPLES: TrackSample[] = [];
for (let i = 0; i < CONTROL_POINTS.length; i++) {
  const n = CONTROL_POINTS.length;
  const p0 = CONTROL_POINTS[(i + n - 1) % n]!;
  const p1 = CONTROL_POINTS[i]!;
  const p2 = CONTROL_POINTS[(i + 1) % n]!;
  const p3 = CONTROL_POINTS[(i + 2) % n]!;
  for (let j = 0; j < SEGMENT_SAMPLES; j++) {
    const t = j / SEGMENT_SAMPLES;
    const sample: TrackSample = {
      x: catmull(p0[0]!, p1[0]!, p2[0]!, p3[0]!, t) * 1.1,
      y: catmull(p0[1]!, p1[1]!, p2[1]!, p3[1]!, t),
      z: catmull(p0[2]!, p1[2]!, p2[2]!, p3[2]!, t) * 1.1,
      tx: 0, tz: 0, nx: 0, nz: 0, distance: 0,
    };
    const previous = TRACK_SAMPLES.at(-1);
    if (previous) sample.distance = previous.distance + Math.hypot(sample.x - previous.x, sample.z - previous.z);
    TRACK_SAMPLES.push(sample);
  }
}
const first = TRACK_SAMPLES[0]!;
const last = TRACK_SAMPLES.at(-1)!;
export const TRACK_LENGTH = last.distance + Math.hypot(first.x - last.x, first.z - last.z);
for (let i = 0; i < TRACK_SAMPLES.length; i++) {
  const previous = TRACK_SAMPLES[(i + TRACK_SAMPLES.length - 1) % TRACK_SAMPLES.length]!;
  const next = TRACK_SAMPLES[(i + 1) % TRACK_SAMPLES.length]!;
  const sample = TRACK_SAMPLES[i]!;
  const length = Math.hypot(next.x - previous.x, next.z - previous.z);
  sample.tx = (next.x - previous.x) / length;
  sample.tz = (next.z - previous.z) / length;
  sample.nx = sample.tz;
  sample.nz = -sample.tx;
}

export function wrapDistance(distance: number): number {
  return ((distance % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH;
}

export function sampleTrack(distance: number): TrackSample {
  const d = wrapDistance(distance);
  let low = 0;
  let high = TRACK_SAMPLES.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (TRACK_SAMPLES[mid]!.distance <= d) low = mid;
    else high = mid - 1;
  }
  const a = TRACK_SAMPLES[low]!;
  const b = TRACK_SAMPLES[(low + 1) % TRACK_SAMPLES.length]!;
  const segmentLength = low === TRACK_SAMPLES.length - 1 ? TRACK_LENGTH - a.distance : b.distance - a.distance;
  const t = segmentLength > 0 ? (d - a.distance) / segmentLength : 0;
  const tx = a.tx + (b.tx - a.tx) * t;
  const tz = a.tz + (b.tz - a.tz) * t;
  const tangentLength = Math.hypot(tx, tz);
  return {
    x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t, tx: tx / tangentLength, tz: tz / tangentLength,
    nx: tz / tangentLength, nz: -tx / tangentLength, distance: d,
  };
}

export function projectToTrack(x: number, z: number): TrackProjection {
  let nearestSquared = Infinity;
  let nearestDistance = 0;
  let nearestX = 0;
  let nearestZ = 0;
  for (let i = 0; i < TRACK_SAMPLES.length; i++) {
    const a = TRACK_SAMPLES[i]!;
    const b = TRACK_SAMPLES[(i + 1) % TRACK_SAMPLES.length]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const squared = (x - px) ** 2 + (z - pz) ** 2;
    if (squared < nearestSquared) {
      nearestSquared = squared;
      nearestDistance = a.distance + Math.sqrt(lengthSquared) * t;
      nearestX = px;
      nearestZ = pz;
    }
  }
  const sample = sampleTrack(nearestDistance);
  return {
    distance: sample.distance,
    offset: (x - nearestX) * sample.nx + (z - nearestZ) * sample.nz,
    height: sample.y,
    heading: Math.atan2(sample.tx, sample.tz),
  };
}

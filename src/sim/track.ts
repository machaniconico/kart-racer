import { exclusionAt, widthAt } from './corridor';
import type { CorridorNormal } from './corridor';
import type { Barrier, Pose, Track, TrackDef, TrackProjection, TrackSample } from './types';

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return 0.5 * (2 * p1 + (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

type ControlPoint = TrackDef['controlPoints'][number];

/** Non-uniform Catmull-Rom; the uniform MEADOW path remains unchanged. */
function centripetal(p0: ControlPoint, p1: ControlPoint, p2: ControlPoint, p3: ControlPoint,
  t: number, scale: number): number[] {
  const points = [p0, p1, p2, p3].map(([x, y, z]) => [x * scale, y, z * scale]);
  const knots = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const step = Math.sqrt(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!));
    if (step === 0) throw new RangeError('Centripetal control points must be distinct');
    knots.push(knots[i - 1]! + step);
  }
  const u = knots[1]! + (knots[2]! - knots[1]!) * t;
  const blend = (a: number, b: number, from: number, to: number): number =>
    ((to - u) * a + (u - from) * b) / (to - from);
  return [0, 1, 2].map(axis => {
    const a = blend(points[0]![axis]!, points[1]![axis]!, knots[0]!, knots[1]!);
    const b = blend(points[1]![axis]!, points[2]![axis]!, knots[1]!, knots[2]!);
    const c = blend(points[2]![axis]!, points[3]![axis]!, knots[2]!, knots[3]!);
    const d = blend(a, b, knots[0]!, knots[2]!);
    const e = blend(b, c, knots[1]!, knots[3]!);
    return blend(d, e, knots[1]!, knots[2]!);
  });
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Build an immutable, arc-length indexed course using only its JSON definition. */
export function buildTrack(definition: TrackDef): Track {
  if (definition.boxRows.length !== 4 || definition.boxLanes.length !== 3) {
    throw new RangeError('A course requires twelve boxes in four rows and three lanes');
  }
  if (definition.controlPoints.length < 4 || !Number.isInteger(definition.samplesPerSegment) ||
    definition.samplesPerSegment < 1 || !Number.isInteger(definition.checkpointCount) || definition.checkpointCount < 1) {
    throw new RangeError('A course requires four control points and positive sample/checkpoint counts');
  }
  const def: TrackDef = JSON.parse(JSON.stringify(definition));
  const samples: TrackSample[] = [];
  for (let i = 0; i < def.controlPoints.length; i++) {
    const n = def.controlPoints.length;
    const p0 = def.controlPoints[(i + n - 1) % n]!;
    const p1 = def.controlPoints[i]!;
    const p2 = def.controlPoints[(i + 1) % n]!;
    const p3 = def.controlPoints[(i + 2) % n]!;
    for (let j = 0; j < def.samplesPerSegment; j++) {
      const t = j / def.samplesPerSegment;
      const curve = def.spline === 'centripetal' ? centripetal(p0, p1, p2, p3, t, def.scale) : null;
      const sample: TrackSample = {
        x: curve ? curve[0]! : catmull(p0[0]!, p1[0]!, p2[0]!, p3[0]!, t) * def.scale,
        y: curve ? curve[1]! : catmull(p0[1]!, p1[1]!, p2[1]!, p3[1]!, t),
        z: curve ? curve[2]! : catmull(p0[2]!, p1[2]!, p2[2]!, p3[2]!, t) * def.scale,
        tx: 0, tz: 0, nx: 0, nz: 0, distance: 0,
      };
      const previous = samples.at(-1);
      if (previous) sample.distance = previous.distance + Math.hypot(sample.x - previous.x, sample.z - previous.z);
      samples.push(sample);
    }
  }
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const length = last.distance + Math.hypot(first.x - last.x, first.z - last.z);
  for (let i = 0; i < samples.length; i++) {
    const previous = samples[(i + samples.length - 1) % samples.length]!;
    const next = samples[(i + 1) % samples.length]!;
    const sample = samples[i]!;
    const length = Math.hypot(next.x - previous.x, next.z - previous.z);
    sample.tx = (next.x - previous.x) / length;
    sample.tz = (next.z - previous.z) / length;
    sample.nx = sample.tz;
    sample.nz = -sample.tx;
  }

  const boxPoses: Pose[] = [];
  const track: Track = {
    def, samples, length,
    checkpointDistances: Array.from({ length: def.checkpointCount }, (_, i) => i * length / def.checkpointCount),
    boxPoses,
  };
  for (const fraction of def.boxRows) {
    const sample = sampleTrack(track, length * fraction);
    for (const offset of def.boxLanes) {
      boxPoses.push({ x: sample.x + sample.nx * offset, y: sample.y,
        z: sample.z + sample.nz * offset, heading: Math.atan2(sample.tx, sample.tz) });
    }
  }
  return freezeDeep(track);
}

export function wrapDistance(track: Track, distance: number): number {
  return ((distance % track.length) + track.length) % track.length;
}

function segmentIndex(track: Track, distance: number): number {
  const d = wrapDistance(track, distance);
  let low = 0;
  let high = track.samples.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (track.samples[mid]!.distance <= d) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function sampleTrack(track: Track, distance: number): TrackSample {
  const d = wrapDistance(track, distance);
  const low = segmentIndex(track, d);
  const a = track.samples[low]!;
  const b = track.samples[(low + 1) % track.samples.length]!;
  const segmentLength = low === track.samples.length - 1 ? track.length - a.distance : b.distance - a.distance;
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

export function projectToTrack(track: Track, x: number, z: number, previousDistance?: number): TrackProjection {
  const count = track.samples.length;
  let startIndex = 0;
  let segmentCount = count;
  if (previousDistance !== undefined && Number.isFinite(previousDistance)) {
    const previous = sampleTrack(track, previousDistance);
    // Normal driving remains in the previous section, including the start seam.
    // Positions beyond the road corridor (respawns/teleports) reacquire globally.
    if (Math.hypot(x - previous.x, z - previous.z) <= widthAt(track, previousDistance).wallHalfWidth + 6) {
      startIndex = segmentIndex(track, previousDistance - 20);
      const endIndex = segmentIndex(track, previousDistance + 20);
      segmentCount = (endIndex - startIndex + count) % count + 1;
    }
  }
  let nearestSquared = Infinity;
  let nearestDistance = 0;
  let nearestX = 0;
  let nearestZ = 0;
  for (let step = 0; step < segmentCount; step++) {
    const i = (startIndex + step) % count;
    const a = track.samples[i]!;
    const b = track.samples[(i + 1) % track.samples.length]!;
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
  const sample = sampleTrack(track, nearestDistance);
  return {
    distance: sample.distance,
    offset: (x - nearestX) * sample.nx + (z - nearestZ) * sample.nz,
    height: sample.y,
    heading: Math.atan2(sample.tx, sample.tz),
  };
}

/** Strictly inside a barrier's kart-centre exclusion; the boundary itself is free. */
export function insideBarrier(track: Track, barrier: Barrier, distance: number, offset: number, time: number): boolean {
  const exclusion = exclusionAt(track, barrier, distance, time);
  return exclusion !== null && offset > exclusion.min && offset < exclusion.max;
}

/** Distance along a unit (arc, lateral) normal that leaves the exclusion, with a tiny clearance. */
export function barrierEscape(track: Track, barrier: Barrier, distance: number, offset: number,
  normal: CorridorNormal, time: number): number {
  const inside = (s: number): boolean =>
    insideBarrier(track, barrier, distance + normal.d * s, offset + normal.offset * s, time);
  let high = 0.25;
  for (let i = 0; i < 16 && inside(high); i++) high *= 2;
  let low = 0;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (inside(mid)) low = mid;
    else high = mid;
  }
  return high + 1e-6;
}

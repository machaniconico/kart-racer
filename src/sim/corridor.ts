import { buildTrack } from './track';
import { racingLineOffset } from './surfaces';
import type { Barrier, Track, TrackDef } from './types';

/** Same kart radius as race.ts; keep this geometry module independent of race state. */
export const KART_RADIUS = 0.95;
const MIN_PASSAGE = 2 * KART_RADIUS + 0.6;
const EPSILON = 1e-10;

export interface Interval { readonly min: number; readonly max: number }
export interface CorridorNormal { readonly d: number; readonly offset: number }
export interface Exclusion extends Interval {
  readonly halfWidth: number;
  /** Outward normal at the nearest side, or radially from the nose for a cap hit. */
  normalAt(offset: number): CorridorNormal;
}

function wrap(distance: number, length: number): number {
  const remainder = distance % length;
  return remainder < 0 ? remainder + length : remainder;
}

/** Keys are ordered in arc metres. The last/first pair also forms a segment. */
function keySegment<T extends { readonly distance: number }>(keys: readonly T[], length: number, distance: number) {
  const d = wrap(distance, length);
  let a = keys[keys.length - 1]!;
  let aDistance = a.distance - length;
  for (const b of keys) {
    if (d < b.distance) return { a, b, t: (d - aDistance) / (b.distance - aDistance) };
    a = b;
    aDistance = a.distance;
  }
  const b = keys[0]!;
  return { a, b, t: (d - aDistance) / (b.distance + length - aDistance) };
}

export function widthAt(track: Track, d: number): { roadHalfWidth: number; wallHalfWidth: number } {
  const keys = track.def.widthKeys;
  if (!keys?.length) return { roadHalfWidth: track.def.roadHalfWidth, wallHalfWidth: track.def.wallHalfWidth };
  const { a, b, t } = keySegment(keys, track.length, d);
  return {
    roadHalfWidth: a.roadHalfWidth + (b.roadHalfWidth - a.roadHalfWidth) * t,
    wallHalfWidth: a.wallHalfWidth + (b.wallHalfWidth - a.wallHalfWidth) * t,
  };
}

/**
 * Section 1.5's band expansion: semicircular caps and half(d) + R on the taper.
 * Distances and normals use (arc metres, lateral metres), including wrapped bands.
 * Motion is reserved for M3; time deliberately has no effect in M1.
 */
export function exclusionAt(track: Track, barrier: Barrier, d: number, _time: number): Exclusion | null {
  const radius = KART_RADIUS;
  const span = wrap(barrier.to - barrier.from, track.length);
  let along = wrap(d - barrier.from, track.length);
  // In the gap between the ends, choose the nearer cap, including across the seam.
  if (along > span && track.length - along < along - span) along -= track.length;
  const cap = along <= 0 ? along : along >= span ? along - span : null;
  if (cap !== null && Math.abs(cap) > radius + EPSILON) return null;
  const taper = barrier.taper ?? 4;
  // Wrapping can round an exact cap endpoint slightly inward; preserve its zero width.
  const halfWidth = cap !== null ? Math.abs(cap) >= radius - EPSILON ? 0 : Math.sqrt(radius * radius - cap * cap) :
    barrier.halfWidth * Math.min(1, along / taper, (span - along) / taper) + radius;
  const slope = along < taper && along < span / 2 ? barrier.halfWidth / taper :
    along > span - taper && along > span / 2 ? -barrier.halfWidth / taper : 0;
  return {
    min: barrier.center - halfWidth,
    max: barrier.center + halfWidth,
    halfWidth,
    normalAt(offset) {
      const lateral = offset - barrier.center;
      if (cap !== null) {
        const length = Math.hypot(cap, lateral);
        if (length === 0) return { d: along <= 0 ? -1 : 1, offset: 0 };
        return { d: cap / length, offset: lateral / length };
      }
      const length = Math.hypot(slope, 1);
      return { d: -slope / length, offset: (lateral < 0 ? -1 : 1) / length };
    },
  };
}

/** Subtract the union of expanded bands from the walls, preserving ascending order. */
export function corridorAt(track: Track, d: number, time: number): Interval[] {
  const { wallHalfWidth } = widthAt(track, d);
  let intervals: Interval[] = [{ min: -wallHalfWidth, max: wallHalfWidth }];
  for (const barrier of track.def.barriers ?? []) {
    const exclusion = exclusionAt(track, barrier, d, time);
    if (!exclusion) continue;
    const next: Interval[] = [];
    for (const interval of intervals) {
      if (exclusion.max < interval.min || exclusion.min > interval.max) next.push(interval);
      else {
        if (exclusion.min > interval.min) next.push({ min: interval.min, max: exclusion.min });
        if (exclusion.max < interval.max) next.push({ min: exclusion.max, max: interval.max });
      }
    }
    intervals = next;
  }
  return intervals;
}

/** Containing interval, or the nearest one; ties choose the earlier interval. */
export function freeIntervalFor(intervals: readonly Interval[], offset: number): Interval | undefined {
  let nearest: Interval | undefined;
  let bestDistance = Infinity;
  for (const interval of intervals) {
    const distance = Math.max(interval.min - offset, offset - interval.max, 0);
    if (distance < bestDistance) { nearest = interval; bestDistance = distance; }
  }
  return nearest;
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

function validateWidths(road: number, wall: number): void {
  requireFinite(road, 'roadHalfWidth');
  requireFinite(wall, 'wallHalfWidth');
  if (road < 3.6) throw new RangeError('roadHalfWidth must be at least 3.6 m');
  if (wall < road) throw new RangeError('wallHalfWidth must be at least roadHalfWidth');
}

/** Throws on unsafe M1 geometry without changing the source definition or its JSON. */
export function validateTrackDef(def: TrackDef): void {
  validateWidths(def.roadHalfWidth, def.wallHalfWidth);
  requireFinite(def.scale, 'scale');
  if (def.scale <= 0) throw new RangeError('scale must be positive');
  for (const point of def.controlPoints) for (const value of point) requireFinite(value, 'control point');
  const track = buildTrack(def);
  const { length } = track;
  if (!Number.isFinite(length) || length <= 0) throw new RangeError('Track length must be positive and finite');
  const phase = def.checkpointPhase ?? 0;
  requireFinite(phase, 'checkpointPhase');
  if (Math.abs(phase) >= 0.5) throw new RangeError('checkpointPhase must be between -0.5 and 0.5');

  const distances = new Set<number>();
  const addDistance = (d: number): void => { distances.add(wrap(d, length)); };
  const checkDistance = (d: number, label: string): void => {
    requireFinite(d, label);
    if (d < 0 || d > length) throw new RangeError(`${label} must be within the lap`);
  };
  const keys = def.widthKeys ?? [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    checkDistance(key.distance, 'widthKeys distance');
    validateWidths(key.roadHalfWidth, key.wallHalfWidth);
    if (i > 0 && key.distance <= keys[i - 1]!.distance) {
      throw new RangeError('widthKeys distances must be strictly increasing');
    }
    const next = keys[(i + 1) % keys.length]!;
    const span = next.distance - key.distance + (i === keys.length - 1 ? length : 0);
    if (Math.abs(next.roadHalfWidth - key.roadHalfWidth) > 0.35 * span + EPSILON ||
      Math.abs(next.wallHalfWidth - key.wallHalfWidth) > 0.35 * span + EPSILON) {
      throw new RangeError('widthKeys lateral slope must not exceed 0.35 (including the seam)');
    }
    // Explicit keys at both zero and length describe the very same point.
    if (span === 0 && (next.roadHalfWidth !== key.roadHalfWidth || next.wallHalfWidth !== key.wallHalfWidth)) {
      throw new RangeError('widthKeys at zero and length must match');
    }
    addDistance(key.distance);
  }

  const barriers = def.barriers ?? [];
  for (const barrier of barriers) {
    checkDistance(barrier.from, 'barrier from');
    checkDistance(barrier.to, 'barrier to');
    requireFinite(barrier.center, 'barrier center');
    requireFinite(barrier.halfWidth, 'barrier halfWidth');
    const taper = barrier.taper ?? 4;
    requireFinite(taper, 'barrier taper');
    if (taper < 2) throw new RangeError('barrier taper must be at least 2 m');
    if (barrier.halfWidth <= 0 || barrier.halfWidth / taper > 0.5) {
      throw new RangeError('barrier halfWidth must be positive and halfWidth / taper must not exceed 0.5');
    }
    if ((barrier.scenery === 'rock' || barrier.scenery === 'building') && taper < 8) {
      throw new RangeError('island taper must be at least 8 m');
    }
    const span = wrap(barrier.to - barrier.from, length);
    if (span === 0) throw new RangeError('barrier endpoints must be distinct around the lap');
    for (const d of [barrier.from - KART_RADIUS, barrier.from, barrier.from + Math.min(taper, span / 2),
      barrier.to - Math.min(taper, span / 2), barrier.to, barrier.to + KART_RADIUS]) addDistance(d);
  }

  const assertFree = (d: number, offset: number, label: string): void => {
    requireFinite(offset, `${label} offset`);
    if (barriers.some(barrier => {
      const exclusion = exclusionAt(track, barrier, d, 0);
      return exclusion !== null && offset >= exclusion.min && offset <= exclusion.max;
    })) throw new RangeError(`${label} is inside a barrier exclusion`);
  };
  for (const point of def.racingLine) {
    checkDistance(point.distance, 'racingLine distance');
    assertFree(point.distance, point.offset, 'racingLine');
    addDistance(point.distance);
  }
  for (let i = 1; i < def.racingLine.length; i++) {
    if (def.racingLine[i]!.distance <= def.racingLine[i - 1]!.distance) {
      throw new RangeError('racingLine distances must be strictly increasing');
    }
  }
  for (let slot = 0; slot < 8; slot++) {
    assertFree(length - 8 - Math.floor(slot / 2) * 4.5, slot % 2 === 0 ? -2 : 2, `start grid slot ${slot}`);
  }
  for (const row of def.boxRows) {
    requireFinite(row, 'box row');
    if (row < 0 || row >= 1) throw new RangeError('box rows must be lap fractions in [0, 1)');
    for (const offset of def.boxLanes) assertFree(row * length, offset, 'item box');
  }

  for (let d = 0; d < length; d += 0.5) addDistance(d);
  for (const d of distances) {
    if (!corridorAt(track, d, 0).some(interval => interval.max - interval.min >= MIN_PASSAGE - EPSILON)) {
      throw new RangeError(`No free interval at ${d} m is at least 2R + 0.6 m wide`);
    }
    if (def.racingLine.length) {
      assertFree(d, racingLineOffset(track, d), 'racingLine');
    }
  }
  for (let i = 0; i < def.checkpointCount; i++) {
    const gate = i === 0 ? 0 : (i + phase) * length / def.checkpointCount;
    for (const barrier of barriers) for (const tip of [barrier.from, barrier.to]) {
      const gap = wrap(gate - tip, length);
      if (Math.min(gap, length - gap) <= 10) throw new RangeError('checkpoint gate is within 10 m of a barrier tip');
    }
  }
}

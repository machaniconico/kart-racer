import { buildTrack } from './track';
import { racingLineOffset } from './surfaces';
import type { Barrier, SurfaceZone, Track, TrackDef } from './types';

/** Same kart radius as race.ts; keep this geometry module independent of race state. */
export const KART_RADIUS = 0.95;
const MIN_PASSAGE = 2 * KART_RADIUS + 0.6;
const PASSAGE_MARGIN = 0.05;
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

/** Closed, forward arcs; starts may be outside the lap, spans may cover a whole lap. */
function arcsOverlap(a: number, aSpan: number, b: number, bSpan: number, length: number): boolean {
  return aSpan >= length || bSpan >= length ||
    wrap(b - a, length) <= aSpan + EPSILON || wrap(a - b, length) <= bSpan + EPSILON;
}

function zoneOffsets(track: Track, zone: SurfaceZone, d: number): Interval {
  const { roadHalfWidth } = widthAt(track, d);
  return { min: zone.offsetMin ?? -roadHalfWidth, max: zone.offsetMax ?? roadHalfWidth };
}

/** The widest available route can have a minimum where two gap widths cross. */
function addPassageCrossings(track: Track, distances: Set<number>): void {
  const barriers = [...(track.def.barriers ?? [])].sort((a, b) => a.center - b.center);
  if (barriers.length < 2) return;
  const ordered = [...distances].sort((a, b) => a - b);
  for (let i = 0; i < ordered.length; i++) {
    const from = ordered[i]!;
    const to = ordered[i + 1] ?? ordered[0]! + track.length;
    const edges = barriers.map(barrier => [
      exclusionAt(track, barrier, from, 0), exclusionAt(track, barrier, to, 0),
    ] as const).filter((pair): pair is readonly [Exclusion, Exclusion] => pair[0] !== null && pair[1] !== null);
    if (edges.length < 2) continue;
    const widths = [from, to].map((d, end) => {
      const wall = widthAt(track, d).wallHalfWidth;
      const gaps = [2 * wall];
      for (let left = 0; left < edges.length; left++) {
        const edge = edges[left]![end]!;
        gaps.push(wall + edge.min, wall - edge.max);
        for (let right = left + 1; right < edges.length; right++) {
          gaps.push(edges[right]![end]!.min - edge.max);
        }
      }
      return gaps;
    });
    // Include every possible gap, including across overlapping bands: a union
    // can change which band's edge bounds a corridor between the samples.
    // Between geometric breakpoints these widths are linear; caps retain the
    // bounded interpolation error of the equal-angle samples and safety margin.
    for (let a = 0; a < widths[0]!.length; a++) for (let b = a + 1; b < widths[0]!.length; b++) {
      const start = widths[0]![a]! - widths[0]![b]!;
      const end = widths[1]![a]! - widths[1]![b]!;
      if ((start < 0 && end > 0) || (start > 0 && end < 0)) {
        distances.add(wrap(from + (to - from) * start / (start - end), track.length));
      }
    }
  }
}

/** Throws on unsafe geometry without changing the source definition or its JSON. */
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
    for (const tip of [barrier.from, barrier.to]) {
      for (const delta of [-taper, 0, taper]) addDistance(tip + delta);
    }
    addDistance(barrier.from + Math.min(taper, span / 2));
    addDistance(barrier.from + span - Math.min(taper, span / 2));
    // Equal angles bound lateral interpolation error on each semicircular nose.
    for (let k = 0; k <= 32; k++) {
      const s = KART_RADIUS * Math.cos(k * Math.PI / 64);
      addDistance(barrier.from - s);
      addDistance(barrier.to + s);
    }
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
  addPassageCrossings(track, distances);
  for (const d of distances) {
    if (!corridorAt(track, d, 0).some(interval => interval.max - interval.min >= MIN_PASSAGE + PASSAGE_MARGIN - EPSILON)) {
      throw new RangeError(`No free interval at ${d} m is at least 2R + 0.6 + 0.05 m wide`);
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

  const zones = def.surfaces.filter(zone => zone.kind === 'jump' || zone.kind === 'pit');
  for (const zone of zones) {
    checkDistance(zone.from, `${zone.kind} from`);
    checkDistance(zone.to, `${zone.kind} to`);
    if (wrap(zone.to - zone.from, length) === 0) throw new RangeError(`${zone.kind} endpoints must be distinct`);
    if (zone.offsetMin !== undefined) requireFinite(zone.offsetMin, `${zone.kind} offsetMin`);
    if (zone.offsetMax !== undefined) requireFinite(zone.offsetMax, `${zone.kind} offsetMax`);
    const span = wrap(zone.to - zone.from, length);
    for (const d of [zone.from, zone.to, ...keys.filter(key =>
      wrap(key.distance - zone.from, length) <= span + EPSILON).map(key => key.distance)]) {
      const offsets = zoneOffsets(track, zone, d);
      if (offsets.min >= offsets.max) throw new RangeError(`${zone.kind} offsets must be increasing`);
    }
  }
  const jumps = zones.filter(zone => zone.kind === 'jump');

  // Include exact feature boundaries as well as the shared geometry samples.
  const sectionDistances = (from: number, to: number): number[] => {
    const span = wrap(to - from, length);
    const result = [wrap(from, length), wrap(to, length)];
    for (let along = 0.5; along < span; along += 0.5) result.push(wrap(from + along, length));
    for (const d of distances) if (wrap(d - from, length) <= span + EPSILON) result.push(d);
    return result;
  };
  const splits = def.splits ?? [];
  for (const split of splits) {
    checkDistance(split.from, 'split from');
    checkDistance(split.to, 'split to');
    const span = wrap(split.to - split.from, length);
    if (span === 0 || split.lanes.length < 2) throw new RangeError('split needs a nonempty span and at least two lanes');
    for (const lane of split.lanes) {
      requireFinite(lane.offsetMin, 'split lane offsetMin');
      requireFinite(lane.offsetMax, 'split lane offsetMax');
      if (lane.offsetMax - lane.offsetMin < MIN_PASSAGE + 1 - EPSILON) {
        throw new RangeError('split lane width must be at least 2R + 0.6 + 1.0 m');
      }
    }
    for (const d of sectionDistances(split.from, split.to)) {
      const intervals = corridorAt(track, d, 0);
      if (intervals.length !== split.lanes.length) throw new RangeError('split free interval count must match its lanes');
      const used = new Set<number>();
      for (const lane of split.lanes) {
        const index = intervals.findIndex(interval => lane.offsetMin >= interval.min - EPSILON &&
          lane.offsetMax <= interval.max + EPSILON);
        if (index < 0 || used.has(index)) throw new RangeError('split lanes must occupy distinct free intervals');
        used.add(index);
      }
    }
    // The branch boundary belongs to the split; the preceding 35 m are unsplit.
    for (const d of sectionDistances(split.from - 35, split.from)) {
      if (wrap(d - split.from, length) < EPSILON) continue;
      if (corridorAt(track, d, 0).length !== 1) throw new RangeError('split approach must have one free interval for 35 m');
    }
  }
  for (const barrier of barriers) {
    if (barrier.scenery !== 'rock' && barrier.scenery !== 'building') continue;
    const span = wrap(barrier.to - barrier.from, length);
    if (!splits.some(split => wrap(barrier.from - split.from, length) + span <=
      wrap(split.to - split.from, length) + EPSILON)) {
      throw new RangeError('island barrier must be fully contained in a split');
    }
  }

  for (const pit of zones.filter(zone => zone.kind === 'pit')) {
    const span = wrap(pit.to - pit.from, length);
    const samples = sectionDistances(pit.from, pit.to);
    // A road edge is linear between width keys. On a cap, sqrt(R²-s²)
    // plus that edge can peak between angle samples at s=R*m/sqrt(1+m²).
    // Check those extrema too, so even a tiny pit/exclusion overlap is rejected.
    for (let i = 0; i < keys.length; i++) {
      const a = keys[i]!;
      const b = keys[(i + 1) % keys.length]!;
      const run = b.distance - a.distance + (i === keys.length - 1 ? length : 0);
      if (run <= 0) continue;
      const slope = Math.abs((b.roadHalfWidth - a.roadHalfWidth) / run);
      const s = KART_RADIUS * slope / Math.sqrt(1 + slope * slope);
      for (const barrier of barriers) for (const d of [barrier.from - s, barrier.to + s]) {
        if (wrap(d - pit.from, length) <= span + EPSILON) samples.push(wrap(d, length));
      }
    }
    const candidates = jumps.filter(jump => {
      const gap = wrap(pit.from - jump.from, length);
      const jumpOffsets = zoneOffsets(track, jump, jump.from);
      return gap >= 4 - EPSILON && gap <= 12 + EPSILON && samples.every(d => {
        const pitOffsets = zoneOffsets(track, pit, d);
        return jumpOffsets.min <= pitOffsets.min + EPSILON && jumpOffsets.max >= pitOffsets.max - EPSILON;
      });
    });
    if (!candidates.length) throw new RangeError('pit needs a jump covering its lateral range 4–12 m before it');
    if (!candidates.some(jump => {
      const speed = (wrap(pit.from - jump.from, length) + span) / 0.8;
      return speed >= 15 - EPSILON && speed <= 26 + EPSILON;
    })) throw new RangeError('pit clear speed must be between 15 and 26 m/s');
    for (const d of samples) {
      const offsets = zoneOffsets(track, pit, d);
      if (barriers.some(barrier => {
        const exclusion = exclusionAt(track, barrier, d, 0);
        return exclusion && exclusion.max >= offsets.min && exclusion.min <= offsets.max;
      })) throw new RangeError('pit must not overlap a barrier exclusion');
    }
    for (let i = 0; i < def.checkpointCount; i++) {
      const gate = i === 0 ? 0 : (i + phase) * length / def.checkpointCount;
      if (wrap(gate - pit.from, length) <= span + EPSILON) throw new RangeError('pit must not contain a checkpoint gate');
    }
  }
}

/** Placement rules for the registered courses only. validateTrackDef does not call this, so synthetic layouts in tests stay free of them. */
export function validateCoursePlayability(def: TrackDef): void {
  const track = buildTrack(def);
  const { length } = track;
  const barriers = def.barriers ?? [];
  for (let slot = 0; slot < 8; slot++) {
    const start = length - 8 - Math.floor(slot / 2) * 4.5;
    if (barriers.some(barrier => arcsOverlap(start, 100, barrier.from - KART_RADIUS,
      wrap(barrier.to - barrier.from, length) + 2 * KART_RADIUS, length))) {
      throw new RangeError(`start grid slot ${slot} has a barrier exclusion within 100 m ahead`);
    }
  }
  for (const row of def.boxRows) {
    if (barriers.some(barrier => {
      const start = barrier.from - KART_RADIUS;
      const span = wrap(barrier.to - barrier.from, length) + 2 * KART_RADIUS;
      const d = row * length;
      const gap = wrap(d - start, length) <= span ? 0 :
        Math.min(wrap(start - d, length), wrap(d - start - span, length));
      return gap < 8 - EPSILON;
    })) throw new RangeError('item box row must be at least 8 m from a barrier exclusion');
  }
  for (const jump of def.surfaces.filter(zone => zone.kind === 'jump')) {
    for (const barrier of barriers) for (const tip of [barrier.from, barrier.to]) {
      const offsets = zoneOffsets(track, jump, tip);
      if (wrap(tip - (jump.from - 10), length) <= 50 + EPSILON &&
        barrier.center + KART_RADIUS >= offsets.min && barrier.center - KART_RADIUS <= offsets.max) {
        throw new RangeError('jump has a laterally overlapping barrier nose from -10 to +40 m');
      }
    }
  }
}

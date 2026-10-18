import { buildTrack, rollAt, slopeAt } from './track';
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

/** Lateral centre in metres at race time in seconds (zero during countdown). */
export function barrierCenterAt(barrier: Barrier, time: number): number {
  const motion = barrier.motion;
  if (motion?.kind !== 'sweep') return barrier.center;
  return barrier.center + motion.amplitude * Math.sin(2 * Math.PI * time / motion.period + motion.phase);
}

/** Half-width in metres; a phase-zero gate starts at its static half-width. */
export function barrierHalfWidthAt(barrier: Barrier, time: number): number {
  const motion = barrier.motion;
  if (motion?.kind !== 'gate') return barrier.halfWidth;
  return barrier.halfWidth - (barrier.halfWidth - motion.minWidth!) *
    (1 - Math.cos(2 * Math.PI * time / motion.period + motion.phase)) / 2;
}

/**
 * Section 1.5's band expansion: semicircular caps and half(d) + R on the taper.
 * Distances and normals use (arc metres, lateral metres), including wrapped bands.
 */
export function exclusionAt(track: Track, barrier: Barrier, d: number, time: number): Exclusion | null {
  const radius = KART_RADIUS;
  const span = wrap(barrier.to - barrier.from, track.length);
  let along = wrap(d - barrier.from, track.length);
  // In the gap between the ends, choose the nearer cap, including across the seam.
  if (along > span && track.length - along < along - span) along -= track.length;
  const cap = along <= 0 ? along : along >= span ? along - span : null;
  if (cap !== null && Math.abs(cap) > radius + EPSILON) return null;
  const taper = barrier.taper ?? 4;
  const center = barrierCenterAt(barrier, time);
  const bandHalfWidth = barrierHalfWidthAt(barrier, time);
  // Wrapping can round an exact cap endpoint slightly inward; preserve its zero width.
  const halfWidth = cap !== null ? Math.abs(cap) >= radius - EPSILON ? 0 : Math.sqrt(radius * radius - cap * cap) :
    bandHalfWidth * Math.min(1, along / taper, (span - along) / taper) + radius;
  const slope = along < taper && along < span / 2 ? bandHalfWidth / taper :
    along > span - taper && along > span / 2 ? -bandHalfWidth / taper : 0;
  return {
    min: center - halfWidth,
    max: center + halfWidth,
    halfWidth,
    normalAt(offset) {
      const lateral = offset - center;
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
function addPassageCrossings(track: Track, distances: Set<number>, time: number): void {
  const barriers = [...(track.def.barriers ?? [])].sort((a, b) => barrierCenterAt(a, time) - barrierCenterAt(b, time));
  if (barriers.length < 2) return;
  const ordered = [...distances].sort((a, b) => a - b);
  for (let i = 0; i < ordered.length; i++) {
    const from = ordered[i]!;
    const to = ordered[i + 1] ?? ordered[0]! + track.length;
    const edges = barriers.map(barrier => [
      exclusionAt(track, barrier, from, time), exclusionAt(track, barrier, to, time),
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

/** Validated motions only: a common time grid plus exact phase extrema, without an LCM. */
function barrierSampleTimes(barriers: readonly Barrier[]): number[] {
  const motions = barriers.flatMap(barrier => barrier.motion ? [barrier.motion] : []);
  if (!motions.length) return [0];
  const minPeriod = Math.min(...motions.map(motion => motion.period));
  const maxPeriod = Math.max(...motions.map(motion => motion.period));
  const times = new Set([0, maxPeriod]);
  const step = minPeriod / 32;
  for (let i = 1; i * step < maxPeriod; i++) times.add(i * step);
  for (const motion of motions) {
    for (let quarter = 0; quarter < 4; quarter++) {
      const first = wrap((quarter * Math.PI / 2 - motion.phase) * motion.period / (2 * Math.PI), motion.period);
      for (let cycle = 0; first + cycle * motion.period <= maxPeriod; cycle++) {
        times.add(first + cycle * motion.period);
      }
    }
  }
  return [...times].sort((a, b) => a - b);
}

/** Closed forward arcs include wrapped decks and the zero/length seam. */
function onDeck(track: Track, distance: number): boolean {
  return (track.def.decks ?? []).some(deck =>
    arcsOverlap(deck.from, deck.to === track.length && deck.from === 0 ? track.length :
      wrap(deck.to - deck.from, track.length), distance, 0, track.length));
}

function validateCrossings(track: Track, slopes: readonly number[]): void {
  const { samples, length, def } = track;
  const bankKeys = def.bankKeys;
  const checkApproach = (distance: number): void => {
    const from = wrap(distance - 20, length);
    const to = wrap(distance + 20, length);
    if (Math.abs(slopeAt(track, from)) > 0.10 + EPSILON || Math.abs(slopeAt(track, to)) > 0.10 + EPSILON ||
      samples.some((sample, i) => wrap(sample.distance - from, length) <= 40 + EPSILON &&
        Math.abs(slopes[i]!) > 0.10 + EPSILON)) {
      throw new RangeError('crossing slope within 20 m must not exceed 0.10');
    }
    if (bankKeys?.length && (Math.abs(rollAt(track, from)) > 0.10 + EPSILON ||
      Math.abs(rollAt(track, to)) > 0.10 + EPSILON || bankKeys.some(key =>
        wrap(key.distance - from, length) <= 40 + EPSILON && Math.abs(key.roll) > 0.10 + EPSILON))) {
      throw new RangeError('crossing roll within 20 m must not exceed 0.10');
    }
    if (track.checkpointDistances.some(gate => {
      const gap = wrap(gate - distance, length);
      return Math.min(gap, length - gap) <= 25 + EPSILON;
    })) throw new RangeError('checkpoint gate is within 25 m of a crossing');
  };

  // Sweep X bounds before testing pairs (O(n²) worst case). Ordinary courses
  // avoid the full pair scan; undeclared crossings still cannot escape validation.
  const segments = samples.map((a, index) => {
    const b = samples[(index + 1) % samples.length]!;
    return { a, b, index, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
      minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) };
  }).sort((a, b) => a.minX - b.minX || a.index - b.index);
  for (let i = 0; i < segments.length; i++) {
    const first = segments[i]!;
    const { a, b } = first;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    for (let j = i + 1; j < segments.length; j++) {
      const second = segments[j]!;
      if (second.minX > first.maxX + EPSILON) break;
      const apart = Math.abs(first.index - second.index);
      if (apart === 1 || apart === samples.length - 1 ||
        first.maxZ < second.minZ - EPSILON || second.maxZ < first.minZ - EPSILON) continue;
      const { a: c, b: d } = second;
      const ex = d.x - c.x;
      const ez = d.z - c.z;
      const qx = c.x - a.x;
      const qz = c.z - a.z;
      const cross = dx * ez - dz * ex;
      if (Math.abs(cross) <= EPSILON) {
        if (Math.abs(qx * dz - qz * dx) <= EPSILON) {
          throw new RangeError('crossing angle must be at least 45 degrees');
        }
        continue;
      }
      const t = (qx * ez - qz * ex) / cross;
      const u = (qx * dz - qz * dx) / cross;
      if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) continue;
      const ay = a.y + (b.y - a.y) * t;
      const cy = c.y + (d.y - c.y) * u;
      if (Math.abs(ay - cy) < 12 - EPSILON) {
        throw new RangeError('crossing centreline height difference must be at least 12 m');
      }
      if (Math.abs(dx * ex + dz * ez) > Math.SQRT1_2 * Math.hypot(dx, dz) * Math.hypot(ex, ez) + EPSILON) {
        throw new RangeError('crossing angle must be at least 45 degrees');
      }
      const ad = wrap(a.distance + (first.index + 1 === samples.length ? length - a.distance : b.distance - a.distance) * t, length);
      const cd = wrap(c.distance + (second.index + 1 === samples.length ? length - c.distance : d.distance - c.distance) * u, length);
      if (!onDeck(track, ay > cy ? ad : cd)) {
        throw new RangeError('upper crossing must be within a deck');
      }
      checkApproach(ad);
      checkApproach(cd);
    }
  }

  if (def.decks?.length) {
    // 2 × maximum wall half-width (13.65) + explosion radius (4.5).
    const reach = 31.8;
    // Include the legacy 2 m arc for jumps without an explicit height.
    const jumps = def.surfaces.filter(zone => zone.kind === 'jump');
    const jumpHeight = jumps.length ? Math.max(...jumps.map(zone => zone.height ?? 2.0)) : 2.0;
    const heightDifference = 6.0 + jumpHeight;
    const deckSamples = samples.filter(sample => onDeck(track, sample.distance));
    const outsideSamples = samples.filter(sample => !onDeck(track, sample.distance));
    for (const a of deckSamples) for (const b of outsideSamples) {
      const gap = Math.abs(a.distance - b.distance);
      if (Math.min(gap, length - gap) <= reach) continue;
      if ((a.x - b.x) ** 2 + (a.z - b.z) ** 2 <= reach ** 2 + EPSILON && Math.abs(a.y - b.y) < heightDifference - EPSILON) {
        // LEVEL_GAP (6.0) + maximum jump height; no dependency on race state.
        throw new RangeError(`deck surface height difference must be at least ${heightDifference} m within 31.8 m`);
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
  if (def.physics?.maxRoll !== undefined) {
    requireFinite(def.physics.maxRoll, 'physics maxRoll');
    if (def.physics.maxRoll <= 0 || def.physics.maxRoll > 0.9) {
      throw new RangeError('physics maxRoll must be positive and at most 0.9');
    }
  }
  // Check source values: buildTrack's JSON copy turns NaN and infinities into null.
  for (const jump of def.surfaces.filter(zone => zone.kind === 'jump')) {
    if (jump.duration !== undefined) {
      requireFinite(jump.duration, 'jump duration');
      if (jump.duration <= 0 || jump.duration > 2.55) {
        throw new RangeError('jump duration must be positive and at most 2.55 s');
      }
    }
    if (jump.height !== undefined) {
      requireFinite(jump.height, 'jump height');
      if (jump.height < 0) throw new RangeError('jump height must be nonnegative');
    }
  }

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

  const slopes = track.samples.map(sample => slopeAt(track, sample.distance));
  if (def.physics !== undefined) {
    if (slopes.some(slope => !Number.isFinite(slope) || Math.abs(slope) > 0.55 + EPSILON)) {
      throw new RangeError('Track slope must not exceed 0.55');
    }
  } else if (slopes.some(slope => !Number.isFinite(slope) || Math.abs(slope) > 0.30 + EPSILON)) {
    throw new RangeError('Track slope must not exceed 0.30');
  }
  const bankKeys = def.bankKeys;
  if (bankKeys?.length) for (let i = 0; i < bankKeys.length; i++) {
    const key = bankKeys[i]!;
    checkDistance(key.distance, 'bankKeys distance');
    requireFinite(key.roll, 'bankKeys roll');
    if (def.physics !== undefined) {
      if (Math.abs(key.roll) > 0.9) throw new RangeError('bankKeys roll must not exceed 0.9');
    } else if (Math.abs(key.roll) > 0.35) throw new RangeError('bankKeys roll must not exceed 0.35');
    if (i > 0 && key.distance <= bankKeys[i - 1]!.distance) {
      throw new RangeError('bankKeys distances must be strictly increasing');
    }
  }
  if (bankKeys?.length) for (let i = 0; i < bankKeys.length; i++) {
    const key = bankKeys[i]!;
    const next = bankKeys[(i + 1) % bankKeys.length]!;
    const span = next.distance - key.distance + (i === bankKeys.length - 1 ? length : 0);
    if (span === 0 && next.roll !== key.roll) throw new RangeError('bankKeys at zero and length must match');
    if (Math.abs(next.roll - key.roll) > 0.02 * span + EPSILON) {
      throw new RangeError('bankKeys twist must not exceed 0.02 rad/m (including the seam)');
    }
  }
  const decks = def.decks;
  if (decks?.length) for (let i = 0; i < decks.length; i++) {
    const deck = decks[i]!;
    checkDistance(deck.from, 'deck from');
    checkDistance(deck.to, 'deck to');
    const span = deck.to === length && deck.from === 0 ? length : wrap(deck.to - deck.from, length);
    for (let j = 0; j < i; j++) {
      const previous = decks[j]!;
      const previousSpan = previous.to === length && previous.from === 0 ? length : wrap(previous.to - previous.from, length);
      if (arcsOverlap(deck.from, span, previous.from, previousSpan, length)) {
        throw new RangeError('deck distance ranges must not overlap');
      }
    }
  }
  validateCrossings(track, slopes);

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
    const motion = barrier.motion;
    if (motion) {
      requireFinite(motion.period, 'barrier motion period');
      requireFinite(motion.amplitude, 'barrier motion amplitude');
      requireFinite(motion.phase, 'barrier motion phase');
      if (motion.period <= 0) throw new RangeError('barrier motion period must be positive');
      if (motion.amplitude < 0) throw new RangeError('barrier motion amplitude must be nonnegative');
      if (motion.kind === 'gate') {
        if (motion.minWidth === undefined) throw new RangeError('gate minWidth is required');
        requireFinite(motion.minWidth, 'gate minWidth');
        if (motion.minWidth <= 0 || motion.minWidth > barrier.halfWidth) {
          throw new RangeError('gate minWidth must be positive and at most halfWidth');
        }
      }
      const speed = motion.kind === 'sweep' ? 2 * Math.PI * motion.amplitude / motion.period :
        Math.PI * (barrier.halfWidth - motion.minWidth!) / motion.period;
      if (speed > 6) throw new RangeError('barrier edge speed must not exceed 6 m/s');
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

  const moving = barriers.filter(barrier => barrier.motion);
  for (let i = 0; i < moving.length; i++) for (let j = i + 1; j < moving.length; j++) {
    const a = moving[i]!;
    const b = moving[j]!;
    if (arcsOverlap(a.from - KART_RADIUS, wrap(a.to - a.from, length) + 2 * KART_RADIUS,
      b.from - KART_RADIUS, wrap(b.to - b.from, length) + 2 * KART_RADIUS, length)) {
      throw new RangeError('moving barrier distance ranges including noses must not overlap');
    }
  }
  const times = barrierSampleTimes(barriers);
  const assertFree = (d: number, offset: number, label: string, time: number): void => {
    requireFinite(offset, `${label} offset`);
    if (barriers.some(barrier => {
      const exclusion = exclusionAt(track, barrier, d, time);
      return exclusion !== null && offset >= exclusion.min && offset <= exclusion.max;
    })) throw new RangeError(`${label} is inside a barrier exclusion`);
  };
  for (const point of def.racingLine) {
    checkDistance(point.distance, 'racingLine distance');
    for (const time of times) assertFree(point.distance, point.offset, 'racingLine', time);
    addDistance(point.distance);
  }
  for (let i = 1; i < def.racingLine.length; i++) {
    if (def.racingLine[i]!.distance <= def.racingLine[i - 1]!.distance) {
      throw new RangeError('racingLine distances must be strictly increasing');
    }
  }
  for (let slot = 0; slot < 8; slot++) {
    for (const time of times) {
      assertFree(length - 8 - Math.floor(slot / 2) * 4.5, slot % 2 === 0 ? -2 : 2, `start grid slot ${slot}`, time);
    }
  }
  for (const row of def.boxRows) {
    requireFinite(row, 'box row');
    if (row < 0 || row >= 1) throw new RangeError('box rows must be lap fractions in [0, 1)');
    for (const offset of def.boxLanes) for (const time of times) assertFree(row * length, offset, 'item box', time);
  }

  for (let d = 0; d < length; d += 0.5) addDistance(d);
  for (const time of times) {
    const samples = times.length === 1 ? distances : new Set(distances);
    addPassageCrossings(track, samples, time);
    for (const d of samples) {
      if (!corridorAt(track, d, time).some(interval => interval.max - interval.min >= MIN_PASSAGE + PASSAGE_MARGIN - EPSILON)) {
        throw new RangeError(`No free interval at ${d} m, time ${time} s is at least 2R + 0.6 + 0.05 m wide`);
      }
      if (def.racingLine.length) {
        assertFree(d, racingLineOffset(track, d), 'racingLine', time);
      }
    }
  }
  for (let i = 0; i < def.checkpointCount; i++) {
    const gate = i === 0 ? 0 : (i + phase) * length / def.checkpointCount;
    for (const barrier of barriers) for (const tip of [barrier.from, barrier.to]) {
      const gap = wrap(gate - tip, length);
      if (Math.min(gap, length - gap) <= 10) throw new RangeError('checkpoint gate is within 10 m of a barrier tip');
    }
  }

  const zones = def.surfaces.filter(zone => zone.kind === 'jump' || zone.kind === 'pit' ||
    zone.kind === 'spin' || zone.kind === 'fall');
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
      if (zone.kind === 'fall') {
        const { roadHalfWidth: road, wallHalfWidth: wall } = widthAt(track, d);
        if (!((offsets.min >= road - EPSILON && offsets.max <= wall + EPSILON) ||
          (offsets.min >= -wall - EPSILON && offsets.max <= -road + EPSILON))) {
          throw new RangeError('fall must be a band between road and wall');
        }
      }
    }
  }
  const jumps = zones.filter(zone => zone.kind === 'jump').sort((a, b) =>
    wrap(a.from, length) - wrap(b.from, length));
  if (def.physics !== undefined) for (let i = 0; i < jumps.length; i++) {
    const jump = jumps[i]!;
    const next = jumps[(i + 1) % jumps.length]!;
    const spacing = jumps.length === 1 ? length : wrap(next.from - jump.from, length);
    if (spacing <= (jump.duration ?? 0.8) * 60) {
      throw new RangeError('jump spacing must exceed duration * 60 m, including the seam');
    }
  }
  const falls = zones.filter(zone => zone.kind === 'fall');
  for (const fall of falls) {
    if (fall.respawnAt === undefined) throw new RangeError('fall respawnAt is required');
    checkDistance(fall.respawnAt, 'fall respawnAt');
    const span = wrap(fall.to - fall.from, length);
    // Check entry and every crossed gate: between gates the preceding checkpoint
    // is constant, and the nearest-lap respawn can only move forward by a lap.
    const from = wrap(fall.from, length);
    const end = from + span;
    let checkpoint = 0;
    const entries: number[] = [];
    for (let i = 0; i < def.checkpointCount; i++) {
      const gate = i === 0 ? 0 : (i + phase) * length / def.checkpointCount;
      if (gate <= from) checkpoint = gate;
      const entry = gate < from ? gate + length : gate;
      if (entry > from && entry <= end) entries.push(entry);
    }
    for (const entry of [from, ...entries.sort((a, b) => a - b)]) {
      if (entry !== from) checkpoint = entry;
      const respawn = entry + wrap(fall.respawnAt - entry + length / 2, length) - length / 2;
      if (respawn < checkpoint - EPSILON) {
        throw new RangeError('fall respawnAt must be at or after the preceding checkpoint');
      }
    }
    const nextJump = [...jumps].sort((a, b) =>
      wrap(a.from - fall.respawnAt!, length) - wrap(b.from - fall.respawnAt!, length))[0];
    if (!nextJump) continue;
    const nextIndex = jumps.indexOf(nextJump);
    const followingJump = jumps[(nextIndex + 1) % jumps.length]!;
    const jumpSpacing = jumps.length === 1 ? length : wrap(followingJump.from - nextJump.from, length);
    const duration = nextJump.duration ?? 0.8;
    const flightDistance = duration * 60;
    const launch = zoneOffsets(track, nextJump, nextJump.from);
    let gap = wrap(nextJump.to - nextJump.from, length);
    // Gap is takeoff to the far edge of every hazard this jump can encounter.
    // Overlapping bands form one gap; unrelated lanes or distant bands do not.
    for (const hazard of zones.filter(zone => zone.kind === 'fall' || zone.kind === 'pit')) {
      const span = wrap(hazard.to - hazard.from, length);
      const behind = wrap(nextJump.from - hazard.from, length);
      const start = behind <= span ? -behind : wrap(hazard.from - nextJump.from, length);
      if (start > flightDistance || start >= jumpSpacing) continue;
      const offsets = zoneOffsets(track, hazard, nextJump.from + Math.max(0, start));
      if (offsets.max < launch.min || offsets.min > launch.max) continue;
      gap = Math.max(gap, start + span);
    }
    if (gap > flightDistance + EPSILON) {
      throw new RangeError('fall respawnAt next jump gap exceeds duration * 60 m');
    }
    const runway = wrap(nextJump.from - fall.respawnAt, length);
    if (runway < (gap / duration) ** 2 / (2 * 19.9) * 1.3 - EPSILON) {
      throw new RangeError('fall respawnAt needs more runway before the next jump');
    }
  }
  for (const jump of jumps) {
    const takeoff = slopeAt(track, jump.to);
    // slopeAt is constant until the next sample; include every change in (to, to + 40].
    let landing = Math.min(takeoff, slopeAt(track, jump.to + 40));
    for (let i = 0; i < track.samples.length; i++) {
      const gap = wrap(track.samples[i]!.distance - jump.to, length);
      if (gap > 0 && gap <= 40 + EPSILON) landing = Math.min(landing, slopes[i]!);
    }
    if (landing < takeoff - 0.05 - EPSILON) {
      throw new RangeError('jump landing slope must be at least takeoff slope minus 0.05');
    }
  }

  // Include exact feature boundaries as well as the shared geometry samples.
  const sectionDistances = (from: number, to: number): number[] => {
    const span = wrap(to - from, length);
    const result = [wrap(from, length), wrap(to, length)];
    for (let along = 0.5; along < span; along += 0.5) result.push(wrap(from + along, length));
    for (const d of distances) if (wrap(d - from, length) <= span + EPSILON) result.push(d);
    return result;
  };
  for (const spin of zones.filter(zone => zone.kind === 'spin')) {
    if (spin.rate === undefined) throw new RangeError('spin rate is required');
    requireFinite(spin.rate, 'spin rate');
    if (spin.rate === 0 || Math.abs(spin.rate) > 1.5) throw new RangeError('spin rate must satisfy 0 < |rate| <= 1.5 rad/s');
    const diameter = spin.to - spin.from;
    if (diameter <= 0 || diameter > 30) throw new RangeError('spin diameter must be positive and at most 30 m');
    if (spin.offsetMin === undefined || spin.offsetMax === undefined ||
      Math.abs(diameter - (spin.offsetMax - spin.offsetMin)) > EPSILON) {
      throw new RangeError('spin requires offsetMin / offsetMax spanning its diameter');
    }
    for (let i = 0; i < track.samples.length; i++) {
      const a = track.samples[(i + track.samples.length - 1) % track.samples.length]!;
      const b = track.samples[i]!;
      const c = track.samples[(i + 1) % track.samples.length]!;
      // Include triples straddling either boundary, even for zones between samples.
      if (!arcsOverlap(a.distance, wrap(c.distance - a.distance, length), spin.from, diameter, length)) continue;
      const twiceArea = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      const radius = twiceArea === 0 ? Infinity : Math.hypot(b.x - a.x, b.z - a.z) *
        Math.hypot(c.x - b.x, c.z - b.z) * Math.hypot(c.x - a.x, c.z - a.z) / (2 * twiceArea);
      if (radius < 200) throw new RangeError('spin requires curvature radius at least 200 m');
    }
    const radius = diameter / 2;
    const center = (spin.offsetMin + spin.offsetMax) / 2;
    const samples = [...sectionDistances(spin.from, spin.to), spin.from + radius];
    for (const d of samples) for (const time of times) {
      const along = wrap(d - spin.from, length) - radius;
      const halfWidth = Math.sqrt(Math.max(0, radius * radius - along * along));
      if (barriers.some(barrier => {
        const exclusion = exclusionAt(track, barrier, d, time);
        return exclusion !== null && exclusion.max >= center - halfWidth && exclusion.min <= center + halfWidth;
      })) throw new RangeError('spin must not overlap a barrier exclusion');
    }
  }
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
  const { samples } = track;
  for (const split of def.splits ?? []) {
    const span = wrap(split.to - split.from, length);
    for (const lane of split.lanes) {
      if (lane.offsetMax - lane.offsetMin < 6 - EPSILON) throw new RangeError('island lane width must be at least 6 m');
    }
    // Lap changes at distance 0; a split across it could swap the chosen lane mid-passage.
    const toStart = wrap(-split.from, length);
    if (toStart > EPSILON && toStart < span - EPSILON) throw new RangeError('split must not cross the start line');
    // An offset curve beyond the curvature radius folds over itself on the inside of the bend.
    const outerHalf = Math.max(...split.lanes.flatMap(lane => [Math.abs(lane.offsetMin), Math.abs(lane.offsetMax)]));
    for (let i = 0; i < samples.length; i++) {
      if (wrap(samples[i]!.distance - split.from, length) > span + EPSILON) continue;
      const a = samples[(i + samples.length - 1) % samples.length]!;
      const b = samples[i]!;
      const c = samples[(i + 1) % samples.length]!;
      const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      const product = Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) * Math.hypot(c.x - a.x, c.z - a.z);
      if (outerHalf * 2 * Math.abs(cross) > product) {
        throw new RangeError('split outer lane half-width must not exceed the curvature radius');
      }
    }
  }
}

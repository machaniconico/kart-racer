import { widthAt } from './corridor';
import type { SurfaceZone, Track } from './types';

export const JUMP_DURATION = 0.8;
export const JUMP_HEIGHT = 2;

// Preserve exact in-range endpoints: adding a full lap before modulo can round them.
function wrap(track: Track, distance: number): number {
  const remainder = distance % track.length;
  return remainder < 0 ? remainder + track.length : remainder;
}

function containsOffset(track: Track, zone: SurfaceZone, distance: number, offset: number): boolean {
  const { roadHalfWidth } = widthAt(track, distance);
  return offset >= (zone.offsetMin ?? -roadHalfWidth) && offset <= (zone.offsetMax ?? roadHalfWidth);
}

function inZone(zone: SurfaceZone, d: number): boolean {
  return zone.from <= zone.to ? d >= zone.from && d < zone.to : d >= zone.from || d < zone.to;
}

/** Continuous surface modifiers; boost and jump are entry events, not surfaces. */
export function surfaceAt(track: Track, distance: number, offset: number): 'road' | 'ice' | 'dirt' {
  const d = wrap(track, distance);
  const on = (kind: 'ice' | 'dirt'): boolean =>
    track.def.surfaces.some(zone => zone.kind === kind && containsOffset(track, zone, d, offset) && inZone(zone, d));
  return on('ice') ? 'ice' : on('dirt') ? 'dirt' : 'road';
}

/** Spin floors are discs centred in their zone with diameter (to - from); validateTrackDef keeps them on straights. */
export function spinRateAt(track: Track, distance: number, offset: number): number {
  for (const zone of track.def.surfaces) {
    if (zone.kind !== 'spin') continue;
    const radius = (zone.to - zone.from) / 2;
    const along = wrap(track, distance) - (zone.from + zone.to) / 2;
    const across = offset - ((zone.offsetMin ?? 0) + (zone.offsetMax ?? 0)) / 2;
    if (along * along + across * across <= radius * radius) return zone.rate ?? 0;
  }
  return 0;
}

/** Each tick travels less than half a lap. Count only a forward (previous, current] entry. */
export function crossedZone(track: Track, kind: SurfaceZone['kind'], previousDistance: number,
  distance: number, offset: number): boolean {
  let advance = (distance - previousDistance) % track.length;
  if (advance < -track.length / 2) advance += track.length;
  else if (advance > track.length / 2) advance -= track.length;
  if (advance <= 0) return false;
  return track.def.surfaces.some(zone => {
    if (zone.kind !== kind || !containsOffset(track, zone, distance, offset)) return false;
    const entry = wrap(track, zone.from - previousDistance);
    return entry > 0 && entry <= advance;
  });
}

/** Closed [from, to] membership (with lane bounds), for the landing tick of a pit. */
export function insideZone(track: Track, kind: SurfaceZone['kind'], distance: number, offset: number): boolean {
  return zoneAt(track, kind, distance, offset) !== undefined;
}

/** The matching zone is also needed for its respawn destination. */
export function zoneAt(track: Track, kind: SurfaceZone['kind'], distance: number, offset: number): SurfaceZone | undefined {
  const d = wrap(track, distance);
  return track.def.surfaces.find(zone => zone.kind === kind && containsOffset(track, zone, d, offset) &&
    wrap(track, d - zone.from) <= wrap(track, zone.to - zone.from));
}

/** Validated jump spacing keeps the launch zone behind the kart throughout flight.
 * Lane bounds apply at takeoff only: crossing lanes in the air must not change the arc. */
export function jumpAt(track: Track, distance: number): { duration: number; height: number } {
  let launch: SurfaceZone | undefined;
  let nearest = Infinity;
  if (track.def.physics !== undefined) for (const zone of track.def.surfaces) {
    if (zone.kind !== 'jump') continue;
    const behind = wrap(track, distance - zone.from);
    if (behind < nearest) { launch = zone; nearest = behind; }
  }
  return { duration: launch?.duration ?? JUMP_DURATION, height: launch?.height ?? JUMP_HEIGHT };
}

/** Periodic linear interpolation, including the segment across the start line. */
export function racingLineOffset(track: Track, distance: number): number {
  const line = track.def.racingLine;
  if (line.length === 0) return 0;
  const d = wrap(track, distance);
  let before = line[0]!;
  let after = before;
  let beforeDistance = Infinity;
  let afterDistance = Infinity;
  for (const point of line) {
    const behind = wrap(track, d - point.distance);
    const ahead = wrap(track, point.distance - d);
    if (behind < beforeDistance) { before = point; beforeDistance = behind; }
    if (ahead < afterDistance) { after = point; afterDistance = ahead; }
  }
  const span = beforeDistance + afterDistance;
  const offset = span === 0 ? before.offset : before.offset + (after.offset - before.offset) * beforeDistance / span;
  const limit = Math.max(0, widthAt(track, d).roadHalfWidth - 1);
  return Math.max(-limit, Math.min(limit, offset));
}

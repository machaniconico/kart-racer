import type { SurfaceZone, Track } from './types';

export const JUMP_DURATION = 0.8;
export const JUMP_HEIGHT = 2;

// Preserve exact in-range endpoints: adding a full lap before modulo can round them.
function wrap(track: Track, distance: number): number {
  const remainder = distance % track.length;
  return remainder < 0 ? remainder + track.length : remainder;
}

function containsOffset(track: Track, zone: SurfaceZone, offset: number): boolean {
  return offset >= (zone.offsetMin ?? -track.def.roadHalfWidth) &&
    offset <= (zone.offsetMax ?? track.def.roadHalfWidth);
}

/** Continuous surface modifiers; boost and jump are entry events, not surfaces. */
export function surfaceAt(track: Track, distance: number, offset: number): 'road' | 'ice' {
  const d = wrap(track, distance);
  return track.def.surfaces.some(zone => zone.kind === 'ice' && containsOffset(track, zone, offset) &&
    (zone.from <= zone.to ? d >= zone.from && d < zone.to : d >= zone.from || d < zone.to)) ? 'ice' : 'road';
}

/** Each tick travels less than half a lap. Count only a forward (previous, current] entry. */
export function crossedZone(track: Track, kind: SurfaceZone['kind'], previousDistance: number,
  distance: number, offset: number): boolean {
  let advance = (distance - previousDistance) % track.length;
  if (advance < -track.length / 2) advance += track.length;
  else if (advance > track.length / 2) advance -= track.length;
  if (advance <= 0) return false;
  return track.def.surfaces.some(zone => {
    if (zone.kind !== kind || !containsOffset(track, zone, offset)) return false;
    const entry = wrap(track, zone.from - previousDistance);
    return entry > 0 && entry <= advance;
  });
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
  const limit = Math.max(0, track.def.roadHalfWidth - 1);
  return Math.max(-limit, Math.min(limit, offset));
}

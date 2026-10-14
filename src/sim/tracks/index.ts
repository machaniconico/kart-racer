import { buildTrack } from '../track';
import type { Track, TrackDef, TrackId } from '../types';
import { meadow } from './meadow';
import { canyon } from './canyon';
import { snowpeak } from './snowpeak';
import { neon } from './neon';
import { harbor } from './harbor';
import { forest } from './forest';
import { volcano } from './volcano';
import { skyline } from './skyline';

export const TRACK_IDS: readonly TrackId[] = Object.freeze([
  'meadow', 'canyon', 'snowpeak', 'neon', 'harbor', 'forest', 'volcano', 'skyline',
]);
const cache = new Map<TrackId, Track>();

// Own frozen copies, so editing a source definition cannot invalidate the fingerprint.
export const TRACKS: Readonly<Record<TrackId, TrackDef>> = Object.freeze(Object.fromEntries(
  [meadow, canyon, snowpeak, neon, harbor, forest, volcano, skyline].map(def => {
    const track = buildTrack(def);
    cache.set(def.id, track);
    return [def.id, track.def];
  }),
) as Record<TrackId, TrackDef>);

export function getTrack(id: string): Track {
  const track = cache.get(id as TrackId);
  if (!track) throw new RangeError(`Unknown course: ${id}`);
  return track;
}

/** Courses still registered as a copy of MEADOW's layout; a course story drops out by replacing its def. */
export function scaffoldIds(): TrackId[] {
  const reference = JSON.stringify(TRACKS.meadow.controlPoints);
  return TRACK_IDS.filter(id => id !== 'meadow' && JSON.stringify(TRACKS[id].controlPoints) === reference);
}

function fingerprint(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
}

export const COURSE_FINGERPRINT = fingerprint(JSON.stringify(TRACK_IDS.map(id => TRACKS[id])));

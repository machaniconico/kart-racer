import { buildTrack } from '../track';
import type { Track, TrackDef, TrackId } from '../types';
import { meadow } from './meadow';
import { canyon } from './canyon';
import { snowpeak } from './snowpeak';
import { neon } from './neon';

export const TRACK_IDS: readonly TrackId[] = Object.freeze(['meadow', 'canyon', 'snowpeak', 'neon']);
const cache = new Map<TrackId, Track>();

// Own frozen copies, so editing a source definition cannot invalidate the fingerprint.
export const TRACKS: Readonly<Record<TrackId, TrackDef>> = Object.freeze(Object.fromEntries(
  [meadow, canyon, snowpeak, neon].map(def => {
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

function fingerprint(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
}

export const COURSE_FINGERPRINT = fingerprint(JSON.stringify(TRACK_IDS.map(id => TRACKS[id])));

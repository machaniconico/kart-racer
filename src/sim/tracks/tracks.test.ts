import { describe, expect, it } from 'vitest';
import { getAIInput } from '../ai';
import { validateTrackDef, widthAt } from '../corridor';
import { DEFAULT_LAPS } from '../laps';
import { createRace, stepRace } from '../race';
import { buildTrack, projectToTrack, sampleTrack, slopeAt, wrapDistance } from '../track';
import type { RaceState, TrackDef, TrackId } from '../types';
import { COURSE_FINGERPRINT, getTrack, scaffoldIds, TRACK_IDS, TRACKS } from './index';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

function fnv1a32(value: unknown): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return hash >>> 0;
}

function expectFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(expectFrozen);
}

describe('course registry and MEADOW golden baseline', () => {
  it('fixes registry order and course identities', () => {
    expect(TRACK_IDS).toEqual(['meadow', 'canyon', 'snowpeak', 'neon', 'harbor', 'forest', 'volcano', 'skyline']);
    expect(TRACK_IDS.map(id => TRACKS[id].name)).toEqual([
      'MEADOW LOOP', 'SUNSCAR CANYON', 'FROSTBITE PEAK', 'NEON NIGHTLINE',
      'TIDEWATER HARBOR', 'MOSSWOOD TRAIL', 'EMBER CALDERA', 'STRATOS CITY',
    ]);
    for (const id of TRACK_IDS) {
      expect(getTrack(id).def.id).toBe(id);
      expect(getTrack(id).def.themeId).toBe(id);
      expect(getTrack(id).def).toBe(TRACKS[id]);
      expect(getTrack(id)).toBe(getTrack(id));
    }
    expect(new Set(TRACK_IDS.map(getTrack)).size).toBe(8);
    expect(COURSE_FINGERPRINT).toBe(fnv1a32(TRACK_IDS.map(id => TRACKS[id])));
    expectFrozen(TRACK_IDS);
    expectFrozen(TRACKS);
  });

  // Pending marker: M6-01–04 each replace one scaffold in parallel, so only the subset is pinned
  // here; M6-05 changes this to an empty list.
  it('registers only the four new courses as MEADOW-layout scaffolds', () => {
    for (const id of scaffoldIds()) {
      expect(['harbor', 'forest', 'volcano', 'skyline']).toContain(id);
      expect(TRACKS[id].layoutVersion).toBe(1);
    }
  });

  it.each(['', 'MEADOW', 'unknown', '__proto__', 'constructor'])('rejects unknown ID %j', id => {
    expect(() => getTrack(id)).toThrow(RangeError);
    expect(() => createRace(1, { trackId: id as TrackId })).toThrow(RangeError);
  });

  it('rejects non-string course IDs received from JSON', () => {
    for (const trackId of [null, 1, {}]) {
      const options = JSON.parse(JSON.stringify({ trackId }));
      expect(() => createRace(1, options)).toThrow(RangeError);
    }
  });

  it('enforces the 24-box layout at build time', () => {
    const def = TRACKS.meadow;
    expect(() => buildTrack({ ...def, boxRows: def.boxRows.slice(1) })).toThrow(RangeError);
    expect(() => buildTrack({ ...def, boxRows: [...def.boxRows, 0.95] })).toThrow(RangeError);
    expect(() => buildTrack({ ...def, boxLanes: def.boxLanes.slice(1) })).toThrow(RangeError);
    expect(() => buildTrack({ ...def, boxLanes: [...def.boxLanes, 6] })).toThrow(RangeError);
  });

  it('owns immutable data independent of mutable source definitions and race state', () => {
    const source = JSON.parse(JSON.stringify(TRACKS.meadow));
    const track = buildTrack(source);
    const serialized = JSON.stringify(track);
    source.controlPoints[0][0] = 1000;
    source.boxRows[0] = 0.9;
    expect(JSON.stringify(track)).toBe(serialized);
    expectFrozen(track);
    const state = createRace(1);
    state.boxes[0]!.x += 123;
    expect(createRace(1).boxes[0]!.x).toBe(getTrack('meadow').boxPoses[0]!.x);
  });

  it('supports a closed centripetal course without changing the default uniform sampler', () => {
    const def: TrackDef = { ...TRACKS.meadow, spline: 'centripetal' };
    const track = buildTrack(def);
    expect(track.samples.every(sample => Object.values(sample).every(Number.isFinite))).toBe(true);
    expect(sampleTrack(track, track.length)).toEqual(sampleTrack(track, 0));
    expect(track.samples).not.toEqual(getTrack('meadow').samples);
    expect(buildTrack(JSON.parse(JSON.stringify(def)))).toEqual(track);
  });
});

describe.each(TRACK_IDS)('%s course contract', id => {
  const track = getTrack(id);

  it('validates the width profile, passages, grid, boxes and racing line', () => {
    expect(() => validateTrackDef(track.def)).not.toThrow();
  });

  it('keeps every grade within 30%, including the seam', () => {
    for (const sample of track.samples) {
      expect(Math.abs(slopeAt(track, sample.distance)), `distance ${sample.distance}`).toBeLessThanOrEqual(0.30);
    }
  });

  it('keeps curvature radius at least wall half-width plus 2.5m, including the seam', () => {
    const points = track.samples;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length]!;
      const b = points[i]!;
      const c = points[(i + 1) % points.length]!;
      const twiceArea = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      const radius = Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) *
        Math.hypot(c.x - a.x, c.z - a.z) / (2 * twiceArea);
      expect(radius, `distance ${b.distance}`).toBeGreaterThanOrEqual(widthAt(track, b.distance).wallHalfWidth + 2.5);
    }
  });

  it('projects continuously every 0.5m at every integer offset within the local wall width', () => {
    let largestDelta = 0;
    const maxOffset = Math.floor(Math.max(track.def.wallHalfWidth,
      ...(track.def.widthKeys ?? []).map(key => key.wallHalfWidth)));
    for (let offset = -maxOffset; offset <= maxOffset; offset++) {
      let previous = 0;
      for (let distance = 0; distance <= track.length + 1; distance += 0.5) {
        if (Math.abs(offset) > Math.floor(widthAt(track, distance).wallHalfWidth)) {
          previous = distance;
          continue;
        }
        const sample = sampleTrack(track, distance);
        const projection = projectToTrack(track, sample.x + sample.nx * offset,
          sample.z + sample.nz * offset, previous);
        const delta = wrapDistance(track, projection.distance - previous + track.length / 2) - track.length / 2;
        largestDelta = Math.max(largestDelta, Math.abs(delta));
        previous = projection.distance;
      }
    }
    expect(largestDelta).toBeLessThan(2);
  });

  it('closes exactly, with unit orthogonal tangents/normals and grade at most 0.30', () => {
    expect(sampleTrack(track, track.length)).toEqual(sampleTrack(track, 0));
    expect(wrapDistance(track, -1)).toBeCloseTo(track.length - 1, 10);
    let largestGrade = 0;
    for (let i = 0; i < track.samples.length; i++) {
      const point = track.samples[i]!;
      const next = track.samples[(i + 1) % track.samples.length]!;
      const ds = i === track.samples.length - 1 ? track.length - point.distance : next.distance - point.distance;
      largestGrade = Math.max(largestGrade, Math.abs((next.y - point.y) / ds));
    }
    for (let distance = 0; distance < track.length; distance += 0.5) {
      const point = sampleTrack(track, distance);
      expect(point.tx * point.nx + point.tz * point.nz).toBeCloseTo(0, 14);
      expect(Math.hypot(point.tx, point.tz)).toBeCloseTo(1, 14);
      expect(Math.hypot(point.nx, point.nz)).toBeCloseTo(1, 14);
    }
    expect(largestGrade).toBeLessThanOrEqual(0.30);
  });

  it('builds 24 boxes, every checkpoint, and the declared course widths', () => {
    const state = createRace(1, { trackId: id });
    expect(state.trackId).toBe(id);
    expect(state.boxes).toHaveLength(24);
    expect(track.boxPoses).toHaveLength(24);
    expect(track.checkpointDistances).toHaveLength(track.def.checkpointCount);
    expect(track.checkpointDistances).toEqual(Array.from({ length: track.def.checkpointCount },
      (_, i) => i * track.length / track.def.checkpointCount));
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
  });

  it.each([1, 42, 98765])('finishes eight CPUs over three laps and matches JSON replay every tick (seed %i)', seed => {
    const state = createRace(seed, { trackId: id, racers: [] });
    expect(createRace(seed, { trackId: id, racers: [] })).toEqual(state);
    const hasJump = getTrack(id).def.surfaces.some(zone => zone.kind === 'jump');
    let restored: RaceState = JSON.parse(JSON.stringify(state));
    for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
      stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
      stepRace(restored, restored.karts.map(kart => getAIInput(restored, kart.id)));
      expect(JSON.stringify(restored)).toBe(JSON.stringify(state));
      if (!hasJump) expect(state.karts.every(kart => kart.airTime === 0)).toBe(true);
      // Exercise restoring an active race as well as the initial grid.
      if (tick === 1000) restored = JSON.parse(JSON.stringify(restored));
    }
    expect(state.phase).toBe('finished');
    expect(state.karts).toHaveLength(8);
    for (const kart of state.karts) {
      expect(kart.human).toBe(false);
      expect(kart.lap).toBe(DEFAULT_LAPS);
      expect(kart.lapTimes).toHaveLength(3);
      expect(kart.finishTime).not.toBeNull();
      expect(kart.airTime).toBe(0);
    }
  }, 120_000);
});

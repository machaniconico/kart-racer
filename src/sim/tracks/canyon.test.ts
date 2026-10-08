import { describe, expect, it } from 'vitest';
import { getAIInput } from '../ai';
import { widthAt } from '../corridor';
import { TOTAL_LAPS } from '../laps';
import { createRace, KART_RADIUS, stepRace } from '../race';
import { JUMP_DURATION, surfaceAt } from '../surfaces';
import { buildTrack, projectToTrack, sampleTrack, wrapDistance } from '../track';
import type { RaceState } from '../types';
import { getTrack } from './index';

const track = getTrack('canyon');
const jumps = track.def.surfaces.filter(zone => zone.kind === 'jump');

function sampleHash(samples: unknown): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(JSON.stringify(samples))) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return hash >>> 0;
}

describe('SUNSCAR CANYON', () => {
  it('has its own reproducible 600–720m layout with at least 10m of elevation', () => {
    expect(track.length).toBeGreaterThanOrEqual(600);
    expect(track.length).toBeLessThanOrEqual(720);
    const heights = track.samples.map(point => point.y);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThanOrEqual(10);
    expect(sampleHash(track.samples)).not.toBe(sampleHash(getTrack('meadow').samples));
    expect(sampleHash(buildTrack(JSON.parse(JSON.stringify(track.def))).samples)).toBe(sampleHash(track.samples));
    let maximumGrade = 0;
    for (const [i, point] of track.samples.entries()) {
      const next = track.samples[(i + 1) % track.samples.length]!;
      maximumGrade = Math.max(maximumGrade, Math.abs(next.y - point.y) / Math.hypot(next.x - point.x, next.z - point.z));
    }
    expect(maximumGrade).toBeLessThanOrEqual(0.12);
  });

  it('places exactly two downhill jumps on straight takeoff and landing corridors', () => {
    expect(jumps).toHaveLength(2);
    for (const jump of jumps) {
      expect(jump.from).toBeGreaterThan(15);
      expect(jump.to).toBeGreaterThan(jump.from);
      expect(jump.to + 15).toBeLessThan(track.length);
      expect(sampleTrack(track, jump.from + 15).y).toBeLessThan(sampleTrack(track, jump.from - 15).y);
      let minimumRadius = Infinity;
      // Include the entire marked surface and a boosted kart's landing zone,
      // in addition to the required 15m either side of takeoff.
      for (const [i, b] of track.samples.entries()) {
        if (b.distance < jump.from - 15 || b.distance > Math.max(jump.to + 15, jump.from + 50 * JUMP_DURATION)) continue;
        const a = track.samples[(i + track.samples.length - 1) % track.samples.length]!;
        const c = track.samples[(i + 1) % track.samples.length]!;
        const twiceArea = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
        const radius = twiceArea === 0 ? Infinity : Math.hypot(b.x - a.x, b.z - a.z) *
          Math.hypot(c.x - b.x, c.z - b.z) * Math.hypot(c.x - a.x, c.z - a.z) / (2 * twiceArea);
        minimumRadius = Math.min(minimumRadius, radius);
      }
      expect(minimumRadius).toBeGreaterThanOrEqual(40);
    }
  });

  it('narrows one passage to 4m half-width with 20m ramps on layout 2', () => {
    expect(track.def.layoutVersion).toBe(2);
    const keys = track.def.widthKeys!;
    expect(keys).toHaveLength(4);
    expect(keys.map(key => key.roadHalfWidth)).toEqual([7.2, 4, 4, 7.2]);
    const [entry, narrowStart, narrowEnd, exit] = keys;
    expect(narrowStart!.distance - entry!.distance).toBe(20);
    expect(exit!.distance - narrowEnd!.distance).toBe(20);
    expect(narrowEnd!.distance).toBeGreaterThan(narrowStart!.distance);
    for (const key of keys) expect(widthAt(track, key.distance).roadHalfWidth).toBe(key.roadHalfWidth);
    for (const [a, b] of [[entry!, narrowStart!], [narrowEnd!, exit!]]) {
      expect(widthAt(track, (a.distance + b.distance) / 2).roadHalfWidth).toBeCloseTo(5.6);
    }
    expect(widthAt(track, 0).roadHalfWidth).toBe(7.2);
    expect(widthAt(track, track.length - 1).roadHalfWidth).toBe(7.2);
  });

  it('covers the full road width with at least 40m of dirt', () => {
    const dirt = track.def.surfaces.filter(zone => zone.kind === 'dirt');
    expect(dirt).toHaveLength(1);
    for (const zone of dirt) {
      const length = wrapDistance(track, zone.to - zone.from);
      expect(length).toBeGreaterThanOrEqual(40);
      for (let along = 0; along < length; along += 0.5) {
        const distance = wrapDistance(track, zone.from + along);
        const half = widthAt(track, distance).roadHalfWidth;
        for (const offset of [-half, 0, half]) expect(surfaceAt(track, distance, offset)).toBe('dirt');
      }
    }
  });

  it('keeps every grid slot clear of barrier exclusions through the first 100m after the start line', () => {
    const { karts } = createRace(1, { trackId: 'canyon', racers: [] });
    expect(karts).toHaveLength(8);
    expect(new Set(karts.map(kart => kart.lateralOffset))).toEqual(new Set([-2, 2]));
    for (const kart of karts) {
      const approach = wrapDistance(track, -kart.trackDistance) + 100;
      for (const pillar of track.def.barriers!) {
        // Check the entire expanded band, including both caps, without gaps between samples.
        // Keeping it out of this arc clears both columns in every row of the grid.
        const nose = wrapDistance(track, pillar.from - KART_RADIUS - kart.trackDistance);
        const span = wrapDistance(track, pillar.to - pillar.from) + 2 * KART_RADIUS;
        expect(nose, `grid slot ${kart.id}`).toBeGreaterThan(approach);
        expect(nose + span, `grid slot ${kart.id}`).toBeLessThan(track.length);
      }
    }
  });

  it.each(track.def.boxLanes)('keeps every item row in lane %s at least 8m from pillar exclusions', offset => {
    for (const fraction of track.def.boxRows) {
      const distance = fraction * track.length;
      const point = sampleTrack(track, distance);
      const box = projectToTrack(track, point.x + point.nx * offset, point.z + point.nz * offset, distance);
      for (const pillar of track.def.barriers!) {
        // Reserve reaction distance before the nose and after the tail, including the kart radius.
        // This longitudinal bound clears every lane, even when the box is off the centre line.
        const fromNose = wrapDistance(track, box.distance - (pillar.from - KART_RADIUS));
        const span = wrapDistance(track, pillar.to - pillar.from) + 2 * KART_RADIUS;
        const context = `row ${distance}, lane ${offset}, pillar ${pillar.from}`;
        expect(fromNose - span, context).toBeGreaterThanOrEqual(8);
        expect(track.length - fromNose, context).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it('keeps centre pillars on straight shelves clear of jumps and gates and guarantees passage width between samples', () => {
    const pillars = track.def.barriers!;
    expect(pillars.length).toBeGreaterThanOrEqual(2);
    expect(pillars.length).toBeLessThanOrEqual(3);
    for (const pillar of pillars) {
      expect(pillar.scenery).toBe('pillar');
      expect(pillar.halfWidth).toBe(1.2);
      expect(pillar.taper).toBe(4);
      expect(Math.abs(pillar.center)).toBeLessThanOrEqual(2);
      const start = sampleTrack(track, pillar.from);
      for (let distance = pillar.from; distance <= pillar.to; distance += 0.5) {
        const point = sampleTrack(track, distance);
        expect(point.tx * start.tx + point.tz * start.tz).toBeGreaterThan(0.99);
      }
      for (const jump of jumps) {
        expect(pillar.to + KART_RADIUS <= jump.from ||
          pillar.from - KART_RADIUS >= jump.from + 50 * JUMP_DURATION).toBe(true);
      }
      for (const gate of track.checkpointDistances) {
        const fromNose = wrapDistance(track, gate - (pillar.from - KART_RADIUS));
        const span = wrapDistance(track, pillar.to - pillar.from) + 2 * KART_RADIUS;
        expect(fromNose - span).toBeGreaterThanOrEqual(10);
        expect(track.length - fromNose).toBeGreaterThanOrEqual(10);
      }
    }
    // A conservative bound for the entire lap, including all taper/cap interiors.
    // Unlike the validator's 0.5m grid this cannot miss a narrow passage between samples:
    // linear width interpolation never goes below a key and every exclusion stays in this envelope.
    const minimumWall = Math.min(...track.def.widthKeys!.map(key => key.wallHalfWidth));
    const envelope = Math.max(...pillars.map(pillar => Math.abs(pillar.center) + pillar.halfWidth + KART_RADIUS));
    expect(minimumWall - envelope).toBeGreaterThanOrEqual(2 * KART_RADIUS + 0.6);
  });

  it.each([1, 42, 98765])('flies every CPU over both jumps on every lap, stays inside walls and replays exactly (seed %i)', seed => {
    const state = createRace(seed, { trackId: 'canyon', racers: [] });
    let restored: RaceState = JSON.parse(JSON.stringify(state));
    const flights = state.karts.map(() => jumps.map(() => new Set<number>()));
    let airborneTicks = 0;
    let maximumAirborneOffset = 0;
    for (let tick = 0; tick < 60 * 180 && state.phase !== 'finished'; tick++) {
      const previous = state.karts.map(kart => ({ airTime: kart.airTime, distance: kart.trackDistance }));
      stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
      stepRace(restored, restored.karts.map(kart => getAIInput(restored, kart.id)));
      expect(JSON.stringify(restored)).toBe(JSON.stringify(state));
      for (const kart of state.karts) {
        if (kart.airTime <= 0) continue;
        airborneTicks++;
        const projection = projectToTrack(track, kart.x, kart.z);
        maximumAirborneOffset = Math.max(maximumAirborneOffset, Math.abs(projection.offset));
        expect(kart.driftTime).toBe(0);
        expect(kart.driftDirection).toBe(0);
        if (previous[kart.id]!.airTime > 0) continue;
        const distance = previous[kart.id]!.distance;
        const travel = wrapDistance(track, kart.trackDistance - distance);
        const index = jumps.findIndex(jump => wrapDistance(track, jump.from - distance) <= travel);
        expect(index).toBeGreaterThanOrEqual(0);
        if (kart.finishTime === null) flights[kart.id]![index]!.add(kart.lap);
        // Restore while airborne as well as from the starting grid.
        restored = JSON.parse(JSON.stringify(restored));
      }
    }
    expect(state.phase).toBe('finished');
    expect(state.karts).toHaveLength(8);
    expect(airborneTicks).toBeGreaterThan(0);
    expect(maximumAirborneOffset + KART_RADIUS).toBeLessThanOrEqual(track.def.wallHalfWidth + 1e-6);
    for (const kart of state.karts) {
      expect(kart.human).toBe(false);
      expect(kart.lap).toBe(TOTAL_LAPS);
      expect(kart.lapTimes).toHaveLength(3);
      expect(kart.finishTime).not.toBeNull();
      expect(kart.airTime).toBe(0);
      for (const laps of flights[kart.id]!) expect(laps.size).toBe(TOTAL_LAPS);
    }
  }, 30_000);
});

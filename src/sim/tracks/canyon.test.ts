import { describe, expect, it } from 'vitest';
import { getAIInput } from '../ai';
import { TOTAL_LAPS } from '../laps';
import { createRace, KART_RADIUS, stepRace } from '../race';
import { JUMP_DURATION } from '../surfaces';
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
    expect(track.def.surfaces).toHaveLength(2);
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

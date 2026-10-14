import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAIInput } from '../ai';
import { validateTrackDef } from '../corridor';
import { DEFAULT_LAPS, getRank } from '../laps';
import { createRace, stepRace } from '../race';
import { surfaceAt } from '../surfaces';
import { rollAt, slopeAt } from '../track';
import { getTrack } from './index';

const track = getTrack('snowpeak');
const ice = track.def.surfaces.filter(zone => zone.kind === 'ice');

describe('FROSTBITE PEAK', () => {
  it('uses layout 3 with a 15m climb and a 20–30% grade on the unchanged XZ loop', () => {
    expect(track.def.layoutVersion).toBe(3);
    expect(Math.abs(track.length - 619.02)).toBeLessThanOrEqual(0.01);
    const heights = track.samples.map(sample => sample.y);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThanOrEqual(15);
    const maxSlope = Math.max(...track.samples.map(sample => Math.abs(slopeAt(track, sample.distance))));
    expect(maxSlope).toBeGreaterThanOrEqual(0.20);
    expect(maxSlope).toBeLessThanOrEqual(0.30);
    expect(track.def.decks ?? []).toHaveLength(0);
    expect(() => validateTrackDef(track.def)).not.toThrow();
  });

  it('keeps the entire starting grid on grades no steeper than 5%', () => {
    const state = createRace(1, { trackId: 'snowpeak', racers: [] });
    const distances = state.karts.map(kart => kart.trackDistance);
    const from = Math.min(...distances);
    const to = Math.max(...distances);
    const gridSamples = track.samples.filter(sample => sample.distance >= from && sample.distance <= to);
    for (const distance of [...distances, ...gridSamples.map(sample => sample.distance)]) {
      expect(Math.abs(slopeAt(track, distance))).toBeLessThanOrEqual(0.05);
    }
  });

  it('banks one broad sweeper by 0.25–0.35 radians with gentle transitions and a level seam', () => {
    const keys = track.def.bankKeys!;
    expect(keys[0]).toEqual({ distance: 0, roll: 0 });
    expect(keys.at(-1)).toEqual({ distance: track.length, roll: 0 });
    const maxRoll = Math.max(...keys.map(key => Math.abs(key.roll)));
    expect(maxRoll).toBeGreaterThanOrEqual(0.25);
    expect(maxRoll).toBeLessThanOrEqual(0.35);
    let bankedCorners = 0;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1]!;
      const b = keys[i]!;
      if (a.roll === 0 && b.roll !== 0) bankedCorners++;
      expect(Math.abs(b.roll - a.roll) / (b.distance - a.distance)).toBeLessThanOrEqual(0.02);
    }
    expect(bankedCorners).toBe(1);
    const points = track.samples;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length]!;
      const b = points[i]!;
      const c = points[(i + 1) % points.length]!;
      if ([a, b, c].every(sample => rollAt(track, sample.distance) === 0)) continue;
      const twiceArea = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      const radius = Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) *
        Math.hypot(c.x - a.x, c.z - a.z) / (2 * twiceArea);
      expect(radius).toBeGreaterThanOrEqual(33);
    }
  });

  it('has a distinct 550–700m alpine loop with three separate full-width ice sections covering 20–30%', () => {
    expect(track.def.name).toBe('FROSTBITE PEAK');
    expect(track.def.themeId).toBe('snowpeak');
    expect(track.length).toBeGreaterThanOrEqual(550);
    expect(track.length).toBeLessThanOrEqual(700);
    const sampleHash = (samples: typeof track.samples) =>
      createHash('sha256').update(JSON.stringify(samples)).digest('hex');
    expect(sampleHash(track.samples)).not.toBe(sampleHash(getTrack('meadow').samples));
    expect(ice.length).toBeGreaterThanOrEqual(3);
    let previousEnd = 0;
    for (const zone of ice) {
      expect(zone.from).toBeGreaterThan(previousEnd);
      expect(zone.to).toBeGreaterThan(zone.from);
      expect(zone.to).toBeLessThan(track.length);
      expect(zone.offsetMin ?? -track.def.roadHalfWidth).toBe(-track.def.roadHalfWidth);
      expect(zone.offsetMax ?? track.def.roadHalfWidth).toBe(track.def.roadHalfWidth);
      for (const offset of [-track.def.roadHalfWidth, 0, track.def.roadHalfWidth]) {
        expect(surfaceAt(track, (zone.from + zone.to) / 2, offset)).toBe('ice');
      }
      expect(surfaceAt(track, zone.from - 0.01, 0)).toBe('road');
      expect(surfaceAt(track, zone.to + 0.01, 0)).toBe('road');
      previousEnd = zone.to;
    }
    const coverage = ice.reduce((sum, zone) => sum + zone.to - zone.from, 0) / track.length;
    expect(coverage).toBeGreaterThanOrEqual(0.2);
    expect(coverage).toBeLessThanOrEqual(0.3);
  });

  it('keeps ice curvature radius at least 25m, including both transition boundaries', () => {
    let minimumRadius = Infinity;
    const points = track.samples;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length]!;
      const b = points[i]!;
      const c = points[(i + 1) % points.length]!;
      // Include adjoining sample triangles whenever they overlap an icy interval.
      if (!ice.some(zone => a.distance <= zone.to && c.distance >= zone.from)) continue;
      const twiceArea = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      const radius = Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) *
        Math.hypot(c.x - a.x, c.z - a.z) / (2 * twiceArea);
      minimumRadius = Math.min(minimumRadius, radius);
    }
    expect(Number.isFinite(minimumRadius)).toBe(true);
    expect(minimumRadius).toBeGreaterThanOrEqual(25);
  });

  it.each([1, 42, 98765])('finishes all eight CPUs within 180 seconds over three laps (seed %i)', seed => {
    const state = createRace(seed, { trackId: 'snowpeak', racers: [] });
    const visited = state.karts.map(() => ice.map(() => new Set<number>()));
    for (let tick = 0; tick < 60 * 180 && state.phase !== 'finished'; tick++) {
      stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
      for (const kart of state.karts) {
        if (!kart.startedLap || kart.finishTime !== null) continue;
        ice.forEach((zone, index) => {
          if (kart.trackDistance >= zone.from && kart.trackDistance < zone.to &&
            surfaceAt(track, kart.trackDistance, kart.lateralOffset) === 'ice') {
            visited[kart.id]![index]!.add(kart.lap);
          }
        });
      }
    }
    expect(state.phase).toBe('finished');
    expect(state.karts).toHaveLength(8);
    for (const kart of state.karts) {
      expect(kart.human).toBe(false);
      expect(kart.lap).toBe(DEFAULT_LAPS);
      expect(kart.lapTimes).toHaveLength(3);
      expect(kart.finishTime).not.toBeNull();
      expect(kart.finishTime).toBeLessThanOrEqual(180);
      for (const laps of visited[kart.id]!) expect([...laps].sort()).toEqual([0, 1, 2]);
    }
    const last = state.karts.find(kart => getRank(state, kart.id) === 8)!;
    expect(last.finishTime).toBe(Math.max(...state.karts.map(kart => kart.finishTime!)));
    expect(last.finishTime).toBeLessThanOrEqual(180);
  }, 30_000);
});

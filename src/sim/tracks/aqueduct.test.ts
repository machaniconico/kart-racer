import { describe, expect, it } from 'vitest';
import { getAIInput } from '../ai';
import { corridorAt, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, NEUTRAL_INPUT, stepRace } from '../race';
import { insideZone } from '../surfaces';
import { buildTrack, projectToTrack, rollAt, sampleTrack, slopeAt, surfaceHeightAt } from '../track';
import type { KartState } from '../types';
import { getTrack, scaffoldIds } from './index';
import { elevationRange, maxSlope, measureCpuLaps, minCurvatureRadius, WALL_HITS_MAX_EXISTING } from './shapeMetrics';

const track = getTrack('aqueduct');
const jump = track.def.surfaces.find(zone => zone.kind === 'jump')!;
const falls = track.def.surfaces.filter(zone => zone.kind === 'fall');

function place(kart: KartState, distance: number, offset = 0): void {
  const point = sampleTrack(track, distance);
  Object.assign(kart, { x: point.x + point.nx * offset, z: point.z + point.nz * offset,
    y: surfaceHeightAt(track, distance, offset), heading: Math.atan2(point.tx, point.tz),
    trackDistance: distance, lateralOffset: offset });
}

/** Detect actual intersections independently of the declared deck spans. */
function crossings() {
  const result: { upper: number; lower: number; gap: number; angle: number }[] = [];
  const { samples, length } = track;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i]!, b = samples[(i + 1) % samples.length]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    for (let j = i + 2; j < samples.length; j++) {
      if (i === 0 && j === samples.length - 1) continue;
      const c = samples[j]!, d = samples[(j + 1) % samples.length]!;
      const ex = d.x - c.x, ez = d.z - c.z, determinant = dx * ez - dz * ex;
      if (Math.abs(determinant) < 1e-9) continue;
      const t = ((c.x - a.x) * ez - (c.z - a.z) * ex) / determinant;
      const u = ((c.x - a.x) * dz - (c.z - a.z) * dx) / determinant;
      if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
      const ad = a.distance + t * ((b.distance || length) - a.distance);
      const cd = c.distance + u * ((d.distance || length) - c.distance);
      const ay = a.y + t * (b.y - a.y), cy = c.y + u * (d.y - c.y);
      result.push({ upper: ay > cy ? ad : cd, lower: ay > cy ? cd : ad,
        gap: Math.abs(ay - cy),
        angle: Math.acos(Math.min(1, Math.abs(dx * ex + dz * ez) / Math.hypot(dx, dz) / Math.hypot(ex, ez))) });
    }
  }
  return result;
}

describe('AQUEDUCT single-path upper deck', () => {
  it('replaces the scaffold with a gated, playable 1800–2200 m course', () => {
    expect(scaffoldIds()).not.toContain('aqueduct');
    expect(track.def.physics).toBeDefined();
    expect(track.length).toBeGreaterThanOrEqual(1800);
    expect(track.length).toBeLessThanOrEqual(2200);
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(() => validateTrackDef({ ...track.def, physics: undefined })).toThrow(/requires physics/);
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
    expect(sampleTrack(track, track.length)).toEqual(sampleTrack(track, 0));
    expect(track.boxPoses).toHaveLength(24);
    expect(track.def.splits ?? []).toEqual([]);
    expect(track.def.barriers ?? []).toEqual([]);
    expect(track.def.surfaces.map(zone => zone.kind)).toEqual(['jump', 'fall', 'fall']);
    expect(minCurvatureRadius(track)).toBeGreaterThanOrEqual(track.def.wallHalfWidth + 2.5);
    expect(maxSlope(track)).toBeLessThanOrEqual(0.55);
    expect(elevationRange(track).range).toBeGreaterThanOrEqual(12);
    expect(elevationRange(track).range).toBeLessThanOrEqual(elevationRange(getTrack('spire')).range);
  });

  it('runs the 11 m lower outer loop before the 7.2 m upper section, then descends late in the lap', () => {
    expect(jump.from / track.length).toBeGreaterThan(0.5);
    expect(falls).toHaveLength(2);
    const upper = falls[0]!;
    expect(upper.from - jump.to).toBeGreaterThanOrEqual(0);
    expect(upper.from - jump.to).toBeLessThanOrEqual(5);
    expect(upper.to - upper.from).toBeGreaterThan(200);
    for (let d = 0; d < track.length * 0.5; d += 0.5) {
      expect(widthAt(track, d).roadHalfWidth * 2).toBe(11);
      expect(Math.abs(sampleTrack(track, d).y)).toBeLessThan(0.5);
    }
    for (let d = upper.from; d <= upper.to; d += 0.5) {
      expect(widthAt(track, d).roadHalfWidth * 2).toBe(7.2);
      expect(sampleTrack(track, d).y).toBeCloseTo(16, 1);
      expect(insideZone(track, 'fall', d, -3.7)).toBe(true);
      expect(insideZone(track, 'fall', d, 3.7)).toBe(true);
      expect(insideZone(track, 'fall', d, 0)).toBe(false);
    }
    expect(sampleTrack(track, track.length * 0.8).y).toBeLessThan(3);
    for (let d = track.length * 0.85; d < track.length; d += 0.5) {
      expect(widthAt(track, d).roadHalfWidth * 2).toBe(11);
      expect(Math.abs(sampleTrack(track, d).y)).toBeLessThan(0.5);
    }
    for (let d = 0; d < track.length; d += 0.5) expect(corridorAt(track, d, 0)).toHaveLength(1);
    expect(track.samples.some(p => p.distance > upper.to && slopeAt(track, p.distance) < -0.1)).toBe(true);
  });

  it('banks the upper section at 12 degrees and flattens only the crossing approaches', () => {
    const angle = 12 * Math.PI / 180;
    const upper = falls[0]!;
    let bankedMetres = 0;
    for (let d = upper.from; d < upper.to; d += 0.5) {
      const roll = rollAt(track, d);
      expect(Math.abs(roll)).toBeLessThanOrEqual(angle + 1e-12);
      if (Math.abs(roll - angle) < 1e-12) bankedMetres += 0.5;
    }
    expect(bankedMetres).toBeGreaterThanOrEqual(75);
    expect(rollAt(track, 0)).toBe(0);
    expect(rollAt(track, track.length * 0.9)).toBe(0);
    const intersections = crossings();
    expect(intersections).toHaveLength(1);
    const crossing = intersections[0]!;
    expect(crossing.lower).toBeLessThan(jump.from);
    expect(crossing.upper).toBeGreaterThan(upper.from);
    expect(crossing.upper).toBeLessThan(upper.to);
    expect(crossing.gap).toBeCloseTo(16, 6);
    expect(crossing.angle).toBeCloseTo(Math.PI / 2, 6);
    expect(track.def.decks!.some(deck => crossing.upper >= deck.from && crossing.upper <= deck.to)).toBe(true);
    expect(() => validateTrackDef({ ...track.def, decks: [] })).toThrow(/upper crossing/);
    for (const distance of [crossing.lower, crossing.upper]) {
      for (let delta = -20; delta <= 20; delta += 0.5) {
        expect(Math.abs(slopeAt(track, distance + delta))).toBeLessThanOrEqual(0.1);
        expect(Math.abs(rollAt(track, distance + delta))).toBeLessThanOrEqual(0.1);
        const point = sampleTrack(track, distance + delta);
        for (const offset of [-widthAt(track, point.distance).roadHalfWidth, 0,
          widthAt(track, point.distance).roadHalfWidth]) {
          for (const hint of [point.distance - 1, undefined]) {
            const projection = projectToTrack(track, point.x + point.nx * offset,
              point.z + point.nz * offset, hint, point.y);
            expect(projection.distance).toBeCloseTo(point.distance, 2);
            expect(projection.height).toBeCloseTo(point.y, 2);
          }
        }
      }
    }
  });

  it('launches 2.0 m above the upper entrance and lands on its 7.2 m road', () => {
    expect(jump.height).toBe(2);
    const state = createRace(1, { trackId: 'aqueduct', karts: 1, itemBoxes: false });
    state.phase = 'racing';
    const kart = state.karts[0]!;
    place(kart, jump.from - 4);
    kart.speed = 26;
    let launched = false, landed = false, peak = 0;
    for (let tick = 0; tick < 180 && !landed; tick++) {
      stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
      peak = Math.max(peak, kart.y - surfaceHeightAt(track, kart.trackDistance, kart.lateralOffset));
      expect(state.events.some(event => event.type === 'fall')).toBe(false);
      if (launched && kart.airTime === 0) landed = true;
      launched ||= kart.airTime > 0;
    }
    expect(launched).toBe(true);
    expect(landed).toBe(true);
    expect(peak).toBeCloseTo(2, 6);
    expect(kart.trackDistance).toBeGreaterThan(falls[0]!.from);
    expect(kart.trackDistance).toBeLessThan(falls[0]!.to);
    expect(Math.abs(kart.lateralOffset)).toBeLessThan(3.6);
    expect(kart.y).toBeCloseTo(16, 2);
  });

  it.each([-1, 1])('recovers a fall on side %i to before the entrance and completes the lap', side => {
    const upper = falls[0]!;
    expect(falls.map(zone => zone.respawnAt)).toEqual([1200, 1200]);
    expect(upper.respawnAt).toBeLessThan(jump.from);
    expect(insideZone(track, 'fall', upper.respawnAt!, 0)).toBe(false);
    expect(track.checkpointDistances.some(d => d > upper.respawnAt! && d <= upper.to)).toBe(false);
    for (const distance of [upper.from + 1, (upper.from + upper.to) / 2, upper.to - 1]) {
      const state = createRace(42, { trackId: 'aqueduct', racers: [], karts: 1,
        laps: 1, cpuLevel: 'easy', itemBoxes: false });
      state.phase = 'racing';
      const kart = state.karts[0]!;
      place(kart, distance, side * 4);
      Object.assign(kart, { startedLap: true, lapProgress: distance, nextCheckpoint: 0 });
      stepRace(state, [NEUTRAL_INPUT]);
      expect(state.events).toEqual([{ type: 'fall', kartId: kart.id }]);
      expect(kart.trackDistance).toBe(upper.respawnAt);
      expect(kart.lapProgress).toBeCloseTo(upper.respawnAt!, 8);
      expect(kart.lapValid).toBe(true);
      expect(kart.nextCheckpoint).toBe(0);
      expect(kart.lap).toBe(0);
      let launches = 0;
      for (let tick = 0; tick < 60 * 90 && kart.finishTime === null; tick++) {
        const grounded = kart.airTime === 0;
        stepRace(state, [getAIInput(state, kart.id)]);
        if (grounded && kart.airTime > 0) launches++;
        expect(state.events.some(event => event.type === 'fall')).toBe(false);
      }
      expect(launches).toBe(1);
      expect(kart.lap).toBe(1);
      expect(kart.finishTime).not.toBeNull();
    }
  });

  it('keeps normal pace and CPU falls/wall hits within the existing budgets', () => {
    // One fall per seed on average is below CHASM's existing 9/12 fall budgets.
    const results = measureCpuLaps('aqueduct', { fallBudget: 1 });
    for (const result of results) {
      const laps = result.runs.flatMap(run => run.state.karts.flatMap(kart => kart.lapTimes));
      const meanLap = laps.reduce((sum, time) => sum + time, 0) / laps.length;
      console.info('AQUEDUCT CPU', { level: result.cpuLevel, meanLap, falls: result.falls,
        meanFalls: result.meanFalls, wallHits: result.wallHits, bandHits: result.bandHits,
        runs: result.runs.map(run => ({ seed: run.seed, finished: run.finished, falls: run.falls })) });
      expect(laps).toHaveLength(72);
      expect(result.passed).toBe(true);
      expect(result.meanFalls).toBeLessThanOrEqual(1);
      expect(result.wallHits).toBeLessThanOrEqual(WALL_HITS_MAX_EXISTING);
      if (result.cpuLevel === 'normal') {
        expect(meanLap).toBeGreaterThanOrEqual(60);
        expect(meanLap).toBeLessThanOrEqual(72);
      }
    }
  }, 120_000);
});

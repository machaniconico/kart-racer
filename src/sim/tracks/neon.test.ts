import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildScenery, disposeObjectTree } from '../../render/course/buildCourse';
import { neon as theme } from '../../render/course/themes/neon';
import { getAIInput } from '../ai';
import { KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { DEFAULT_LAPS } from '../laps';
import { createRace, FIXED_DT, stepRace } from '../race';
import { crossedZone, racingLineOffset } from '../surfaces';
import { projectToTrack, rollAt, sampleTrack, slopeAt } from '../track';
import type { TrackSample } from '../types';
import { getTrack } from './index';
import { NEON_TUNNEL } from './neon';
import { curvatureProfile, findCompoundCorners, findHairpins, findSCurves, maxSlope, minCurvatureRadius } from './shapeMetrics';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const track = getTrack('neon');
const NEON_LENGTH = 2282.93140155352;
const profile = curvatureProfile(track);
const SEEDS = [1, 42, 98765];

/** Intersections of non-neighbouring sampled centre-line segments in the XZ plane. */
function crossings() {
  const result: { upper: number; lower: number; height: number; angle: number }[] = [];
  const { samples, length } = track;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i]!, b = samples[(i + 1) % samples.length]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    for (let j = i + 2; j < samples.length; j++) {
      if (i === 0 && j === samples.length - 1) continue;
      const c = samples[j]!, d = samples[(j + 1) % samples.length]!;
      const ex = d.x - c.x, ez = d.z - c.z;
      const determinant = dx * ez - dz * ex;
      if (Math.abs(determinant) < 1e-9) continue;
      const t = ((c.x - a.x) * ez - (c.z - a.z) * ex) / determinant;
      const u = ((c.x - a.x) * dz - (c.z - a.z) * dx) / determinant;
      if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
      const ad = a.distance + t * ((b.distance || length) - a.distance);
      const cd = c.distance + u * ((d.distance || length) - c.distance);
      const ay = a.y + t * (b.y - a.y), cy = c.y + u * (d.y - c.y);
      result.push({ upper: ay > cy ? ad : cd, lower: ay > cy ? cd : ad,
        height: Math.abs(ay - cy),
        angle: Math.acos(Math.min(1, Math.abs(dx * ex + dz * ez) / Math.hypot(dx, dz) / Math.hypot(ex, ez))) });
    }
  }
  return result;
}

function expectStraight(from: number, to: number): void {
  // Include the triples touching either boundary, including between-sample zones.
  for (let i = 0; i < profile.length; i++) {
    const previous = profile[(i + profile.length - 1) % profile.length]!.distance;
    const next = profile[(i + 1) % profile.length]!.distance;
    if ((i === 0 ? 0 : previous) > to || (i === profile.length - 1 ? track.length : next) < from) continue;
    expect(1 / Math.abs(profile[i]!.curvature)).toBeGreaterThanOrEqual(200);
  }
}

function runRace(seed: number) {
  const state = createRace(seed, { trackId: 'neon', racers: [] });
  const boosts = state.karts.map(() => new Set<number>());
  let wallHits = 0, bandHits = 0;
  for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
    const previous = state.karts.map(kart => kart.trackDistance);
    // A replay is needed only on the few ticks that can enter the panel.
    const nearEntrance = state.karts.some(kart => kart.finishTime === null &&
      kart.trackDistance >= NEON_TUNNEL.from - 2 && kart.trackDistance < NEON_TUNNEL.from + 6);
    const before = nearEntrance ? structuredClone(state) : null;
    const inputs = state.karts.map(kart => getAIInput(state, kart.id));
    stepRace(state, inputs);
    for (const event of state.events) {
      if (event.type !== 'hit') continue;
      if (event.value === 1) { bandHits++; continue; }
      if (event.value === 2) continue;
      const kart = state.karts[event.kartId]!;
      if (Math.abs(kart.lateralOffset) >= widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS - 0.01) wallHits++;
    }
    for (const kart of state.karts) {
      if (!kart.startedLap || kart.finishTime !== null) continue;
      if (!crossedZone(track, 'boost', previous[kart.id]!, kart.trackDistance, kart.lateralOffset)) continue;
      expect(kart.trackDistance).toBeGreaterThanOrEqual(NEON_TUNNEL.from);
      expect(kart.trackDistance).toBeLessThan(NEON_TUNNEL.to);
      expect(state.events).toContainEqual({ type: 'boost', kartId: kart.id });
      // Item impacts run after the panel and may clear the boost in this same tick.
      if (kart.boostTime === 0) {
        expect(state.events.some(event => event.type === 'hit' && event.kartId === kart.id)).toBe(true);
      }
      expect(before).not.toBeNull();
      // Cap competing boosts while keeping acceleration active for this entrance tick.
      const entrance = structuredClone(before!);
      entrance.projectiles = [];
      entrance.traps = [];
      const enteringKart = entrance.karts[kart.id]!;
      enteringKart.boostTime = Math.min(enteringKart.boostTime, 2 * FIXED_DT);
      enteringKart.driftTime = 0;
      const previousBoostTime = enteringKart.boostTime;
      stepRace(entrance, inputs.map(input => ({ ...input, useItem: false })));
      expect(crossedZone(track, 'boost', previous[kart.id]!, enteringKart.trackDistance,
        enteringKart.lateralOffset)).toBe(true);
      expect(enteringKart.boostTime).toBeGreaterThan(previousBoostTime);
      expect(enteringKart.boostTime).toBe(0.5);
      boosts[kart.id]!.add(kart.lap);
    }
  }
  expect(state.phase).toBe('finished');
  expect(state.karts).toHaveLength(8);
  let totalLapTime = 0;
  for (const kart of state.karts) {
    expect(kart.human).toBe(false);
    expect(kart.lap).toBe(DEFAULT_LAPS);
    expect(kart.lapTimes).toHaveLength(DEFAULT_LAPS);
    expect(kart.finishTime).not.toBeNull();
    expect(kart.finishTime).toBeLessThanOrEqual(420);
    expect([...boosts[kart.id]!].sort()).toEqual([0, 1, 2]);
    totalLapTime += kart.lapTimes.reduce((sum, time) => sum + time, 0);
  }
  return { totalLapTime, wallHits, bandHits };
}

describe('NEON NIGHTLINE', () => {
  it('pins a playable 2100–2400 m layout 4 with 24 checkpoints and eight item rows', () => {
    expect(track.length).toBeCloseTo(NEON_LENGTH, 8);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.layoutVersion).toBe(4);
    expect(track.def.checkpointCount).toBe(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.boxPoses).toHaveLength(24);
    const hash = (samples: readonly TrackSample[]) => createHash('sha256').update(JSON.stringify(samples)).digest('hex');
    expect(hash(track.samples)).not.toBe(hash(getTrack('meadow').samples));
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
  });

  it('has safe right-angle blocks, a hairpin, a chicane and a compound corner', () => {
    expect(findHairpins(track)).toHaveLength(1);
    expect(findSCurves(track).length).toBeGreaterThanOrEqual(1);
    expect(findCompoundCorners(track).length).toBeGreaterThanOrEqual(1);
    expect(minCurvatureRadius(track)).toBeGreaterThanOrEqual(17);
    for (const point of profile) {
      expect(1 / Math.abs(point.curvature), `radius at ${point.distance}`)
        .toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 2.5 + 0.8);
    }
    let rightAngles = 0;
    // Separate city-block corners; these windows do not overlap the hairpin or chicane.
    for (const apex of [695, 2200]) {
      const entry = sampleTrack(track, apex - 70), exit = sampleTrack(track, apex + 70);
      const angle = Math.acos(Math.max(-1, Math.min(1, entry.tx * exit.tx + entry.tz * exit.tz))) * 180 / Math.PI;
      if (angle >= 80 && angle <= 100) rightAngles++;
    }
    expect(rightAngles).toBeGreaterThanOrEqual(2);
    expect(maxSlope(track)).toBeGreaterThan(0.1);
    expect(maxSlope(track)).toBeLessThanOrEqual(0.25);
  });

  it('keeps the opening 100 m flat and straight, including the rear-end regression at 50 m', () => {
    expectStraight(0, 100);
    for (let distance = 0; distance <= 100; distance += 0.5) {
      expect(sampleTrack(track, distance).y).toBeCloseTo(track.samples[0]!.y, 12);
      expect(slopeAt(track, distance)).toBeCloseTo(0, 12);
    }
  });

  it('crosses once above the tunnel with 13 m clearance and a 40 m deck', () => {
    const intersections = crossings();
    expect(intersections).toHaveLength(1);
    const crossing = intersections[0]!;
    expect(crossing.height).toBeGreaterThanOrEqual(13);
    expect(crossing.angle).toBeGreaterThanOrEqual(Math.PI / 4);
    expect(crossing.lower).toBeGreaterThanOrEqual(NEON_TUNNEL.from);
    expect(crossing.lower).toBeLessThanOrEqual(NEON_TUNNEL.to);
    expect(track.def.decks).toHaveLength(1);
    const deck = track.def.decks![0]!;
    expect(crossing.upper - deck.from).toBeCloseTo(20, 6);
    expect(deck.to - crossing.upper).toBeCloseTo(20, 6);
    for (const distance of [crossing.upper, crossing.lower]) {
      for (let delta = -20; delta <= 20; delta += 0.5) {
        expect(Math.abs(slopeAt(track, distance + delta))).toBeLessThanOrEqual(0.10);
        expect(Math.abs(rollAt(track, distance + delta))).toBeLessThanOrEqual(0.10);
      }
      for (const gate of track.checkpointDistances) {
        const gap = Math.abs(gate - distance);
        expect(Math.min(gap, track.length - gap)).toBeGreaterThan(25);
      }
    }
    for (const a of track.samples.filter(point => point.distance >= deck.from && point.distance <= deck.to)) {
      for (const b of track.samples.filter(point => point.distance < deck.from || point.distance > deck.to)) {
        const gap = Math.abs(a.distance - b.distance);
        if (Math.min(gap, track.length - gap) <= 31.8 || Math.hypot(a.x - b.x, a.z - b.z) > 31.8) continue;
        expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it('puts a float32-exact 6 m boost at the entrance of a straight tunnel at least 60 m long', () => {
    expect(NEON_TUNNEL.to - NEON_TUNNEL.from).toBeGreaterThanOrEqual(60);
    expect(track.def.surfaces.filter(zone => zone.kind === 'boost')).toEqual([
      { kind: 'boost', from: NEON_TUNNEL.from, to: NEON_TUNNEL.from + 6 },
    ]);
    expect(Math.fround(NEON_TUNNEL.from)).toBe(NEON_TUNNEL.from);
    expectStraight(NEON_TUNNEL.from, NEON_TUNNEL.to);
  });

  it('keeps a sweep, gate and spin floor separated from boxes, with early safe detours', () => {
    const bands = track.def.barriers!.filter(barrier => barrier.motion);
    expect(bands.filter(barrier => barrier.motion!.kind === 'sweep')).toHaveLength(1);
    expect(bands.filter(barrier => barrier.motion!.kind === 'gate')).toHaveLength(1);
    const periods = bands.map(barrier => barrier.motion!.period);
    expect(Math.max(...periods) / Math.min(...periods)).toBeLessThanOrEqual(2);
    for (const barrier of track.def.barriers!) {
      expect(barrier.halfWidth / barrier.taper!).toBeLessThanOrEqual(0.5);
      for (const row of track.def.boxRows) {
        const distance = row * track.length;
        expect(distance < barrier.from - 40 || distance > barrier.to + KART_RADIUS + 8).toBe(true);
      }
    }
    for (const barrier of bands) {
      const approach = track.def.racingLine.filter(point => point.distance < barrier.from).at(-1)!;
      expect(barrier.from - approach.distance).toBeGreaterThanOrEqual(30);
    }
    const spins = track.def.surfaces.filter(zone => zone.kind === 'spin');
    expect(spins).toHaveLength(1);
    const spin = spins[0]!;
    expect(spin.from).toBeGreaterThan(100);
    expect(spin.to).toBeGreaterThan(spin.from);
    expect(spin.to).toBeLessThan(track.length);
    expect(spin.to - spin.from).toBeLessThanOrEqual(30);
    expect(spin.offsetMax! - spin.offsetMin!).toBe(spin.to - spin.from);
    expectStraight(spin.from, spin.to);
    for (const distance of [spin.from, (spin.from + spin.to) / 2, spin.to]) {
      expect(racingLineOffset(track, distance)).toBe(0);
    }
  });

  it('has one building island with 11.7 m lanes and one 55% narrow street', () => {
    expect(track.def.splits).toHaveLength(1);
    const split = track.def.splits![0]!;
    expect(split.from).toBeGreaterThan(100);
    expect(split.to).toBeGreaterThan(split.from);
    expect(split.to).toBeLessThan(track.length);
    expect(split.lanes).toHaveLength(2);
    for (const lane of split.lanes) expect(lane.offsetMax - lane.offsetMin).toBeCloseTo(11.7, 12);
    const islands = track.def.barriers!.filter(barrier => barrier.scenery === 'building');
    expect(islands).toHaveLength(1);
    expect(islands[0]!.from).toBeGreaterThanOrEqual(split.from);
    expect(islands[0]!.to).toBeLessThanOrEqual(split.to);
    const narrow = track.def.widthKeys!.filter(key => key.roadHalfWidth < BASE_ROAD_HALF_WIDTH);
    expect(narrow).toHaveLength(2);
    expect(narrow[1]!.distance - narrow[0]!.distance).toBeGreaterThanOrEqual(40);
    for (const key of narrow) {
      expect(key.roadHalfWidth).toBeCloseTo(BASE_ROAD_HALF_WIDTH * 0.55, 12);
      expect(key.wallHalfWidth).toBeCloseTo(BASE_WALL_HALF_WIDTH * 0.55, 12);
    }
  });

  it('covers the whole lap with a continuous racing line and lateral slopes at most 0.30', () => {
    const line = track.def.racingLine;
    expect(line[0]).toEqual({ distance: 0, offset: 0 });
    expect(line.at(-1)!.distance).toBeCloseTo(track.length, 8);
    expect(line.at(-1)!.offset).toBe(line[0]!.offset);
    for (let i = 1; i < line.length; i++) {
      const previous = line[i - 1]!, point = line[i]!;
      expect(point.distance).toBeGreaterThan(previous.distance);
      expect(Math.abs(point.offset - previous.offset) / (point.distance - previous.distance)).toBeLessThanOrEqual(0.30);
    }
    expect(racingLineOffset(track, 450)).toBeGreaterThan(0);
    expect(racingLineOffset(track, 510)).toBeLessThan(0);
    expect(racingLineOffset(track, 570)).toBeGreaterThan(0);
  });

  it('bounds city scenery and clears the widened island and both overpass branches', () => {
    const group = new THREE.Group();
    theme.buildProps(track, group, theme.budget);
    const buildings = group.getObjectByName('neon:buildings') as THREE.InstancedMesh;
    expect(buildings.count).toBeGreaterThan(30);
    expect(buildings.count).toBeLessThanOrEqual(60);
    const widest = Math.max(BASE_WALL_HALF_WIDTH, ...track.def.widthKeys!.map(key => key.wallHalfWidth));
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
    for (let i = 0; i < buildings.count; i++) {
      buildings.getMatrixAt(i, matrix);
      position.setFromMatrixPosition(matrix);
      scale.setFromMatrixScale(matrix);
      expect(Math.abs(projectToTrack(track, position.x, position.z).offset))
        .toBeGreaterThan(widest + Math.hypot(scale.x, scale.z) / 2 + 4.99);
    }
    let triangles = 0;
    group.traverse(object => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      triangles += object.geometry.index!.count / 3 * object.count;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
    });
    expect(triangles).toBeLessThanOrEqual(25_200);
  });

  it('preserves all tunnel lighting when scenery is cleared from the overpass', () => {
    const group = new THREE.Group();
    buildScenery(track, theme, group);
    const lights = group.getObjectByName('neon:tunnel-lights') as THREE.Mesh;
    expect(lights).toBeInstanceOf(THREE.Mesh);
    // Nine complete ribs and two full-length guides survive the deck clearance pass.
    expect(lights.geometry.index!.count / 3).toBe(9 * 320 + 2 * 12);
    lights.geometry.computeBoundingBox();
    const entrance = sampleTrack(track, NEON_TUNNEL.from), exit = sampleTrack(track, NEON_TUNNEL.to);
    for (const point of [entrance, exit]) {
      expect(lights.geometry.boundingBox!.containsPoint(new THREE.Vector3(point.x, point.y, point.z))).toBe(true);
    }
    disposeObjectTree(group);
  });

  it('boosts all 72 CPU laps within the pace and collision budgets', () => {
    const results = SEEDS.map(runRace);
    const meanLap = results.reduce((sum, result) => sum + result.totalLapTime, 0) / 72;
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(results.reduce((sum, result) => sum + result.wallHits, 0)).toBeLessThanOrEqual(6);
    expect(results.reduce((sum, result) => sum + result.bandHits, 0)).toBeLessThanOrEqual(4);
  }, 120_000);
});

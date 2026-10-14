import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCourse } from '../../render/course/buildCourse';
import { volcano as theme, volcanoPalette } from '../../render/course/themes/volcano';
import { getAIInput } from '../ai';
import { KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, stepRace } from '../race';
import { JUMP_DURATION, racingLineOffset } from '../surfaces';
import { buildTrack, rollAt, sampleTrack, slopeAt, wrapDistance } from '../track';
import { getTrack, scaffoldIds } from './index';
import { curvatureProfile, elevationRange, findCompoundCorners, findHairpins, findSCurves,
  maxSlope, minCurvatureRadius } from './shapeMetrics';
import { VOLCANO_LENGTH } from './volcano';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const track = getTrack('volcano');
const profile = curvatureProfile(track);
const pits = track.def.surfaces.filter(zone => zone.kind === 'pit');
const jump = track.def.surfaces.find(zone => zone.kind === 'jump')!;

afterEach(() => vi.unstubAllGlobals());

/** Count intersections independently of the declared deck interval. */
function crossings() {
  const result: { upper: number; lower: number; gap: number }[] = [];
  const { samples, length } = track;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i]!, b = samples[(i + 1) % samples.length]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    for (let j = i + 2; j < samples.length; j++) {
      if (i === 0 && j === samples.length - 1) continue;
      const c = samples[j]!, d = samples[(j + 1) % samples.length]!;
      const ex = d.x - c.x, ez = d.z - c.z, cross = dx * ez - dz * ex;
      if (Math.abs(cross) < 1e-9) continue;
      const t = ((c.x - a.x) * ez - (c.z - a.z) * ex) / cross;
      const u = ((c.x - a.x) * dz - (c.z - a.z) * dx) / cross;
      if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
      const ad = a.distance + t * ((b.distance || length) - a.distance);
      const cd = c.distance + u * ((d.distance || length) - c.distance);
      const ay = a.y + t * (b.y - a.y), cy = c.y + u * (d.y - c.y);
      result.push({ upper: ay > cy ? ad : cd, lower: ay > cy ? cd : ad, gap: Math.abs(ay - cy) });
    }
  }
  return result;
}

function renderCourse() {
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ fillRect() {}, fillText() {} }) }) });
  return buildCourse(track, theme);
}

describe('EMBER CALDERA', () => {
  it('pins a playable 2100–2400m course independent of the scaffold', () => {
    expect(track.length).toBeCloseTo(VOLCANO_LENGTH, 8);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.layoutVersion).toBe(1);
    expect(track.def.checkpointCount).toBe(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(scaffoldIds()).not.toContain('volcano');
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
    expect(track.def.splits ?? []).toEqual([]);
    expect(track.def.barriers ?? []).toEqual([]);
    expect(track.def.surfaces.map(zone => zone.kind).sort()).toEqual(['dirt', 'jump', 'pit', 'pit']);
    expect(track.def.racingLine[0]).toEqual({ distance: 0, offset: 0 });
    expect(track.def.racingLine.at(-1)).toEqual({ distance: track.length, offset: 0 });
    for (let d = 0; d < track.length; d += 0.5) {
      expect(Math.abs(racingLineOffset(track, d)) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
    }
  });

  it('has two climbing switchbacks, compound corners and S bends with volcanic grades', () => {
    const hairpins = findHairpins(track);
    expect(hairpins.length).toBeGreaterThanOrEqual(2);
    for (const bend of hairpins) {
      expect(sampleTrack(track, bend.to).y - sampleTrack(track, bend.from).y).toBeGreaterThan(3);
    }
    expect(findCompoundCorners(track).length).toBeGreaterThanOrEqual(1);
    expect(findSCurves(track).length).toBeGreaterThanOrEqual(1);
    expect(elevationRange(track).range).toBeGreaterThanOrEqual(18);
    expect(maxSlope(track)).toBeGreaterThanOrEqual(0.22);
    expect(maxSlope(track)).toBeLessThanOrEqual(0.30);
    expect(minCurvatureRadius(track)).toBeGreaterThanOrEqual(17);
    for (const point of profile) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 2.5);
    }
  });

  it('crosses once on a level basalt bridge with at least 13m of separation', () => {
    expect(track.def.decks).toHaveLength(1);
    const intersections = crossings();
    expect(intersections).toHaveLength(1);
    const crossing = intersections[0]!, deck = track.def.decks![0]!;
    expect(crossing.gap).toBeGreaterThanOrEqual(13);
    expect(crossing.upper - deck.from).toBeGreaterThanOrEqual(19);
    expect(deck.to - crossing.upper).toBeGreaterThanOrEqual(19);
    for (const d of [crossing.upper, crossing.lower]) {
      for (let delta = -20; delta <= 20; delta += 0.5) {
        expect(Math.abs(slopeAt(track, d + delta))).toBeLessThanOrEqual(0.1);
        expect(Math.abs(rollAt(track, d + delta))).toBeLessThanOrEqual(0.1);
      }
      for (const gate of track.checkpointDistances) {
        const gap = wrapDistance(track, gate - d);
        expect(Math.min(gap, track.length - gap)).toBeGreaterThan(25);
      }
    }
  });

  it('leaves a continuous safe lane beside both lava pits and one downhill jump', () => {
    expect(pits).toHaveLength(2);
    expect(track.def.surfaces.filter(zone => zone.kind === 'jump')).toHaveLength(1);
    expect(jump.offsetMin).toBeUndefined();
    expect(jump.offsetMax).toBeUndefined();
    expect(slopeAt(track, jump.to)).toBeLessThan(0);
    expect(sampleTrack(track, jump.to + 40).y).toBeLessThan(sampleTrack(track, jump.from).y);
    const landingSamples = [jump.to, jump.to + 40, ...track.samples.map(p => p.distance)
      .filter(d => d > jump.to && d < jump.to + 40)];
    for (const d of landingSamples) expect(slopeAt(track, d)).toBeGreaterThanOrEqual(slopeAt(track, jump.to) - 0.05);
    for (const point of profile.filter(p => p.distance >= jump.from - 15 && p.distance <= jump.from + 50 * JUMP_DURATION)) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(40);
    }
    for (const pit of pits) {
      expect(pit.from - jump.from).toBeGreaterThanOrEqual(4);
      expect(pit.from - jump.from).toBeLessThanOrEqual(12);
      expect((pit.to - jump.from) / JUMP_DURATION).toBeGreaterThanOrEqual(15);
      expect((pit.to - jump.from) / JUMP_DURATION).toBeLessThanOrEqual(26);
      // Check approaches and exits too; a centre line with no connecting lane is not a bypass.
      for (let d = pit.from - 40; d <= pit.to + 40; d += 0.5) {
        const offset = racingLineOffset(track, d);
        expect(Math.abs(offset) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
        for (const hole of pits.filter(hole => d >= hole.from && d <= hole.to)) {
          const clearance = Math.max(hole.offsetMin! - offset, offset - hole.offsetMax!);
          expect(clearance).toBeGreaterThan(KART_RADIUS + 0.3);
        }
      }
    }
    expect(pits[1]!.offsetMin! - pits[0]!.offsetMax! - 2 * KART_RADIUS).toBeGreaterThanOrEqual(2.55);
  });

  it('narrows one ridge to 55% and banks one corner without excessive twist', () => {
    const keys = track.def.widthKeys!;
    expect(keys).toHaveLength(4);
    expect(keys.map(key => key.roadHalfWidth)).toEqual([
      BASE_ROAD_HALF_WIDTH, BASE_ROAD_HALF_WIDTH * 0.55, BASE_ROAD_HALF_WIDTH * 0.55, BASE_ROAD_HALF_WIDTH,
    ]);
    expect(keys.map(key => key.wallHalfWidth)).toEqual([
      BASE_WALL_HALF_WIDTH, BASE_WALL_HALF_WIDTH * 0.55, BASE_WALL_HALF_WIDTH * 0.55, BASE_WALL_HALF_WIDTH,
    ]);
    expect(keys[1]!.distance - keys[0]!.distance).toBeGreaterThanOrEqual(20);
    expect(keys[3]!.distance - keys[2]!.distance).toBeGreaterThanOrEqual(20);
    expect(keys[2]!.distance).toBeGreaterThan(keys[1]!.distance);
    expect(2 * keys[1]!.roadHalfWidth - 2 * KART_RADIUS).toBeGreaterThanOrEqual(2.55);
    const banks = track.def.bankKeys!;
    expect(banks.filter((key, i) => key.roll !== 0 && banks[i - 1]!.roll === 0)).toHaveLength(1);
    for (let i = 1; i < banks.length; i++) {
      const a = banks[i - 1]!, b = banks[i]!;
      if (b.roll !== 0) {
        expect(b.roll).toBeGreaterThanOrEqual(0.25);
        expect(b.roll).toBeLessThanOrEqual(0.35);
      }
      expect(Math.abs(b.roll - a.roll) / (b.distance - a.distance)).toBeLessThanOrEqual(0.02);
    }
    expect(banks[0]).toEqual({ distance: 0, roll: 0 });
    expect(banks.at(-1)).toEqual({ distance: track.length, roll: 0 });
    expect(rollAt(track, track.length - 0.01)).toBe(0);
  });

  it('renders emissive lava and volcanic props within the triangle budget', () => {
    const course = renderCourse();
    try {
      let triangles = 0;
      course.group.traverse(object => {
        expect(object).not.toBeInstanceOf(THREE.Points);
        if (!(object instanceof THREE.Mesh)) return;
        triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3 *
          (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
      });
      // trianglesCap(length), conservatively including shadows and 20k for eight karts.
      expect(triangles + 20_000).toBeLessThanOrEqual(60 * track.length + 30_000);
      for (const name of ['trunks', 'volcano:dead-branches', 'volcano:lava-columns', 'rocks', 'flowers']) {
        const mesh = course.group.getObjectByName(name) as THREE.InstancedMesh;
        expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
        expect(mesh.count).toBeGreaterThan(0);
        mesh.geometry.computeBoundingSphere();
        const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
        const rotation = new THREE.Quaternion();
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          matrix.decompose(position, rotation, scale);
          const radius = mesh.geometry.boundingSphere!.radius * Math.max(scale.x, scale.y, scale.z);
          let clearance = Infinity;
          for (const [j, a] of track.samples.entries()) {
            const b = track.samples[(j + 1) % track.samples.length]!;
            const dx = b.x - a.x, dz = b.z - a.z;
            const t = Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.z - a.z) * dz) / (dx * dx + dz * dz)));
            const d = a.distance + t * ((b.distance || track.length) - a.distance);
            clearance = Math.min(clearance, Math.hypot(position.x - a.x - t * dx, position.z - a.z - t * dz)
              - widthAt(track, d).wallHalfWidth - radius);
          }
          expect(clearance, `${name}:${i}`).toBeGreaterThan(0);
        }
      }
      expect(course.group.getObjectByName('crowns')).toBeUndefined();
      expect(course.group.getObjectByName('peaks')).toBeUndefined();
      for (const name of ['surface:pit', 'flowers']) {
        const mesh = course.group.getObjectByName(name) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
        expect(mesh.material.emissive.getHex()).toBe(volcanoPalette.lava);
        expect(mesh.material.emissiveIntensity).toBeGreaterThan(0);
      }
      const road = course.group.getObjectByName('road') as THREE.Mesh;
      const lava = course.group.getObjectByName('surface:pit') as THREE.Mesh;
      course.group.updateMatrixWorld(true);
      for (const pit of pits) {
        const p = sampleTrack(track, (pit.from + pit.to) / 2), offset = (pit.offsetMin! + pit.offsetMax!) / 2;
        const ray = new THREE.Raycaster(new THREE.Vector3(p.x + p.nx * offset, p.y + 10, p.z + p.nz * offset),
          new THREE.Vector3(0, -1, 0));
        expect(ray.intersectObjects([road, lava])[0]!.object.name).toBe('surface:pit');
        ray.ray.origin.set(p.x, p.y + 10, p.z);
        expect(ray.intersectObjects([road, lava])[0]!.object.name).toBe('road');
      }
      for (const fraction of theme.signFractions) {
        expect(fraction).toBeGreaterThan(0);
        expect(fraction).toBeLessThan(1);
        const d = fraction * track.length;
        expect(pits.some(pit => d >= pit.from - 10 && d <= pit.to + 10)).toBe(false);
      }
    } finally { course.dispose(); }
  });

  it('keeps supports out of the lower road and terrain below the ridge and descent', () => {
    const course = renderCourse();
    try {
      const pillars = course.group.getObjectByName('deck-pillars') as THREE.InstancedMesh;
      expect(pillars.count).toBeGreaterThan(0);
      const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      for (let i = 0; i < pillars.count; i++) {
        pillars.getMatrixAt(i, matrix);
        matrix.decompose(position, rotation, scale);
        for (const [j, a] of track.samples.entries()) {
          const b = track.samples[(j + 1) % track.samples.length]!;
          if (Math.min(a.y, b.y) >= position.y + scale.y / 2) continue;
          const dx = b.x - a.x, dz = b.z - a.z;
          const t = Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.z - a.z) * dz) / (dx * dx + dz * dz)));
          const d = a.distance + t * ((b.distance || track.length) - a.distance);
          expect(Math.hypot(position.x - a.x - t * dx, position.z - a.z - t * dz))
            .toBeGreaterThan(widthAt(track, d).wallHalfWidth + 0.45);
        }
      }
      const grounds = [-1, 1].map(side => course.group.getObjectByName(`ground:${side}`)!);
      course.group.updateMatrixWorld(true);
      for (const [from, to] of [[990, 1120], [1275, 1470], [2130, 2265]]) {
        for (let d = from!; d <= to!; d += 5) {
          const p = sampleTrack(track, d);
          for (const side of [-1, 1]) for (const margin of [0.5, 5, 12]) {
            const offset = side * (widthAt(track, d).wallHalfWidth + margin);
            const ray = new THREE.Raycaster(new THREE.Vector3(p.x + p.nx * offset, 100, p.z + p.nz * offset),
              new THREE.Vector3(0, -1, 0));
            const hits = ray.intersectObjects(grounds);
            expect(hits.length).toBeGreaterThan(0);
            expect(hits[0]!.point.y, `ground at ${d}, offset ${offset}`).toBeLessThanOrEqual(p.y + 0.1);
          }
        }
      }
    } finally { course.dispose(); }
  });

  // M6-03: 8 CPUs × seeds [1, 42, 98765] × 3 laps (72 completed laps),
  // meanLap 67.82407407407408 s, wallHits 0, bandHits 0, pitFalls 0.
  // Same hit classification and 60 * 420 tick stop as handling.test.ts; no AI/sim changes.
  it('finishes 72 CPU laps within pace/hit budgets and flies the descent every lap', () => {
    const lapTimes: number[] = [];
    let wallHits = 0, bandHits = 0, pitFalls = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'volcano', racers: [] });
      const flights = state.karts.map(() => new Set<number>());
      for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
        stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
        for (const event of state.events) {
          if (event.type !== 'hit') continue;
          if (event.value === 1) { bandHits++; continue; }
          if (event.value === 2) { pitFalls++; continue; }
          const kart = state.karts[event.kartId]!;
          if (Math.abs(kart.lateralOffset) >= widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS - 0.01) wallHits++;
        }
        for (const kart of state.karts) {
          if (kart.finishTime === null && kart.airTime > 0 && kart.trackDistance >= jump.from && kart.trackDistance <= jump.to + 40) {
            flights[kart.id]!.add(kart.lap);
          }
        }
      }
      expect(state.phase).toBe('finished');
      expect(state.karts).toHaveLength(8);
      for (const kart of state.karts) {
        expect(kart.human).toBe(false);
        expect(kart.lap).toBe(3);
        expect(kart.finishTime).not.toBeNull();
        expect(kart.lapTimes).toHaveLength(3);
        expect([...flights[kart.id]!].sort()).toEqual([0, 1, 2]);
        lapTimes.push(...kart.lapTimes);
      }
    }
    expect(lapTimes).toHaveLength(72);
    const meanLap = lapTimes.reduce((sum, time) => sum + time, 0) / lapTimes.length;
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(6);
    expect(bandHits).toBe(0);
    expect(pitFalls).toBeLessThanOrEqual(6);
  }, 120_000);
});

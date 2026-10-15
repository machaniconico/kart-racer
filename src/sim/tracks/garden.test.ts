// M10-02 (darwin-arm64): 42 meshes; five-build median 97.782 ms (2026-10-16).
// 8 CPUs × seeds [1, 42, 98765] × 3 laps: 72 laps, meanLap 65.24166666666663 s,
// wallHits 0, bandHits 0, pitFalls 0. Hit classification matches handling.test.ts.
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCourse } from '../../render/course/buildCourse';
import { garden as theme, gardenPalette } from '../../render/course/themes/garden';
import { meadow as meadowTheme } from '../../render/course/themes/meadow';
import { getAIInput } from '../ai';
import { barrierHalfWidthAt, corridorAt, exclusionAt, KART_RADIUS,
  validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, stepRace } from '../race';
import { JUMP_DURATION, racingLineOffset } from '../surfaces';
import { buildTrack, projectToTrack, sampleTrack } from '../track';
import { getTrack, scaffoldIds } from './index';
import { GARDEN_LENGTH } from './garden';
import { curvatureProfile, elevationRange, maxSlope } from './shapeMetrics';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH, WIDTH_SCALE } from './widths';

const track = getTrack('garden');
const profile = curvatureProfile(track);
const splits = track.def.splits!;
const islands = track.def.barriers!.filter(barrier => barrier.scenery === 'rock');
const gate = track.def.barriers!.find(barrier => barrier.motion)!;
const jump = track.def.surfaces.find(zone => zone.kind === 'jump')!;
const pit = track.def.surfaces.find(zone => zone.kind === 'pit')!;

afterEach(() => vi.unstubAllGlobals());

function renderCourse() {
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ fillRect() {}, fillText() {} }) }) });
  return buildCourse(track, theme);
}

describe('BLOSSOM GARDEN', () => {
  it('pins a playable course independent of the scaffold and stable through JSON', () => {
    expect(track.length).toBeCloseTo(2309.59306536773, 8);
    expect(track.length).toBe(GARDEN_LENGTH);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.layoutVersion).toBe(1);
    expect(track.def.checkpointCount).toBe(24);
    expect(track.checkpointDistances).toHaveLength(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.boxPoses).toHaveLength(24);
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(scaffoldIds()).not.toContain('garden');
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
    expect(track.def.racingLine[0]).toEqual({ distance: 0, offset: 0 });
    expect(track.def.racingLine.at(-1)).toEqual({ distance: track.length, offset: 0 });
    for (let d = 0; d < track.length; d += 0.5) {
      expect(Math.abs(racingLineOffset(track, d)) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
    }
  });

  it('keeps the rolling garden below 8m relief and every corner outside the walls', () => {
    expect(elevationRange(track).range).toBeGreaterThan(0);
    expect(elevationRange(track).range).toBeLessThanOrEqual(8);
    expect(maxSlope(track)).toBeLessThanOrEqual(0.30);
    for (const point of profile) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 2.5);
    }
    expect(track.def.decks ?? []).toEqual([]);
    // This ground-level garden must not accidentally introduce a bridge crossing.
    const { samples } = track;
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
        if (t >= 0 && t < 1 && u >= 0 && u < 1) throw new Error(`Unexpected crossing: ${i}/${j}`);
      }
    }
  });

  it('has two lantern-stone islands, with an inner risk lane and an outer risk lane', () => {
    expect(splits).toHaveLength(2);
    expect(islands).toHaveLength(2);
    expect(track.def.barriers).toHaveLength(3);
    for (const [index, split] of splits.entries()) {
      const barrier = islands[index]!;
      expect(barrier.from).toBeGreaterThan(split.from);
      expect(barrier.to).toBeLessThan(split.to);
      expect(barrier.taper).toBeGreaterThanOrEqual(8);
      expect(split.lanes).toHaveLength(2);
      const risky = split.lanes.filter(lane => lane.risk === 1);
      expect(risky).toHaveLength(1);
      const turn = profile.filter(p => p.distance >= split.from && p.distance <= split.to)
        .reduce((sum, p) => sum + p.turn, 0);
      expect(Math.abs(turn)).toBeGreaterThan(0.01);
      // Heading = atan2(tx, tz), so its sign is opposite the x-z circumcircle turn.
      const innerSide = -Math.sign(turn);
      expect(Math.sign(risky[0]!.offsetMin + risky[0]!.offsetMax)).toBe(index === 0 ? innerSide : -innerSide);
      for (const lane of split.lanes) expect(lane.offsetMax - lane.offsetMin).toBeGreaterThanOrEqual(6);
      for (let d = split.from - 35; d < split.from; d += 0.5) expect(corridorAt(track, d, 0)).toHaveLength(1);
      for (let d = split.from; d <= split.to; d += 0.5) {
        const intervals = corridorAt(track, d, 0);
        expect(intervals).toHaveLength(2);
        for (const lane of split.lanes) {
          expect(intervals.some(interval => lane.offsetMin >= interval.min - 1e-8 && lane.offsetMax <= interval.max + 1e-8)).toBe(true);
        }
        const safe = split.lanes.find(lane => lane.risk === 0)!;
        expect(racingLineOffset(track, d)).toBeGreaterThan(safe.offsetMin + KART_RADIUS);
        expect(racingLineOffset(track, d)).toBeLessThan(safe.offsetMax - KART_RADIUS);
      }
    }
  });

  it('pairs one pond with a jump and a continuous paved bypass with kart clearance', () => {
    expect(track.def.surfaces.map(zone => zone.kind).sort()).toEqual(['jump', 'pit']);
    expect(pit.from - jump.from).toBeGreaterThanOrEqual(4);
    expect(pit.from - jump.from).toBeLessThanOrEqual(12);
    expect((pit.to - jump.from) / JUMP_DURATION).toBeGreaterThanOrEqual(15);
    expect((pit.to - jump.from) / JUMP_DURATION).toBeLessThanOrEqual(26);
    expect(jump.offsetMin).toBeLessThanOrEqual(pit.offsetMin!);
    expect(jump.offsetMax).toBeGreaterThanOrEqual(pit.offsetMax!);
    for (let d = pit.from - 40; d <= pit.to + 40; d += 0.5) {
      const offset = racingLineOffset(track, d);
      expect(Math.abs(offset) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
      if (d >= pit.from && d <= pit.to) {
        expect(Math.max(pit.offsetMin! - offset, offset - pit.offsetMax!)).toBeGreaterThan(KART_RADIUS + 0.3);
      }
    }
    for (const point of profile.filter(p => p.distance >= jump.from - 15 && p.distance <= jump.to + 40)) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(40);
    }
  });

  it('opens one wooden gate without blocking the racing line at any phase', () => {
    expect(gate.scenery).toBe('block');
    expect(gate.motion!.kind).toBe('gate');
    expect(gate.motion!.minWidth).toBeGreaterThanOrEqual(0.6 * WIDTH_SCALE);
    expect(barrierHalfWidthAt(gate, gate.motion!.period / 2)).toBeLessThan(barrierHalfWidthAt(gate, 0));
    for (let time = 0; time <= gate.motion!.period; time += 0.25) {
      for (let d = gate.from; d <= gate.to; d += 0.5) {
        const exclusion = exclusionAt(track, gate, d, time)!;
        expect(racingLineOffset(track, d)).toBeLessThan(exclusion.min);
      }
    }
  });

  it('renders cherry blossoms, stone lanterns, pond water and a wooden gate within budget', () => {
    expect(theme).not.toBe(meadowTheme);
    expect(theme.colors.curb).toEqual([gardenPalette.blossom, gardenPalette.white]);
    expect(theme.colors.shoulder).toBe(gardenPalette.limestone);
    expect(theme.colors.motionBarrier).toBe(gardenPalette.wood);
    const course = renderCourse();
    try {
      let triangles = 0;
      course.group.traverse(object => {
        expect(object).not.toBeInstanceOf(THREE.Points);
        if (!(object instanceof THREE.Mesh)) return;
        triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3 *
          (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
      });
      expect(triangles + 20_000).toBeLessThanOrEqual(60 * track.length + 30_000);
      for (const name of ['trunks', 'crowns', 'rocks', 'garden:lanterns', 'flowers']) {
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
          for (const [j, a] of track.samples.entries()) {
            const b = track.samples[(j + 1) % track.samples.length]!;
            const dx = b.x - a.x, dz = b.z - a.z;
            const t = Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.z - a.z) * dz) / (dx * dx + dz * dz)));
            const d = a.distance + t * ((b.distance || track.length) - a.distance);
            const clearance = Math.hypot(position.x - a.x - t * dx, position.z - a.z - t * dz)
              - widthAt(track, d).wallHalfWidth - radius;
            if (clearance <= 0) throw new Error(`${name}:${i} overlaps road at ${d}`);
          }
        }
      }
      // Island lanterns deliberately occupy the physical barrier, outside both drivable lanes.
      const lanterns = course.group.getObjectByName('garden:island-lanterns') as THREE.Mesh;
      expect(lanterns).toBeInstanceOf(THREE.Mesh);
      const vertices = lanterns.geometry.getAttribute('position');
      expect(vertices.count).toBeGreaterThan(0);
      for (let i = 0; i < vertices.count; i++) {
        const p = projectToTrack(track, vertices.getX(i), vertices.getZ(i));
        expect(islands.some(barrier => {
          const along = p.distance - barrier.from;
          const half = barrier.halfWidth * Math.min(1, along / barrier.taper!, (barrier.to - p.distance) / barrier.taper!);
          return along >= 0 && p.distance <= barrier.to && Math.abs(p.offset) < half;
        })).toBe(true);
      }
      const water = course.group.getObjectByName('surface:pit') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
      expect(water.material.color.getHex()).toBe(gardenPalette.pond);
      const door = course.group.getObjectByName('motion:barrier:2') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
      expect(door.material.color.getHex()).toBe(gardenPalette.wood);
      const initialWidth = door.scale.x;
      course.update(gate.motion!.period / 2);
      expect(door.scale.x).toBeLessThan(initialWidth);
      const road = course.group.getObjectByName('road')!;
      course.group.updateMatrixWorld(true);
      const point = sampleTrack(track, (pit.from + pit.to) / 2), offset = (pit.offsetMin! + pit.offsetMax!) / 2;
      const ray = new THREE.Raycaster(new THREE.Vector3(point.x + point.nx * offset, point.y + 10, point.z + point.nz * offset),
        new THREE.Vector3(0, -1, 0));
      expect(ray.intersectObjects([road, water])[0]!.object.name).toBe('surface:pit');
      ray.ray.origin.set(point.x, point.y + 10, point.z);
      expect(ray.intersectObjects([road, water])[0]!.object.name).toBe('road');
    } finally { course.dispose(); }
  });

  it('measures five complete course builds and keeps scenery deterministic', () => {
    const times: number[] = [];
    let meshes = 0;
    let instances: number[][] = [];
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      const course = renderCourse();
      times.push(performance.now() - started);
      try {
        let count = 0;
        const matrices: number[][] = [];
        course.group.traverse(object => {
          if (object instanceof THREE.Mesh) count++;
          if (object instanceof THREE.InstancedMesh) matrices.push(Array.from(object.instanceMatrix.array));
        });
        if (run === 0) { meshes = count; instances = matrices; }
        else { expect(count).toBe(meshes); expect(matrices).toEqual(instances); }
      } finally { course.dispose(); }
    }
    console.log('GARDEN RENDER', { meshes, medianMs: times.sort((a, b) => a - b)[2] });
  });
  it('finishes 72 CPU laps within pace and hit budgets', () => {
    const lapTimes: number[] = [];
    let wallHits = 0, bandHits = 0, pitFalls = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'garden', racers: [] });
      for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
        stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
        for (const event of state.events) {
          if (event.type !== 'hit') continue;
          if (event.value === 1) { bandHits++; continue; }
          if (event.value === 2) { pitFalls++; continue; }
          const kart = state.karts[event.kartId]!;
          if (Math.abs(kart.lateralOffset) >= widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS - 0.01) wallHits++;
        }
      }
      expect(state.phase).toBe('finished');
      expect(state.karts).toHaveLength(8);
      for (const kart of state.karts) {
        expect(kart.human).toBe(false);
        expect(kart.lap).toBe(3);
        expect(kart.finishTime).not.toBeNull();
        expect(kart.lapTimes).toHaveLength(3);
        lapTimes.push(...kart.lapTimes);
      }
    }
    expect(lapTimes).toHaveLength(72);
    const meanLap = lapTimes.reduce((sum, time) => sum + time, 0) / lapTimes.length;
    console.log('GARDEN CPU', { meanLap, wallHits, bandHits, pitFalls });
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(6);
    expect(bandHits).toBeLessThanOrEqual(2);
    expect(pitFalls).toBeLessThanOrEqual(6);
  }, 120_000);
});

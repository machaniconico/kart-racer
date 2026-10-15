// M10-04 measured 2026-10-16, darwin-arm64 (concurrent story verification):
// buildCourse: 39 meshes, 78,091 triangles including shadows; five-build median 685.699 ms.
// 8 CPUs × seeds [1, 42, 98765] × 3 laps: 72 completed laps; meanLap 68.79768518518516 s,
// wallHits 0, bandHits 0, pitFalls 0. Hit classification matches handling.test.ts.
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCourse } from '../../render/course/buildCourse';
import { bayou as theme, bayouPalette } from '../../render/course/themes/bayou';
import { getAIInput } from '../ai';
import { barrierCenterAt, barrierHalfWidthAt, exclusionAt, KART_RADIUS,
  validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, stepRace } from '../race';
import { JUMP_DURATION, racingLineOffset } from '../surfaces';
import { buildTrack, rollAt, sampleTrack, slopeAt, wrapDistance } from '../track';
import { getTrack, scaffoldIds } from './index';
import { curvatureProfile, elevationRange, maxSlope } from './shapeMetrics';
import { BAYOU_LENGTH } from './bayou';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const track = getTrack('bayou');
const profile = curvatureProfile(track);
const pits = track.def.surfaces.filter(zone => zone.kind === 'pit');
const jumps = track.def.surfaces.filter(zone => zone.kind === 'jump');
const sceneryNames = ['trunks', 'bayou:cypress-crowns', 'rocks', 'bayou:reeds', 'flowers'];

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

describe('MOONLIT BAYOU', () => {
  it('pins a playable 2100–2400m course independent of the scaffold', () => {
    expect(track.length).toBeCloseTo(BAYOU_LENGTH, 8);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.id).toBe('bayou');
    expect(track.def.themeId).toBe('bayou');
    expect(track.def.layoutVersion).toBe(1);
    expect(track.def.checkpointCount).toBe(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(scaffoldIds()).not.toContain('bayou');
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
    expect(track.def.racingLine[0]).toEqual({ distance: 0, offset: 0 });
    expect(track.def.racingLine.at(-1)).toEqual({ distance: track.length, offset: 0 });
    for (let d = 0; d < track.length; d += 0.5) {
      expect(Math.abs(racingLineOffset(track, d)) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
    }
  });

  it('keeps both marsh loops smooth with shallow bridge approaches', () => {
    expect(maxSlope(track)).toBeLessThanOrEqual(0.30);
    expect(elevationRange(track).range).toBeGreaterThanOrEqual(17.9);
    expect(profile.some(point => point.curvature > 1 / 100)).toBe(true);
    expect(profile.some(point => point.curvature < -1 / 100)).toBe(true);
    for (const point of profile) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 2.5);
    }
    expect(track.def.splits ?? []).toEqual([]);
    expect(track.def.surfaces.map(zone => zone.kind).sort()).toEqual(['dirt', 'dirt', 'jump', 'jump', 'pit', 'pit']);
  });

  it('crosses once on a timber deck with at least 13m of separation', () => {
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

  it('pairs both water pits with shoreline jumps and continuous paved bypasses', () => {
    expect(pits).toHaveLength(2);
    expect(jumps).toHaveLength(2);
    for (const pit of pits) {
      const jump = jumps.find(zone => pit.from - zone.from >= 4 && pit.from - zone.from <= 12)!;
      expect(jump).toBeDefined();
      expect(jump.offsetMin).toBeLessThanOrEqual(pit.offsetMin!);
      expect(jump.offsetMax).toBeGreaterThanOrEqual(pit.offsetMax!);
      expect((pit.to - jump.from) / JUMP_DURATION).toBeGreaterThanOrEqual(15);
      expect((pit.to - jump.from) / JUMP_DURATION).toBeLessThanOrEqual(26);
      for (let d = pit.from - 40; d <= pit.to + 40; d += 0.5) {
        const offset = racingLineOffset(track, d);
        expect(Math.abs(offset) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
        for (const hole of pits.filter(hole => d >= hole.from && d <= hole.to)) {
          expect(Math.max(hole.offsetMin! - offset, offset - hole.offsetMax!)).toBeGreaterThan(KART_RADIUS + 0.3);
        }
      }
      for (const point of profile.filter(point => point.distance >= jump.from - 15 && point.distance <= jump.from + 50 * JUMP_DURATION)) {
        expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(40);
      }
    }
    const mud = track.def.surfaces.filter(zone => zone.kind === 'dirt');
    expect(mud).toHaveLength(2);
    for (const patch of mud) {
      expect(patch.to - patch.from).toBeGreaterThanOrEqual(80);
      expect(patch.offsetMin).toBeUndefined();
      expect(patch.offsetMax).toBeUndefined();
      expect(pits.some(pit => pit.from < patch.to && pit.to > patch.from)).toBe(false);
    }
  });

  it('sweeps two logs without closing the racing line at any phase', () => {
    expect(track.def.barriers).toHaveLength(2);
    for (const barrier of track.def.barriers!) {
      expect(barrier.scenery).toBe('block');
      expect(barrier.motion?.kind).toBe('sweep');
      const motion = barrier.motion!;
      expect(motion.amplitude).toBeGreaterThan(0);
      expect(2 * Math.PI * motion.amplitude / motion.period).toBeLessThanOrEqual(6);
      const safeHalf = Math.abs(barrier.center) - motion.amplitude - barrier.halfWidth;
      expect(safeHalf).toBeGreaterThan(KART_RADIUS + 0.3);
      for (let phase = 0; phase <= 32; phase++) for (let d = barrier.from - 1; d <= barrier.to + 1; d += 0.5) {
        const exclusion = exclusionAt(track, barrier, d, phase * motion.period / 32);
        if (!exclusion) continue;
        const line = racingLineOffset(track, d);
        expect(Math.max(exclusion.min - line, line - exclusion.max)).toBeGreaterThan(0.3);
      }
    }
  });

  it('builds the teal marsh and violet scenery within the triangle budget', () => {
    const elapsed: number[] = [];
    let meshCount = 0, triangles = 0;
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      const course = renderCourse();
      elapsed.push(performance.now() - start);
      try {
        meshCount = triangles = 0;
        course.group.traverse(object => {
          expect(object).not.toBeInstanceOf(THREE.Points);
          if (!(object instanceof THREE.Mesh)) return;
          meshCount++;
          triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3 *
            (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
        });
        expect(triangles + 20_000).toBeLessThanOrEqual(60 * track.length + 30_000);
        expect(theme.colors.ground).toBe(bayouPalette.teal);
        expect(theme.colors.surfaces.pit).toBe(bayouPalette.water);
        expect(theme.colors.surfaces.dirt).toBe(bayouPalette.mud);
        expect(theme.colors.deck).toBe(bayouPalette.wood);
        expect(theme.fog.near).toBeLessThanOrEqual(90);
        expect(theme.fog.far).toBeLessThanOrEqual(300);
        const fungi = course.group.getObjectByName('flowers') as THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
        expect(fungi.material.emissive.getHex()).toBe(bayouPalette.violet);
        expect(fungi.material.emissiveIntensity).toBeGreaterThan(0);
        const bridge = course.group.getObjectByName('bayou:bridge-logs') as THREE.Mesh;
        expect(bridge).toBeInstanceOf(THREE.Mesh);
        expect(bridge.geometry.getAttribute('position').count).toBeGreaterThan(1000);
      } finally { course.dispose(); }
    }
    console.info('bayou render', { meshCount, triangles, medianBuildMs: elapsed.sort((a, b) => a - b)[2] });
  });

  it('keeps every instanced scenery footprint outside both roads', () => {
    const course = renderCourse();
    try {
      for (const name of sceneryNames) {
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
    } finally { course.dispose(); }
  });

  it('renders open water, a clear underpass and logs aligned with the sweep collision', () => {
    const course = renderCourse();
    try {
      const road = course.group.getObjectByName('road') as THREE.Mesh;
      const water = course.group.getObjectByName('surface:pit') as THREE.Mesh;
      course.group.updateMatrixWorld(true);
      for (const pit of pits) {
        const p = sampleTrack(track, (pit.from + pit.to) / 2), offset = (pit.offsetMin! + pit.offsetMax!) / 2;
        const ray = new THREE.Raycaster(new THREE.Vector3(p.x + p.nx * offset, p.y + 10, p.z + p.nz * offset),
          new THREE.Vector3(0, -1, 0));
        expect(ray.intersectObjects([road, water])[0]!.object.name).toBe('surface:pit');
        ray.ray.origin.set(p.x, p.y + 10, p.z);
        expect(ray.intersectObjects([road, water])[0]!.object.name).toBe('road');
      }
      const crossing = crossings()[0]!;
      const lower = sampleTrack(track, crossing.lower);
      const ray = new THREE.Raycaster(new THREE.Vector3(lower.x, lower.y + 8, lower.z), new THREE.Vector3(0, -1, 0));
      expect(ray.intersectObjects([road, course.group.getObjectByName('deck-pillars')!])[0]!.object.name).toBe('road');
      for (const [i, barrier] of track.def.barriers!.entries()) {
        const log = course.group.getObjectByName(`motion:barrier:${i}`) as THREE.Mesh<THREE.CylinderGeometry, THREE.MeshLambertMaterial>;
        expect(log.geometry).toBeInstanceOf(THREE.CylinderGeometry);
        expect(log.material.color.getHex()).toBe(bayouPalette.wood);
        const p = sampleTrack(track, (barrier.from + barrier.to) / 2);
        for (const time of [0, 2, 4, 6, 8, 13]) {
          course.update(time);
          const center = barrierCenterAt(barrier, time);
          expect(log.position.x).toBeCloseTo(p.x + p.nx * center, 8);
          expect(log.position.z).toBeCloseTo(p.z + p.nz * center, 8);
          expect(log.scale.x).toBe(barrierHalfWidthAt(barrier, time));
        }
      }
    } finally { course.dispose(); }
  });

  it('finishes 72 CPU laps within pace, wall, barrier and pit budgets', () => {
    const lapTimes: number[] = [];
    let wallHits = 0, bandHits = 0, pitFalls = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'bayou', racers: [] });
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
    console.info('bayou CPU', { meanLap, wallHits, bandHits, pitFalls });
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(6);
    expect(bandHits).toBeLessThanOrEqual(2);
    expect(pitFalls).toBeLessThanOrEqual(6);
  }, 120_000);
});

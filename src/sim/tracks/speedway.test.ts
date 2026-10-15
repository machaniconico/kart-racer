// M10-03, darwin-arm64: 30 meshes, 68,122 triangles including shadows;
// buildCourse median of five builds: 82.47 ms under concurrent story load (2026-10-16).
// 8 CPUs × seeds [1, 42, 98765] × 3 laps = 72 completed laps:
// meanLap 63.362500000000004 s, meanSpeed 35.610839532949186 m/s,
// wallHits 0, bandHits 0, pitFalls 0 (NEON baseline: 35.488151098445165 m/s).
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCourse } from '../../render/course/buildCourse';
import { speedway as theme, speedwayPalette } from '../../render/course/themes/speedway';
import { getAIInput } from '../ai';
import { barrierCenterAt, exclusionAt, KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, stepRace } from '../race';
import { racingLineOffset } from '../surfaces';
import { buildTrack, rollAt, sampleTrack } from '../track';
import type { Track } from '../types';
import { getTrack, scaffoldIds, TRACK_IDS } from './index';
import { curvatureProfile, maxSlope } from './shapeMetrics';
import { SPEEDWAY_LENGTH } from './speedway';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const track = getTrack('speedway');
const profile = curvatureProfile(track);

afterEach(() => vi.unstubAllGlobals());

function longestStraight(course: Track): number {
  const curve = curvatureProfile(course);
  let longest = 0, run = 0;
  for (let i = 0; i < curve.length * 2; i++) {
    const a = curve[i % curve.length]!, b = curve[(i + 1) % curve.length]!;
    run = Math.abs(a.curvature) < 1e-8 ? run + (b.distance - a.distance + course.length) % course.length : 0;
    longest = Math.max(longest, run);
  }
  return Math.min(longest, course.length);
}

function renderCourse() {
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ fillRect() {}, fillText() {} }) }) });
  return buildCourse(track, theme);
}

describe('THUNDER OVAL', () => {
  it('replaces the scaffold with a playable, serializable full-width oval', () => {
    expect(track.length).toBeCloseTo(SPEEDWAY_LENGTH, 8);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.layoutVersion).toBe(1);
    expect(track.def.checkpointCount).toBe(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(scaffoldIds()).not.toContain('speedway');
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
    expect(track.def.widthKeys ?? []).toEqual([]);
    expect(track.def.splits ?? []).toEqual([]);
    expect(track.def.decks ?? []).toEqual([]);
    expect(track.def.racingLine[0]).toEqual({ distance: 0, offset: 0 });
    expect(track.def.racingLine.at(-1)).toEqual({ distance: track.length, offset: 0 });
    for (let d = 0; d < track.length; d += 0.5) {
      expect(widthAt(track, d)).toEqual({ roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH });
      expect(Math.abs(racingLineOffset(track, d)) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
    }
  });

  it('has the longest straight of all registered courses and broad, level turns', () => {
    expect(maxSlope(track)).toBeLessThanOrEqual(0.30);
    for (const point of profile) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 2.5);
    }
    const straight = longestStraight(track);
    expect(straight).toBeGreaterThanOrEqual(650);
    for (const id of TRACK_IDS.filter(id => id !== 'speedway')) {
      expect(straight, id).toBeGreaterThan(longestStraight(getTrack(id)));
    }
  });

  it('banks both long turns toward their inside at 0.35 with gentle transitions', () => {
    const keys = track.def.bankKeys!;
    const plateaus = keys.slice(1).flatMap((key, i) => {
      const previous = keys[i]!;
      return key.roll !== 0 && key.roll === previous.roll ? [{ from: previous.distance, to: key.distance, roll: key.roll }] : [];
    });
    expect(plateaus).toHaveLength(2);
    for (const bank of plateaus) {
      expect(Math.abs(bank.roll)).toBe(0.35);
      expect(bank.to - bank.from).toBeGreaterThanOrEqual(350);
      for (let d = bank.from; d <= bank.to; d += 2) expect(rollAt(track, d)).toBeCloseTo(bank.roll, 10);
      const bend = profile.filter(point => point.distance >= bank.from && point.distance <= bank.to);
      expect(bend.length).toBeGreaterThan(0);
      for (const point of bend) {
        expect(Math.sign(rollAt(track, point.distance)), `bank direction at ${point.distance}`)
          .toBe(Math.sign(point.curvature));
      }
    }
    for (let i = 1; i < keys.length; i++) {
      expect(Math.abs(keys[i]!.roll - keys[i - 1]!.roll) / (keys[i]!.distance - keys[i - 1]!.distance))
        .toBeLessThanOrEqual(0.02);
    }
    expect(keys[0]).toEqual({ distance: 0, roll: 0 });
    expect(keys.at(-1)).toEqual({ distance: track.length, roll: 0 });
  });

  it('places three consecutive boosts on the home straight and a sweeping pit wall on the back straight', () => {
    expect(track.def.surfaces).toEqual([
      { kind: 'boost', from: 210, to: 220 },
      { kind: 'boost', from: 245, to: 255 },
      { kind: 'boost', from: 280, to: 290 },
    ]);
    for (const zone of track.def.surfaces) {
      for (const point of profile.filter(point => point.distance >= zone.from - 40 && point.distance <= zone.to + 40)) {
        expect(Math.abs(point.curvature)).toBeLessThan(1e-8);
      }
    }
    expect(track.def.barriers).toHaveLength(1);
    const wall = track.def.barriers![0]!;
    expect(wall.scenery).toBe('block');
    expect(wall.motion).toEqual({ kind: 'sweep', amplitude: 1.5, period: 8, phase: 0 });
    expect(barrierCenterAt(wall, 2) - barrierCenterAt(wall, 6)).toBeCloseTo(3, 10);
    for (const point of profile.filter(point => point.distance >= wall.from - 40 && point.distance <= wall.to + 40)) {
      expect(Math.abs(point.curvature)).toBeLessThan(1e-8);
    }
    for (let time = 0; time <= wall.motion!.period; time += 0.125) {
      for (let d = wall.from - 40; d <= wall.to + 40; d += 0.5) {
        const band = exclusionAt(track, wall, d, time);
        if (band) expect(band.min - racingLineOffset(track, d)).toBeGreaterThan(0.3);
        expect(Math.abs(barrierCenterAt(wall, time)) + wall.halfWidth).toBeLessThan(widthAt(track, d).roadHalfWidth);
      }
    }
  });

  it('builds the dusk stadium within the triangle budget and keeps every scenery instance outside the walls', () => {
    const durations: number[] = [];
    let meshes = 0, triangles = 0;
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      const course = renderCourse();
      durations.push(performance.now() - start);
      try {
        let currentMeshes = 0, currentTriangles = 0;
        course.group.traverse(object => {
          expect(object).not.toBeInstanceOf(THREE.Points);
          if (!(object instanceof THREE.Mesh)) return;
          currentMeshes++;
          currentTriangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3 *
            (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
        });
        expect(currentTriangles + 20_000).toBeLessThanOrEqual(60 * track.length + 30_000);
        if (run > 0) {
          expect(currentMeshes).toBe(meshes);
          expect(currentTriangles).toBe(triangles);
        }
        meshes = currentMeshes; triangles = currentTriangles;
        if (run !== 0) continue;
        expect(theme.colors.road).toBe(speedwayPalette.asphalt);
        expect(theme.colors.curb).toEqual([speedwayPalette.red, speedwayPalette.white]);
        expect(theme.colors.skyBottom).toBe(speedwayPalette.sunset);
        const road = course.group.getObjectByName('road')!;
        const terrain = course.group.children.filter(child => child.name.startsWith('ground:') ||
          (child instanceof THREE.Mesh && child.geometry instanceof THREE.PlaneGeometry && child.geometry.parameters.width === 1800));
        expect(terrain).toHaveLength(3);
        course.group.updateMatrixWorld(true);
        // The low side of a long bank must stay visible above the flat infield.
        // A y=1 oval otherwise buries its inside curb at the maximum roll.
        for (let d = 0; d < track.length; d += 10) {
          if (Math.abs(rollAt(track, d)) < 0.3) continue;
          const point = sampleTrack(track, d);
          for (const side of [-1, 1]) {
            const offset = side * (widthAt(track, d).roadHalfWidth - 0.5);
            const ray = new THREE.Raycaster(new THREE.Vector3(point.x + point.nx * offset, 100, point.z + point.nz * offset),
              new THREE.Vector3(0, -1, 0));
            expect(ray.intersectObjects([road, ...terrain])[0]?.object.name, `bank road at ${d}, side ${side}`).toBe('road');
          }
        }
        const props = course.group.children.filter(child => child.name.startsWith('speedway:'));
        const names: string[] = [];
        // Inspect every theme-created batch rather than a hand-picked subset.
        for (const child of props) {
          names.push(child.name);
          const mesh = child as THREE.InstancedMesh;
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
            expect(clearance, `${mesh.name}:${i}`).toBeGreaterThan(0);
          }
        }
        expect(names).toEqual(['speedway:light-towers', 'speedway:floodlights', 'speedway:grandstands',
          'speedway:canopies', 'speedway:canopy-supports']);
        const lamps = course.group.getObjectByName('speedway:floodlights') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
        expect(lamps.material.emissive.getHex()).toBe(speedwayPalette.lamp);
        expect(lamps.material.emissiveIntensity).toBeGreaterThan(0);
        const barrier = course.group.getObjectByName('motion:barrier:0')!;
        const before = barrier.position.clone();
        course.update(2);
        expect(before.distanceTo(barrier.position)).toBeCloseTo(1.5, 6);
      } finally { course.dispose(); }
    }
    console.info('speedway render', { meshes, triangles, medianBuildMs: durations.sort((a, b) => a - b)[2] });
  });

  it('finishes 72 CPU laps within the pace, wall and barrier hit budgets', () => {
    const lapTimes: number[] = [];
    let wallHits = 0, bandHits = 0, pitFalls = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'speedway', racers: [] });
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
    const meanSpeed = track.length / meanLap;
    console.info('speedway CPU', { length: track.length, meanLap, meanSpeed, wallHits, bandHits, pitFalls });
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    // Original eight-course baselines from handling.test.ts: the same 8 CPUs,
    // seeds [1, 42, 98765] and 3 laps. Compare speed, since lap lengths differ.
    const originalMeanLaps = {
      meadow: 68.5011574074074, canyon: 68.49583333333334,
      snowpeak: 67.89120370370368, neon: 64.32939814814814,
      harbor: 69.73750000000001, forest: 69.52407407407406,
      volcano: 67.82407407407408, skyline: 67.35324074074076,
    };
    for (const [id, baselineMeanLap] of Object.entries(originalMeanLaps)) {
      expect(meanSpeed, `average speed must exceed ${id}`)
        .toBeGreaterThan(getTrack(id).length / baselineMeanLap);
    }
    expect(wallHits).toBeLessThanOrEqual(6);
    expect(bandHits).toBeLessThanOrEqual(2);
    expect(pitFalls).toBeLessThanOrEqual(6);
  }, 120_000);
});

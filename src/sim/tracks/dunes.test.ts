// M10-01, darwin-arm64: buildCourse 32 meshes, 90,718 triangles including shadows;
// Five-build median 169.775208 ms (focused suite, other stories running concurrently).
// With eight karts: 110,718 < 164,391.24 triangle cap.
// Eight CPUs × seeds [1, 42, 98765] × three laps: meanLap 85.47638888888889 s,
// wallHits 0, bandHits 0, pitFalls 0; 72 laps and all 216 ridge landings on dirt.
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCourse } from '../../render/course/buildCourse';
import { dunes as theme, dunesPalette } from '../../render/course/themes/dunes';
import { getAIInput } from '../ai';
import { KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, stepRace } from '../race';
import { JUMP_DURATION, racingLineOffset, surfaceAt } from '../surfaces';
import { buildTrack, rollAt, sampleTrack, slopeAt } from '../track';
import { DUNES_LENGTH } from './dunes';
import { getTrack, scaffoldIds } from './index';
import { curvatureProfile, elevationRange, maxSlope } from './shapeMetrics';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const track = getTrack('dunes');
const profile = curvatureProfile(track);
const jumps = track.def.surfaces.filter(zone => zone.kind === 'jump');
const dirt = track.def.surfaces.filter(zone => zone.kind === 'dirt');

afterEach(() => vi.unstubAllGlobals());

function renderCourse() {
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ fillRect() {}, fillText() {} }) }) });
  return buildCourse(track, theme);
}

describe('SIROCCO DUNES', () => {
  it('replaces the scaffold with a playable, JSON-stable 2100–2400m course', () => {
    expect(track.length).toBeCloseTo(DUNES_LENGTH, 8);
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
    expect(scaffoldIds()).not.toContain('dunes');
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
    expect(track.def.splits ?? []).toEqual([]);
    expect(track.def.barriers ?? []).toEqual([]);
    expect(track.def.decks ?? []).toEqual([]);
    expect(track.def.surfaces.map(zone => zone.kind).sort()).toEqual(['dirt', 'dirt', 'jump', 'jump', 'jump']);
    expect(track.def.racingLine[0]).toEqual({ distance: 0, offset: 0 });
    expect(track.def.racingLine.at(-1)).toEqual({ distance: track.length, offset: 0 });
    for (let d = 0; d < track.length; d += 0.5) {
      expect(Math.abs(racingLineOffset(track, d)) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
    }
  });

  it('keeps the dunes gentle and the road ribbons clear of folds and crossings', () => {
    expect(maxSlope(track)).toBeLessThanOrEqual(0.30);
    expect(elevationRange(track).range).toBeGreaterThan(12);
    for (const point of profile) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 2.5);
    }
    // No decks are declared: independently rule out XZ intersections of non-adjacent segments.
    let crossings = 0;
    for (let i = 0; i < track.samples.length; i++) {
      const a = track.samples[i]!, b = track.samples[(i + 1) % track.samples.length]!;
      const dx = b.x - a.x, dz = b.z - a.z;
      for (let j = i + 2; j < track.samples.length; j++) {
        if (i === 0 && j === track.samples.length - 1) continue;
        const c = track.samples[j]!, d = track.samples[(j + 1) % track.samples.length]!;
        const ex = d.x - c.x, ez = d.z - c.z, cross = dx * ez - dz * ex;
        if (Math.abs(cross) < 1e-9) continue;
        const t = ((c.x - a.x) * ez - (c.z - a.z) * ex) / cross;
        const u = ((c.x - a.x) * dz - (c.z - a.z) * dx) / cross;
        if (t >= 0 && t < 1 && u >= 0 && u < 1) crossings++;
      }
    }
    expect(crossings).toBe(0);
  });

  it('launches from three separate ridge crests into two long dirt basins', () => {
    expect(jumps).toHaveLength(3);
    expect(dirt).toHaveLength(2);
    for (const zone of dirt) {
      expect(zone.to - zone.from).toBeGreaterThanOrEqual(180);
      expect(zone.offsetMin).toBeUndefined();
      expect(zone.offsetMax).toBeUndefined();
    }
    for (const jump of jumps) {
      expect(jump.to - jump.from).toBe(4);
      expect(jump.offsetMin).toBeUndefined();
      expect(jump.offsetMax).toBeUndefined();
      expect(slopeAt(track, jump.from)).toBeLessThan(0);
      expect(Math.abs(slopeAt(track, jump.from))).toBeLessThan(0.05);
      const crest = sampleTrack(track, jump.from).y;
      expect(crest - sampleTrack(track, jump.from - 50).y).toBeGreaterThan(2);
      expect(crest - sampleTrack(track, jump.from + 40).y).toBeGreaterThan(1.5);
      // The full landing envelope (15–50m/s for the existing 0.8s jump) remains on sand.
      for (let d = jump.from + 15 * JUMP_DURATION; d <= jump.to + 50 * JUMP_DURATION; d += 0.5) {
        for (const offset of [-BASE_ROAD_HALF_WIDTH + KART_RADIUS, 0, BASE_ROAD_HALF_WIDTH - KART_RADIUS]) {
          expect(surfaceAt(track, d, offset)).toBe('dirt');
        }
      }
      for (const point of profile.filter(p => p.distance >= jump.from - 15 && p.distance <= jump.to + 50 * JUMP_DURATION)) {
        expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(80);
      }
    }
  });

  it('narrows one canyon to 55% before a correctly banked ±0.3 S bend', () => {
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
    expect(keys[2]!.distance - keys[1]!.distance).toBeGreaterThanOrEqual(40);
    for (const fraction of track.def.boxRows) {
      for (const offset of track.def.boxLanes) {
        expect(Math.abs(offset) + KART_RADIUS).toBeLessThan(widthAt(track, fraction * track.length).roadHalfWidth);
      }
    }
    const banks = track.def.bankKeys!;
    expect(banks[0]).toEqual({ distance: 0, roll: 0 });
    expect(banks.at(-1)).toEqual({ distance: track.length, roll: 0 });
    expect(banks.filter((key, i) => key.roll !== 0 && banks[i - 1]!.roll === 0).map(key => key.roll)).toEqual([-0.3, 0.3]);
    for (let i = 1; i < banks.length; i++) {
      const a = banks[i - 1]!, b = banks[i]!;
      expect(Math.abs(b.roll - a.roll) / (b.distance - a.distance)).toBeLessThanOrEqual(0.02);
      if (a.roll === 0 || a.roll !== b.roll) continue;
      const bend = profile.filter(p => p.distance >= a.distance && p.distance <= b.distance);
      expect(bend.length).toBeGreaterThan(0);
      // Positive roll lowers the left side; the matching curvature sign turns toward that side.
      for (const point of bend) expect(Math.sign(point.curvature)).toBe(Math.sign(a.roll));
      expect(Math.abs(bend.reduce((sum, point) => sum + point.turn, 0))).toBeGreaterThan(0.5);
    }
    expect(rollAt(track, track.length - 0.01)).toBe(0);
  });

  it('renders a dusty sunset desert within budget and keeps every prop outside the walls', () => {
    expect(theme.colors.ground).toBe(dunesPalette.sand);
    expect(theme.colors.sky).toBe(dunesPalette.sky);
    expect(theme.fog).toEqual({ color: dunesPalette.dust, near: 115, far: 390 });
    const times: number[] = [];
    let meshes = 0, triangles = 0;
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      const course = renderCourse();
      times.push(performance.now() - start);
      try {
        meshes = 0; triangles = 0;
        course.group.traverse(object => {
          expect(object).not.toBeInstanceOf(THREE.Points);
          if (!(object instanceof THREE.Mesh)) return;
          meshes++;
          triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3 *
            (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
        });
        expect(triangles + 20_000).toBeLessThanOrEqual(60 * track.length + 30_000);
        if (run !== 0) continue;
        for (const name of ['trunks', 'dunes:cactus-arms', 'rocks', 'dunes:sand-ridges', 'flowers']) {
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
              const distance = a.distance + t * ((b.distance || track.length) - a.distance);
              clearance = Math.min(clearance, Math.hypot(position.x - a.x - t * dx, position.z - a.z - t * dz)
                - widthAt(track, distance).wallHalfWidth - radius);
            }
            expect(clearance, `${name}:${i}`).toBeGreaterThan(0);
          }
        }
        expect(course.group.getObjectByName('surface:dirt')).toBeInstanceOf(THREE.Mesh);
        expect(course.group.getObjectByName('surface:jump')).toBeInstanceOf(THREE.Mesh);
        course.group.updateMatrixWorld(true);
        const launch = sampleTrack(track, (jumps[2]!.from + jumps[2]!.to) / 2);
        const ray = new THREE.Raycaster(new THREE.Vector3(launch.x, launch.y + 10, launch.z), new THREE.Vector3(0, -1, 0));
        const decals = ['surface:dirt', 'surface:jump'].map(name => course.group.getObjectByName(name)!);
        expect(ray.intersectObjects(decals)[0]!.object.name).toBe('surface:jump');
        expect(course.group.getObjectByName('crowns')).toBeUndefined();
      } finally { course.dispose(); }
    }
    console.info('dunes render', { meshes, triangles, medianBuildMs: times.sort((a, b) => a - b)[2] });
  });

  it('finishes 72 CPU laps and lands all three ridge jumps on dirt within pace/hit budgets', () => {
    const lapTimes: number[] = [];
    let wallHits = 0, bandHits = 0, pitFalls = 0, landings = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'dunes', racers: [] });
      const flights = state.karts.map(() => new Set<string>());
      const airborne = state.karts.map(() => false);
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
          if (kart.finishTime !== null) continue;
          if (kart.airTime > 0) {
            const jump = jumps.findIndex(zone => kart.trackDistance >= zone.from && kart.trackDistance <= zone.to + 40);
            expect(jump).toBeGreaterThanOrEqual(0);
            flights[kart.id]!.add(`${kart.lap}:${jump}`);
          } else if (airborne[kart.id]) {
            expect(surfaceAt(track, kart.trackDistance, kart.lateralOffset)).toBe('dirt');
            landings++;
          }
          airborne[kart.id] = kart.airTime > 0;
        }
      }
      expect(state.phase).toBe('finished');
      expect(state.karts).toHaveLength(8);
      for (const kart of state.karts) {
        expect(kart.human).toBe(false);
        expect(kart.lap).toBe(3);
        expect(kart.finishTime).not.toBeNull();
        expect(kart.lapTimes).toHaveLength(3);
        expect([...flights[kart.id]!].sort()).toEqual(['0:0', '0:1', '0:2', '1:0', '1:1', '1:2', '2:0', '2:1', '2:2']);
        lapTimes.push(...kart.lapTimes);
      }
    }
    expect(lapTimes).toHaveLength(72);
    expect(landings).toBe(216);
    const meanLap = lapTimes.reduce((sum, time) => sum + time, 0) / lapTimes.length;
    console.info('dunes CPU', { meanLap, wallHits, bandHits, pitFalls, landings });
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(6);
    expect(bandHits).toBe(0);
    expect(pitFalls).toBeLessThanOrEqual(6);
  }, 120_000);
});

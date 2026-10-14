import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { buildCourse, disposeObjectTree } from '../../render/course/buildCourse';
import { harbor as theme, harborPalette } from '../../render/course/themes/harbor';
import { getAIInput } from '../ai';
import { barrierHalfWidthAt, corridorAt, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, KART_RADIUS, stepRace } from '../race';
import { racingLineOffset } from '../surfaces';
import { projectToTrack, rollAt, sampleTrack, slopeAt } from '../track';
import { getTrack, scaffoldIds } from './index';
import { curvatureProfile, elevationRange, findCompoundCorners, findHairpins, findSCurves, maxSlope, minCurvatureRadius } from './shapeMetrics';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const HARBOR_LENGTH = 2341.240695605225;
const track = getTrack('harbor');

describe('TIDEWATER HARBOR', () => {
  it('pins layout 1, its measured length, gates and eight item rows', () => {
    expect(track.length).toBe(HARBOR_LENGTH);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.layoutVersion).toBe(1);
    expect(track.def.checkpointCount).toBe(24);
    expect(track.checkpointDistances).toHaveLength(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.boxPoses).toHaveLength(24);
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    expect(scaffoldIds()).not.toContain('harbor');
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
  });

  it('measures two long straights, a pier hairpin, two S sections and compound corners', () => {
    const profile = curvatureProfile(track);
    const straights: number[] = [];
    let start = 0;
    // Conservatively exclude each curved sample and its following chord; the seam is straight.
    for (let i = 0; i < profile.length; i++) {
      if (Math.abs(profile[i]!.curvature) < 1 / 200) continue;
      straights.push(profile[i]!.distance - start);
      start = profile[i + 1]?.distance ?? track.length;
    }
    straights.push(track.length - start);
    expect(straights.filter(length => length >= 150).length).toBeGreaterThanOrEqual(2);
    const hairpins = findHairpins(track);
    expect(hairpins.length).toBeGreaterThanOrEqual(1);
    expect(hairpins.some(pin => pin.from < 300 && pin.to > 300)).toBe(true);
    expect(findSCurves(track).length).toBeGreaterThanOrEqual(2);
    expect(findCompoundCorners(track).length).toBeGreaterThanOrEqual(1);
    expect(maxSlope(track)).toBeLessThanOrEqual(0.12);
    expect(elevationRange(track).range).toBeLessThanOrEqual(8);
    expect(minCurvatureRadius(track)).toBeGreaterThanOrEqual(17);
    for (const point of profile) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 3.3);
    }
  });

  it('has one lighthouse island, two main-route jumps, two sand sections and one quay gate', () => {
    expect(track.def.splits).toHaveLength(1);
    const split = track.def.splits![0]!;
    expect(split.from).toBeGreaterThan(100);
    expect(split.to).toBeGreaterThan(split.from);
    expect(split.to).toBeLessThan(track.length);
    expect(split.lanes).toHaveLength(2);
    for (const lane of split.lanes) {
      expect(lane.offsetMax - lane.offsetMin).toBeCloseTo(11.7, 10);
      expect(lane.offsetMax - lane.offsetMin).toBeGreaterThanOrEqual(6);
    }
    const outer = Math.max(...split.lanes.flatMap(lane => [Math.abs(lane.offsetMin), Math.abs(lane.offsetMax)]));
    for (const point of curvatureProfile(track).filter(point => point.distance >= split.from && point.distance <= split.to)) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(outer);
    }
    expect(track.def.barriers).toHaveLength(2);
    const moving = track.def.barriers!.filter(barrier => barrier.motion);
    expect(moving).toHaveLength(1);
    const gate = moving[0]!;
    expect(gate.motion!.kind).toBe('gate');
    expect(barrierHalfWidthAt(gate, 0)).toBeGreaterThan(barrierHalfWidthAt(gate, gate.motion!.period / 2));
    expect(track.def.decks ?? []).toEqual([]);
    expect(track.def.surfaces.map(zone => zone.kind).sort()).toEqual(['dirt', 'dirt', 'jump', 'jump']);
    for (const jump of track.def.surfaces.filter(zone => zone.kind === 'jump')) {
      expect(jump.offsetMin).toBeUndefined();
      expect(jump.offsetMax).toBeUndefined();
      expect(slopeAt(track, jump.from - 40)).toBeGreaterThan(0.01);
      const takeoff = slopeAt(track, jump.to);
      expect(Math.abs(takeoff)).toBeLessThan(0.02);
      for (let d = jump.to; d <= jump.to + 40; d += 0.5) {
        expect(slopeAt(track, d)).toBeGreaterThanOrEqual(takeoff - 0.05);
      }
    }
  });

  it('keeps one smooth bank, a zero seam, no narrow passages and a full-lap racing line', () => {
    const banks = track.def.bankKeys!;
    expect(banks.map(key => key.roll)).toEqual([0, 0, 0.18, 0.18, 0, 0]);
    expect(banks[0]).toEqual({ distance: 0, roll: 0 });
    expect(banks.at(-1)).toEqual({ distance: track.length, roll: 0 });
    expect(Math.max(...banks.map(key => key.roll))).toBeGreaterThanOrEqual(0.15);
    expect(Math.max(...banks.map(key => key.roll))).toBeLessThanOrEqual(0.25);
    for (let i = 1; i < banks.length; i++) {
      expect(Math.abs(banks[i]!.roll - banks[i - 1]!.roll) / (banks[i]!.distance - banks[i - 1]!.distance)).toBeLessThanOrEqual(0.02);
    }
    expect(rollAt(track, 0)).toBe(0);
    const line = track.def.racingLine;
    expect(line[0]).toEqual({ distance: 0, offset: 0 });
    expect(line.at(-1)).toEqual({ distance: track.length, offset: 0 });
    for (let i = 1; i < line.length; i++) expect(line[i]!.distance).toBeGreaterThan(line[i - 1]!.distance);
    for (let d = 0; d < track.length; d += 1) {
      expect(widthAt(track, d).roadHalfWidth).toBeGreaterThanOrEqual(BASE_ROAD_HALF_WIDTH);
      const passages = corridorAt(track, d, 0);
      expect(passages.some(passage => passage.max - passage.min >= 2.55)).toBe(true);
      const offset = racingLineOffset(track, d);
      expect(passages.some(passage => offset >= passage.min && offset <= passage.max)).toBe(true);
    }
  });

  // M6-01 / darwin-arm64: 8 CPUs × seeds [1, 42, 98765] × 3 laps = 72 laps.
  // Measured meanLap 69.7375 s, wallHits 0, bandHits 0 (no AI/sim or validator changes).
  // Per-seed means: 69.57430555555555, 69.82430555555557, 69.81388888888888 s; all hits 0.
  // Length 2341.240695605225 m; radius 18.115594961689634 m; max slope 0.07806396484375;
  // elevation range 3.5970611572265625 m. GPU baseline remains null until M6-05 (no E2E here).
  it('finishes all 72 CPU laps within the pace and collision budgets', () => {
    const lapTimes: number[] = [];
    let wallHits = 0, bandHits = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'harbor', racers: [] });
      for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
        stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
        for (const event of state.events) {
          if (event.type !== 'hit') continue;
          if (event.value === 1) { bandHits++; continue; }
          if (event.value === 2) continue;
          const kart = state.karts[event.kartId]!;
          if (Math.abs(kart.lateralOffset) >= widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS - 0.01) wallHits++;
        }
      }
      expect(state.phase).toBe('finished');
      expect(state.karts).toHaveLength(8);
      for (const kart of state.karts) {
        expect(kart.human).toBe(false);
        expect(kart.lap).toBe(3);
        expect(kart.lapTimes).toHaveLength(3);
        expect(kart.finishTime).not.toBeNull();
        lapTimes.push(...kart.lapTimes);
      }
    }
    expect(lapTimes).toHaveLength(72);
    const meanLap = lapTimes.reduce((sum, time) => sum + time, 0) / lapTimes.length;
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(6);
    expect(bandHits).toBeLessThanOrEqual(6);
  }, 120_000);

  it('keeps harbour furniture outside all road branches and the lighthouse inside its island', () => {
    const scene = new THREE.Group();
    theme.buildProps(track, scene, theme.budget);
    try {
      for (const name of ['trunks', 'crowns', 'harbor:lamps', 'rocks', 'harbor:buoys', 'harbor:crates', 'flowers']) {
        const mesh = scene.getObjectByName(name) as THREE.InstancedMesh;
        expect(mesh.count).toBeGreaterThan(0);
        const vertices = mesh.geometry.getAttribute('position');
        let radius = 0;
        for (let i = 0; i < vertices.count; i++) radius = Math.max(radius, Math.hypot(vertices.getX(i), vertices.getZ(i)));
        const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          position.setFromMatrixPosition(matrix);
          scale.setFromMatrixScale(matrix);
          let clearance = Infinity;
          for (let j = 0; j < track.samples.length; j++) {
            const a = track.samples[j]!, b = track.samples[(j + 1) % track.samples.length]!;
            const dx = b.x - a.x, dz = b.z - a.z;
            const t = Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.z - a.z) * dz) / (dx * dx + dz * dz)));
            const distance = a.distance + t * ((j + 1 === track.samples.length ? track.length : b.distance) - a.distance);
            clearance = Math.min(clearance, Math.hypot(position.x - a.x - t * dx, position.z - a.z - t * dz)
              - widthAt(track, distance).wallHalfWidth - radius * Math.max(scale.x, scale.z));
          }
          expect(clearance, `${name} instance ${i}`).toBeGreaterThanOrEqual(1.9);
        }
      }
      theme.buildLandmarks(track, scene);
      const lighthouse = scene.getObjectByName('harbor:lighthouse')!;
      const island = track.def.barriers![0]!;
      const contained = () => {
        scene.updateMatrixWorld(true);
        let inside = true;
        lighthouse.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return;
          const vertices = object.geometry.getAttribute('position');
          for (let i = 0; i < vertices.count; i++) {
            const vertex = new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(object.matrixWorld);
            const projection = projectToTrack(track, vertex.x, vertex.z);
            const half = island.halfWidth * Math.min(1,
              (projection.distance - island.from) / island.taper!, (island.to - projection.distance) / island.taper!);
            inside &&= Math.abs(projection.offset - island.center) <= half;
          }
        });
        return inside;
      };
      expect(contained()).toBe(true);
      const original = lighthouse.position.clone();
      // A footprint of the same size must fail when moved into a lane or beyond the nose.
      for (const [distance, offset] of [[(island.from + island.to) / 2, 12], [island.to + 5, 0]] as const) {
        const point = sampleTrack(track, distance);
        lighthouse.position.set(point.x + point.nx * offset, original.y, point.z + point.nz * offset);
        expect(contained()).toBe(false);
      }
      lighthouse.position.copy(original);
      expect(scene.getObjectByName('harbor:pier-gaps')).toBeDefined();
    } finally { disposeObjectTree(scene); }
  });

  it('preserves the palette and leaves room under the length-based triangle cap', () => {
    expect(harborPalette).toEqual({ sky: 0x9ad8ff, fog: 0xcfe9f5, road: 0x6f7f86,
      sand: 0xe6d3a3, sea: 0x2b8fc9, accent: 0xff7a3d });
    expect(theme.signFractions).toHaveLength(7);
    expect(theme.signFractions.every(fraction => fraction > 0 && fraction < 1)).toBe(true);
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ fillRect() {}, fillText() {} }) }) });
    try {
      const course = buildCourse(track, theme);
      try {
        let triangles = 0;
        course.group.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return;
          const count = (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
          triangles += count * (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
        });
        // Conservative whole-course geometry + shadow pass; GPU/kart measurements belong to M6-05.
        expect(triangles).toBeLessThan(60 * track.length + 30_000 - 15_000);
        expect(course.group.getObjectByName('motion')!.children).toHaveLength(1);
      } finally { course.dispose(); }
    } finally { vi.unstubAllGlobals(); }
  });
});

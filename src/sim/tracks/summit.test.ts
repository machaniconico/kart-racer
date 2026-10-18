// M11-04, darwin-arm64: length 2916.8514481104626 m; climb +0.43315972222222987,
// descent -0.48730468750001393; ridge 240 m at road half-width 3.6 m.
// Human full throttle, no items/boost: downhill 42.98333316264478 m/s,
// identical flat geometry 36.64333333333324 m/s; gain 6.3399998293115445 m/s.
// measureCpuLaps, seeds [1, 42, 98765], 8 CPUs × 3 laps per seed, items enabled:
// easy:   72/72 laps, mean 90.27083333333333 s, falls 0, wallHits 0, bandHits 0.
// normal: 72/72 laps, mean 85.30115740740740 s, falls 0, wallHits 0, bandHits 0.
// hard:   72/72 laps, mean 82.25439814814813 s, falls 0, wallHits 0, bandHits 0.
// buildCourse: 32 meshes, 95,366 triangles including shadows. Chromium 1280×720,
// seed 127, 8 grid karts, 10 frames: 126 draw calls / 101,126 triangles.
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCourse, buildScenery, disposeObjectTree } from '../../render/course/buildCourse';
import { summit as theme } from '../../render/course/themes/summit';
import { KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, NEUTRAL_INPUT, stepRace } from '../race';
import { buildTrack, sampleTrack, slopeAt } from '../track';
import * as tracks from './index';
import { measureCpuLaps } from './shapeMetrics';
import { SUMMIT_DESCENT, SUMMIT_RIDGE } from './summit';

const track = tracks.getTrack('summit');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('SUMMIT DROP', () => {
  it('has a validated steep climb, plunge and 240 m exposed ridge', () => {
    const slopes = track.samples.map(p => slopeAt(track, p.distance));
    console.info('SUMMIT shape', { length: track.length, climb: Math.max(...slopes), descent: Math.min(...slopes), gates: track.checkpointDistances });
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(Math.max(...slopes)).toBeGreaterThanOrEqual(0.38);
    expect(Math.min(...slopes)).toBeLessThanOrEqual(-0.45);
    expect(Math.max(...slopes.map(Math.abs))).toBeLessThanOrEqual(0.55);
    expect(SUMMIT_RIDGE.to - SUMMIT_RIDGE.from).toBeGreaterThanOrEqual(220);
    for (let d = SUMMIT_RIDGE.from; d <= SUMMIT_RIDGE.to; d++) {
      expect(widthAt(track, d).roadHalfWidth).toBe(3.6);
      expect(sampleTrack(track, d).y).toBeCloseTo(100);
    }
    expect(track.def.surfaces.filter(zone => zone.kind === 'fall')).toHaveLength(2);
    for (const zone of track.def.surfaces) {
      expect(zone.from).toBe(SUMMIT_RIDGE.from);
      expect(zone.to).toBe(SUMMIT_RIDGE.to);
    }
    expect(track.def.surfaces.map(zone => [zone.offsetMin, zone.offsetMax])).toEqual([[-10, -3.6], [3.6, 10]]);
    expect(sampleTrack(track, track.length)).toEqual(sampleTrack(track, 0));
    for (const row of track.def.boxRows) for (const lane of track.def.boxLanes) {
      expect(Math.abs(lane) + KART_RADIUS).toBeLessThan(widthAt(track, row * track.length).roadHalfWidth);
    }
    expect(tracks.scaffoldIds()).not.toContain('summit');
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
  });

  it.each([-1, 1])('respawns a grounded kart off the %i ridge edge without skipping a checkpoint', side => {
    for (const distance of [SUMMIT_RIDGE.from + 1, 560, SUMMIT_RIDGE.to - 1]) {
      const state = createRace(42, { trackId: 'summit', karts: 1, itemBoxes: false });
      state.phase = 'racing';
      const kart = state.karts[0]!, p = sampleTrack(track, distance), offset = side * 4.2;
      Object.assign(kart, { x: p.x + p.nx * offset, y: p.y, z: p.z + p.nz * offset,
        heading: Math.atan2(p.tx, p.tz), trackDistance: distance, lateralOffset: offset,
        startedLap: true, nextCheckpoint: 2, lapProgress: distance, lapValid: true });
      stepRace(state, [NEUTRAL_INPUT]);
      expect(state.events.filter(event => event.type === 'fall')).toHaveLength(1);
      expect(kart.trackDistance).toBe(SUMMIT_RIDGE.from);
      expect(kart.lateralOffset).toBe(0);
      expect(kart.nextCheckpoint).toBe(2);
      expect(kart.lapValid).toBe(true);
      expect(kart.lapProgress).toBeCloseTo(SUMMIT_RIDGE.from);
    }
  });

  it('renders bare ridge edges and alpine landmarks within the course triangle budget', () => {
    const scenery = new THREE.Group();
    try { expect(() => buildScenery(track, theme, scenery)).not.toThrow(); }
    finally { disposeObjectTree(scenery); }
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ fillRect() {}, fillText() {} }) }) });
    const course = buildCourse(track, theme);
    try {
      course.group.updateMatrixWorld(true);
      for (const name of ['summit:peaks', 'summit:snowcaps', 'summit:conifers', 'summit:rocks']) {
        expect(course.group.getObjectByName(name)).toBeInstanceOf(THREE.InstancedMesh);
      }
      expect(course.group.getObjectByName('summit:ridge-cliffs')).toBeInstanceOf(THREE.Mesh);
      const edgeObjects = ['shoulder:-1', 'shoulder:1', 'ground:-1', 'ground:1', 'curbs', 'rails', 'posts']
        .map(name => course.group.getObjectByName(name)!);
      for (let distance = SUMMIT_RIDGE.from + 1; distance < SUMMIT_RIDGE.to; distance += 5) {
        const p = sampleTrack(track, distance);
        for (const offset of [-10, -5, -3.9, 3.9, 5, 10]) {
          const ray = new THREE.Raycaster(new THREE.Vector3(p.x + p.nx * offset, p.y + 3, p.z + p.nz * offset),
            new THREE.Vector3(0, -1, 0), 0, 4);
          expect(ray.intersectObjects(edgeObjects)).toHaveLength(0);
        }
        const ray = new THREE.Raycaster(new THREE.Vector3(p.x, p.y + 3, p.z), new THREE.Vector3(0, -1, 0), 0, 4);
        expect(ray.intersectObject(course.group.getObjectByName('road')!).length).toBeGreaterThan(0);
      }
      let meshes = 0, triangles = 0;
      course.group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        meshes++;
        triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3
          * (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
      });
      console.info('SUMMIT render', { meshes, triangles });
      expect(triangles + 20_000).toBeLessThanOrEqual(60 * track.length + 30_000);
    } finally { course.dispose(); }
  });

  it('exceeds 42 m/s unboosted downhill and beats the identical flat course by 5 m/s', () => {
    const flat = buildTrack({ ...track.def, controlPoints: track.def.controlPoints.map(([x, , z]) => [x, 4, z]) });
    function drive(course: typeof track): number {
      vi.spyOn(tracks, 'getTrack').mockReturnValue(course);
      const state = createRace(1, { trackId: 'summit', karts: 1, itemBoxes: false });
      state.phase = 'racing';
      const kart = state.karts[0]!;
      const start = sampleTrack(course, 0);
      Object.assign(kart, { x: start.x, y: start.y, z: start.z,
        heading: Math.atan2(start.tx, start.tz), trackDistance: 0, lateralOffset: 0 });
      let peak = 0;
      for (let tick = 0; tick < 3600 && kart.trackDistance < SUMMIT_DESCENT.to; tick++) {
        stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
        expect(kart.boostTime).toBe(0);
        expect(kart.item).toBeNull();
        if (kart.trackDistance >= SUMMIT_DESCENT.from) peak = Math.max(peak, kart.speed);
      }
      expect(kart.trackDistance).toBeGreaterThanOrEqual(SUMMIT_DESCENT.to);
      return peak;
    }
    const downhill = drive(track), flatPeak = drive(flat);
    console.info('SUMMIT speed', { downhill, flatPeak, gain: downhill - flatPeak });
    expect(downhill).toBeGreaterThanOrEqual(42);
    expect(downhill - flatPeak).toBeGreaterThanOrEqual(5);
  });

  it('finishes eight CPUs × three laps for every seed and difficulty within the fall/wall budgets', () => {
    const metrics = measureCpuLaps('summit', { fallBudget: 6 });
    for (const result of metrics) {
      const laps = result.runs.flatMap(run => run.state.karts.flatMap(kart => kart.lapTimes));
      console.info('SUMMIT CPU', { level: result.cpuLevel, finished: result.runs.map(run => run.finished), falls: result.falls,
        meanFalls: result.meanFalls, wallHits: result.wallHits, bandHits: result.bandHits,
        meanLap: laps.reduce((sum, time) => sum + time, 0) / laps.length });
      expect(result.passed).toBe(true);
      expect(laps).toHaveLength(72);
      expect(result.meanFalls).toBeLessThanOrEqual(6);
      expect(result.wallHits).toBeLessThanOrEqual(8);
    }
  }, 120_000);
});

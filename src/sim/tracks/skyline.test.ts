import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { buildCourse, buildScenery, disposeObjectTree } from '../../render/course/buildCourse';
import { skyline as theme } from '../../render/course/themes/skyline';
import { getAIInput } from '../ai';
import { KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, NEUTRAL_INPUT, stepRace } from '../race';
import { racingLineOffset } from '../surfaces';
import { projectToTrack, rollAt, sampleTrack, slopeAt } from '../track';
import { getTrack, scaffoldIds } from './index';
import { SKYLINE_TUBE } from './skyline';
import { curvatureProfile, elevationRange, findHairpins, findSCurves, maxSlope, minCurvatureRadius } from './shapeMetrics';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const track = getTrack('skyline');
const SKYLINE_LENGTH = 2390.427831962635;
const SEEDS = [1, 42, 98765];
// M6-04 / darwin-arm64: 8 CPU × seeds [1,42,98765] × 3 laps, unchanged AI/items.
// meanLap = 67.35324074074074 s; wallHits = 0; bandHits = 1; pitFalls = 0.
// Per-seed means: 66.92916666666667, 67.09722222222221, 68.03333333333333 s.
// Every kart finishes within the 420 s cap; no collision-budget relaxation.

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


describe('SKYLINE / STRATOS CITY', () => {
  it('pins the complete playable layout and removes its scaffold status', () => {
    expect(track.length).toBe(SKYLINE_LENGTH);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.layoutVersion).toBe(1);
    expect(track.def.checkpointCount).toBe(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.boxPoses).toHaveLength(24);
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    expect(scaffoldIds()).not.toContain('skyline');
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
  });

  it('measures a separate opening chicane, western S bends, hairpin and high-altitude profile', () => {
    const curves = findSCurves(track);
    expect(curves.some(curve => curve.from < 300 && curve.to < 320)).toBe(true);
    expect(curves.some(curve => curve.from > 1600)).toBe(true);
    expect(findHairpins(track)).toHaveLength(1);
    expect(minCurvatureRadius(track)).toBeGreaterThanOrEqual(17);
    expect(elevationRange(track).range).toBeGreaterThanOrEqual(20);
    expect(maxSlope(track)).toBeLessThanOrEqual(0.22);
  });

  it('crosses twice with 13 m clearance, gentle approaches and no opening difficulty cluster', () => {
    expect(track.def.decks).toHaveLength(2);
    const points = crossings();
    expect(points).toHaveLength(2);
    for (const point of points) {
      expect(point.height).toBeGreaterThanOrEqual(13);
      expect(point.angle).toBeGreaterThanOrEqual(Math.PI / 4);
      expect(track.def.decks!.some(deck => point.upper >= deck.from && point.upper <= deck.to)).toBe(true);
      for (const distance of [point.upper, point.lower]) {
        expect(distance).toBeGreaterThanOrEqual(300);
        for (let delta = -20; delta <= 20; delta += 0.5) {
          expect(Math.abs(slopeAt(track, distance + delta))).toBeLessThanOrEqual(0.1);
          expect(Math.abs(rollAt(track, distance + delta))).toBeLessThanOrEqual(0.1);
        }
        for (const gate of track.checkpointDistances) {
          const gap = Math.abs(gate - distance);
          expect(Math.min(gap, track.length - gap)).toBeGreaterThan(25);
        }
      }
    }
    for (const zone of [...track.def.decks!, ...track.def.surfaces.filter(z => z.kind === 'pit' || z.kind === 'spin')]) {
      expect(zone.from).toBeGreaterThanOrEqual(300);
      expect(zone.to).toBeGreaterThan(zone.from);
    }
  });

  it('has two wind gates, a rotating platform, two banks and one straight boost tube', () => {
    const bands = track.def.barriers!.filter(b => b.motion);
    expect(bands).toHaveLength(2);
    expect(bands.filter(b => b.motion!.kind === 'gate')).toHaveLength(2);
    const spins = track.def.surfaces.filter(z => z.kind === 'spin');
    expect(spins).toHaveLength(1);
    const spin = spins[0]!;
    expect(spin.offsetMax! - spin.offsetMin!).toBe(spin.to - spin.from);
    const banks = track.def.bankKeys!.filter(key => key.roll !== 0);
    expect(banks).toHaveLength(2);
    for (const key of banks) {
      expect(Math.abs(key.roll)).toBeGreaterThanOrEqual(0.25);
      expect(Math.abs(key.roll)).toBeLessThanOrEqual(0.35);
    }
    const keys = track.def.bankKeys!;
    expect(keys[0]).toEqual({ distance: 0, roll: 0 });
    expect(keys.at(-1)).toEqual({ distance: track.length, roll: 0 });
    for (let i = 1; i < keys.length; i++) {
      expect(Math.abs(keys[i]!.roll - keys[i - 1]!.roll) / (keys[i]!.distance - keys[i - 1]!.distance)).toBeLessThanOrEqual(0.02);
    }
    expect(track.def.surfaces.filter(z => z.kind === 'boost')).toEqual([
      { kind: 'boost', from: SKYLINE_TUBE.from, to: SKYLINE_TUBE.from + 6 },
    ]);
    expect(SKYLINE_TUBE.to - SKYLINE_TUBE.from).toBeGreaterThanOrEqual(60);
    for (const point of curvatureProfile(track)) {
      if (point.distance >= SKYLINE_TUBE.from && point.distance <= SKYLINE_TUBE.to ||
        point.distance >= spin.from - 3 && point.distance <= spin.to + 3) {
        expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(200);
      }
    }
    expect(track.def.surfaces.some(z => z.kind === 'ice' || z.kind === 'dirt')).toBe(false);
  });

  it('provides an island with wide curved lanes and two jumpable gaps with paved bypasses', () => {
    expect(track.def.splits).toHaveLength(1);
    const split = track.def.splits![0]!;
    expect(split.from).toBeGreaterThan(300);
    expect(split.to).toBeLessThan(track.length);
    expect(split.to).toBeGreaterThan(split.from);
    for (const lane of split.lanes) {
      expect(lane.offsetMax - lane.offsetMin).toBeGreaterThanOrEqual(6);
      for (const point of curvatureProfile(track).filter(p => p.distance >= split.from && p.distance <= split.to)) {
        expect(1 / Math.abs(point.curvature)).toBeGreaterThan(Math.max(Math.abs(lane.offsetMin), Math.abs(lane.offsetMax)) + 2.5);
      }
    }
    const pits = track.def.surfaces.filter(z => z.kind === 'pit');
    const jumps = track.def.surfaces.filter(z => z.kind === 'jump');
    expect(pits).toHaveLength(2);
    expect(jumps).toHaveLength(2);
    for (const [i, pit] of pits.entries()) {
      const jump = jumps[i]!;
      expect(pit.from - jump.from).toBeGreaterThanOrEqual(4);
      expect(pit.from - jump.from).toBeLessThanOrEqual(12);
      const clearSpeed = (pit.to - jump.from) / 0.8;
      expect(clearSpeed).toBeGreaterThanOrEqual(15);
      expect(clearSpeed).toBeLessThanOrEqual(26);
      expect(jump.offsetMin).toBe(pit.offsetMin);
      expect(jump.offsetMax).toBe(pit.offsetMax);
      for (let d = pit.from - 20; d <= pit.to + 20; d += 0.5) {
        const offset = racingLineOffset(track, d);
        expect(offset < pit.offsetMin! - KART_RADIUS || offset > pit.offsetMax! + KART_RADIUS).toBe(true);
      }
      for (let d = jump.to; d <= jump.to + 40; d += 0.5) {
        expect(slopeAt(track, d)).toBeGreaterThanOrEqual(slopeAt(track, jump.to) - 0.05);
      }
    }
  });

  it('covers the lap with a continuous racing line and early gate approaches', () => {
    const line = track.def.racingLine;
    expect(line[0]).toEqual({ distance: 0, offset: 0 });
    expect(line.at(-1)).toEqual({ distance: track.length, offset: 0 });
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!, b = line[i]!;
      expect(b.distance).toBeGreaterThan(a.distance);
      expect(Math.abs(b.offset - a.offset) / (b.distance - a.distance)).toBeLessThanOrEqual(0.3);
    }
    for (const band of track.def.barriers!.filter(b => b.motion)) {
      expect(band.from - line.filter(p => p.distance < band.from).at(-1)!.distance).toBeGreaterThanOrEqual(30);
    }
  });

  it('actually launches over both platform gaps and lands beyond their far lips', () => {
    for (const jump of track.def.surfaces.filter(zone => zone.kind === 'jump')) {
      const pit = track.def.surfaces.find(zone => zone.kind === 'pit' && zone.from === jump.from + 8)!;
      const state = createRace(1, { trackId: 'skyline' });
      state.phase = 'racing';
      state.karts = [state.karts[0]!];
      state.boxes = [];
      const kart = state.karts[0]!;
      const start = sampleTrack(track, jump.from - 2);
      const offset = (jump.offsetMin! + jump.offsetMax!) / 2;
      Object.assign(kart, { x: start.x + start.nx * offset, y: start.y,
        z: start.z + start.nz * offset, heading: Math.atan2(start.tx, start.tz),
        trackDistance: start.distance, lateralOffset: offset, speed: 26 });
      let launched = false, landed = false;
      for (let tick = 0; tick < 90; tick++) {
        stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
        expect(state.events.some(event => event.type === 'hit' && event.value === 2)).toBe(false);
        if (kart.airTime > 0) launched = true;
        if (launched && kart.airTime === 0) {
          expect(kart.trackDistance).toBeGreaterThan(pit.to);
          landed = true;
          break;
        }
      }
      expect(launched && landed).toBe(true);
    }
  });

  it('uses sky-city scenery and a visible open boost tube', () => {
    const scene = new THREE.Group();
    buildScenery(track, theme, scene);
    expect(theme.fog.far).toBeGreaterThanOrEqual(640);
    for (const name of ['trunks', 'rocks', 'flowers', 'skyline:boost-tube']) expect(scene.getObjectByName(name)).toBeDefined();
    const clouds = scene.getObjectByName('flowers') as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4(), scale = new THREE.Vector3();
    for (let i = 0; i < clouds.count; i++) {
      clouds.getMatrixAt(i, matrix);
      scale.setFromMatrixScale(matrix);
      expect(scale.y).toBeLessThan(scale.x / 8);
    }
    disposeObjectTree(scene);
  });

  it('leaves open air under the course, clear lower lanes and no paint over either pit', () => {
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ fillRect() {}, fillText() {} }) }) });
    const course = buildCourse(track, theme);
    try {
      for (const name of ['ground:-1', 'ground:1', 'surface:pit']) expect(course.group.getObjectByName(name)).toBeUndefined();
      let triangles = 0;
      course.group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        expect(object.geometry instanceof THREE.PlaneGeometry && object.geometry.parameters.width === 1800).toBe(false);
        triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3
          * (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
      });
      // Same length-based budget as courses.spec.ts, with all shadow passes and 20k for racers.
      expect(triangles + 20_000).toBeLessThanOrEqual(60 * track.length + 30_000);
      const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
      const supports = course.group.getObjectByName('deck-pillars') as THREE.InstancedMesh;
      expect(supports.count).toBeGreaterThan(0);
      for (let i = 0; i < supports.count; i++) {
        supports.getMatrixAt(i, matrix);
        position.setFromMatrixPosition(matrix);
        const lower = projectToTrack(track, position.x, position.z, undefined, 40);
        expect(Math.abs(lower.offset)).toBeGreaterThan(widthAt(track, lower.distance).wallHalfWidth + 0.45);
      }
      course.group.updateMatrixWorld(true);
      for (const pit of track.def.surfaces.filter(zone => zone.kind === 'pit')) {
        const side = pit.offsetMin! > 0 ? 1 : -1;
        const line = course.group.getObjectByName(`line:${side}`)!;
        const road = course.group.getObjectByName('road')!;
        for (let d = pit.from + 0.1; d < pit.to; d += 0.5) {
          const p = sampleTrack(track, d);
          for (const offset of [(pit.offsetMin! + pit.offsetMax!) / 2, side * (track.def.roadHalfWidth - 0.08)]) {
            const ray = new THREE.Raycaster(new THREE.Vector3(p.x + p.nx * offset, p.y + 2,
              p.z + p.nz * offset), new THREE.Vector3(0, -1, 0), 0, 3);
            expect(ray.intersectObjects([road, line], false)).toHaveLength(0);
          }
        }
      }
    } finally { course.dispose(); vi.unstubAllGlobals(); }
  });

  it('finishes 8 CPU × 3 seeds × 3 laps within the pace and collision budgets', () => {
    let wallHits = 0, bandHits = 0, pitFalls = 0, totalLapTime = 0;
    for (const seed of SEEDS) {
      const state = createRace(seed, { trackId: 'skyline', racers: [] });
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
        expect(kart.lapTimes).toHaveLength(3);
        expect(kart.finishTime).not.toBeNull();
        totalLapTime += kart.lapTimes.reduce((sum, time) => sum + time, 0);
      }
    }
    const meanLap = totalLapTime / 72;
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(6);
    expect(bandHits).toBeLessThanOrEqual(6);
    expect(pitFalls).toBeLessThanOrEqual(6);
  }, 120_000);
});

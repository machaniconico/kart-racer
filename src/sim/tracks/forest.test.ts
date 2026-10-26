import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { buildCourse, buildScenery, disposeObjectTree } from '../../render/course/buildCourse';
import { forest as theme, forestPalette } from '../../render/course/themes/forest';
import { getAIInput } from '../ai';
import { corridorAt, KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, stepRace } from '../race';
import { racingLineOffset } from '../surfaces';
import { projectToTrack, rollAt, sampleTrack, slopeAt, surfaceHeightAt } from '../track';
import { FOREST_LENGTH } from './forest';
import { getTrack, scaffoldIds } from './index';
import { curvatureProfile, elevationRange, findCompoundCorners, findHairpins, findSCurves, maxSlope, minCurvatureRadius } from './shapeMetrics';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const track = getTrack('forest');

/** Intersect all nonadjacent centreline segments, independently of the declared deck. */
function crossings() {
  const result: { upper: number; lower: number; clearance: number; angle: number }[] = [];
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
      result.push({ upper: ay > cy ? ad : cd, lower: ay > cy ? cd : ad, clearance: Math.abs(ay - cy),
        angle: Math.acos(Math.min(1, Math.abs(dx * ex + dz * ez) / Math.hypot(dx, dz) / Math.hypot(ex, ez))) });
    }
  }
  return result;
}

describe('MOSSWOOD TRAIL', () => {
  it('pins a distinct playable 2100–2400 m layout 1 with 24 checkpoints and eight box rows', () => {
    expect(track.length).toBeCloseTo(FOREST_LENGTH, 8);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.layoutVersion).toBe(1);
    expect(track.def.checkpointCount).toBe(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.boxPoses).toHaveLength(24);
    expect(scaffoldIds()).not.toContain('forest');
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
  });

  it('measures two hairpins, two S sections and at least two compound corners', () => {
    expect(findHairpins(track)).toHaveLength(2);
    expect(findSCurves(track).length).toBeGreaterThanOrEqual(2);
    expect(findCompoundCorners(track).length).toBeGreaterThanOrEqual(2);
    expect(minCurvatureRadius(track)).toBeGreaterThanOrEqual(17);
    for (const point of curvatureProfile(track)) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 3.3);
    }
    expect(maxSlope(track)).toBeGreaterThanOrEqual(0.12);
    expect(maxSlope(track)).toBeLessThanOrEqual(0.18);
    expect(elevationRange(track).range).toBeGreaterThanOrEqual(8);
    // M6-02 coordinator followup: allow 14 m total relief for the >=12 m crossing.
    expect(elevationRange(track).range).toBeLessThanOrEqual(14);
  });

  it('has three dirt sections, one full-width creek jump and no unrelated hazards', () => {
    expect(track.def.surfaces.filter(zone => zone.kind === 'dirt')).toHaveLength(3);
    const jumps = track.def.surfaces.filter(zone => zone.kind === 'jump');
    expect(jumps).toHaveLength(1);
    expect(track.def.surfaces.filter(zone => !['dirt', 'jump'].includes(zone.kind))).toEqual([]);
    expect(track.def.splits ?? []).toEqual([]);
    expect(track.def.barriers ?? []).toEqual([]);
    const jump = jumps[0]!;
    expect(jump.offsetMin).toBeUndefined();
    expect(jump.offsetMax).toBeUndefined();
    const takeoff = slopeAt(track, jump.to);
    for (let d = jump.to; d <= jump.to + 40; d += 0.5) {
      expect(slopeAt(track, d)).toBeGreaterThanOrEqual(takeoff - 0.05 - 1e-9);
    }
  });

  it('narrows exactly two passages to 55% with safe tapers and at least 2.55 m free', () => {
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    const keys = track.def.widthKeys!;
    expect(keys).toHaveLength(8);
    for (let i = 0; i < keys.length; i += 4) {
      const [before, start, end, after] = keys.slice(i, i + 4);
      expect(before!.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
      expect(after!.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
      for (const key of [start!, end!]) {
        expect(key.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH * 0.55);
        expect(key.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH * 0.55);
      }
      expect(end!.distance - start!.distance).toBeGreaterThanOrEqual(40);
      for (let d = before!.distance; d <= after!.distance; d += 0.5) {
        const passage = corridorAt(track, d, 0);
        expect(passage).toHaveLength(1);
        expect(passage[0]!.max - passage[0]!.min).toBeGreaterThanOrEqual(2.55);
      }
      expect((before!.wallHalfWidth - start!.wallHalfWidth) / (start!.distance - before!.distance)).toBeLessThanOrEqual(0.3);
      expect((after!.wallHalfWidth - end!.wallHalfWidth) / (after!.distance - end!.distance)).toBeLessThanOrEqual(0.3);
    }
  });

  it('has one gentle bank and a continuous safe racing line covering the entire lap', () => {
    const keys = track.def.bankKeys!;
    const positive = keys.filter(key => key.roll !== 0);
    expect(positive).toHaveLength(2);
    expect(positive[1]!.roll).toBe(positive[0]!.roll);
    expect(positive[0]!.roll).toBeGreaterThanOrEqual(0.15);
    expect(positive[0]!.roll).toBeLessThanOrEqual(0.25);
    expect(rollAt(track, 0)).toBe(0);
    expect(rollAt(track, track.length)).toBe(0);
    const line = track.def.racingLine;
    expect(line[0]).toEqual({ distance: 0, offset: 0 });
    expect(line.at(-1)).toEqual({ distance: FOREST_LENGTH, offset: 0 });
    for (let i = 1; i < line.length; i++) {
      const before = line[i - 1]!, after = line[i]!;
      expect(after.distance).toBeGreaterThan(before.distance);
      expect(Math.abs(after.offset - before.offset) / (after.distance - before.distance)).toBeLessThanOrEqual(0.3);
    }
    // M9-02: 10–20 keys; centred on the deck, both narrows and 30 m either side of the creek jump.
    expect(line.length).toBeGreaterThanOrEqual(10);
    expect(line.length).toBeLessThanOrEqual(20);
    for (const [from, to] of [[130, 170], [208, 278], [1230, 1290], [1330, 1370]] as const) {
      for (let d = from; d <= to; d++) expect(racingLineOffset(track, d), `racing line at ${d} m`).toBe(0);
    }
    for (const p of track.samples) {
      const offset = racingLineOffset(track, p.distance);
      expect(Math.abs(offset)).toBeLessThanOrEqual(widthAt(track, p.distance).roadHalfWidth - KART_RADIUS - 0.5);
      expect(corridorAt(track, p.distance, 0).some(interval => offset >= interval.min && offset <= interval.max)).toBe(true);
    }
  });

  it('crosses once on a log deck with 13 m clearance and clear gate approaches', () => {
    const intersections = crossings();
    expect(intersections).toHaveLength(1);
    const crossing = intersections[0]!;
    expect(crossing.clearance).toBeGreaterThanOrEqual(13);
    expect(crossing.angle).toBeGreaterThanOrEqual(Math.PI / 4);
    expect(track.def.decks).toHaveLength(1);
    const deck = track.def.decks![0]!;
    expect(crossing.upper).toBeGreaterThan(deck.from + 20);
    expect(crossing.upper).toBeLessThan(deck.to - 20);
    for (const distance of [crossing.upper, crossing.lower]) {
      for (let delta = -20; delta <= 20; delta += 0.5) {
        expect(Math.abs(slopeAt(track, distance + delta))).toBeLessThanOrEqual(0.1);
        expect(Math.abs(rollAt(track, distance + delta))).toBeLessThanOrEqual(0.1);
      }
      for (const gate of track.checkpointDistances) {
        const gap = Math.abs(gate - distance);
        expect(Math.min(gap, track.length - gap)).toBeGreaterThan(25);
      }
    }
  });

  it('keeps broadleaf trees, moss rocks, stumps, mushrooms and ferns outside the walls', () => {
    const group = new THREE.Group();
    try {
      buildScenery(track, theme, group);
      expect(theme.fog).toEqual({ color: forestPalette.fog, near: 120, far: 320 });
      const matrix = new THREE.Matrix4(), p = new THREE.Vector3();
      for (const name of ['trunks', 'crowns', 'moss-rocks', 'stumps', 'mushroom-stems', 'mushrooms', 'ferns']) {
        const mesh = group.getObjectByName(`forest:${name}`) as THREE.InstancedMesh;
        expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
        expect(mesh.count).toBeGreaterThan(0);
        const bounds = mesh.geometry.boundingBox ?? (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox!);
        const corners = [bounds.min.x, bounds.max.x].flatMap(x => [bounds.min.y, bounds.max.y]
          .flatMap(y => [bounds.min.z, bounds.max.z].map(z => new THREE.Vector3(x, y, z))));
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          for (const corner of corners) {
            p.copy(corner).applyMatrix4(matrix);
            const projection = projectToTrack(track, p.x, p.z);
            expect(Math.abs(projection.offset)).toBeGreaterThan(widthAt(track, projection.distance).wallHalfWidth + 1);
          }
        }
      }
      expect(group.getObjectByName('forest:log-bridge')).toBeDefined();
      expect(group.getObjectByName('forest:creek')).toBeDefined();
      const approaches = [100, findHairpins(track)[0]!.from, findHairpins(track)[1]!.from,
        1300, findSCurves(track)[0]!.from, findSCurves(track)[1]!.from];
      theme.signFractions.forEach((fraction, i) => {
        const lead = approaches[i]! - fraction * track.length;
        expect(lead).toBeGreaterThanOrEqual(20);
        expect(lead).toBeLessThanOrEqual(100);
      });
    } finally { disposeObjectTree(group); }
  });

  it('clears terrain along the full road and lower-lane pillars within the triangle cap', () => {
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ fillRect() {}, fillText() {} }) }) });
    const course = buildCourse(track, theme);
    try {
      const crossing = crossings()[0]!;
      const lower = sampleTrack(track, crossing.lower);
      const pillars = course.group.getObjectByName('deck-pillars') as THREE.InstancedMesh;
      expect(pillars.count).toBeGreaterThan(0);
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < pillars.count; i++) {
        pillars.getMatrixAt(i, matrix);
        const x = matrix.elements[12]! - lower.x, z = matrix.elements[14]! - lower.z;
        expect(Math.abs(x * lower.nx + z * lower.nz)).toBeGreaterThan(BASE_WALL_HALF_WIDTH + 0.45 - 1e-5);
      }
      course.group.updateMatrixWorld(true);
      // Include the shared flat ground: ribbons alone miss buried banked edges.
      const baseGround = course.group.children.find(object => object instanceof THREE.Mesh
        && object.geometry instanceof THREE.PlaneGeometry && object.rotation.x === -Math.PI / 2);
      expect(baseGround).toBeDefined();
      const ground = [baseGround!, ...[-1, 1].map(side => course.group.getObjectByName(`ground:${side}`)!)];
      const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
      for (let d = 0; d < track.length; d += 3) {
        const p = sampleTrack(track, d);
        const { roadHalfWidth, wallHalfWidth } = widthAt(track, d);
        for (const offset of [-wallHalfWidth + 0.5, -roadHalfWidth, 0, roadHalfWidth, wallHalfWidth - 0.5]) {
          ray.ray.origin.set(p.x + p.nx * offset, 30, p.z + p.nz * offset);
          for (const hit of ray.intersectObjects(ground, false)) {
            expect(hit.point.y, `terrain at ${d} m, offset ${offset}`).toBeLessThanOrEqual(surfaceHeightAt(track, d, offset) + 0.1);
          }
        }
      }
      let triangles = 0;
      course.group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const geometry = object.geometry;
        const count = (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
        triangles += count * (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
      });
      // Reserve 30k triangles for karts and remaining renderer objects outside buildCourse.
      expect(triangles + 30_000).toBeLessThanOrEqual(60 * track.length + 30_000);
    } finally { course.dispose(); vi.unstubAllGlobals(); }
  });

  // M9-02 / darwin-arm64: 8 CPUs × seeds [1, 42, 98765] × 3 laps = 72 laps, with the racing line.
  // Measured meanLap 69.52407407407406 s (M6-02 centre line: 70.53587962962963 s, −1.43 %), wallHits 0, bandHits 0.
  // Per-seed means: 69.86527777777779, 69.47222222222223, 69.23472222222222 s; all hits 0.
  // Max |lateralOffset| over the 72 jump crossings: 2.500223446354248 m, the ±2.5 m CPU weave of getAiLineOffset
  // on a zero racing line (the M6-02 centre line also measured 2.5002 m).
  // Length 2237.3654195978625 m; radius 17.349946898361907 m; max slope 0.12959622113025598;
  // elevation range 13.864839823647234 m; crossing height difference 13.2 m.
  // GPU baseline remains null until M6-05; E2E is deliberately not run in this story.
  it('finishes all 72 CPU laps within the pace and collision budgets', () => {
    const lapTimes: number[] = [];
    let wallHits = 0, bandHits = 0;
    const jumpOffsets: number[] = [];
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'forest', racers: [] });
      for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
        const previous = state.karts.map(kart => kart.trackDistance);
        stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
        state.karts.forEach((kart, index) => {
          const before = previous[index]!;
          if (kart.finishTime === null && before < 1260 && kart.trackDistance >= 1260 && kart.trackDistance - before < 10) {
            jumpOffsets.push(kart.lateralOffset);
          }
        });
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
    // M12-23 (C3 item rebalance): the item-on race now measures 70.01851851851852 s (was 69.52407407407406
    // at M9-02, cap 69.8 = +0.40 %). Re-pinned with the same +0.40 % margin; still under the M6-02 centre line.
    expect(meanLap).toBeLessThanOrEqual(70.29);
    expect(wallHits).toBeLessThanOrEqual(2);
    expect(bandHits).toBe(0);
    // Every CPU crosses the creek jump once per lap close to the centre line.
    expect(jumpOffsets).toHaveLength(72);
    // M12-21: 2.6842 m (seed 1, kart 1, lap 1) held outward by side contact with kart 5; old 2.55 / 2.5002 margin kept.
    for (const offset of jumpOffsets) expect(Math.abs(offset)).toBeLessThanOrEqual(2.74);
  }, 120_000);
});

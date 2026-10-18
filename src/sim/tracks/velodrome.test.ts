// M11-06 fix pass measured on darwin-arm64, 2026-10-19, measureCpuLaps:
// seeds [1, 42, 98765], item boxes on, 8 CPUs × 3 laps × 3 seeds per difficulty.
// Length 2145.545732350878 m; each difficulty completed 72 laps, wall/band/fall/pit = 0.
// Level   meanLap (s)       meanSpeed (m/s)   latest finish (s)
// easy    65.01550925925926  33.00052182618746  198.45
// normal  61.60092592592592  34.82976432742035  189.18333333333334
// hard    59.3951388888889   36.12325473915589  181.7
// Compare normal with speedway's normal H1 mean 35.611 m/s.
// Both bowls: turn pi, roll 0.85, minimum sampled radius 30.275132994172214 m;
// S banks -0.6/+0.6/-0.6, maximum measured twist 0.014976 rad/m; grade 0.
// Adaptive CPU steering, full throttle/no brake/no drift, aura + dash, BOTH bowls:
// Same 24-tick warm-up reaches 50.2 m/s. Banked: 167 ticks, mean 58.082 m/s,
// minimum 46.353, wall/grass 0. Roll 0 only: 231 ticks, mean 45.338, minimum
// 20.010, wall 1 / grass 36 ticks. Identical steering probe measures yaw ×1.3.
// This high-speed comparison is separate from the ordinary CPU lap benchmark.
// M11-08 render handoff: 28 meshes / 87,174 geometry triangles; Chromium
// 1280×720 DPR 1, seed 127 start grid: 124 calls / 93,922 triangles.
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { buildCourse } from '../../render/course/buildCourse';
import { velodrome as theme, velodromePalette } from '../../render/course/themes/velodrome';
import { getAIInput } from '../ai';
import { createRace, stepRace } from '../race';
import { KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { racingLineOffset } from '../surfaces';
import { buildTrack, rollAt, sampleTrack, slopeAt, surfaceHeightAt } from '../track';
import { CPU_LEVELS } from '../types';
import { getTrack, scaffoldIds } from './index';
import * as tracks from './index';
import { curvatureProfile, maxSlope, measureCpuLaps } from './shapeMetrics';

const track = getTrack('velodrome');
const keys = track.def.bankKeys!;
const bowls = keys.slice(1).flatMap((key, i) => keys[i]!.roll >= 0.75 && key.roll === keys[i]!.roll
  ? [{ from: keys[i]!.distance, to: key.distance }] : []);

describe('WALL BOWL', () => {
  it('replaces the scaffold with a valid, serializable stadium with tight bowls and a banked S', () => {
    expect(scaffoldIds()).not.toContain('velodrome');
    expect(track.def.layoutVersion).toBe(1);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.checkpointDistances).toHaveLength(24);
    expect(track.boxPoses).toHaveLength(24);
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
  });

  it('holds at least 0.75 rad through two complete 180-degree bowls and reaches 0.85 rad', () => {
    expect(bowls).toHaveLength(2);
    const profile = curvatureProfile(track);
    let maximum = 0;
    for (const bowl of bowls) {
      const a = sampleTrack(track, bowl.from), b = sampleTrack(track, bowl.to);
      expect(a.tx * b.tx + a.tz * b.tz).toBeCloseTo(-1, 6);
      const turn = profile.filter(point => point.distance >= bowl.from && point.distance <= bowl.to)
        .reduce((sum, point) => sum + point.turn, 0);
      expect(turn).toBeCloseTo(Math.PI, 2);
      for (let d = bowl.from; d <= bowl.to; d += 0.5) {
        expect(rollAt(track, d)).toBeGreaterThanOrEqual(0.75);
        maximum = Math.max(maximum, rollAt(track, d));
      }
    }
    for (const bowl of bowls) {
      const curved = profile.filter(p => p.distance >= bowl.from && p.distance <= bowl.to);
      const minRadius = 1 / Math.max(...curved.map(p => Math.abs(p.curvature)));
      const tightTurn = curved.filter(p => Math.abs(p.curvature) >= 1 / 45)
        .reduce((sum, p) => sum + p.turn, 0);
      console.info('velodrome bowl geometry', { minRadius, tightTurn });
      expect(minRadius).toBeGreaterThanOrEqual(30);
      expect(minRadius).toBeLessThanOrEqual(45);
      expect(tightTurn).toBeGreaterThan(Math.PI / 2);
    }
    expect(maximum).toBeGreaterThanOrEqual(0.85);
    expect(maximum).toBeLessThanOrEqual(track.def.physics!.maxRoll!);
  });

  it('banks both directions through a real S, with gradual reversals', () => {
    const s = keys.slice(1).flatMap((key, i) => Math.abs(key.roll) === 0.6 && key.roll === keys[i]!.roll
      ? [{ from: keys[i]!.distance, to: key.distance, roll: key.roll }] : []);
    expect(s.map(bend => bend.roll)).toEqual([-0.6, 0.6, -0.6]);
    const profile = curvatureProfile(track);
    for (const bend of s) {
      const turn = profile.filter(p => p.distance >= bend.from && p.distance <= bend.to)
        .reduce((sum, p) => sum + p.turn, 0);
      expect(turn * Math.sign(bend.roll)).toBeGreaterThan(0.15);
      expect(rollAt(track, (bend.from + bend.to) / 2)).toBeCloseTo(bend.roll, 12);
    }
    for (let i = 1; i < s.length; i++) {
      expect(s[i]!.from - s[i - 1]!.to).toBeGreaterThanOrEqual(60);
    }
  });

  it('limits twist and grade through both ramps and the lap seam', () => {
    for (let i = 0; i < keys.length; i++) {
      const a = keys[i]!, b = keys[(i + 1) % keys.length]!;
      const span = b.distance - a.distance + (i === keys.length - 1 ? track.length : 0);
      if (span === 0) expect(a.roll).toBe(b.roll);
      else expect(Math.abs(b.roll - a.roll) / span).toBeLessThanOrEqual(0.02);
    }
    expect(maxSlope(track)).toBeLessThanOrEqual(0.2);
    for (let d = 0; d < track.length; d += 0.5) {
      expect(Math.abs(slopeAt(track, d))).toBeLessThanOrEqual(0.2);
      expect(Math.abs(rollAt(track, d + 0.5) - rollAt(track, d)) / 0.5).toBeLessThanOrEqual(0.02);
      const width = widthAt(track, d);
      expect(Math.abs(racingLineOffset(track, d)) + KART_RADIUS).toBeLessThan(width.roadHalfWidth);
      expect(surfaceHeightAt(track, d, -width.wallHalfWidth)).toBeGreaterThan(0);
    }
  });

  it('lights a night stadium, with budgeted props clear of the whole road', () => {
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ fillRect() {}, fillText() {} }) }) });
    const course = buildCourse(track, theme);
    try {
      const road = course.group.getObjectByName('road') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
      expect(road.material.color.getHex()).toBe(velodromePalette.timber);
      const lights: THREE.PointLight[] = [];
      course.group.traverse(object => { if (object instanceof THREE.PointLight) lights.push(object); });
      expect(lights).toHaveLength(6);
      const lamps = course.group.getObjectByName('velodrome:floodlights') as THREE.InstancedMesh;
      expect((lamps.material as THREE.MeshLambertMaterial).emissiveIntensity).toBeGreaterThan(1);
      // Raised floodlights must reach the high bowls from above the tilted road,
      // not just glow against the sky. Test the Lambert normal dot light vector.
      for (let d = 0; d < track.length; d += 1) {
        if (rollAt(track, d) < 0.75) continue;
        const p = sampleTrack(track, d), roll = rollAt(track, d);
        const normal = new THREE.Vector3(-p.nx * Math.sin(roll), 1, -p.nz * Math.sin(roll)).normalize();
        expect(lights.some(light => {
          const direction = light.position.clone().sub(new THREE.Vector3(p.x, p.y, p.z));
          return direction.length() < light.distance && direction.dot(normal) > 0;
        }), `lit bowl at ${d}m`).toBe(true);
      }
      const counts = {
        'light-towers': theme.budget.trees, floodlights: theme.budget.trees,
        seating: theme.budget.rocks, canopies: theme.budget.flowers, 'neon-ribbons': theme.budget.flowers,
      };
      const matrix = new THREE.Matrix4();
      for (const [name, count] of Object.entries(counts)) {
        const mesh = course.group.getObjectByName(`velodrome:${name}`) as THREE.InstancedMesh;
        expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
        expect(mesh.count).toBe(count);
        mesh.geometry.computeBoundingBox();
        const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
        const footprint = Math.hypot(size.x, size.z) / 2;
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          const position = new THREE.Vector3().setFromMatrixPosition(matrix);
          for (let j = 0; j < track.samples.length; j++) {
            const a = track.samples[j]!, b = track.samples[(j + 1) % track.samples.length]!;
            const dx = b.x - a.x, dz = b.z - a.z;
            const t = Math.max(0, Math.min(1,
              ((position.x - a.x) * dx + (position.z - a.z) * dz) / (dx * dx + dz * dz)));
            expect(Math.hypot(position.x - a.x - t * dx, position.z - a.z - t * dz))
              .toBeGreaterThan(widthAt(track, a.distance).wallHalfWidth + footprint + 3);
          }
        }
      }
      let meshes = 0, triangles = 0;
      course.group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        meshes++;
        const vertices = object.geometry.getAttribute('position');
        expect(Array.from(vertices.array).every(Number.isFinite)).toBe(true);
        triangles += (object.geometry.index?.count ?? vertices.count) / 3
          * (object instanceof THREE.InstancedMesh ? object.count : 1);
      });
      console.info('velodrome render', { meshes, triangles });
      expect(meshes).toBeLessThanOrEqual(40);
      expect(triangles).toBeLessThanOrEqual(60 * track.length + 30_000);
    } finally {
      course.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('uses the +30% bank grip to clear both bowls at full throttle under aura + dash', () => {
    const flat = buildTrack({ ...track.def, bankKeys: [] });
    // Both variants recompute CPU steering every tick. Aura + dash are normal
    // game effects; a 24-tick straight warm-up reaches 50.2 m/s by acceleration.
    // Ordinary unboosted laps can take these bowls without saturating steering.
    const drive = (course: typeof track, bowl: typeof bowls[number]) => {
      const lookup = vi.spyOn(tracks, 'getTrack').mockReturnValue(course);
      try {
        const state = createRace(42, { trackId: 'velodrome', karts: 1, itemBoxes: false });
        state.phase = 'racing';
        const kart = state.karts[0]!;
        const d = bowl.from + 2.6, p = sampleTrack(course, d), offset = racingLineOffset(course, d);
        Object.assign(kart, { x: p.x + p.nx * offset, z: p.z + p.nz * offset,
          y: surfaceHeightAt(course, d, offset), heading: Math.atan2(p.tx, p.tz),
          trackDistance: d, lateralOffset: offset, speed: 36.64, boostTime: 1.9 });
        kart.effects.auraTime = 6.4;
        const fullThrottle = { steer: 0, throttle: 1, brake: false, drift: false, useItem: false };
        for (let i = 0; i < 24; i++) stepRace(state, [fullThrottle]);
        const entry = [kart.x, kart.z, kart.heading, kart.speed, kart.trackDistance,
          kart.boostTime, kart.effects.auraTime];
        const probe = structuredClone(state);
        stepRace(probe, [{ ...fullThrottle, steer: -1 }]);
        const yaw = Math.abs(probe.karts[0]!.heading - kart.heading);
        let minSpeed = Infinity, wallHits = 0, offRoad = 0, speedSum = 0, ticks = 0;
        let roadClearance = Infinity;
        for (; ticks < 1200 && kart.trackDistance < bowl.to + 20; ticks++) {
          const input = { ...fullThrottle, steer: getAIInput(state, kart.id).steer };
          stepRace(state, [input]);
          minSpeed = Math.min(minSpeed, kart.speed);
          speedSum += kart.speed;
          const clearance = widthAt(course, kart.trackDistance).roadHalfWidth - Math.abs(kart.lateralOffset);
          roadClearance = Math.min(roadClearance, clearance - KART_RADIUS);
          if (clearance < 0) offRoad++;
          wallHits += state.events.filter(e => e.type === 'hit').length;
        }
        return { entry, yaw, ticks, minSpeed, wallHits, offRoad, roadClearance,
          meanSpeed: speedSum / ticks, completed: kart.trackDistance >= bowl.to + 20 };
      } finally { lookup.mockRestore(); }
    };
    for (const bowl of bowls) {
      const banked = drive(track, bowl), unbanked = drive(flat, bowl);
      expect(banked.entry).toEqual(unbanked.entry);
      expect(banked.entry[3]).toBeCloseTo(50.2, 8);
      expect(banked.yaw / unbanked.yaw).toBeCloseTo(1.3, 10);
      expect(banked.completed).toBe(true);
      expect(unbanked.completed).toBe(true);
      expect(banked.offRoad).toBe(0);
      expect(banked.roadClearance).toBeGreaterThan(0);
      expect(banked.wallHits).toBe(0);
      expect(banked.minSpeed).toBeGreaterThan(45);
      expect(unbanked.offRoad).toBeGreaterThan(0);
      expect(unbanked.wallHits).toBeGreaterThan(banked.wallHits);
      expect(unbanked.meanSpeed).toBeLessThan(banked.meanSpeed - 10);
      expect(unbanked.minSpeed).toBeLessThan(25);
      console.info('velodrome adaptive aura + dash comparison', { from: bowl.from, banked, unbanked });
    }
  });

  it.each(CPU_LEVELS)('finishes 8 CPUs × 3 laps for all three seeds on %s within the wall-hit budget', cpuLevel => {
    const [result] = measureCpuLaps('velodrome', { cpuLevels: [cpuLevel], fallBudget: 0, wallHitBudget: 8, bandHitBudget: 0 });
    const lapTimes = result!.runs.flatMap(run => run.state.karts.flatMap(kart => kart.lapTimes));
    const meanLap = lapTimes.reduce((sum, lap) => sum + lap, 0) / lapTimes.length;
    console.info('velodrome CPU', { cpuLevel, length: track.length, meanLap,
      meanSpeed: track.length / meanLap, wallHits: result!.wallHits, bandHits: result!.bandHits,
      falls: result!.falls, finishTimes: result!.runs.map(run => run.state.time),
      completedLaps: lapTimes.length });
    expect(result!.runs.map(run => run.seed)).toEqual([1, 42, 98765]);
    expect(result!.wallHits).toBeLessThanOrEqual(8);
    expect(result!.bandHits).toBe(0);
    expect(result!.falls).toBe(0);
    // 35.611 is speedway's normal-difficulty H1 baseline (handling.test.ts).
    if (cpuLevel === 'normal') expect(track.length / meanLap).toBeLessThan(35.611);
    expect(result!.passed).toBe(true);
    expect(lapTimes).toHaveLength(72);
    for (const run of result!.runs) {
      expect(run.finished, `seed ${run.seed}`).toBe(true);
      expect(run.state.karts).toHaveLength(8);
      expect(run.pitFalls).toBe(0);
      expect(run.state.time).toBeLessThanOrEqual(420);
      for (const kart of run.state.karts) {
        expect(kart.human).toBe(false);
        expect(kart.lap).toBe(3);
        expect(kart.lapTimes).toHaveLength(3);
        expect(kart.finishTime).not.toBeNull();
      }
    }
  }, 120_000);
});

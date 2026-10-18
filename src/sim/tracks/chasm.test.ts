// M11-05, darwin-arm64: measureCpuLaps, 8 CPUs × 3 laps, items enabled.
// Seeds [1, 42, 98765]; tick cap 25200; every kart finished in every run.
// easy:   ticks [12337, 12378, 12489], falls [0, 1, 0], wallHits [0, 0, 1].
// normal: ticks [11855, 11643, 11477], falls [1, 1, 1], wallHits [0, 0, 0].
// hard:   ticks [11260, 11280, 11207], falls [0, 0, 0], wallHits [0, 0, 0].
// Mean falls: easy 1/3, normal 1, hard 0; all bandHits 0.
// Fix pass remeasured 2026-10-19 with jump.from clearance: CPU values above unchanged.
// At entry speed 26 without boosts, leaps 1/2/3 have no falls and land at
// 237.103 / 442.808 / 638.075 m, beyond gap ends 232 / 436 / 630 m.
// Airborne ticks [84, 97, 109], peak clearances [4, 5, 6] m;
// third leap: 109 ticks = 1.8166666666666667 s.
// M11-08 handoff: buildCourse 34 meshes / 65,790 triangles; Chromium 1280×720,
// DPR 1, seed 127, all ten start-grid frames 130 draws / 72,538 triangles.
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { buildCourse } from '../../render/course/buildCourse';
import { chasm as theme } from '../../render/course/themes/chasm';
import { validateCoursePlayability, validateTrackDef } from '../corridor';
import { createRace, FIXED_DT, NEUTRAL_INPUT, stepRace } from '../race';
import { projectToTrack, sampleTrack, surfaceHeightAt } from '../track';
import { getTrack } from './index';
import { measureCpuLaps, WALL_HITS_MAX_EXISTING } from './shapeMetrics';

const track = getTrack('chasm');
const jumps = track.def.surfaces.filter(zone => zone.kind === 'jump');
const gaps = track.def.surfaces.filter(zone => zone.kind === 'fall');

describe('CHASM LEAP', () => {
  it('validates the registered course and its full-width ravines', () => {
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
  });

  it.each([206, 220, 232])('rejects a respawn at %s m that would fall repeatedly', respawnAt => {
    const def = { ...track.def, surfaces: track.def.surfaces.map(zone =>
      zone === gaps[0] ? { ...zone, respawnAt } : zone) };
    expect(() => validateTrackDef(def)).toThrow(/respawnAt.*fall zone/);
  });

  it('pairs three increasing leaps with boosts and landing-side respawns', () => {
    expect(jumps.map(zone => zone.duration)).toEqual([1.4, 1.6, 1.8]);
    expect(jumps.map(zone => zone.height)).toEqual([4, 5, 6]);
    expect(gaps.map(zone => zone.to - zone.from)).toEqual([26, 30, 34]);
    for (const [i, gap] of gaps.entries()) {
      const jump = jumps[i]!;
      expect(jump.to - jump.from).toBeLessThanOrEqual(5);
      expect(gap.from).toBeGreaterThan(jump.to);
      expect(gap.from - jump.to).toBeLessThanOrEqual(5);
      expect(jump.offsetMin).toBeLessThanOrEqual(gap.offsetMin!);
      expect(jump.offsetMax).toBeGreaterThanOrEqual(gap.offsetMax!);
      expect(gap.respawnAt).toBeGreaterThan(gap.to);
      expect(gap.offsetMin).toBe(-track.def.wallHalfWidth);
      expect(gap.offsetMax).toBe(track.def.wallHalfWidth);
      expect(track.checkpointDistances.some(d => d >= gap.from && d <= gap.respawnAt!)).toBe(false);
      expect(track.def.surfaces.some(zone => zone.kind === 'boost' &&
        zone.from >= jump.from - 60 && zone.to < jump.from)).toBe(true);
      // No barrier or split may intrude into even the 60 m/s alignment window.
      for (const obstacle of [...track.def.barriers ?? [], ...track.def.splits ?? []]) {
        expect(obstacle.to < jump.from - 120 || obstacle.from > jump.from).toBe(true);
      }
    }
  });

  it.each([0, 1, 2])('clears leap %i from 26 m/s without a boost or fall', index => {
    const state = createRace(1, { trackId: 'chasm', karts: 1, itemBoxes: false });
    state.phase = 'racing';
    const kart = state.karts[0]!;
    const start = jumps[index]!.from - 0.2;
    const point = sampleTrack(track, start);
    Object.assign(kart, { x: point.x, y: point.y, z: point.z, trackDistance: start,
      heading: Math.atan2(point.tx, point.tz), lateralOffset: 0, speed: 26, boostTime: 0 });
    let airborneTicks = 0;
    let peak = 0;
    let landed = false;
    for (let tick = 0; tick < 180; tick++) {
      stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
      expect(state.events.filter(event => event.type === 'fall')).toEqual([]);
      expect(kart.boostTime).toBe(0);
      if (kart.airTime > 0) {
        airborneTicks++;
        peak = Math.max(peak, kart.y - surfaceHeightAt(track, kart.trackDistance, kart.lateralOffset));
      } else if (airborneTicks > 0) { landed = true; break; }
    }
    expect(landed).toBe(true);
    expect(airborneTicks * FIXED_DT).toBeGreaterThanOrEqual(jumps[index]!.duration!);
    expect(peak).toBeGreaterThanOrEqual(jumps[index]!.height! - 0.5);
    expect(kart.trackDistance).toBeGreaterThan(gaps[index]!.to);
    console.info('CHASM leap', index + 1, { seconds: airborneTicks * FIXED_DT, peak,
      landing: kart.trackDistance, gapEnd: gaps[index]!.to });
  });

  it('renders open ravines with intact lips, no floating walls, and bounded scenery', () => {
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ fillRect() {}, fillText() {} }) }) });
    const before = JSON.stringify(track.def);
    const course = buildCourse(track, theme);
    try {
      course.group.updateMatrixWorld(true);
      const ribbons = ['road', 'shoulder:-1', 'shoulder:1', 'ground:-1', 'ground:1', 'line:-1', 'line:1']
        .map(name => course.group.getObjectByName(name)!);
      const ray = new THREE.Raycaster();
      for (const gap of gaps) {
        for (const distance of [gap.from + 0.01, (gap.from + gap.to) / 2, gap.to - 0.01]) {
          const p = sampleTrack(track, distance);
          for (const offset of [-25, -12, -6, 0, 6, 12, 25]) {
            ray.set(new THREE.Vector3(p.x + p.nx * offset, 60, p.z + p.nz * offset), new THREE.Vector3(0, -1, 0));
            expect(ray.intersectObjects(ribbons)).toEqual([]);
          }
        }
        for (const distance of [gap.from - 0.01, gap.to + 0.01]) {
          const p = sampleTrack(track, distance);
          ray.set(new THREE.Vector3(p.x, 60, p.z), new THREE.Vector3(0, -1, 0));
          expect(ray.intersectObject(ribbons[0]!)).toHaveLength(1);
        }
      }
      const matrix = new THREE.Matrix4(), vertex = new THREE.Vector3();
      for (const mesh of course.group.children) {
        if (!(mesh instanceof THREE.InstancedMesh) || mesh.name.startsWith('chasm:')) continue;
        const vertices = mesh.geometry.getAttribute('position');
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          for (let v = 0; v < vertices.count; v++) {
            vertex.fromBufferAttribute(vertices, v).applyMatrix4(matrix);
            const { distance } = projectToTrack(track, vertex.x, vertex.z);
            expect(gaps.some(gap => distance > gap.from && distance < gap.to)).toBe(false);
          }
        }
      }
      for (const name of ['buttes', 'butte-caps', 'rocks', 'ravine-faces', 'lip-markers', 'landing-beacons']) {
        expect(course.group.getObjectByName(`chasm:${name}`)).toBeInstanceOf(THREE.Mesh);
      }
      let meshes = 0, triangles = 0;
      course.group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        meshes++;
        const positions = object.geometry.getAttribute('position');
        expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
        triangles += (object.geometry.index?.count ?? positions.count) / 3 *
          (object instanceof THREE.InstancedMesh ? object.count : 1);
      });
      expect(meshes).toBeLessThanOrEqual(40);
      expect(triangles).toBeLessThanOrEqual(60 * track.length + 30_000);
      expect(JSON.stringify(track.def)).toBe(before);
      console.info('CHASM course render', { meshes, triangles });
    } finally {
      course.dispose();
      vi.unstubAllGlobals();
    }
  });

  it.each([0, 1, 2])('respawns a grounded kart beyond ravine %i exactly once', index => {
    const gap = gaps[index]!;
    const state = createRace(1, { trackId: 'chasm', karts: 1, itemBoxes: false });
    state.phase = 'racing';
    const kart = state.karts[0]!;
    const distance = (gap.from + gap.to) / 2;
    const point = sampleTrack(track, distance);
    Object.assign(kart, { x: point.x, y: point.y, z: point.z, trackDistance: distance,
      heading: Math.atan2(point.tx, point.tz), lateralOffset: 0, speed: 0 });
    stepRace(state, [NEUTRAL_INPUT]);
    expect(state.events).toEqual([{ type: 'fall', kartId: kart.id }]);
    expect(kart.trackDistance).toBe(gap.respawnAt);
    expect(kart.lapValid).toBe(true);
    for (let tick = 0; tick < 120; tick++) {
      stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
      expect(state.events.filter(event => event.type === 'fall')).toEqual([]);
    }
    expect(kart.trackDistance).toBeGreaterThan(gap.respawnAt!);
  });

  it.each(['easy', 'normal', 'hard'] as const)('finishes 8 CPUs × 3 laps on %s within the fall budget', cpuLevel => {
    const budget = cpuLevel === 'normal' ? 9 : 12;
    const [metrics] = measureCpuLaps('chasm', { cpuLevels: [cpuLevel], fallBudget: budget });
    console.info('CHASM CPU', cpuLevel, metrics!.runs.map(run => ({ seed: run.seed,
      ticks: run.state.tick, falls: run.falls, wallHits: run.wallHits,
      bandHits: run.bandHits, finished: run.finished })));
    expect(metrics!.meanFalls).toBeLessThanOrEqual(budget);
    expect(metrics!.wallHits).toBeLessThanOrEqual(WALL_HITS_MAX_EXISTING);
    expect(metrics!.runs.every(run => run.finished)).toBe(true);
    expect(metrics!.passed).toBe(true);
  });
});

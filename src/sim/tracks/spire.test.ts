/**
 * M11-07 / darwin-arm64, seeds [1, 42, 98765], measureCpuLaps, 8 CPUs × 3 laps.
 * Compact layout: 2526.434751 m; normal mean with items: 71.307407 s.
 * Per-seed mean lap / last finish, racing seconds (countdown excluded):
 * With items:
 * easy: 77.331944 / 233.016667, 77.243056 / 233.716667, 76.995139 / 232.983333
 * normal: 70.911111 / 214.666667, 71.704861 / 216.750000, 71.306250 / 217.216667
 * hard: 68.168056 / 206.283333, 68.706944 / 208.000000, 68.881250 / 208.983333
 * Without items (drift boosts enabled):
 * easy: 76.288194 / 230.900000, 76.181944 / 230.483333, 76.263889 / 230.333333
 * normal: 70.746528 / 214.100000, 70.771528 / 214.866667, 70.542361 / 213.666667
 * hard: 68.033333 / 205.950000, 68.072917 / 206.416667, 67.893056 / 205.483333
 * Every difficulty in both modes: 24/24 finishes, falls=0, wallHits=0, bandHits=0, pitFalls=0.
 * AC3: 0 <= delta <= speed * FIXED_DT + 0.25 m on every tick, including lap seams.
 * Speed is sampled immediately after movement, before collisions/item hits change it.
 * Maximum delta / minimum headroom to the upper bound (m), easy / normal / hard:
 * with items:    0.899725368 / 0.035818518, 1.050792050 / 0.016056815, 1.096748832 / 0.023678411
 * without items: 0.877531548 / 0.097660820, 0.919463454 / 0.096204339, 0.941295217 / 0.095318074
 * Minimum delta=0 in all six cases; 96 seam crossings per case (start plus three laps).
 * Human full throttle, no items/boost: plunge peak=42.982693 m/s; flat peak=36.643333 m/s.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCourse } from '../../render/course/buildCourse';
import { spire as theme } from '../../render/course/themes/spire';
import { validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import * as race from '../race';
import * as geometry from '../track';
import { projectToTrack, sampleTrack, slopeAt } from '../track';
import { CPU_LEVELS } from '../types';
import type { KartState } from '../types';
import { getTrack, scaffoldIds } from './index';
import { elevationRange, measureCpuLaps, minCurvatureRadius, WALL_HITS_MAX_EXISTING } from './shapeMetrics';

const track = getTrack('spire');
const SEEDS = [1, 42, 98765];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Non-neighbouring centre-line intersections, independent of the declared decks. */
function crossings() {
  const points: { upper: number; lower: number; gap: number; angle: number }[] = [];
  const { samples, length } = track;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i]!, b = samples[(i + 1) % samples.length]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    for (let j = i + 2; j < samples.length; j++) {
      if (i === 0 && j === samples.length - 1) continue;
      const c = samples[j]!, d = samples[(j + 1) % samples.length]!;
      const ex = d.x - c.x, ez = d.z - c.z, determinant = dx * ez - dz * ex;
      if (Math.abs(determinant) < 1e-9) continue;
      const t = ((c.x - a.x) * ez - (c.z - a.z) * ex) / determinant;
      const u = ((c.x - a.x) * dz - (c.z - a.z) * dx) / determinant;
      if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
      const ad = a.distance + t * ((b.distance || length) - a.distance);
      const cd = c.distance + u * ((d.distance || length) - c.distance);
      const ay = a.y + t * (b.y - a.y), cy = c.y + u * (d.y - c.y);
      points.push({ upper: ay > cy ? ad : cd, lower: ay > cy ? cd : ad,
        gap: Math.abs(ay - cy),
        angle: Math.acos(Math.min(1, Math.abs(dx * ex + dz * ez) / Math.hypot(dx, dz) / Math.hypot(ex, ez))) });
    }
  }
  return points.sort((a, b) => a.upper - b.upper);
}

function humanRun(from: number, to: number) {
  const state = race.createRace(1, { trackId: 'spire', karts: 1, itemBoxes: false });
  state.phase = 'racing';
  const kart = state.karts[0]!, point = sampleTrack(track, from);
  Object.assign(kart, { x: point.x, y: point.y, z: point.z, heading: Math.atan2(point.tx, point.tz),
    speed: 36.6, trackDistance: point.distance, lateralOffset: 0 });
  let peak = 0, launched = false, landing: number | undefined;
  for (let tick = 0; tick < 600 && kart.trackDistance < to; tick++) {
    race.stepRace(state, [{ ...race.NEUTRAL_INPUT, throttle: 1 }]);
    peak = Math.max(peak, kart.speed);
    expect(kart.boostTime).toBe(0);
    expect(kart.item).toBeNull();
    if (launched && kart.airTime === 0 && landing === undefined) landing = kart.trackDistance;
    launched ||= kart.airTime > 0;
  }
  expect(kart.trackDistance).toBeGreaterThanOrEqual(to);
  return { peak, launched, landing };
}

/** Observe the real harness without changing inputs, physics or race state. */
function observeProgress() {
  let min = Infinity, max = 0, maxExcess = -Infinity, seamCrossings = 0;
  let karts: readonly KartState[] = [], speeds: (number | undefined)[] = [];
  const project = geometry.projectToTrack;
  const projection = vi.spyOn(geometry, 'projectToTrack').mockImplementation((track, x, z, hint, level) => {
    // The first projection after movement still has the integration speed, before
    // collisions or item hits can change it. Pre-movement useItem projections have
    // no hint; later calls cannot overwrite a captured speed.
    if (hint !== undefined) {
      const kart = karts.find(kart => speeds[kart.id] === undefined &&
        kart.x === x && kart.z === z && kart.trackDistance === hint);
      if (kart) speeds[kart.id] = kart.speed;
    }
    return project(track, x, z, hint, level);
  });
  const step = race.stepRace;
  vi.spyOn(race, 'stepRace').mockImplementation((state, inputs) => {
    const before = state.karts.map(kart => kart.trackDistance);
    const racing = state.phase === 'racing';
    karts = state.karts;
    speeds = [];
    step(state, inputs);
    projection.mockClear(); // Do not retain millions of projection call arguments.
    state.karts.forEach((kart, i) => {
      const speed = racing ? speeds[kart.id] : kart.speed;
      if (speed === undefined) throw new Error(`Missing movement speed for kart ${kart.id} at tick ${state.tick}`);
      let delta = kart.trackDistance - before[i]!;
      if (delta < -track.length / 2) { delta += track.length; seamCrossings++; }
      else if (delta > track.length / 2) delta -= track.length;
      min = Math.min(min, delta);
      max = Math.max(max, delta);
      // Compare each tick with that kart's speed, including item/drift boosts.
      maxExcess = Math.max(maxExcess, delta - (speed * race.FIXED_DT + 0.25));
    });
  });
  return () => ({ min, max, maxExcess, seamCrossings });
}

describe('SPIRE / SKY SPIRE', () => {
  it('replaces the scaffold with a validated, closed, three-tier switchback', () => {
    expect(scaffoldIds()).not.toContain('spire');
    expect(track.def.physics).toBeDefined();
    expect(track.def.layoutVersion).toBe(1);
    expect(track.def.checkpointCount).toBe(24);
    expect(track.length).toBeLessThanOrEqual(2700);
    expect(minCurvatureRadius(track)).toBeGreaterThanOrEqual(track.def.wallHalfWidth + 2.5);
    expect(track.boxPoses).toHaveLength(24);
    expect(() => validateTrackDef(track.def)).not.toThrow(); // Includes validateCrossings.
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(sampleTrack(track, track.length)).toEqual(sampleTrack(track, 0));
    expect(track.def.racingLine.at(-1)).toEqual({ distance: track.length, offset: 0 });
    const intersections = crossings();
    expect(intersections).toHaveLength(3);
    expect(intersections.map(p => Math.round(sampleTrack(track, p.upper).y))).toEqual([37, 55, 19]);
    expect(intersections.map(p => Math.sign(sampleTrack(track, p.upper).tx))).toEqual([-1, 1, 1]);
    expect(track.def.decks).toHaveLength(3);
    for (const point of intersections) {
      expect(point.gap).toBeGreaterThanOrEqual(12);
      expect(point.angle).toBeGreaterThanOrEqual(Math.PI / 4);
      expect(track.def.decks!.some(deck => point.upper >= deck.from && point.upper <= deck.to)).toBe(true);
      for (const distance of [point.upper, point.lower]) {
        for (let delta = -20; delta <= 20; delta += 0.5) {
          expect(Math.abs(slopeAt(track, distance + delta))).toBeLessThanOrEqual(0.10);
        }
        for (const gate of track.checkpointDistances) {
          const gap = Math.abs(gate - distance);
          expect(Math.min(gap, track.length - gap)).toBeGreaterThan(25);
        }
      }
    }
    expect(() => validateTrackDef({ ...track.def, decks: [] })).toThrow(/upper crossing/);
  });

  it('projects road and wall edges onto their own layer on both approaches to all three crossings', () => {
    const intersections = crossings();
    expect(intersections).toHaveLength(3);
    for (const crossing of intersections) {
      for (const distance of [crossing.upper, crossing.lower]) {
        for (let delta = -20; delta <= 20; delta += 0.5) {
          const point = sampleTrack(track, distance + delta);
          const { roadHalfWidth, wallHalfWidth } = widthAt(track, point.distance);
          for (const offset of [-roadHalfWidth, roadHalfWidth, -(wallHalfWidth - 0.95), wallHalfWidth - 0.95]) {
            const x = point.x + point.nx * offset, z = point.z + point.nz * offset;
            // Cover both the local driving window and global height-based reacquisition.
            for (const hint of [point.distance - 1, undefined]) {
              const projected = projectToTrack(track, x, z, hint, point.y);
              const gap = Math.abs(projected.distance - point.distance);
              expect(Math.min(gap, track.length - gap)).toBeLessThan(0.15);
              expect(projected.height).toBeCloseTo(point.y, 3);
              expect(projected.offset).toBeCloseTo(offset, 2);
            }
          }
        }
      }
    }
  });

  it('climbs over 50 m and plunges at least -0.50 within the gated slope limit', () => {
    expect(elevationRange(track).range).toBeGreaterThanOrEqual(50);
    const grades = track.samples.map(p => slopeAt(track, p.distance));
    expect(Math.min(...grades)).toBeLessThanOrEqual(-0.50);
    expect(Math.max(...grades)).toBeLessThanOrEqual(0.38);
    expect(Math.max(...grades.map(Math.abs))).toBeLessThanOrEqual(0.55);
    expect(() => validateTrackDef({ ...track.def, physics: undefined })).toThrow();
  });

  it('reaches 42 m/s without items or boost, then launches at the bottom and lands on the straight', () => {
    const plunge = humanRun(1025, 1243);
    const flat = humanRun(1564, 1704);
    expect(plunge.peak).toBeGreaterThanOrEqual(42);
    expect(plunge.peak - flat.peak).toBeGreaterThanOrEqual(5);
    expect(plunge.launched).toBe(true);
    expect(plunge.landing).toBeGreaterThan(1206);
    expect(plunge.landing).toBeLessThan(1244);
    expect(flat.launched).toBe(false);
    expect(track.def.surfaces.some(zone => zone.kind === 'boost')).toBe(false);
    // No barrier or split can intrude into the speed-dependent jump alignment window.
    expect(track.def.barriers ?? []).toHaveLength(0);
    expect(track.def.splits ?? []).toHaveLength(0);
  });

  describe.each([true, false])('CPU acceptance (itemBoxes=%s)', itemBoxes => {
    it.each(CPU_LEVELS)('finishes eight %s CPUs × three seeds × three laps with 0 ≤ Δd ≤ speed·dt + 0.25 m every tick', cpuLevel => {
      const progress = observeProgress();
      const [result] = measureCpuLaps('spire', { seeds: SEEDS, cpuLevels: [cpuLevel], fallBudget: 0, itemBoxes });
      const measured = progress();
      expect(result!.passed).toBe(true);
      expect(result!.falls).toBe(0);
      expect(result!.meanFalls).toBe(0);
      expect(result!.wallHits).toBeLessThanOrEqual(WALL_HITS_MAX_EXISTING);
      expect(measured.min).toBeGreaterThanOrEqual(0);
      expect(measured.maxExcess, JSON.stringify(measured)).toBeLessThanOrEqual(0);
      expect(measured.seamCrossings).toBe(3 * 8 * 4); // Start line plus three completed laps.
      for (const run of result!.runs) {
        expect(run.finished).toBe(true);
        expect(run.state.time).toBeLessThanOrEqual(420);
        expect(run.state.karts).toHaveLength(8);
        expect(run.falls).toBe(0);
        expect(run.pitFalls).toBe(0);
        if (cpuLevel === 'normal') {
          const laps = run.state.karts.flatMap(kart => kart.lapTimes);
          expect(laps.reduce((sum, lap) => sum + lap, 0) / laps.length).toBeLessThanOrEqual(85);
        }
        for (const kart of run.state.karts) {
          expect(kart.lap).toBe(3);
          expect(kart.lapTimes).toHaveLength(3);
          expect(kart.finishTime).not.toBeNull();
        }
      }
    });
  });

  it('uses a distinct tower theme with open terraces, clear supports and bounded geometry', () => {
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ fillRect() {}, fillText() {} }) }) });
    const course = buildCourse(track, theme);
    try {
      expect(theme.colors.rail).toBe(0x23c9be);
      expect(theme.fog.far).toBeGreaterThanOrEqual(800);
      for (const name of ['spire:switchback-tower', 'spire:columns', 'spire:beacons', 'deck-pillars']) {
        expect(course.group.getObjectByName(name)).toBeDefined();
      }
      for (const name of ['ground:-1', 'ground:1']) expect(course.group.getObjectByName(name)).toBeUndefined();
      const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
      for (const name of ['spire:columns', 'spire:foundations', 'spire:beacons']) {
        const mesh = course.group.getObjectByName(name) as THREE.InstancedMesh;
        expect(mesh.count).toBeGreaterThan(0);
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          position.setFromMatrixPosition(matrix);
          expect(Math.abs(projectToTrack(track, position.x, position.z).offset))
            .toBeGreaterThanOrEqual(track.def.wallHalfWidth + 12);
        }
      }
      let triangles = 0;
      course.group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3
          * (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
      });
      expect(triangles + 20_000).toBeLessThanOrEqual(60 * track.length + 30_000);
    } finally { course.dispose(); }
  });
});

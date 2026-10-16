/**
 * M10-07 re-review measurements (Node 25, macOS, focused course test run):
 * Rendering: 28 meshes, 113,488 shadow-weighted triangles; five-build median
 * 21.837 ms (133,488 including karts < 169,715.715 cap).
 * CPU: 8 CPUs × seeds [1, 42, 98765] × 3 laps = 72; meanLap 68.323843 s,
 * wallHits 1, bandHits 0, pitFalls 0 (handling.test.ts event classification).
 *
 * Review correction: road half-width stays 4.68 (50%), but wall half-width is
 * 5.60 instead of the original criterion 6's 6.825. Moving the rails inward is
 * explicitly requested by the fix feedback: 5.60 - KART_RADIUS = 4.65 < 4.68,
 * so the grass-braking escape band is inaccessible. No barriers/sim edits.
 * The opposite turns now have distinct minimum radii: 11.043 / 11.937 m.
 *
 * Scripts over [from - 20, to + 80], time s / maximum speed m/s / hit count:
 * The interval includes the earned exit turbo (2026-10-16 route decision).
 *                 A                         B                         C
 * Lower: 4.483333 / 37.222486 / 1   3.883333 / 54.666712 / 0   7.066667 / 37.217359 / 0
 * Upper: 4.600000 / 36.643332 / 1   3.916667 / 54.476728 / 0   7.466667 / 36.637959 / 0
 * A - B: 0.600000 / 0.683333 s; a hit now also requires >= 0.5 s lost.
 * C - B: 3.183333 / 3.550000 s; C remains asserted, with no downgrade.
 * B mean speeds 41.872560 / 41.770624; exit driftTime 2.000000 / 2.050000 s;
 * inward steering 1.450000 / 1.400000 s. C entry speeds 15.730504 / 15.603333.
 * B and C have zero rail touches, including the approach and extended exit.
 * Acceleration before soft speed-cap drag allows throttle to exceed nominal 32.
 * All scripts share the outside target 3 m, look-ahead 8 m, heading gain 8,
 * lateral gain 0.6; B converts requested yaw through the drift steering formula.
 *
 * Sweep: all 324 controllers per bend × full throttle, drift and 320 slowing
 * schedules: start 40/25/15/8/3 m before entry × release at entry/quarter/apex/exit
 * × target 12/14/15.5/17/18.5/20/22/25 m/s × brake/coast (103,680 slowing runs).
 * This applies the critic's p5.ts grid to every controller, without its subset.
 * Coast means throttle 0 above target within the window, then full throttle.
 * All modes share each controller and start pose;
 * incomplete runs or approach/interval hits cannot win. Drifts also need zero
 * rail touches; non-drifts may graze rails, making their comparison more lenient.
 * Clean full throttle:
 * 0/324 (0%) on both. Best clean brake / drift / advantage in seconds:
 * lower 4.466667 / 3.750000 / 0.716667; upper 4.583333 / 3.750000 / 0.833333.
 * These replace the narrower sweep's overstated to+20 advantages 0.700/0.833.
 * Correction (M10-10): the Opus critic's continuous optimisation of the clean
 * non-drift runs found faster schedules than this grid: best clean non-drift
 * lower 4.383 / upper 4.417 s vs drift 3.750 s, so the true margins are
 * 0.633 / 0.667 s (still >= 0.5 s), not the grid's 0.717 / 0.833 s.
 * Best drift controllers (outside offset, look-ahead, heading/lateral gain):
 * lower (3, 12, 4, 0.3), upper (3, 12, 8, 0.6). Best non-drift settings:
 * lower (2, 12, 4, 0.1), start -3 m, release apex, brake to 25 m/s;
 * upper (0, 6, 8, 0.1), start -3 m, release quarter, brake to 12 m/s.
 * Both drift winners beat the fastest clean non-drift run by >= 0.5 s.
 * ai.ts:45 already brakes for curvature > 0.62 rad / 12 m above 21 m/s.
 * A 1.5 m inside racingLine keeps the CPU's exit turbo clear of the rails;
 * the human scripts do not read racingLine. No AI or physics changes needed.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCourse } from '../../render/course/buildCourse';
import { serpentine as theme, serpentinePalette } from '../../render/course/themes/serpentine';
import { getAIInput } from '../ai';
import { KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, DRIFT_BLUE_TIME, stepRace } from '../race';
import { racingLineOffset } from '../surfaces';
import { buildTrack, rollAt, sampleTrack } from '../track';
import { getTrack, scaffoldIds } from './index';
import { curvatureProfile, elevationRange, findHairpins, maxSlope } from './shapeMetrics';
import type { Hairpin } from './shapeMetrics';
import { SERPENTINE_LENGTH } from './serpentine';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const track = getTrack('serpentine');
const profile = curvatureProfile(track);
const hairpins = findHairpins(track);
const driftHairpins = hairpins.filter(bend => bend.minRadius <= 12);
afterEach(() => vi.unstubAllGlobals());

interface Controller {
  offset: number;
  lookAhead: number;
  headingGain: number;
  lateralGain: number;
}
const scriptController: Controller = { offset: 3, lookAhead: 8, headingGain: 8, lateralGain: 0.6 };

interface Braking {
  startBefore: number;
  release: 'entry' | 'quarter' | 'apex' | 'exit';
  targetSpeed: number;
  coast: boolean;
}
const scriptBraking: Braking = { startBefore: 40, release: 'exit', targetSpeed: 15.5, coast: false };

/** Same seed, pose, speed and P controller for every mode; only the inputs differ. */
function scripted(bend: Hairpin, script: 'A' | 'B' | 'C', controller = scriptController,
  braking = scriptBraking, stopOnHit = false) {
  const state = createRace(1, { trackId: 'serpentine', karts: 1, itemBoxes: false });
  const kart = state.karts[0]!;
  state.phase = 'racing'; state.countdown = 0;
  const start = sampleTrack(track, bend.from - 60);
  Object.assign(kart, { x: start.x, y: start.y, z: start.z, heading: Math.atan2(start.tx, start.tz),
    trackDistance: start.distance, lateralOffset: 0, speed: 32 });
  const direction = -Math.sign(profile.find(point => point.distance >= bend.at)!.curvature);
  const brakeRelease = { entry: bend.from, quarter: bend.from + (bend.to - bend.from) / 4,
    apex: bend.at, exit: bend.to }[braking.release];
  // Include the exit turbo and count collisions throughout the same interval.
  const finish = bend.to + 80;
  let railTouches = 0, ticks = 0, hits = 0, maxSpeed = 0, speedSum = 0, exitDrift = 0, entrySpeed = Infinity;
  let crossedExit = false, inwardSteers = 0, approachHits = 0;
  for (let tick = 0; tick < 1200 && kart.trackDistance < finish; tick++) {
    const d = kart.trackDistance;
    const drift = script === 'B' && d >= bend.from - 10 && d <= bend.to;
    const slowing = script === 'C' && d >= bend.from - braking.startBefore && d <= brakeRelease && kart.speed > braking.targetSpeed;
    const brake = slowing && !braking.coast;
    const throttle = slowing && braking.coast ? 0 : 1;
    const target = sampleTrack(track, d + controller.lookAhead);
    const slip = kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
    const angle = Math.atan2(target.tx, target.tz) - kart.heading + slip;
    const error = Math.atan2(Math.sin(angle), Math.cos(angle));
    // Outside target, inside turn: the same line is requested for all three scripts.
    let steer = controller.headingGain * error + (-direction * controller.offset - kart.lateralOffset) * controller.lateralGain;
    if (drift && kart.driftDirection === 0) steer = direction * Math.max(0.13, Math.abs(steer));
    else if (drift) steer = (steer - direction * 0.75) / 0.6;
    steer = Math.max(-1, Math.min(1, steer));
    if (drift && d >= bend.from && d <= bend.to && steer * direction > 0) inwardSteers++;
    stepRace(state, [{ steer, throttle, brake, drift, useItem: false }]);
    if (d < bend.from && kart.trackDistance >= bend.from) entrySpeed = kart.speed;
    if (!crossedExit && kart.trackDistance >= bend.to) { crossedExit = true; exitDrift = kart.driftTime; }
    // Wall projection clamps the offset even when a glancing touch emits no hit.
    // Include the approach so a drift cannot benefit from an earlier rail correction.
    const railLimit = widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS;
    if (Math.abs(kart.lateralOffset) >= railLimit - 1e-6) railTouches++;
    const frameHits = state.events.filter(event => event.type === 'hit').length;
    if (d < bend.from - 20) approachHits += frameHits;
    if (d >= bend.from - 20 && d <= finish) {
      ticks++; maxSpeed = Math.max(maxSpeed, kart.speed); speedSum += kart.speed;
      hits += frameHits;
    }
    if (stopOnHit && (hits > 0 || approachHits > 0)) break;
  }
  const completed = crossedExit && kart.trackDistance >= finish;
  return { human: kart.human, boxCount: state.boxes.length, completed, approachHits, railTouches,
    time: ticks / 60, maxSpeed, hits, meanSpeed: speedSum / ticks, exitDrift, entrySpeed, inwardTime: inwardSteers / 60 };
}

function renderCourse() {
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ fillRect() {}, fillText() {} }) }) });
  return buildCourse(track, theme);
}

describe('SERPENT PASS', () => {
  it('replaces the scaffold with a serializable, playable 2100–2400m mountain course', () => {
    expect(track.length).toBeCloseTo(SERPENTINE_LENGTH, 8);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.layoutVersion).toBe(1);
    expect(track.def.checkpointCount).toBe(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(scaffoldIds()).not.toContain('serpentine');
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
    expect(track.def.racingLine[0]).toEqual({ distance: 0, offset: 0 });
    expect(track.def.racingLine.at(-1)).toEqual({ distance: track.length, offset: 0 });
    for (let d = 0; d < track.length; d += 0.5) {
      expect(Math.abs(racingLineOffset(track, d)) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
    }
  });

  it('has two drift switchbacks, a normal hairpin, mountain grades and safe curvature', () => {
    expect(hairpins.length).toBeGreaterThanOrEqual(3);
    expect(driftHairpins).toHaveLength(2);
    expect(Math.abs(driftHairpins[0]!.minRadius - driftHairpins[1]!.minRadius)).toBeGreaterThan(0.5);
    const signs = driftHairpins.map(bend => Math.sign(profile.find(point => point.distance >= bend.at)!.curvature));
    expect(signs[0]).toBe(-signs[1]!);
    expect(hairpins.some(bend => widthAt(track, bend.at).wallHalfWidth === BASE_WALL_HALF_WIDTH)).toBe(true);
    expect(driftHairpins[0]!.from).toBeGreaterThanOrEqual(250);
    expect(driftHairpins[0]!.from).toBeLessThanOrEqual(500);
    expect(elevationRange(track).range).toBeGreaterThanOrEqual(20);
    expect(maxSlope(track)).toBeGreaterThanOrEqual(0.2);
    expect(maxSlope(track)).toBeLessThanOrEqual(0.3);
    for (const point of profile) {
      expect(1 / Math.abs(point.curvature), `radius at ${point.distance}`)
        .toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 2.5);
    }
    for (const bend of driftHairpins) {
      expect(bend.minRadius).toBeGreaterThanOrEqual(10.5);
      expect(bend.minRadius).toBeLessThanOrEqual(12);
      for (let d = bend.from; d <= bend.to; d += 0.5) {
        const width = widthAt(track, d);
        expect(width).toEqual({ roadHalfWidth: 4.68, wallHalfWidth: 5.6 });
        // The critic's grass-braking line is physically inaccessible before rail contact.
        expect(width.wallHalfWidth - KART_RADIUS).toBeLessThan(width.roadHalfWidth);
      }
      for (let d = bend.from - 30; d <= bend.to + 30; d += 0.5) expect(rollAt(track, d)).toBe(0);
      for (const zone of track.def.surfaces) {
        expect(zone.to < bend.from - 40 || zone.from > bend.to + 40).toBe(true);
      }
    }
    // This design has no pits, jumps, gates, islands, barriers or deck crossings.
    expect(track.def.surfaces).toEqual([]);
    expect(track.def.barriers ?? []).toEqual([]);
    expect(track.def.splits ?? []).toEqual([]);
    expect(track.def.decks ?? []).toEqual([]);
  });

  it('keeps the folded route free of undeclared centre-line crossings', () => {
    const { samples } = track;
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
        if (t >= 0 && t < 1 && u >= 0 && u < 1) {
          expect.fail(`undeclared crossing at ${a.distance} / ${c.distance}`);
        }
      }
    }
  });

  it('tapers two 50% narrow roads, keeps item rows outside and banks one other bend', () => {
    const keys = track.def.widthKeys!;
    expect(keys).toHaveLength(8);
    for (const start of [0, 4]) {
      expect(keys.slice(start, start + 4).map(key => key.roadHalfWidth)).toEqual([9.36, 4.68, 4.68, 9.36]);
      expect(keys.slice(start, start + 4).map(key => key.wallHalfWidth)).toEqual([13.65, 5.6, 5.6, 13.65]);
      expect(keys[start + 1]!.distance - keys[start]!.distance).toBeGreaterThanOrEqual(20);
      expect(keys[start + 3]!.distance - keys[start + 2]!.distance).toBeGreaterThanOrEqual(20);
    }
    for (const fraction of track.def.boxRows) {
      const width = widthAt(track, fraction * track.length);
      expect(width.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
      for (const lane of track.def.boxLanes) expect(Math.abs(lane) + KART_RADIUS).toBeLessThan(width.roadHalfWidth);
    }
    const banks = track.def.bankKeys!;
    expect(banks.filter((key, i) => key.roll !== 0 && banks[i - 1]!.roll === 0)).toHaveLength(1);
    expect(Math.max(...banks.map(key => key.roll))).toBe(0.3);
    expect(banks[0]).toEqual({ distance: 0, roll: 0 });
    expect(banks.at(-1)).toEqual({ distance: track.length, roll: 0 });
    for (let i = 1; i < banks.length; i++) {
      const a = banks[i - 1]!, b = banks[i]!;
      expect(Math.abs(b.roll - a.roll) / (b.distance - a.distance)).toBeLessThanOrEqual(0.02);
      if (a.roll !== 0 || b.roll !== 0) {
        for (const bend of hairpins) expect(b.distance < bend.from - 30 || a.distance > bend.to + 30).toBe(true);
      }
    }
  });

  it.each([0, 1])('proves drift advantage through narrow hairpin %i with three deterministic scripts', index => {
    const bend = driftHairpins[index]!;
    const a = scripted(bend, 'A'), b = scripted(bend, 'B'), c = scripted(bend, 'C');
    for (const run of [a, b, c]) {
      expect(run.human).toBe(true);
      expect(run.boxCount).toBe(0);
      expect(run.completed).toBe(true);
      expect(run.approachHits).toBe(0);
    }
    console.info('scripts', index, { a, b, c });
    expect(a.time - b.time).toBeGreaterThanOrEqual(a.hits >= 1 ? 0.5 : 1);
    expect(b.hits).toBe(0);
    expect(b.railTouches).toBe(0);
    expect(b.exitDrift).toBeGreaterThanOrEqual(DRIFT_BLUE_TIME);
    expect(b.meanSpeed).toBeGreaterThanOrEqual(18);
    // Require a sustained inside turn; P corrections may countersteer at the transitions.
    expect(b.inwardTime).toBeGreaterThanOrEqual(1);
    expect(c.hits).toBe(0);
    expect(c.railTouches).toBe(0);
    expect(c.entrySpeed).toBeLessThanOrEqual(16);
    expect(c.time - b.time).toBeGreaterThanOrEqual(0.5);
  });

  it.each([0, 1])('beats the best clean non-drift controller through hairpin %i including the exit turbo', index => {
    const bend = driftHairpins[index]!;
    const clean = (run: ReturnType<typeof scripted>) => run.completed && run.hits === 0 && run.approachHits === 0;
    // Apply the critic's p5.ts braking strategies to every controller.
    // Braking can end before the bend; coasting removes throttle without braking.
    const brakingSettings: Braking[] = [];
    for (const startBefore of [40, 25, 15, 8, 3]) {
      for (const release of ['entry', 'quarter', 'apex', 'exit'] as const) {
        for (const targetSpeed of [12, 14, 15.5, 17, 18.5, 20, 22, 25]) {
          for (const coast of [false, true]) brakingSettings.push({ startBefore, release, targetSpeed, coast });
        }
      }
    }
    expect(brakingSettings).toHaveLength(320);
    let settings = 0, cleanFullThrottle = 0;
    let bestFullThrottle = Infinity, bestBrake = Infinity, bestDrift = Infinity;
    let bestDriftController: Controller | undefined;
    let bestBrakeSettings: { controller: Controller; braking: Braking } | undefined;
    let brakingRuns = 0;
    for (const offset of [-2, -1, 0, 1, 2, 3]) {
      for (const lookAhead of [2, 4, 6, 8, 12, 16]) {
        for (const headingGain of [2, 4, 8]) {
          for (const lateralGain of [0.1, 0.3, 0.6]) {
            const controller = { offset, lookAhead, headingGain, lateralGain };
            settings++;
            const a = scripted(bend, 'A', controller, scriptBraking, true);
            const b = scripted(bend, 'B', controller, scriptBraking, true);
            if (clean(a)) { cleanFullThrottle++; bestFullThrottle = Math.min(bestFullThrottle, a.time); }
            if (clean(b) && b.railTouches === 0 && b.exitDrift >= DRIFT_BLUE_TIME && b.meanSpeed >= 18 && b.time < bestDrift) {
              bestDrift = b.time; bestDriftController = controller;
            }
            for (const braking of brakingSettings) {
              const c = scripted(bend, 'C', controller, braking, true);
              brakingRuns++;
              if (clean(c) && c.time < bestBrake) {
                bestBrake = c.time; bestBrakeSettings = { controller, braking };
              }
            }
          }
        }
      }
    }
    const advantage = Math.min(bestFullThrottle, bestBrake) - bestDrift;
    console.info('sweep', index, { settings, brakingRuns, cleanFullThrottle, bestFullThrottle, bestBrake,
      bestDrift, advantage, bestDriftController, bestBrakeSettings });
    expect(settings).toBe(324);
    expect(brakingRuns).toBe(324 * 5 * 4 * 8 * 2);
    expect(Number.isFinite(bestDrift)).toBe(true);
    expect(Number.isFinite(bestBrake)).toBe(true);
    expect(advantage).toBeGreaterThanOrEqual(0.5);
    expect(cleanFullThrottle / settings).toBeLessThanOrEqual(0.1);
  }, 360_000);

  it('renders orange/red foliage and gray rocks outside every road within the triangle budget', () => {
    const course = renderCourse();
    try {
      let triangles = 0, meshes = 0;
      const props: THREE.InstancedMesh[] = [];
      course.group.traverse(object => {
        expect(object).not.toBeInstanceOf(THREE.Points);
        if (!(object instanceof THREE.Mesh)) return;
        meshes++;
        triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3 *
          (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
        if (object instanceof THREE.InstancedMesh && object.name.startsWith('serpentine:')) props.push(object);
      });
      expect(triangles + 20_000).toBeLessThanOrEqual(60 * track.length + 30_000);
      expect(props.map(mesh => mesh.name).sort()).toEqual([
        'serpentine:fallen-leaves', 'serpentine:foliage', 'serpentine:rocks', 'serpentine:trunks',
      ]);
      for (const mesh of props) {
        expect(mesh.count).toBeGreaterThan(0);
        mesh.geometry.computeBoundingSphere();
        const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
        const rotation = new THREE.Quaternion();
        const colors = new Set<number>();
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix); matrix.decompose(position, rotation, scale);
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
          if (mesh.instanceColor) { const color = new THREE.Color(); mesh.getColorAt(i, color); colors.add(color.getHex()); }
        }
        if (mesh.name === 'serpentine:foliage' || mesh.name === 'serpentine:fallen-leaves') {
          expect([...colors].sort()).toEqual([serpentinePalette.orange, serpentinePalette.red].sort());
        }
        if (mesh.name === 'serpentine:rocks') {
          expect((mesh.material as THREE.MeshLambertMaterial).color.getHex()).toBe(serpentinePalette.rock);
        }
      }
      console.info('render', { meshes, triangles });
      expect(meshes).toBe(28);
    } finally { course.dispose(); }
  });

  it('measures course construction over five disposed builds', () => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const course = renderCourse();
      times.push(performance.now() - start);
      course.dispose();
    }
    const median = times.sort((a, b) => a - b)[2]!;
    console.info('construction median ms', median);
    expect(Number.isFinite(median)).toBe(true);
  });

  it('finishes 72 CPU laps with unchanged AI inside pace and collision budgets', () => {
    const laps: number[] = [];
    let wallHits = 0, bandHits = 0, pitFalls = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'serpentine', racers: [] });
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
        laps.push(...kart.lapTimes);
      }
    }
    expect(laps).toHaveLength(72);
    const meanLap = laps.reduce((sum, time) => sum + time, 0) / laps.length;
    console.info('CPU', { laps: laps.length, meanLap, wallHits, bandHits, pitFalls });
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(8);
    expect(bandHits).toBe(0);
    expect(pitFalls).toBeLessThanOrEqual(6);
  }, 120_000);
});

/**
 * M10-07 measurements (Node 25, macOS; construction median of five builds):
 * Rendering: 28 meshes, 113,260 shadow-weighted triangles; five-build median
 * 204.72 ms under concurrent story load (133,260 including karts < 169,228 cap).
 * CPU: 8 CPUs × seeds [1, 42, 98765] × 3 laps = 72; meanLap 67.9125 s,
 * wallHits 0, bandHits 0, pitFalls 0 (the same classification as handling.test.ts).
 * Script measurements over [from - 20, to + 20], time s / max speed m/s / hits:
 *                 A                       B                       C
 * Lower: 3.400000 / 36.643057 / 1   3.283333 / 50.040358 / 0   5.550000 / 32.131137 / 0
 * Upper: 3.400000 / 36.643057 / 1   3.283333 / 50.040358 / 0   5.616667 / 32.012444 / 0
 * B uses inward steer for 1.05 s, countersteer corrections for 1.216667 s and
 * neutral steer for 0 s within each bend. The test requires >= 1 s inward.
 * B mean speed 32.322708 m/s and exit driftTime 2.55 s on both; C enters at
 * 15.398838 / 15.271667 m/s. C is asserted, not downgraded. B's peak includes
 * its earned exit turbo. Full-throttle A/B settle above the nominal 32 m/s cap
 * because race.ts applies acceleration before its soft speed-cap drag.
 * Scripts use identical initial states and P gains, with an outside target offset
 * of 1 m: heading error × 4 + lateral error × 0.3, looking 4 m ahead. B converts
 * the requested yaw through the existing drift steering formula; no AI is used.
 * ai.ts:45 already brakes for curvature > 0.62 rad / 12 m above 21 m/s, so the
 * CPUs negotiate these bends without changes to ai.ts, race.ts or corridor.ts.
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

/** Isolate each approach at -60 m; all subsequent movement is through stepRace. */
function scripted(bend: Hairpin, script: 'A' | 'B' | 'C') {
  const state = createRace(1, { trackId: 'serpentine', karts: 1, itemBoxes: false });
  const kart = state.karts[0]!;
  state.phase = 'racing'; state.countdown = 0;
  const start = sampleTrack(track, bend.from - 60);
  Object.assign(kart, { x: start.x, y: start.y, z: start.z, heading: Math.atan2(start.tx, start.tz),
    trackDistance: start.distance, lateralOffset: 0, speed: 32 });
  const direction = -Math.sign(profile.find(point => point.distance >= bend.at)!.curvature);
  let ticks = 0, hits = 0, maxSpeed = 0, speedSum = 0, exitDrift = 0, entrySpeed = Infinity;
  let crossedExit = false, inwardSteers = 0, counterSteers = 0, neutralSteers = 0;
  for (let tick = 0; tick < 1200 && kart.trackDistance < bend.to + 20; tick++) {
    const d = kart.trackDistance;
    const drift = script === 'B' && d >= bend.from - 10 && d <= bend.to;
    const brake = script === 'C' && d >= bend.from - 40 && d <= bend.to && kart.speed > 15.5;
    const target = sampleTrack(track, d + 4);
    const slip = kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
    const angle = Math.atan2(target.tx, target.tz) - kart.heading + slip;
    const error = Math.atan2(Math.sin(angle), Math.cos(angle));
    // Outside target, inside turn: the same line is requested for all three scripts.
    let steer = 4 * error + (-direction - kart.lateralOffset) * 0.3;
    if (drift && kart.driftDirection === 0) steer = direction * Math.max(0.13, Math.abs(steer));
    else if (drift) steer = (steer - direction * 0.75) / 0.6;
    steer = Math.max(-1, Math.min(1, steer));
    if (drift && d >= bend.from && d <= bend.to) {
      if (steer * direction > 0) inwardSteers++;
      else if (steer * direction < 0) counterSteers++;
      else neutralSteers++;
    }
    stepRace(state, [{ steer, throttle: 1, brake, drift, useItem: false }]);
    if (d < bend.from && kart.trackDistance >= bend.from) entrySpeed = kart.speed;
    if (!crossedExit && kart.trackDistance >= bend.to) { crossedExit = true; exitDrift = kart.driftTime; }
    if (d >= bend.from - 20 && d <= bend.to + 20) {
      ticks++; maxSpeed = Math.max(maxSpeed, kart.speed); speedSum += kart.speed;
      hits += state.events.filter(event => event.type === 'hit').length;
    }
  }
  expect(kart.human).toBe(true);
  expect(state.boxes).toHaveLength(0);
  expect(kart.trackDistance).toBeGreaterThanOrEqual(bend.to + 20);
  expect(crossedExit).toBe(true);
  return { time: ticks / 60, maxSpeed, hits, meanSpeed: speedSum / ticks, exitDrift, entrySpeed, inwardTime: inwardSteers / 60, counterTime: counterSteers / 60, neutralTime: neutralSteers / 60 };
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
        expect(widthAt(track, d)).toEqual({ roadHalfWidth: 4.68, wallHalfWidth: 6.825 });
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
      expect(keys.slice(start, start + 4).map(key => key.wallHalfWidth)).toEqual([13.65, 6.825, 6.825, 13.65]);
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
    expect(a.hits >= 1 || a.time - b.time >= 1).toBe(true);
    expect(b.hits).toBe(0);
    expect(b.exitDrift).toBeGreaterThanOrEqual(DRIFT_BLUE_TIME);
    expect(b.meanSpeed).toBeGreaterThanOrEqual(18);
    // Require a sustained inside turn; P corrections may countersteer at the transitions.
    expect(b.inwardTime).toBeGreaterThanOrEqual(1);
    expect(c.hits).toBe(0);
    expect(c.entrySpeed).toBeLessThanOrEqual(16);
    expect(c.time - b.time).toBeGreaterThanOrEqual(0.5);
  });

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
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(8);
    expect(bandHits).toBe(0);
    expect(pitFalls).toBeLessThanOrEqual(6);
  }, 120_000);
});

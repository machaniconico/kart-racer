/**
 * M10-08: LUNAR BASIN geometry, rendering and 72-lap CPU acceptance.
 * darwin-arm64 / Node 25.8.1: 45 meshes, 76,852 triangles including shadows;
 * buildCourse median 770.07 ms over five independent, disposed builds (parallel story load).
 * 8 CPUs × seeds [1, 42, 98765] × 3 laps = 72: meanLap 65.17916666666667 s,
 * wallHits 0, bandHits 0, pitFalls 0. No simulation or shared baseline changes.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCourse } from '../../render/course/buildCourse';
import { lunar as theme, lunarPalette } from '../../render/course/themes/lunar';
import { getAIInput } from '../ai';
import { KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, NEUTRAL_INPUT, stepRace } from '../race';
import { JUMP_DURATION, racingLineOffset } from '../surfaces';
import { buildTrack, rollAt, sampleTrack, slopeAt, wrapDistance } from '../track';
import { getTrack, scaffoldIds } from './index';
import { LUNAR_LENGTH } from './lunar';
import { curvatureProfile, findHairpins, maxSlope } from './shapeMetrics';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const track = getTrack('lunar');
const pits = track.def.surfaces.filter(zone => zone.kind === 'pit');
const jumps = track.def.surfaces.filter(zone => zone.kind === 'jump');
const profile = curvatureProfile(track);
afterEach(() => vi.unstubAllGlobals());

/** Count intersections independently of the declared deck interval. */
function crossings() {
  const result: { upper: number; lower: number; gap: number }[] = [];
  const { samples, length } = track;
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
      if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
      const ad = a.distance + t * ((b.distance || length) - a.distance);
      const cd = c.distance + u * ((d.distance || length) - c.distance);
      const ay = a.y + t * (b.y - a.y), cy = c.y + u * (d.y - c.y);
      result.push({ upper: ay > cy ? ad : cd, lower: ay > cy ? cd : ad, gap: Math.abs(ay - cy) });
    }
  }
  return result;
}

function renderCourse() {
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ fillRect() {}, fillText() {} }) }) });
  return buildCourse(track, theme);
}

/** Horizontal clearance of the entire prop, independently checked against every branch. */
function sceneryClearance(position: THREE.Vector3, radius: number): number {
  let clearance = Infinity;
  for (const [i, a] of track.samples.entries()) {
    const b = track.samples[(i + 1) % track.samples.length]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.z - a.z) * dz) / (dx * dx + dz * dz)));
    const d = a.distance + t * ((b.distance || track.length) - a.distance);
    clearance = Math.min(clearance, Math.hypot(position.x - a.x - t * dx, position.z - a.z - t * dz)
      - widthAt(track, d).wallHalfWidth - radius);
  }
  return clearance;
}

describe('LUNAR BASIN', () => {
  it('replaces the scaffold with a playable and JSON-stable 2100–2400m course', () => {
    expect(track.length).toBeCloseTo(LUNAR_LENGTH, 8);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.layoutVersion).toBe(1);
    expect(track.def.themeId).toBe('lunar');
    expect(track.def.checkpointCount).toBe(24);
    expect(track.checkpointDistances).toHaveLength(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.boxPoses).toHaveLength(24);
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(scaffoldIds()).not.toContain('lunar');
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
    expect(track.def.splits ?? []).toEqual([]);
    expect(track.def.barriers ?? []).toEqual([]);
    expect(track.def.surfaces.map(zone => zone.kind).sort())
      .toEqual(['boost', 'dirt', 'jump', 'jump', 'jump', 'pit', 'pit', 'pit']);
    expect(track.def.racingLine[0]).toEqual({ distance: 0, offset: 0 });
    expect(track.def.racingLine.at(-1)).toEqual({ distance: track.length, offset: 0 });
    for (let d = 0; d < track.length; d += 0.5) {
      expect(Math.abs(racingLineOffset(track, d)) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
    }
  });

  it('has two basin-rim hairpins with safe curvature and slopes', () => {
    expect(findHairpins(track).length).toBeGreaterThanOrEqual(2);
    expect(maxSlope(track)).toBeLessThanOrEqual(0.30);
    for (const point of profile) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 2.5);
    }
  });

  it('crosses once inside a level habitat deck with 13m separation and safe approaches', () => {
    expect(track.def.decks).toHaveLength(1);
    const intersections = crossings();
    expect(intersections).toHaveLength(1);
    const crossing = intersections[0]!, deck = track.def.decks![0]!;
    expect(crossing.gap).toBeGreaterThanOrEqual(13);
    expect(crossing.upper - deck.from).toBeGreaterThanOrEqual(19);
    expect(deck.to - crossing.upper).toBeGreaterThanOrEqual(19);
    for (const d of [crossing.upper, crossing.lower]) {
      for (let delta = -20; delta <= 20; delta += 0.5) {
        expect(Math.abs(slopeAt(track, d + delta))).toBeLessThanOrEqual(0.1);
        expect(Math.abs(rollAt(track, d + delta))).toBeLessThanOrEqual(0.1);
      }
      for (const gate of track.checkpointDistances) {
        const gap = wrapDistance(track, gate - d);
        expect(Math.min(gap, track.length - gap)).toBeGreaterThan(25);
      }
    }
  });

  it('provides three crater-rim jumps with a continuous, unlaunched bypass beside each pit', () => {
    expect(pits).toHaveLength(3);
    expect(jumps).toHaveLength(3);
    for (const [i, pit] of pits.entries()) {
      const jump = jumps[i]!;
      expect(pit.from - jump.from).toBeGreaterThanOrEqual(4);
      expect(pit.from - jump.from).toBeLessThanOrEqual(12);
      expect(pit.from - jump.to).toBeGreaterThanOrEqual(4);
      expect(pit.from - jump.to).toBeLessThanOrEqual(12);
      expect(jump.offsetMin).toBe(pit.offsetMin);
      expect(jump.offsetMax).toBe(pit.offsetMax);
      expect((pit.to - jump.from) / JUMP_DURATION).toBeGreaterThanOrEqual(15);
      expect((pit.to - jump.from) / JUMP_DURATION).toBeLessThanOrEqual(26);
      for (let d = jump.from - 40; d <= pit.to + 40; d += 0.5) {
        const offset = racingLineOffset(track, d);
        expect(Math.abs(offset) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
        const clearance = Math.max(pit.offsetMin! - offset, offset - pit.offsetMax!);
        expect(clearance).toBeGreaterThan(KART_RADIUS + 0.3);
      }
      const landing = [jump.to, jump.to + 40, ...track.samples.map(p => p.distance)
        .filter(d => d > jump.to && d < jump.to + 40)];
      for (const d of landing) expect(slopeAt(track, d)).toBeGreaterThanOrEqual(slopeAt(track, jump.to) - 0.05);
      for (const point of profile.filter(p => p.distance >= jump.from - 15 && p.distance <= jump.to + 40)) {
        expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(40);
      }
    }
  });

  it('lets a kart jump every crater or drive its paved bypass without falling', () => {
    for (const [i, pit] of pits.entries()) for (const takeJump of [false, true]) {
      const jump = jumps[i]!, distance = jump.from - 6;
      const offset = takeJump ? (pit.offsetMin! + pit.offsetMax!) / 2 : 0;
      const point = sampleTrack(track, distance);
      const state = createRace(42, { trackId: 'lunar', karts: 1, racers: [], itemBoxes: false });
      state.phase = 'racing';
      const kart = state.karts[0]!;
      Object.assign(kart, { x: point.x + point.nx * offset, y: point.y,
        z: point.z + point.nz * offset, heading: Math.atan2(point.tx, point.tz),
        trackDistance: distance, lateralOffset: offset, speed: 25 });
      let airborne = false;
      for (let tick = 0; tick < 100 && kart.trackDistance < pit.to + 12; tick++) {
        stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
        airborne ||= kart.airTime > 0;
        expect(state.events.some(event => event.type === 'hit')).toBe(false);
      }
      expect(kart.trackDistance).toBeGreaterThanOrEqual(pit.to + 12);
      expect(airborne).toBe(takeJump);
    }
  });

  it('renders grey regolith, an Earth in a black sky, and a habitat tube within budget', () => {
    const times: number[] = [];
    let meshes = 0, triangles = 0;
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      const course = renderCourse();
      times.push(performance.now() - started);
      try {
        meshes = 0; triangles = 0;
        course.group.traverse(object => {
          expect(object).not.toBeInstanceOf(THREE.Points);
          if (!(object instanceof THREE.Mesh)) return;
          meshes++;
          triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3
            * (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
        });
        expect(triangles + 20_000).toBeLessThanOrEqual(60 * track.length + 30_000);
        if (run !== 0) continue;
        expect(theme.colors.sky).toBe(0);
        expect(theme.colors.skyTop).toBe(0);
        expect(theme.colors.skyBottom).toBe(0);
        expect(theme.colors.ground).toBe(lunarPalette.regolith);
        expect(theme.colors.surfaces.dirt).toBe(0x89878d);
        expect(theme.fog.near).toBeGreaterThan(1000);
        expect(theme.fog.far).toBeGreaterThan(4000);
        const earth = course.group.getObjectByName('lunar:earth') as THREE.Mesh;
        expect(earth).toBeInstanceOf(THREE.Mesh);
        expect(earth.parent).toBe(course.sky);
        expect(earth.geometry.getAttribute('color').count).toBeGreaterThan(100);
        // The chase camera looks down: Earth's lower edge must enter the visible horizon.
        earth.geometry.computeBoundingSphere();
        const angularRadius = Math.asin(earth.geometry.boundingSphere!.radius / earth.position.length());
        const elevation = Math.atan2(earth.position.y, Math.hypot(earth.position.x, earth.position.z));
        expect(elevation - angularRadius).toBeLessThan(11 * Math.PI / 180);
        const tube = course.group.getObjectByName('lunar:habitat-tube')!;
        expect(tube).toBeInstanceOf(THREE.Group);
        expect(tube.getObjectByName('lunar:habitat-glass')).toBeInstanceOf(THREE.Mesh);
        expect(tube.children.filter(child => child.name === 'lunar:habitat-rib')).toHaveLength(6);
        const deck = track.def.decks![0]!, p = sampleTrack(track, (deck.from + deck.to) / 2);
        expect(tube.position.x).toBeCloseTo(p.x);
        expect(tube.position.y).toBeGreaterThan(p.y);
        expect(tube.position.z).toBeCloseTo(p.z);
        const props: THREE.InstancedMesh[] = [];
        course.group.traverse(object => {
          if (object instanceof THREE.InstancedMesh && object.name.startsWith('lunar:')) props.push(object);
        });
        expect(props.map(mesh => mesh.name).sort()).toEqual(['lunar:beacons', 'lunar:crater-rims', 'lunar:rocks']);
        for (const mesh of props) {
          expect(mesh.count).toBeGreaterThan(0);
          mesh.geometry.computeBoundingSphere();
          const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
          const rotation = new THREE.Quaternion();
          for (let i = 0; i < mesh.count; i++) {
            mesh.getMatrixAt(i, matrix);
            matrix.decompose(position, rotation, scale);
            const radius = mesh.geometry.boundingSphere!.radius * Math.max(scale.x, scale.y, scale.z);
            expect(sceneryClearance(position, radius), `${mesh.name}:${i}`).toBeGreaterThan(0);
          }
        }
        course.group.updateMatrixWorld(true);
        const road = course.group.getObjectByName('road')!, pitMesh = course.group.getObjectByName('surface:pit')!;
        for (const pit of pits) {
          const p = sampleTrack(track, (pit.from + pit.to) / 2), offset = (pit.offsetMin! + pit.offsetMax!) / 2;
          const ray = new THREE.Raycaster(new THREE.Vector3(p.x + p.nx * offset, p.y + 10, p.z + p.nz * offset),
            new THREE.Vector3(0, -1, 0));
          expect(ray.intersectObjects([road, pitMesh])[0]!.object).toBe(pitMesh);
          ray.ray.origin.set(p.x, p.y + 10, p.z);
          expect(ray.intersectObjects([road, pitMesh])[0]!.object).toBe(road);
        }
      } finally { course.dispose(); }
    }
    console.info('LUNAR render', { meshes, triangles, medianBuildMs: times.sort((a, b) => a - b)[2] });
  });

  it('finishes 72 CPU laps within pace, wall, barrier and pit budgets', () => {
    const lapTimes: number[] = [];
    let wallHits = 0, bandHits = 0, pitFalls = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'lunar', racers: [] });
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
        lapTimes.push(...kart.lapTimes);
      }
    }
    expect(lapTimes).toHaveLength(72);
    const meanLap = lapTimes.reduce((sum, time) => sum + time, 0) / lapTimes.length;
    console.info('LUNAR CPU', { meanLap, wallHits, bandHits, pitFalls });
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(6);
    expect(bandHits).toBe(0);
    expect(pitFalls).toBeLessThanOrEqual(6);
  }, 120_000);
});

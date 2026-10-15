// M10-05 / darwin-arm64: 36 meshes, 82,631 triangles including shadow draws.
// buildCourse: five-build median 458.91 ms (parallel story load, 2026-10-16).
// 8 CPUs × seeds [1, 42, 98765] × 3 laps = 72 completed laps:
// meanLap 62.02824074074072 s; wallHits 0, bandHits 0, pitFalls 0.
// Same event classification / 60 × 420 tick limit as handling.test.ts; no sim changes.
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCourse } from '../../render/course/buildCourse';
import { cavern as theme, cavernPalette } from '../../render/course/themes/cavern';
import { meadow as meadowTheme } from '../../render/course/themes/meadow';
import { getAIInput } from '../ai';
import { barrierHalfWidthAt, exclusionAt, KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, stepRace } from '../race';
import { racingLineOffset } from '../surfaces';
import { buildTrack, rollAt, slopeAt, wrapDistance } from '../track';
import { CAVERN_LENGTH } from './cavern';
import { getTrack, scaffoldIds } from './index';
import { curvatureProfile, findCompoundCorners, maxSlope } from './shapeMetrics';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH, WIDTH_SCALE } from './widths';

const track = getTrack('cavern');
const profile = curvatureProfile(track);
afterEach(() => vi.unstubAllGlobals());

/** Find every crossing without trusting the deck declaration. */
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

describe('CRYSTAL HOLLOW', () => {
  it('replaces the scaffold with a serializable, playable 2100–2400m course', () => {
    expect(track.length).toBeCloseTo(CAVERN_LENGTH, 8);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.layoutVersion).toBe(1);
    expect(track.def.themeId).toBe('cavern');
    expect(track.def.checkpointCount).toBe(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.boxPoses).toHaveLength(24);
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(scaffoldIds()).not.toContain('cavern');
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
    expect(track.def.racingLine[0]).toEqual({ distance: 0, offset: 0 });
    expect(track.def.racingLine.at(-1)).toEqual({ distance: track.length, offset: 0 });
    for (let d = 0; d < track.length; d += 0.5) {
      expect(Math.abs(racingLineOffset(track, d)) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
    }
  });

  it('winds through irregular chambers without folding the road or exceeding grades', () => {
    expect(maxSlope(track)).toBeLessThanOrEqual(0.30);
    expect(findCompoundCorners(track).length).toBeGreaterThanOrEqual(2);
    expect(profile.some(point => point.curvature > 1 / 100)).toBe(true);
    expect(profile.some(point => point.curvature < -1 / 100)).toBe(true);
    for (const point of profile) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 2.5);
    }
  });

  it('has two crystal ice floors and two distinct 55% passages with safe item rows', () => {
    expect(track.def.surfaces.map(zone => zone.kind)).toEqual(['ice', 'ice']);
    expect(track.def.splits ?? []).toEqual([]);
    for (const ice of track.def.surfaces) {
      expect(ice.from).toBeGreaterThan(0);
      expect(ice.to).toBeGreaterThan(ice.from);
      expect(ice.to).toBeLessThan(track.length);
    }
    const keys = track.def.widthKeys!;
    expect(keys).toHaveLength(8);
    for (let i = 0; i < keys.length; i += 4) {
      const section = keys.slice(i, i + 4);
      expect(section.map(key => key.roadHalfWidth)).toEqual([
        BASE_ROAD_HALF_WIDTH, BASE_ROAD_HALF_WIDTH * 0.55, BASE_ROAD_HALF_WIDTH * 0.55, BASE_ROAD_HALF_WIDTH,
      ]);
      expect(section.map(key => key.wallHalfWidth)).toEqual([
        BASE_WALL_HALF_WIDTH, BASE_WALL_HALF_WIDTH * 0.55, BASE_WALL_HALF_WIDTH * 0.55, BASE_WALL_HALF_WIDTH,
      ]);
      expect(section[1]!.distance - section[0]!.distance).toBeGreaterThanOrEqual(20);
      expect(section[3]!.distance - section[2]!.distance).toBeGreaterThanOrEqual(20);
      expect(section[2]!.distance - section[1]!.distance).toBeGreaterThan(0);
      expect(2 * section[1]!.roadHalfWidth - 2 * KART_RADIUS).toBeGreaterThanOrEqual(2.55);
    }
    for (const row of track.def.boxRows) for (const lane of track.def.boxLanes) {
      expect(Math.abs(lane) + KART_RADIUS).toBeLessThan(widthAt(track, row * track.length).roadHalfWidth);
    }
  });

  it('keeps a clear racing line past two moving stalactite pillar gates at every phase', () => {
    expect(track.def.barriers).toHaveLength(2);
    for (const gate of track.def.barriers!) {
      expect(gate.scenery).toBe('pillar');
      expect(gate.motion!.kind).toBe('gate');
      expect(gate.motion!.minWidth).toBeGreaterThanOrEqual(0.6 * WIDTH_SCALE);
      expect(gate.motion!.minWidth).toBeLessThan(gate.halfWidth);
      expect(barrierHalfWidthAt(gate, -gate.motion!.phase * gate.motion!.period / (2 * Math.PI))).toBeCloseTo(gate.halfWidth);
      for (let phase = 0; phase <= 32; phase++) {
        const time = phase / 32 * gate.motion!.period;
        for (let d = gate.from - KART_RADIUS; d <= gate.to + KART_RADIUS; d += 0.5) {
          const exclusion = exclusionAt(track, gate, d, time);
          if (!exclusion) continue;
          const offset = racingLineOffset(track, d);
          expect(Math.max(exclusion.min - offset, offset - exclusion.max)).toBeGreaterThan(0.3);
        }
      }
      for (const checkpoint of track.checkpointDistances) for (const tip of [gate.from, gate.to]) {
        const gap = wrapDistance(track, checkpoint - tip);
        expect(Math.min(gap, track.length - gap)).toBeGreaterThan(10);
      }
    }
  });

  it('crosses once on a level bridge with clearance at both ends and approaches', () => {
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
      for (const checkpoint of track.checkpointDistances) {
        const gap = wrapDistance(track, checkpoint - d);
        expect(Math.min(gap, track.length - gap)).toBeGreaterThan(25);
      }
    }
  });

  it('renders a dark cave, two crystal colors and off-road scenery within budget', () => {
    const durations: number[] = [];
    let meshes = 0, triangles = 0;
    for (let run = 0; run < 5; run++) {
      const start = performance.now(), course = renderCourse();
      durations.push(performance.now() - start);
      try {
        meshes = 0; triangles = 0;
        course.group.traverse(object => {
          expect(object).not.toBeInstanceOf(THREE.Points);
          if (!(object instanceof THREE.Mesh)) return;
          meshes++;
          triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3 *
            (object instanceof THREE.InstancedMesh ? object.count : 1) * (object.castShadow ? 2 : 1);
        });
        expect(triangles + 20_000).toBeLessThanOrEqual(60 * track.length + 30_000);
        if (run !== 4) continue;
        expect(theme).not.toBe(meadowTheme);
        expect(theme.colors.ground).toBe(cavernPalette.rock);
        expect(theme.colors.sky).toBe(cavernPalette.sky);
        expect(theme.fog.near).toBe(45);
        expect(theme.fog.far).toBe(200);
        expect(course.group.getObjectByName('cavern:ceiling')).toBeInstanceOf(THREE.Mesh);
        expect(course.group.getObjectByName('surface:ice')).toBeInstanceOf(THREE.Mesh);
        const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
        const rotation = new THREE.Quaternion();
        for (const name of ['cavern:cyan-crystals', 'cavern:magenta-crystals', 'cavern:stalactites', 'rocks', 'flowers']) {
          const mesh = course.group.getObjectByName(name) as THREE.InstancedMesh;
          expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
          expect(mesh.count).toBeGreaterThan(0);
          mesh.geometry.computeBoundingSphere();
          for (let i = 0; i < mesh.count; i++) {
            mesh.getMatrixAt(i, matrix);
            matrix.decompose(position, rotation, scale);
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
            expect(clearance, `${name}:${i}`).toBeGreaterThan(0);
          }
        }
        for (const [name, color] of [['cavern:cyan-crystals', cavernPalette.cyan], ['cavern:magenta-crystals', cavernPalette.magenta]] as const) {
          const mesh = course.group.getObjectByName(name) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
          expect(mesh.material.emissive.getHex()).toBe(color);
          expect(mesh.material.emissiveIntensity).toBeGreaterThan(0);
        }
        course.update(0);
        const gate = course.group.getObjectByName('motion:barrier:0')!;
        const expanded = gate.scale.x;
        course.update(track.def.barriers![0]!.motion!.period / 2);
        expect(gate.scale.x).toBeLessThan(expanded);
      } finally { course.dispose(); }
    }
    console.info('CRYSTAL HOLLOW render', { meshes, triangles, medianMs: durations.sort((a, b) => a - b)[2] });
  });

  it('finishes 72 CPU laps within pace and collision budgets', () => {
    const lapTimes: number[] = [];
    let wallHits = 0, bandHits = 0, pitFalls = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'cavern', racers: [] });
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
    console.info('CRYSTAL HOLLOW CPU', { meanLap, wallHits, bandHits, pitFalls });
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(6);
    expect(bandHits).toBeLessThanOrEqual(2);
    expect(pitFalls).toBeLessThanOrEqual(6);
  }, 120_000);
});

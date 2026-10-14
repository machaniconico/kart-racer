import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { snowpeak as theme } from '../../render/course/themes/snowpeak';
import { terrainHeight } from '../../render/course/buildCourse';
import { getAIInput } from '../ai';
import { corridorAt, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { DEFAULT_LAPS, getRank } from '../laps';
import { createRace, KART_RADIUS, stepRace } from '../race';
import { racingLineOffset, surfaceAt } from '../surfaces';
import { projectToTrack, rollAt, sampleTrack, slopeAt } from '../track';
import { getTrack } from './index';
import { curvatureProfile, elevationRange, findCompoundCorners, findHairpins, findSCurves, maxSlope, minCurvatureRadius } from './shapeMetrics';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const track = getTrack('snowpeak');
const ice = track.def.surfaces.filter(zone => zone.kind === 'ice');
const profile = curvatureProfile(track);

// M5-03, darwin-arm64: sampled XZ length, independent of the elevation profile.
const SNOWPEAK_LENGTH = 2262.305617320616;

describe('FROSTBITE PEAK', () => {
  it('pins layout 4 at 2100–2400 m with 24 checkpoints and eight item rows', () => {
    expect(track.def.layoutVersion).toBe(4);
    expect(track.length).toBeCloseTo(SNOWPEAK_LENGTH, 8);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.name).toBe('FROSTBITE PEAK');
    expect(track.def.themeId).toBe('snowpeak');
    expect(track.def.checkpointCount).toBe(24);
    expect(track.checkpointDistances).toHaveLength(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.boxPoses).toHaveLength(24);
    expect(new Set(track.def.boxRows).size).toBe(8);
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    const sampleHash = (samples: typeof track.samples) =>
      createHash('sha256').update(JSON.stringify(samples)).digest('hex');
    expect(sampleHash(track.samples)).not.toBe(sampleHash(getTrack('meadow').samples));
    expect(track.def.splits ?? []).toEqual([]);
    expect(track.def.decks ?? []).toEqual([]);
    expect(track.def.barriers ?? []).toEqual([]);
    expect(track.def.surfaces.some(zone => zone.kind === 'pit' || zone.kind === 'spin')).toBe(false);
  });

  it('measures the alpine climb, summit hairpin, S bends and compound corners', () => {
    const elevation = elevationRange(track);
    expect(elevation.range).toBeGreaterThanOrEqual(15);
    expect(maxSlope(track)).toBeGreaterThanOrEqual(0.22);
    expect(maxSlope(track)).toBeLessThanOrEqual(0.30);
    const hairpins = findHairpins(track);
    expect(hairpins.length).toBeGreaterThanOrEqual(1);
    expect(hairpins.some(hairpin => sampleTrack(track, hairpin.at).y >= elevation.max - 1)).toBe(true);
    const curves = findSCurves(track);
    expect(curves.length).toBeGreaterThanOrEqual(1);
    expect(curves.some(curve => ice.some(zone => zone.from < curve.to && zone.to > curve.from))).toBe(true);
    expect(findCompoundCorners(track).length).toBeGreaterThanOrEqual(1);
    const tightest = profile.reduce((a, b) => Math.abs(a.curvature) > Math.abs(b.curvature) ? a : b);
    expect(minCurvatureRadius(track)).toBeGreaterThanOrEqual(widthAt(track, tightest.distance).wallHalfWidth + 2.5 + 0.8);
    // A local-width check also protects every wider section, not just the tightest sample.
    for (const point of profile) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 2.5 + 0.8);
    }
  });

  it('keeps the entire starting grid on grades no steeper than 5%', () => {
    const state = createRace(1, { trackId: 'snowpeak', racers: [] });
    const distances = state.karts.map(kart => kart.trackDistance);
    const gridSamples = track.samples.filter(sample => sample.distance >= Math.min(...distances) &&
      sample.distance <= Math.max(...distances));
    for (const distance of [...distances, ...gridSamples.map(sample => sample.distance)]) {
      expect(Math.abs(slopeAt(track, distance))).toBeLessThanOrEqual(0.05);
    }
  });

  it('banks two broad corners by 0.25–0.35 radians with gentle transitions and a level seam', () => {
    const keys = track.def.bankKeys!;
    expect(keys[0]).toEqual({ distance: 0, roll: 0 });
    expect(keys.at(-1)).toEqual({ distance: track.length, roll: 0 });
    expect(rollAt(track, 0)).toBe(0);
    expect(rollAt(track, track.length - 0.01)).toBe(0);
    let bankedCorners = 0;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1]!;
      const b = keys[i]!;
      expect(b.distance).toBeGreaterThan(a.distance);
      if (a.roll === 0 && b.roll !== 0) bankedCorners++;
      if (b.roll !== 0) {
        expect(Math.abs(b.roll)).toBeGreaterThanOrEqual(0.25);
        expect(Math.abs(b.roll)).toBeLessThanOrEqual(0.35);
      }
      expect(Math.abs(b.roll - a.roll) / (b.distance - a.distance)).toBeLessThanOrEqual(0.02);
    }
    expect(bankedCorners).toBe(2);
    for (const point of profile.filter(point => rollAt(track, point.distance) !== 0)) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(33);
    }
  });

  it('keeps three separate full-width ice sections covering 20–30% of the course', () => {
    expect(ice.length).toBeGreaterThanOrEqual(3);
    let previousEnd = 0;
    for (const zone of ice) {
      expect(zone.from).toBeGreaterThan(previousEnd);
      expect(zone.to).toBeGreaterThan(zone.from);
      expect(zone.to).toBeLessThan(track.length);
      expect(zone.offsetMin).toBeUndefined();
      expect(zone.offsetMax).toBeUndefined();
      for (const offset of [-track.def.roadHalfWidth, 0, track.def.roadHalfWidth]) {
        expect(surfaceAt(track, (zone.from + zone.to) / 2, offset)).toBe('ice');
      }
      expect(surfaceAt(track, zone.from - 0.01, 0)).toBe('road');
      expect(surfaceAt(track, zone.to + 0.01, 0)).toBe('road');
      previousEnd = zone.to;
    }
    const coverage = ice.reduce((sum, zone) => sum + zone.to - zone.from, 0) / track.length;
    expect(coverage).toBeGreaterThanOrEqual(0.2);
    expect(coverage).toBeLessThanOrEqual(0.3);
    // Include sample triangles on both sides of each surface boundary.
    const icy = profile.filter((_, i) => ice.some(zone =>
      track.samples[(i + profile.length - 1) % profile.length]!.distance <= zone.to &&
      track.samples[(i + 1) % profile.length]!.distance >= zone.from));
    expect(icy.length).toBeGreaterThan(0);
    expect(Math.min(...icy.map(point => 1 / Math.abs(point.curvature)))).toBeGreaterThanOrEqual(25);
  });

  it('has one narrow ridge, one uphill-to-level crest jump on the main route, and dirt', () => {
    const keys = track.def.widthKeys!;
    const summit = elevationRange(track).max;
    expect(keys).toHaveLength(4);
    expect(keys.map(key => key.roadHalfWidth)).toEqual([
      BASE_ROAD_HALF_WIDTH, BASE_ROAD_HALF_WIDTH * 0.55, BASE_ROAD_HALF_WIDTH * 0.55, BASE_ROAD_HALF_WIDTH,
    ]);
    expect(keys.map(key => key.wallHalfWidth)).toEqual([
      BASE_WALL_HALF_WIDTH, BASE_WALL_HALF_WIDTH * 0.55, BASE_WALL_HALF_WIDTH * 0.55, BASE_WALL_HALF_WIDTH,
    ]);
    for (let d = keys[0]!.distance; d <= keys.at(-1)!.distance; d += 0.5) {
      expect(sampleTrack(track, d).y).toBeGreaterThanOrEqual(summit - 1);
      const passages = corridorAt(track, d, 0);
      expect(passages).toHaveLength(1);
      expect(passages[0]!.max - passages[0]!.min).toBeGreaterThanOrEqual(2.55);
    }
    const jumps = track.def.surfaces.filter(zone => zone.kind === 'jump');
    expect(jumps).toHaveLength(1);
    const jump = jumps[0]!;
    expect(jump.offsetMin).toBeUndefined();
    expect(jump.offsetMax).toBeUndefined();
    expect(slopeAt(track, jump.from - 40)).toBeGreaterThan(0.01);
    expect(Math.abs(slopeAt(track, jump.to))).toBeLessThan(0.02);
    for (let d = jump.to; d <= jump.to + 40; d += 0.5) {
      expect(slopeAt(track, d)).toBeGreaterThanOrEqual(slopeAt(track, jump.to) - 0.05);
    }
    expect(track.def.surfaces.filter(zone => zone.kind === 'dirt').length).toBeGreaterThanOrEqual(1);
  });

  it('covers the entire lap with a safe line and takes the summit hairpin outside-inside-outside', () => {
    const line = track.def.racingLine;
    expect(line[0]).toEqual({ distance: 0, offset: 0 });
    expect(line.at(-1)).toEqual({ distance: track.length, offset: 0 });
    for (let i = 1; i < line.length; i++) expect(line[i]!.distance).toBeGreaterThan(line[i - 1]!.distance);
    for (const hairpin of findHairpins(track)) {
      const sign = Math.sign(profile.find(point => point.distance === hairpin.at)!.curvature);
      expect(sign * racingLineOffset(track, hairpin.from)).toBeGreaterThan(0);
      expect(sign * racingLineOffset(track, (hairpin.from + hairpin.to) / 2)).toBeLessThan(0);
      expect(sign * racingLineOffset(track, hairpin.to)).toBeGreaterThan(0);
    }
  });

  it('keeps terrain outside the ridge and descent walls below the road', () => {
    for (let d = 675; d <= 1300; d += 2) {
      const point = sampleTrack(track, d);
      for (const side of [-1, 1]) for (const clearance of [0.5, 5, 12, 22]) {
        const offset = side * (widthAt(track, d).wallHalfWidth + clearance);
        const projection = projectToTrack(track, point.x + point.nx * offset, point.z + point.nz * offset);
        expect(terrainHeight(track, projection)).toBeLessThanOrEqual(point.y);
      }
    }
  });

  it('scatters trees and rocks across the expanded course with clearance from local walls', () => {
    const group = new THREE.Group();
    theme.buildProps(track, group, theme.budget);
    const matrix = new THREE.Matrix4();
    try {
      for (const name of ['snowpeak:trunks', 'snowpeak:rocks']) {
        const mesh = group.getObjectByName(name) as THREE.InstancedMesh;
        expect(mesh.count).toBe(name.endsWith('trunks') ? theme.budget.trees : theme.budget.rocks);
        const distances = [];
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          const p = projectToTrack(track, matrix.elements[12]!, matrix.elements[14]!);
          expect(Math.abs(p.offset)).toBeGreaterThan(widthAt(track, p.distance).wallHalfWidth + 7.99);
          distances.push(p.distance);
        }
        expect(Math.max(...distances) - Math.min(...distances)).toBeGreaterThan(track.length * 0.8);
      }
    } finally {
      group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
      });
    }
  });

  // Measured on darwin-arm64: 72 laps, meanLap 67.89120370370368 s, wallHits 0, bandHits 0.
  it('finishes 8 CPUs × 3 seeds × 3 laps within 420 seconds and the pace/collision budgets', () => {
    const lapTimes: number[] = [];
    let wallHits = 0;
    let bandHits = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'snowpeak', racers: [] });
      const visited = state.karts.map(() => ice.map(() => new Set<number>()));
      const flights = state.karts.map(() => new Set<number>());
      const jump = track.def.surfaces.find(zone => zone.kind === 'jump')!;
      for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
        stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
        for (const event of state.events) {
          if (event.type !== 'hit') continue;
          if (event.value === 1) { bandHits++; continue; }
          if (event.value === 2) continue;
          const kart = state.karts[event.kartId]!;
          if (Math.abs(kart.lateralOffset) >= widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS - 0.01) wallHits++;
        }
        for (const kart of state.karts) {
          if (!kart.startedLap || kart.finishTime !== null) continue;
          ice.forEach((zone, index) => {
            if (kart.trackDistance >= zone.from && kart.trackDistance < zone.to &&
              surfaceAt(track, kart.trackDistance, kart.lateralOffset) === 'ice') visited[kart.id]![index]!.add(kart.lap);
          });
          if (kart.airTime > 0 && kart.trackDistance >= jump.from && kart.trackDistance <= jump.to + 40) {
            flights[kart.id]!.add(kart.lap);
          }
        }
      }
      expect(state.phase).toBe('finished');
      expect(state.karts).toHaveLength(8);
      for (const kart of state.karts) {
        expect(kart.human).toBe(false);
        expect(kart.lap).toBe(DEFAULT_LAPS);
        expect(kart.lapTimes).toHaveLength(3);
        expect(kart.finishTime).not.toBeNull();
        expect(kart.finishTime).toBeLessThanOrEqual(420);
        for (const laps of [...visited[kart.id]!, flights[kart.id]!]) expect([...laps].sort()).toEqual([0, 1, 2]);
        lapTimes.push(...kart.lapTimes);
      }
      const last = state.karts.find(kart => getRank(state, kart.id) === 8)!;
      expect(last.finishTime).toBe(Math.max(...state.karts.map(kart => kart.finishTime!)));
    }
    expect(lapTimes).toHaveLength(72);
    const meanLap = lapTimes.reduce((sum, time) => sum + time, 0) / lapTimes.length;
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(6);
    expect(bandHits).toBeLessThanOrEqual(6);
  }, 120_000);
});

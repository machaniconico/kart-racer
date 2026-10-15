// M10-06 fix / darwin-arm64: buildCourse 43 meshes, 94,226 triangles including shadows;
// five-build median 466.322 ms (parallel story load, 2026-10-16). +20k karts < 165,246 cap.
// 8 CPUs × seeds [1, 42, 98765] × 3 laps = 72: meanLap 63.4671296296296 s,
// wallHits 0, bandHits 0, pitFalls 0. Simulation and shared baselines unchanged.
// Island lane integral: inner 35.854 m / outer 64.146 m (28.293 m shortcut).
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCourse } from '../../render/course/buildCourse';
import { temple as theme, templePalette } from '../../render/course/themes/temple';
import { getAIInput } from '../ai';
import { barrierHalfWidthAt, corridorAt, KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, stepRace } from '../race';
import { racingLineOffset } from '../surfaces';
import { buildTrack, rollAt, slopeAt } from '../track';
import { getTrack, scaffoldIds } from './index';
import { curvatureProfile, maxSlope } from './shapeMetrics';
import { TEMPLE_LENGTH } from './temple';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH, WIDTH_SCALE } from './widths';

const track = getTrack('temple');
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

describe('SUNKEN TEMPLE', () => {
  it('defines a playable 2100–2400m layout independent of the scaffold', () => {
    expect(track.length).toBe(TEMPLE_LENGTH);
    expect(track.length).toBeCloseTo(2254.1024005619706, 8);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(track.def.layoutVersion).toBe(1);
    expect(track.def.checkpointCount).toBe(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(scaffoldIds()).not.toContain('temple');
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
    expect(track.def.racingLine[0]).toEqual({ distance: 0, offset: 0 });
    expect(track.def.racingLine.at(-1)).toEqual({ distance: track.length, offset: 0 });
    for (let d = 0; d < track.length; d += 0.5) {
      expect(Math.abs(racingLineOffset(track, d)) + KART_RADIUS).toBeLessThan(widthAt(track, d).roadHalfWidth);
    }
    expect(maxSlope(track)).toBeLessThanOrEqual(0.30);
    for (const point of profile) {
      expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(widthAt(track, point.distance).wallHalfWidth + 2.5);
    }
  });

  it('crosses the courtyard once with a level, adequately supported deck', () => {
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
    }
  });

  it('has two rotating stone floors, two closing doors, one boost and one column island', () => {
    expect(track.def.surfaces.map(zone => zone.kind).sort()).toEqual(['boost', 'spin', 'spin']);
    const spins = track.def.surfaces.filter(zone => zone.kind === 'spin');
    expect(spins.map(zone => Math.sign(zone.rate!))).toEqual([1, -1]);
    for (const spin of spins) {
      expect(Math.abs(spin.rate!)).toBeGreaterThan(0);
      expect(Math.abs(spin.rate!)).toBeLessThanOrEqual(1.5);
      expect(spin.to - spin.from).toBe(spin.offsetMax! - spin.offsetMin!);
      for (const point of profile.filter(point => point.distance >= spin.from && point.distance <= spin.to)) {
        expect(1 / Math.abs(point.curvature)).toBeGreaterThanOrEqual(200);
      }
    }
    const gates = track.def.barriers!.filter(barrier => barrier.motion);
    expect(gates).toHaveLength(2);
    for (const gate of gates) {
      expect(gate.motion!.kind).toBe('gate');
      expect(gate.motion!.minWidth).toBeGreaterThanOrEqual(0.6 * WIDTH_SCALE);
      // Both fully open and fully extended doors must physically cover road,
      // without counting the kart-radius expansion used by collision checks.
      const extendedAt = -gate.motion!.phase * gate.motion!.period / (2 * Math.PI);
      const openAt = extendedAt + gate.motion!.period / 2;
      expect(barrierHalfWidthAt(gate, extendedAt)).toBeCloseTo(gate.halfWidth);
      expect(barrierHalfWidthAt(gate, openAt)).toBeCloseTo(gate.motion!.minWidth!);
      const road = widthAt(track, (gate.from + gate.to) / 2).roadHalfWidth;
      for (const time of [openAt, extendedAt]) {
        const halfWidth = barrierHalfWidthAt(gate, time);
        const overlap = Math.min(road, gate.center + halfWidth) - Math.max(-road, gate.center - halfWidth);
        expect(overlap).toBeGreaterThanOrEqual(2);
      }
      const widths = [];
      for (let step = 0; step <= 48; step++) {
        const time = step * gate.motion!.period / 48;
        widths.push(barrierHalfWidthAt(gate, time));
        for (let d = gate.from; d <= gate.to; d += 0.5) {
          const offset = racingLineOffset(track, d);
          expect(corridorAt(track, d, time).some(lane => lane.min < offset - KART_RADIUS - 0.3 &&
            lane.max > offset + KART_RADIUS + 0.3)).toBe(true);
        }
      }
      expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThan(1);
    }
    expect(track.def.barriers).toHaveLength(3);
    expect(track.def.splits).toHaveLength(1);
    const split = track.def.splits![0]!;
    expect(split.lanes).toHaveLength(2);
    expect(split.lanes.map(lane => lane.risk).sort()).toEqual([0, 1]);
    for (const lane of split.lanes) expect(lane.offsetMax - lane.offsetMin).toBeGreaterThanOrEqual(6);
    const island = track.def.barriers!.find(barrier => !barrier.motion)!;
    expect(island.scenery).toBe('building');
    expect(island.from).toBeGreaterThanOrEqual(split.from);
    expect(island.to).toBeLessThanOrEqual(split.to);
    for (let d = split.from; d <= split.to; d += 0.5) {
      const offset = racingLineOffset(track, d);
      expect(corridorAt(track, d, 0).some(lane => lane.min < offset - KART_RADIUS && lane.max > offset + KART_RADIUS)).toBe(true);
    }
  });

  it('rewards the tighter inner island lane with at least two metres of real shortcut', () => {
    const split = track.def.splits![0]!;
    const risky = split.lanes.find(lane => lane.risk === 1)!;
    const safe = split.lanes.find(lane => lane.risk === 0)!;
    const riskyOffset = (risky.offsetMin + risky.offsetMax) / 2;
    const safeOffset = (safe.offsetMin + safe.offsetMax) / 2;
    let riskyLength = 0, safeLength = 0, measuredDistance = 0;
    for (let i = 0; i < profile.length - 1; i++) {
      const a = profile[i]!, b = profile[i + 1]!;
      const from = Math.max(a.distance, split.from), to = Math.min(b.distance, split.to);
      if (to <= from) continue;
      // Track offsets use the right normal (tz, -tx), so heading curvature
      // is the negative of shapeMetrics' x-z cross-product curvature.
      const curvatureAt = (d: number) => -(a.curvature + (b.curvature - a.curvature) *
        (d - a.distance) / (b.distance - a.distance));
      const curvature = (curvatureAt(from) + curvatureAt(to)) / 2;
      expect(curvatureAt(from) * riskyOffset).toBeGreaterThan(0);
      expect(curvatureAt(to) * riskyOffset).toBeGreaterThan(0);
      expect(curvature * safeOffset).toBeLessThan(0);
      expect(1 - curvature * riskyOffset).toBeGreaterThan(0);
      const ds = to - from;
      riskyLength += (1 - curvature * riskyOffset) * ds;
      safeLength += (1 - curvature * safeOffset) * ds;
      measuredDistance += ds;
    }
    expect(measuredDistance).toBeCloseTo(split.to - split.from, 8);
    expect(safeLength - riskyLength).toBeGreaterThanOrEqual(2);
    console.info('M10-06 island', { riskyLength, safeLength, shortcut: safeLength - riskyLength });
  });

  it('renders jungle ruins and column rows within the geometry budget', () => {
    const durations: number[] = [];
    let meshes = 0, triangles = 0;
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      const course = renderCourse();
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
        expect(theme.colors.ground).toBe(templePalette.moss);
        expect(theme.colors.road).toBe(templePalette.stone);
        expect(theme.colors.motionSpin).toBe(templePalette.gold);
        const columns = course.group.getObjectByName('island-scenery:building') as THREE.InstancedMesh;
        expect(columns.count).toBeGreaterThan(0);
        expect(columns.geometry).toBeInstanceOf(THREE.LatheGeometry);
        // Island columns belong inside their physical barrier, not outside the road.
        const island = track.def.barriers!.find(barrier => !barrier.motion)!;
        const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
        const rotation = new THREE.Quaternion();
        for (let i = 0; i < columns.count; i++) {
          columns.getMatrixAt(i, matrix);
          matrix.decompose(position, rotation, scale);
          expect(scale.x / 2).toBeLessThan(island.halfWidth);
        }
        for (const name of ['temple:trunks', 'temple:canopies', 'temple:ruins', 'temple:ferns', 'temple:relics']) {
          const mesh = course.group.getObjectByName(name) as THREE.InstancedMesh;
          expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
          expect(mesh.count).toBeGreaterThan(0);
          if (run !== 0) continue;
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
        expect(course.group.getObjectByName('motion')!.children).toHaveLength(4);
      } finally { course.dispose(); }
    }
    console.info('M10-06 render', { length: track.length, meshes, triangles,
      medianBuildMs: durations.sort((a, b) => a - b)[2] });
  });

  it('keeps courtyard deck supports outside the lower road', () => {
    const course = renderCourse();
    try {
      const pillars = course.group.getObjectByName('deck-pillars') as THREE.InstancedMesh;
      expect(pillars.count).toBeGreaterThan(0);
      const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      for (let i = 0; i < pillars.count; i++) {
        pillars.getMatrixAt(i, matrix);
        matrix.decompose(position, rotation, scale);
        for (const [j, a] of track.samples.entries()) {
          const b = track.samples[(j + 1) % track.samples.length]!;
          if (Math.min(a.y, b.y) >= position.y + scale.y / 2) continue;
          const dx = b.x - a.x, dz = b.z - a.z;
          const t = Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.z - a.z) * dz) / (dx * dx + dz * dz)));
          const d = a.distance + t * ((b.distance || track.length) - a.distance);
          expect(Math.hypot(position.x - a.x - t * dx, position.z - a.z - t * dz))
            .toBeGreaterThan(widthAt(track, d).wallHalfWidth + 0.45);
        }
      }
    } finally { course.dispose(); }
  });

  it('finishes 72 CPU laps within pace and collision budgets', () => {
    const lapTimes: number[] = [];
    let wallHits = 0, bandHits = 0, pitFalls = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'temple', racers: [] });
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
    console.info('M10-06 CPU', { meanLap, wallHits, bandHits, pitFalls });
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(6);
    expect(bandHits).toBeLessThanOrEqual(2);
    expect(pitFalls).toBeLessThanOrEqual(6);
  }, 120_000);
});

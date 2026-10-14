import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAIInput } from '../ai';
import { validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { DEFAULT_LAPS } from '../laps';
import { createRace, FIXED_DT, KART_RADIUS, NEUTRAL_INPUT, stepRace } from '../race';
import { JUMP_DURATION, surfaceAt } from '../surfaces';
import { buildTrack, projectToTrack, rollAt, sampleTrack, slopeAt, wrapDistance } from '../track';
import type { RaceState } from '../types';
import * as tracks from './index';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';
import { curvatureProfile, elevationRange, findCompoundCorners, findHairpins, findSCurves, maxSlope, minCurvatureRadius } from './shapeMetrics';
import * as THREE from 'three';
import { buildCourse } from '../../render/course/buildCourse';
import { canyon as canyonTheme } from '../../render/course/themes/canyon';

const { getTrack } = tracks;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const track = getTrack('canyon');
const jumps = track.def.surfaces.filter(zone => zone.kind === 'jump');
const mainJumps = jumps.filter(zone => zone.offsetMin === undefined);
const split = track.def.splits![0]!;

function sampleHash(samples: unknown): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(JSON.stringify(samples))) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return hash >>> 0;
}

// A human input fixture: constant full throttle, no drift/items/AI/assist, and
// only heading error to a lane-centre look-ahead point drives the steering.
function driveLane(risk: 0 | 1, missBoost = false) {
  const lane = split.lanes.find(candidate => candidate.risk === risk)!;
  const center = (lane.offsetMin + lane.offsetMax) / 2;
  // Counterfactual: move only the pad bounds 0.5 m outside the target line.
  // The production pad spans the whole lane; moving the kart outside it instead
  // would hit the island or the wall and would confound the missed-boost result.
  const course = missBoost ? buildTrack({ ...track.def, surfaces: track.def.surfaces.map(zone =>
    zone.kind === 'boost' ? { ...zone, offsetMin: center + 0.5, offsetMax: center + 9.5 } : zone) }) : track;
  vi.spyOn(tracks, 'getTrack').mockReturnValue(course);
  const state = createRace(1, { trackId: 'canyon' });
  state.phase = 'racing';
  state.karts = [state.karts[0]!];
  state.boxes = [];
  const kart = state.karts[0]!;
  const start = split.from - 35;
  const point = sampleTrack(course, start);
  Object.assign(kart, { human: true, x: point.x, y: point.y, z: point.z,
    heading: Math.atan2(point.tx, point.tz), trackDistance: start, lateralOffset: 0, speed: 32 });
  let pits = 0;
  let boosts = 0;
  let maxSpin = 0;
  let takeoffSpeed = 0;
  const hits: number[] = [];
  for (let tick = 0; tick < 60 * 30 && kart.trackDistance < split.to + 20; tick++) {
    const d = kart.trackDistance + 4;
    const offset = center * Math.max(0, Math.min(1, (d - start) / 35, (split.to + 20 - d) / 20));
    const target = sampleTrack(course, d);
    const desired = Math.atan2(target.x + target.nx * offset - kart.x, target.z + target.nz * offset - kart.z);
    const error = Math.atan2(Math.sin(desired - kart.heading), Math.cos(desired - kart.heading));
    const airTime = kart.airTime;
    stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1, steer: Math.max(-1, Math.min(1, error * 4)) }]);
    if (kart.airTime > airTime) takeoffSpeed = kart.speed;
    for (const event of state.events) {
      if (event.type === 'boost') boosts++;
      if (event.type === 'hit') {
        if (event.value === 2) pits++;
        else hits.push(event.value ?? 0);
      }
    }
    maxSpin = Math.max(maxSpin, kart.spinTime);
  }
  expect(kart.trackDistance).toBeGreaterThanOrEqual(split.to + 20);
  expect(hits).toEqual([]);
  return { seconds: state.racingTicks * FIXED_DT, pits, boosts, maxSpin, takeoffSpeed };
}

describe('SUNSCAR CANYON', () => {
  it('validates the island placement and registered-course playability', () => {
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(track.def.splits).toHaveLength(1);
    expect(track.def.barriers!.length).toBeGreaterThanOrEqual(2);
    expect(track.def.barriers!.some(barrier => barrier.to < split.from - 40 || barrier.from > split.to + 40)).toBe(true);
    expect(track.def.widthKeys!.length).toBeGreaterThan(0);
    expect(track.def.checkpointCount).toBe(24);
    expect(track.def.boxRows).toHaveLength(8);
    for (const [kind, count] of [['jump', 3], ['boost', 1], ['pit', 1]] as const) {
      expect(track.def.surfaces.filter(zone => zone.kind === kind)).toHaveLength(count);
    }
    expect(split.from - 35).toBeGreaterThan(0);
    expect(split.to).toBeLessThan(track.length - 21.5 - 100);
    for (const lane of split.lanes) expect(lane.offsetMax - lane.offsetMin).toBeCloseTo(11.7, 9);
    const inner = split.lanes.find(lane => lane.risk === 1)!;
    const a = sampleTrack(track, split.from + 20);
    const b = sampleTrack(track, split.from + 30);
    expect(Math.sign(b.tx * a.tz - b.tz * a.tx)).toBe(Math.sign(inner.offsetMin));
  });

  it('builds visible island rocks and both lane signs for CANYON', () => {
    const labels: string[] = [];
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ fillRect() {}, fillText(text: string) { labels.push(text); } }) }) });
    const course = buildCourse(track, canyonTheme);
    try {
      const rocks = course.group.getObjectByName('island-scenery:rock') as THREE.InstancedMesh;
      expect(rocks).toBeInstanceOf(THREE.InstancedMesh);
      expect(rocks.count).toBeGreaterThan(0);
      expect(course.group.getObjectByName('islands')).toBeInstanceOf(THREE.Mesh);
      for (const side of [0, 1]) expect(course.group.getObjectByName(`lane-sign:0:${side}`)).toBeInstanceOf(THREE.Mesh);
      expect(labels).toEqual(expect.arrayContaining(['SHORT', 'SAFE']));
    } finally { course.dispose(); }
  });

  it('keeps mesa and pillar footprints clear of every road branch within the scenery budget', () => {
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ fillRect() {}, fillText() {} }) }) });
    const course = buildCourse(track, canyonTheme);
    try {
      let triangles = 0;
      course.group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const geometry = object.geometry;
        const instances = object instanceof THREE.InstancedMesh ? object.count : 1;
        triangles += (geometry.index?.count ?? geometry.getAttribute('position').count) / 3 * instances *
          (object.castShadow ? 2 : 1);
      });
      // M5-00's length-scaled cap, counting all course geometry and its shadow pass
      // without frustum culling, with another 20k triangles reserved for the racers.
      expect(triangles + 20_000).toBeLessThanOrEqual(60 * track.length + 30_000);
      const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      for (const name of ['canyon:pillars', 'canyon:mesas']) {
        const mesh = course.group.getObjectByName(name) as THREE.InstancedMesh;
        expect(mesh.count).toBeGreaterThan(0);
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          matrix.decompose(position, rotation, scale);
          const radius = Math.max(scale.x, scale.z);
          let clearance = Infinity;
          for (const [j, a] of track.samples.entries()) {
            const b = track.samples[(j + 1) % track.samples.length]!;
            const dx = b.x - a.x, dz = b.z - a.z;
            const t = Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.z - a.z) * dz) / (dx * dx + dz * dz)));
            const distance = a.distance + t * ((j + 1 === track.samples.length ? track.length : b.distance) - a.distance);
            clearance = Math.min(clearance, Math.hypot(position.x - a.x - t * dx, position.z - a.z - t * dz) -
              widthAt(track, distance).wallHalfWidth - radius);
          }
          expect(clearance, `${name}:${i}`).toBeGreaterThan(0);
        }
      }
      // M5-09 handoff baseline: the shared deck builder originally placed two 0.45m-radius supports
      // at (x,z) = (+/-13.05, 0.06286), through the lower road. Each is 28.81007m tall,
      // from y=-1.35 to y=27.46007. Theme props above are independently kept clear.
    } finally { course.dispose(); }
  });

  it('rewards the boosted inner lane and penalizes missing its pad with identical full-throttle steering', () => {
    // M5-02: inner 4.400000s, outer 4.900000s, missed pad 6.650000s.
    // Gain 0.500000s (lower/upper margins 0.100000/1.500000s); fall cost
    // 1.750000s (margin 0.250000s). Same full-throttle fixture and shared pit penalty.
    const inner = driveLane(1);
    const outer = driveLane(0);
    const missed = driveLane(1, true);
    expect(inner.pits).toBe(0);
    expect(inner.maxSpin).toBe(0);
    expect(inner.boosts).toBe(1);
    expect(outer.boosts).toBe(0);
    expect(outer.pits).toBe(0);
    expect(missed.boosts).toBe(0);
    expect(missed.pits).toBe(1);
    // Unboosted takeoff stays below the boosted one: the pit separates the two landings.
    expect(missed.takeoffSpeed).toBeLessThan(inner.takeoffSpeed);
    expect(outer.seconds - inner.seconds).toBeGreaterThanOrEqual(0.4);
    expect(outer.seconds - inner.seconds).toBeLessThanOrEqual(2);
    // The shared pit penalty is unchanged. M5 requires another 0.10s of margin on both outcomes.
    expect(missed.seconds - outer.seconds).toBeGreaterThanOrEqual(1.5);
    expect(outer.seconds - inner.seconds).toBeGreaterThanOrEqual(0.5);
    expect(outer.seconds - inner.seconds).toBeLessThanOrEqual(1.9);
    expect(missed.seconds - outer.seconds).toBeGreaterThanOrEqual(1.6);
  });

  it('pins the reproducible 2100–2400m layout and its technical shapes', () => {
    expect(track.def.layoutVersion).toBe(5);
    expect(track.length).toBeCloseTo(2274.6514118884065, 8);
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
    expect(elevationRange(track).range).toBeGreaterThanOrEqual(12);
    expect(maxSlope(track)).toBeLessThanOrEqual(0.30);
    expect(findHairpins(track).length).toBeGreaterThanOrEqual(1);
    expect(findSCurves(track).length).toBeGreaterThanOrEqual(1);
    expect(findCompoundCorners(track).length).toBeGreaterThanOrEqual(1);
    expect(minCurvatureRadius(track)).toBeGreaterThanOrEqual(16.95);
    for (const point of curvatureProfile(track)) {
      expect(1 / Math.abs(point.curvature), `radius at ${point.distance}`).toBeGreaterThanOrEqual(
        widthAt(track, point.distance).wallHalfWidth + 2.5 + 0.8);
    }
    expect(sampleHash(track.samples)).not.toBe(sampleHash(getTrack('meadow').samples));
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
    const line = track.def.racingLine;
    expect(line[0]).toEqual({ distance: 0, offset: 0 });
    expect(line.at(-1)!.distance).toBeGreaterThan(track.length - 100);
    expect(line.at(-1)!.offset).toBe(0);
    expect(line.some(point => point.distance > split.to && point.offset === 0)).toBe(true);
    const risky = split.lanes.find(lane => lane.risk === 1)!;
    for (const kind of ['dirt', 'boost', 'jump', 'pit']) {
      expect(track.def.surfaces.some(zone => zone.kind === kind && zone.from >= split.from && zone.to <= split.to &&
        zone.offsetMin! >= risky.offsetMin && zone.offsetMax! <= risky.offsetMax)).toBe(true);
    }
  });

  it('has exactly one level crossing, a short upper deck and level gate-free approaches', () => {
    const crossings: { lower: number; upper: number; gap: number; angle: number }[] = [];
    const samples = track.samples;
    for (let i = 0; i < samples.length; i++) {
      const a = samples[i]!, b = samples[(i + 1) % samples.length]!;
      const dx = b.x - a.x, dz = b.z - a.z;
      for (let j = i + 2; j < samples.length; j++) {
        if (i === 0 && j === samples.length - 1) continue;
        const c = samples[j]!, d = samples[(j + 1) % samples.length]!;
        const ex = d.x - c.x, ez = d.z - c.z, cross = dx * ez - dz * ex;
        if (Math.abs(cross) < 1e-9) continue;
        const qx = c.x - a.x, qz = c.z - a.z;
        const t = (qx * ez - qz * ex) / cross, u = (qx * dz - qz * dx) / cross;
        if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
        const ad = a.distance + Math.hypot(dx, dz) * t, cd = c.distance + Math.hypot(ex, ez) * u;
        const ay = a.y + (b.y - a.y) * t, cy = c.y + (d.y - c.y) * u;
        crossings.push({ lower: ay < cy ? ad : cd, upper: ay > cy ? ad : cd, gap: Math.abs(ay - cy),
          angle: Math.acos(Math.min(1, Math.abs(dx * ex + dz * ez) / (Math.hypot(dx, dz) * Math.hypot(ex, ez)))) });
      }
    }
    expect(crossings).toHaveLength(1);
    expect(track.def.decks).toHaveLength(1);
    const crossing = crossings[0]!, deck = track.def.decks![0]!;
    expect(crossing.gap).toBeGreaterThanOrEqual(12);
    expect(crossing.angle).toBeGreaterThanOrEqual(Math.PI / 4);
    expect(crossing.upper - deck.from).toBeGreaterThanOrEqual(19);
    expect(deck.to - crossing.upper).toBeGreaterThanOrEqual(19);
    expect(deck.to - deck.from).toBeLessThanOrEqual(42);
    for (const distance of [crossing.lower, crossing.upper]) {
      for (let delta = -20; delta <= 20; delta += 0.25) {
        expect(Math.abs(slopeAt(track, distance + delta))).toBeLessThanOrEqual(0.10);
        expect(Math.abs(rollAt(track, distance + delta))).toBeLessThanOrEqual(0.10);
      }
      for (const gate of track.checkpointDistances) {
        const gap = wrapDistance(track, gate - distance);
        expect(Math.min(gap, track.length - gap)).toBeGreaterThan(25);
      }
    }
    for (const a of samples.filter(point => point.distance >= deck.from && point.distance <= deck.to)) {
      for (const b of samples.filter(point => point.distance < deck.from || point.distance > deck.to)) {
        const gap = Math.abs(a.distance - b.distance);
        if (Math.min(gap, track.length - gap) > 31.8 && Math.hypot(a.x - b.x, a.z - b.z) <= 31.8) {
          expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(8);
        }
      }
    }
  });

  it('preserves the two non-shortcut downhill jumps on straight takeoff and landing corridors', () => {
    expect(mainJumps).toEqual([{ kind: 'jump', from: 306.5, to: 310.5 }, { kind: 'jump', from: 1386.5, to: 1390.5 }]);
    for (const jump of mainJumps) {
      expect(jump.from).toBeGreaterThan(15);
      expect(jump.to).toBeGreaterThan(jump.from);
      expect(jump.to + 15).toBeLessThan(track.length);
      expect(sampleTrack(track, jump.from + 15).y).toBeLessThan(sampleTrack(track, jump.from - 15).y);
      let minimumRadius = Infinity;
      // Include the entire marked surface and a boosted kart's landing zone,
      // in addition to the required 15m either side of takeoff.
      for (const [i, b] of track.samples.entries()) {
        if (b.distance < jump.from - 15 || b.distance > Math.max(jump.to + 15, jump.from + 50 * JUMP_DURATION)) continue;
        const a = track.samples[(i + track.samples.length - 1) % track.samples.length]!;
        const c = track.samples[(i + 1) % track.samples.length]!;
        const twiceArea = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
        const radius = twiceArea === 0 ? Infinity : Math.hypot(b.x - a.x, b.z - a.z) *
          Math.hypot(c.x - b.x, c.z - b.z) * Math.hypot(c.x - a.x, c.z - a.z) / (2 * twiceArea);
        minimumRadius = Math.min(minimumRadius, radius);
      }
      expect(minimumRadius).toBeGreaterThanOrEqual(40);
    }
  });

  it('narrows one passage to 55% of the base width with 20m ramps', () => {
    expect(track.def.layoutVersion).toBe(5);
    const keys = track.def.widthKeys!.filter(key => key.distance >= 1600);
    expect(keys).toHaveLength(4);
    expect(keys.map(key => key.roadHalfWidth)).toEqual([BASE_ROAD_HALF_WIDTH, 5.148, 5.148, BASE_ROAD_HALF_WIDTH]);
    const [entry, narrowStart, narrowEnd, exit] = keys;
    expect(narrowStart!.roadHalfWidth).toBeCloseTo(BASE_ROAD_HALF_WIDTH * 0.55);
    expect(narrowStart!.wallHalfWidth).toBeCloseTo(BASE_WALL_HALF_WIDTH * 0.55);
    expect(narrowStart!.distance - entry!.distance).toBe(20);
    expect(exit!.distance - narrowEnd!.distance).toBe(20);
    expect(narrowEnd!.distance).toBeGreaterThan(narrowStart!.distance);
    for (const key of keys) expect(widthAt(track, key.distance).roadHalfWidth).toBe(key.roadHalfWidth);
    for (const [a, b] of [[entry!, narrowStart!], [narrowEnd!, exit!]]) {
      expect(widthAt(track, (a.distance + b.distance) / 2).roadHalfWidth).toBeCloseTo((BASE_ROAD_HALF_WIDTH + 5.148) / 2);
    }
    expect(widthAt(track, 0).roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(widthAt(track, track.length - 1).roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
  });

  it('limits shortcut surfaces to the inner lane and leaves the outer lane paved', () => {
    const inner = split.lanes.find(lane => lane.risk === 1)!;
    const outer = split.lanes.find(lane => lane.risk === 0)!;
    const dirt = track.def.surfaces.filter(zone => zone.kind === 'dirt');
    expect(dirt.length).toBeGreaterThanOrEqual(1);
    expect(dirt[0]).toEqual({ kind: 'dirt', from: split.from + 45, to: split.from + 70,
      offsetMin: inner.offsetMin, offsetMax: inner.offsetMax });
    for (let d = split.from; d <= split.to; d += 0.5) {
      expect(surfaceAt(track, d, (outer.offsetMin + outer.offsetMax) / 2)).toBe('road');
      if (d >= dirt[0]!.from && d < dirt[0]!.to) {
        expect(surfaceAt(track, d, (inner.offsetMin + inner.offsetMax) / 2)).toBe('dirt');
      }
    }
  });

  it('keeps every grid slot clear of barrier exclusions through the first 100m after the start line', () => {
    const { karts } = createRace(1, { trackId: 'canyon', racers: [] });
    expect(karts).toHaveLength(8);
    expect(new Set(karts.map(kart => kart.lateralOffset))).toEqual(new Set([-2, 2]));
    for (const kart of karts) {
      const approach = wrapDistance(track, -kart.trackDistance) + 100;
      for (const pillar of track.def.barriers!) {
        // Check the entire expanded band, including both caps, without gaps between samples.
        // Keeping it out of this arc clears both columns in every row of the grid.
        const nose = wrapDistance(track, pillar.from - KART_RADIUS - kart.trackDistance);
        const span = wrapDistance(track, pillar.to - pillar.from) + 2 * KART_RADIUS;
        expect(nose, `grid slot ${kart.id}`).toBeGreaterThan(approach);
        expect(nose + span, `grid slot ${kart.id}`).toBeLessThan(track.length);
      }
    }
  });

  it.each(track.def.boxLanes)('keeps every item row in lane %s at least 8m from pillar exclusions', offset => {
    for (const fraction of track.def.boxRows) {
      const distance = fraction * track.length;
      const point = sampleTrack(track, distance);
      const box = projectToTrack(track, point.x + point.nx * offset, point.z + point.nz * offset, distance);
      for (const pillar of track.def.barriers!) {
        // Reserve reaction distance before the nose and after the tail, including the kart radius.
        // This longitudinal bound clears every lane, even when the box is off the centre line.
        const fromNose = wrapDistance(track, box.distance - (pillar.from - KART_RADIUS));
        const span = wrapDistance(track, pillar.to - pillar.from) + 2 * KART_RADIUS;
        const context = `row ${distance}, lane ${offset}, pillar ${pillar.from}`;
        expect(fromNose - span, context).toBeGreaterThanOrEqual(8);
        expect(track.length - fromNose, context).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it('keeps both lanes wide enough beside the full static island barrier', () => {
    const island = track.def.barriers!.find(barrier => barrier.scenery === 'rock')!;
    expect(island.scenery).toBe('rock');
    expect(island.from).toBeGreaterThan(split.from);
    expect(island.to).toBeLessThan(split.to);
    for (const lane of split.lanes) {
      expect(lane.offsetMax - lane.offsetMin).toBeCloseTo(11.7, 9);
      expect(Math.min(Math.abs(lane.offsetMin), Math.abs(lane.offsetMax))).toBeGreaterThanOrEqual(
        island.halfWidth + KART_RADIUS);
    }
  });

  // M5-02, 8 CPUs x seeds [1, 42, 98765] x 3 laps: mean 68.495833333s,
  // wallHits 0, bandHits 0, passes 72 (24 risky), pitFalls 0. The shared
  // handling suite retains the existing wall/band/pit budgets.
  it.each([1, 42, 98765])('flies every CPU over both non-shortcut jumps on every lap, stays inside walls and replays exactly (seed %i)', seed => {
    const state = createRace(seed, { trackId: 'canyon', racers: [] });
    let restored: RaceState = JSON.parse(JSON.stringify(state));
    const flights = state.karts.map(() => jumps.map(() => new Set<number>()));
    let airborneTicks = 0;

    for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
      const previous = state.karts.map(kart => ({ airTime: kart.airTime, distance: kart.trackDistance }));
      stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
      stepRace(restored, restored.karts.map(kart => getAIInput(restored, kart.id)));
      expect(JSON.stringify(restored)).toBe(JSON.stringify(state));
      for (const kart of state.karts) {
        if (kart.airTime <= 0) continue;
        airborneTicks++;
        const projection = projectToTrack(track, kart.x, kart.z, kart.trackDistance, kart.y);
        expect(Math.abs(projection.offset) + KART_RADIUS).toBeLessThanOrEqual(widthAt(track, projection.distance).wallHalfWidth + 1e-6);
        expect(kart.driftTime).toBe(0);
        expect(kart.driftDirection).toBe(0);
        if (previous[kart.id]!.airTime > 0) continue;
        const distance = previous[kart.id]!.distance;
        const travel = wrapDistance(track, kart.trackDistance - distance);
        const index = jumps.findIndex(jump => wrapDistance(track, jump.from - distance) <= travel);
        expect(index).toBeGreaterThanOrEqual(0);
        if (kart.finishTime === null) flights[kart.id]![index]!.add(kart.lap);
        // Restore while airborne as well as from the starting grid.
        restored = JSON.parse(JSON.stringify(restored));
      }
    }
    expect(state.phase).toBe('finished');
    expect(state.karts).toHaveLength(8);
    expect(state.karts.flatMap(kart => kart.lapTimes).reduce((sum, time) => sum + time, 0) / 24).toBeGreaterThanOrEqual(60);
    expect(airborneTicks).toBeGreaterThan(0);
    for (const kart of state.karts) {
      expect(kart.human).toBe(false);
      expect(kart.lap).toBe(DEFAULT_LAPS);
      expect(kart.lapTimes).toHaveLength(3);
      expect(kart.finishTime).not.toBeNull();
      expect(kart.airTime).toBe(0);
      for (const jump of mainJumps) expect(flights[kart.id]![jumps.indexOf(jump)]!.size).toBe(DEFAULT_LAPS);
    }
  }, 30_000);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAIInput } from '../ai';
import { validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { TOTAL_LAPS } from '../laps';
import { createRace, FIXED_DT, KART_RADIUS, NEUTRAL_INPUT, stepRace } from '../race';
import { JUMP_DURATION, surfaceAt } from '../surfaces';
import { buildTrack, projectToTrack, sampleTrack, wrapDistance } from '../track';
import type { RaceState } from '../types';
import * as tracks from './index';
import { BASE_ROAD_HALF_WIDTH } from './widths';
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
    expect(track.def.barriers).toHaveLength(3);
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

  it('rewards the boosted inner lane and penalizes missing its pad with identical full-throttle steering', () => {
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
    // Coordinator decision (M2-05): the shared M2-02 pit penalty caps a fall at about 2 s
    // over a clean inner run, so a fall must cost at least 1.5 s against the outer lane.
    expect(missed.seconds - outer.seconds).toBeGreaterThanOrEqual(1.5);
  });

  it('has its own reproducible 600–720m layout with at least 10m of elevation', () => {
    expect(track.length).toBeGreaterThanOrEqual(600);
    expect(track.length).toBeLessThanOrEqual(720);
    const heights = track.samples.map(point => point.y);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThanOrEqual(10);
    expect(sampleHash(track.samples)).not.toBe(sampleHash(getTrack('meadow').samples));
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
    let maximumGrade = 0;
    for (const [i, point] of track.samples.entries()) {
      const next = track.samples[(i + 1) % track.samples.length]!;
      maximumGrade = Math.max(maximumGrade, Math.abs(next.y - point.y) / Math.hypot(next.x - point.x, next.z - point.z));
    }
    expect(maximumGrade).toBeLessThanOrEqual(0.12);
  });

  it('preserves the two non-shortcut downhill jumps on straight takeoff and landing corridors', () => {
    expect(mainJumps).toEqual([{ kind: 'jump', from: 60, to: 64 }, { kind: 'jump', from: 393, to: 397 }]);
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

  it('narrows one passage to 5.2m half-width with 20m ramps on layout 4', () => {
    expect(track.def.layoutVersion).toBe(4);
    const keys = track.def.widthKeys!.filter(key => key.distance <= 270);
    expect(keys).toHaveLength(4);
    expect(keys.map(key => key.roadHalfWidth)).toEqual([BASE_ROAD_HALF_WIDTH, 5.2, 5.2, BASE_ROAD_HALF_WIDTH]);
    const [entry, narrowStart, narrowEnd, exit] = keys;
    expect(narrowStart!.distance - entry!.distance).toBe(20);
    expect(exit!.distance - narrowEnd!.distance).toBe(20);
    expect(narrowEnd!.distance).toBeGreaterThan(narrowStart!.distance);
    for (const key of keys) expect(widthAt(track, key.distance).roadHalfWidth).toBe(key.roadHalfWidth);
    for (const [a, b] of [[entry!, narrowStart!], [narrowEnd!, exit!]]) {
      expect(widthAt(track, (a.distance + b.distance) / 2).roadHalfWidth).toBeCloseTo((BASE_ROAD_HALF_WIDTH + 5.2) / 2);
    }
    expect(widthAt(track, 0).roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(widthAt(track, track.length - 1).roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
  });

  it('limits dirt and shortcut surfaces to the inner lane and leaves the outer lane paved', () => {
    const inner = split.lanes.find(lane => lane.risk === 1)!;
    const outer = split.lanes.find(lane => lane.risk === 0)!;
    const dirt = track.def.surfaces.filter(zone => zone.kind === 'dirt');
    expect(dirt.length).toBeGreaterThanOrEqual(1);
    expect(dirt[0]).toEqual({ kind: 'dirt', from: split.from + 26, to: split.from + 50,
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

  it('keeps centre pillars on straight shelves clear of jumps and gates and guarantees passage width between samples', () => {
    const pillars = track.def.barriers!.filter(barrier => barrier.scenery === 'pillar');
    expect(pillars).toEqual([
      { from: 136, to: 152, center: 0, halfWidth: 1.2, taper: 4, scenery: 'pillar' },
      { from: 361, to: 377, center: 0, halfWidth: 1.2, taper: 4, scenery: 'pillar' },
    ]);
    for (const pillar of pillars) {
      expect(pillar.scenery).toBe('pillar');
      expect(pillar.halfWidth).toBe(1.2);
      expect(pillar.taper).toBe(4);
      expect(Math.abs(pillar.center)).toBeLessThanOrEqual(2);
      const start = sampleTrack(track, pillar.from);
      for (let distance = pillar.from; distance <= pillar.to; distance += 0.5) {
        const point = sampleTrack(track, distance);
        expect(point.tx * start.tx + point.tz * start.tz).toBeGreaterThan(0.99);
      }
      for (const jump of jumps) {
        expect(pillar.to + KART_RADIUS <= jump.from ||
          pillar.from - KART_RADIUS >= jump.from + 50 * JUMP_DURATION).toBe(true);
      }
      for (const gate of track.checkpointDistances) {
        const fromNose = wrapDistance(track, gate - (pillar.from - KART_RADIUS));
        const span = wrapDistance(track, pillar.to - pillar.from) + 2 * KART_RADIUS;
        expect(fromNose - span).toBeGreaterThanOrEqual(10);
        expect(track.length - fromNose).toBeGreaterThanOrEqual(10);
      }
    }
    // A conservative bound for the entire lap, including all taper/cap interiors.
    // Unlike the validator's 0.5m grid this cannot miss a narrow passage between samples:
    // linear width interpolation never goes below a key and every exclusion stays in this envelope.
    const minimumWall = Math.min(...track.def.widthKeys!.map(key => key.wallHalfWidth));
    const envelope = Math.max(...pillars.map(pillar => Math.abs(pillar.center) + pillar.halfWidth + KART_RADIUS));
    expect(minimumWall - envelope).toBeGreaterThanOrEqual(2 * KART_RADIUS + 0.6);
  });

  it.each([1, 42, 98765])('flies every CPU over both non-shortcut jumps on every lap, stays inside walls and replays exactly (seed %i)', seed => {
    const state = createRace(seed, { trackId: 'canyon', racers: [] });
    let restored: RaceState = JSON.parse(JSON.stringify(state));
    const flights = state.karts.map(() => jumps.map(() => new Set<number>()));
    let airborneTicks = 0;

    for (let tick = 0; tick < 60 * 180 && state.phase !== 'finished'; tick++) {
      const previous = state.karts.map(kart => ({ airTime: kart.airTime, distance: kart.trackDistance }));
      stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
      stepRace(restored, restored.karts.map(kart => getAIInput(restored, kart.id)));
      expect(JSON.stringify(restored)).toBe(JSON.stringify(state));
      for (const kart of state.karts) {
        if (kart.airTime <= 0) continue;
        airborneTicks++;
        const projection = projectToTrack(track, kart.x, kart.z);
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
    expect(airborneTicks).toBeGreaterThan(0);
    for (const kart of state.karts) {
      expect(kart.human).toBe(false);
      expect(kart.lap).toBe(TOTAL_LAPS);
      expect(kart.lapTimes).toHaveLength(3);
      expect(kart.finishTime).not.toBeNull();
      expect(kart.airTime).toBe(0);
      for (const jump of mainJumps) expect(flights[kart.id]![jumps.indexOf(jump)]!.size).toBe(TOTAL_LAPS);
    }
  }, 30_000);
});

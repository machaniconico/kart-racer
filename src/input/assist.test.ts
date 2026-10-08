import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRace, stepRace } from '../sim/race';
import { sampleTrack } from '../sim/track';
import { buildTrack } from '../sim/track';
import * as tracks from '../sim/tracks';
import { getTrack, TRACK_IDS } from '../sim/tracks';
import { corridorAt, exclusionAt, KART_RADIUS, validateTrackDef, widthAt } from '../sim/corridor';
import type { InputFrame, RaceState, Track, TrackDef, TrackId } from '../sim/types';
import { applySteerAssist, assistPassage } from './assist';
import { Controls } from './Controls';

const input: InputFrame = { steer: 0, throttle: 1, brake: false, drift: false, useItem: false };

function solo(trackId: TrackId = 'meadow') {
  const state = createRace(42, { trackId });
  state.phase = 'racing';
  state.karts = [state.karts[0]!];
  state.boxes = [];
  return state;
}

function straight() {
  const state = solo();
  const track = getTrack(state.trackId);
  // Find a straight long enough to exercise held steering, not just a flat inflection.
  const bend = (distance: number) => {
    const a = sampleTrack(track, distance);
    return Math.max(...[10, 20, 30, 40, 50, 60].map((ahead) => {
      const b = sampleTrack(track, distance + ahead);
      return Math.abs(Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz));
    }));
  };
  const tangent = track.samples.reduce((best, point) => {
    return bend(point.distance) < bend(best.distance) ? point : best;
  });
  const kart = state.karts[0]!;
  Object.assign(kart, { x: tangent.x, z: tangent.z, trackDistance: tangent.distance,
    lateralOffset: 0, heading: Math.atan2(tangent.tx, tangent.tz), speed: 20 });
  return { state, kart };
}

describe('applySteerAssist', () => {
  it.each([-0.25, 0.25])('corrects a straight-road heading error of %s toward the tangent', (error) => {
    const { state, kart } = straight();
    kart.heading += error;
    expect(applySteerAssist(state, kart, input, 1).steer * error).toBeLessThan(0);
  });

  it.each([-1, 1])('steers inward at wall side %s', (side) => {
    const { state, kart } = straight();
    kart.lateralOffset = side * (getTrack(state.trackId).def.roadHalfWidth - 0.5);
    expect(applySteerAssist(state, kart, input, 1).steer * side).toBeLessThan(0);
  });

  it('does not pull toward the centre outside the wall margin', () => {
    const { state, kart } = straight();
    const centered = applySteerAssist(state, kart, input, 1);
    const margin = getTrack(state.trackId).def.roadHalfWidth - 2;
    for (const offset of [-margin, -2, 2, margin]) {
      kart.lateralOffset = offset;
      expect(applySteerAssist(state, kart, input, 1)).toEqual(centered);
    }
  });

  it.each([-0.2, -0.15, 0.15, 0.2])('held steer %s reaches the road edge without reversing the input', (steer) => {
    const { state, kart } = straight();
    const roadHalfWidth = getTrack(state.trackId).def.roadHalfWidth;
    const side = Math.sign(steer);
    for (let tick = 0; tick < 180 && kart.lateralOffset * side < roadHalfWidth - 1; tick++) {
      const frame = applySteerAssist(state, kart, { ...input, steer }, 1);
      expect(frame.steer * side).toBeGreaterThanOrEqual(0);
      stepRace(state, [frame]);
    }
    expect(kart.lateralOffset * side).toBeGreaterThanOrEqual(roadHalfWidth - 1);
    expect(Math.abs(kart.lateralOffset)).toBeLessThan(roadHalfWidth);
  });

  it.each([-1, 1])('never reverses deliberate input of 0.05 or more toward side %s, even near the wall', (side) => {
    const { state, kart } = straight();
    kart.heading += side * 0.7;
    for (const offset of [0, side * (getTrack(state.trackId).def.roadHalfWidth - 0.5)]) {
      kart.lateralOffset = offset;
      for (const magnitude of [0.05, 0.1, 0.15, 0.2, 0.25, 0.5, 0.8, 1]) {
        const steer = side * magnitude;
        const result = applySteerAssist(state, kart, { ...input, steer }, 1).steer;
        expect(result * side).toBeGreaterThanOrEqual(0);
        expect(Math.abs(result - steer)).toBeLessThanOrEqual(magnitude);
      }
    }
  });

  it.each([-1, 1])('fades the opposing cap in continuously around neutral at wall side %s', (side) => {
    const { state, kart } = straight();
    kart.lateralOffset = side * (getTrack(state.trackId).def.roadHalfWidth - 0.5);
    kart.heading += side * 0.3;
    let previous = applySteerAssist(state, kart, input, 1).steer;
    for (let i = 1; i <= 120; i += 1) {
      const steer = side * i * 0.001;
      const result = applySteerAssist(state, kart, { ...input, steer }, 1).steer;
      expect(Math.abs(result - previous)).toBeLessThan(0.02);
      previous = result;
    }
  });

  it('bounds correction and smoothly halves it again by strong input of 0.8', () => {
    const { state, kart } = straight();
    kart.heading += 0.7;
    const correction = (steer: number, strength = 1) =>
      Math.abs(applySteerAssist(state, kart, { ...input, steer }, strength).steer - steer);
    expect(correction(0)).toBeGreaterThan(0);
    expect(correction(0)).toBeLessThanOrEqual(0.35);
    expect(correction(0.5)).toBeLessThan(correction(0));
    for (const steer of [0.8, 0.9, 1]) {
      expect(correction(steer)).toBeCloseTo(correction(0) * (1 - 0.65 * steer) / 2);
    }
    for (const boundary of [0.6, 0.8]) {
      expect(Math.abs(correction(boundary - 0.000001) - correction(boundary + 0.000001))).toBeLessThan(0.00001);
    }
    expect(correction(1)).toBeLessThanOrEqual(0.175);
    expect(correction(0, 0.5)).toBeCloseTo(correction(0) / 2);
    expect(correction(0, 10)).toBe(correction(0));
  });

  it.each([0, -0.1, 0.1, -0.2, 0.2])('leaves drift initiation entirely to player steer %s', (steer) => {
    const { state, kart } = straight();
    kart.heading += 0.7;
    const frame = { ...input, steer, drift: true };
    expect(applySteerAssist(state, kart, frame, 1)).toBe(frame);
    stepRace(state, [applySteerAssist(state, kart, frame, 1)]);
    expect(kart.driftDirection).toBe(Math.abs(steer) > 0.12 ? Math.sign(steer) : 0);
  });

  it('does not pick a drift direction while the button remains held after hopping', () => {
    const { state, kart } = straight();
    kart.heading += 0.7;
    for (let tick = 0; tick < 120; tick++) {
      const frame = { ...input, drift: true };
      expect(applySteerAssist(state, kart, frame, 1)).toBe(frame);
      stepRace(state, [frame]);
      expect(kart.driftDirection).toBe(0);
    }
    expect(kart.hopTime).toBe(0);
  });

  it('weakens established drifts while held and on release', () => {
    const { state, kart } = straight();
    kart.heading += 0.3;
    const normal = Math.abs(applySteerAssist(state, kart, input, 1).steer);
    kart.driftDirection = 1;
    for (const drift of [true, false]) {
      expect(Math.abs(applySteerAssist(state, kart, { ...input, drift }, 1).steer)).toBeCloseTo(normal * 0.35);
    }
  });

  it.each([{ wrongWay: true }, { spinTime: 1 }, { airTime: 1 }, { hopTime: 0.2 },
    { human: false }, { speed: -1 }])('leaves excluded kart state %j untouched', (patch) => {
    const { state, kart } = straight();
    Object.assign(kart, patch);
    expect(applySteerAssist(state, kart, input, 1)).toBe(input);
  });

  it('does not correct a backward heading before wrongWay is updated', () => {
    const { state, kart } = straight();
    kart.heading += Math.PI;
    expect(applySteerAssist(state, kart, input, 1)).toBe(input);
  });

  it('is deterministic, preserves non-steering input and never mutates its arguments', () => {
    const { state, kart } = straight();
    const frame = Object.freeze({ ...input, brake: true, useItem: true });
    const before = JSON.stringify(state);
    const result = applySteerAssist(state, kart, frame, 1);
    expect(result).toEqual(applySteerAssist(state, kart, frame, 1));
    expect({ ...result, steer: frame.steer }).toEqual(frame);
    expect(JSON.stringify(state)).toBe(before);
    for (const strength of [0, -1, NaN, Infinity]) expect(applySteerAssist(state, kart, frame, strength)).toBe(frame);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])('CANYON (pillars): grid slot %i laps with the assist and no input, hitting no wall or band', (slot) => {
    const state = solo('canyon');
    const grid = createRace(42, { trackId: 'canyon' }).karts[slot]!;
    const kart = state.karts[0]!;
    Object.assign(kart, { x: grid.x, y: grid.y, z: grid.z, heading: grid.heading,
      trackDistance: grid.trackDistance, lateralOffset: grid.lateralOffset });
    let wall = 0;
    let band = 0;
    while (kart.lap < 1 && state.tick < 60 * 120) {
      stepRace(state, [applySteerAssist(state, kart, input, 1)]);
      for (const event of state.events) {
        if (event.type !== 'hit') continue;
        if (event.value === 1) band++;
        else wall++;
      }
    }
    expect(kart.lap).toBe(1);
    expect({ wall, band }).toEqual({ wall: 0, band: 0 });
  });

  it.each(TRACK_IDS)('%s: at least halves wall hits over one full lap with throttle alone and no CPU', (trackId) => {
    const drive = (assisted: boolean) => {
      const state = solo(trackId);
      const kart = state.karts[0]!;
      let hits = 0;
      let speedSum = 0;
      while (kart.lap < 1 && state.tick < 60 * 600) {
        stepRace(state, [assisted ? applySteerAssist(state, kart, input, 1) : input]);
        hits += state.events.filter((event) => event.type === 'hit').length;
        speedSum += kart.speed;
      }
      return { hits, lap: kart.lap, seconds: state.time, averageSpeed: speedSum / state.tick };
    };
    const off = drive(false);
    const on = drive(true);
    expect(off.lap, JSON.stringify({ trackId, off, on })).toBe(1);
    expect(on.lap, JSON.stringify({ trackId, off, on })).toBe(1);
    expect(off.hits).toBeGreaterThan(0);
    expect(on.hits, JSON.stringify({ trackId, off, on })).toBeLessThanOrEqual(off.hits / 2);
    expect(on.seconds, JSON.stringify({ trackId, off, on })).toBeLessThan(off.seconds);
    expect(on.averageSpeed, JSON.stringify({ trackId, off, on })).toBeGreaterThan(off.averageSpeed);
  });
});

// A straight (arc ~100 to ~330 m) with a centre pillar at 130-150 m, and the same road without it.
const straightDef: TrackDef = {
  ...tracks.TRACKS.meadow, scale: 1, roadHalfWidth: 8, wallHalfWidth: 10,
  controlPoints: [[-200, 0, 0], [-100, 0, 0], [0, 0, 0], [100, 0, 0], [200, 0, 0], [260, 0, 60],
    [200, 0, 120], [100, 0, 120], [0, 0, 120], [-100, 0, 120], [-200, 0, 120], [-260, 0, 60]],
  surfaces: [], racingLine: [],
};
const plainTrack = buildTrack(straightDef);
const pillarTrack = buildTrack({ ...straightDef,
  barriers: [{ from: 130, to: 150, center: 0, halfWidth: 1.2, taper: 4, scenery: 'pillar' }] });

function onStraight(track: Track, distance: number, offset: number): { state: RaceState; kart: RaceState['karts'][number] } {
  vi.spyOn(tracks, 'getTrack').mockReturnValue(track);
  const state = createRace(42);
  state.phase = 'racing';
  state.karts = [state.karts[0]!];
  state.boxes = [];
  const kart = state.karts[0]!;
  const point = sampleTrack(track, distance);
  Object.assign(kart, { human: true, x: point.x + point.nx * offset, z: point.z + point.nz * offset,
    trackDistance: distance, lateralOffset: offset, heading: Math.atan2(point.tx, point.tz), speed: 20 });
  return { state, kart };
}

describe('M1-03 assist passages', () => {
  afterEach(() => vi.restoreAllMocks());
  // Beside a centre pillar (full width) the passages are [-9.05, -2.15] and [2.15, 9.05] in kart-centre
  // space. A 70 m pillar keeps every row of the look-ahead in that section.
  const longPillarTrack = buildTrack({ ...straightDef,
    barriers: [{ from: 130, to: 200, center: 0, halfWidth: 1.2, taper: 4, scenery: 'pillar' }] });

  it.each([[4, 0], [7.5, 0], [3, 0], [-4, 0], [-8, 0], [-3, 0.5], [4, -0.5]])(
    'keeps its own line beside the pillar while that line clears it (offset %s, steer %s)', (offset, steer) => {
      const { state, kart } = onStraight(longPillarTrack, 140, offset);
      const passage = assistPassage(state, kart, steer, 10);
      expect(passage.banded).toBe(true);
      expect(Math.abs(passage.center - offset)).toBeLessThanOrEqual(0.2);
    });

  it.each([[0, 0.5], [0, -0.5], [0.5, 0], [-0.5, 0], [0.3, -0.5]])(
    'leaves a line into the pillar nose, on the steering side when steering (offset %s, steer %s)', (offset, steer) => {
      const { state, kart } = onStraight(longPillarTrack, 110, offset);
      const { center } = assistPassage(state, kart, steer, 16);
      expect(Math.abs(center - offset)).toBeGreaterThan(0.5);
      if (steer !== 0) expect((center - offset) * steer).toBeGreaterThan(0);
    });

  // Road 3.6 with pillars at -3, 0 and 3: the only passages, [-9.05, -5.15] and [5.15, 9.05], lie off the road.
  const offRoadDef: TrackDef = { ...straightDef, roadHalfWidth: 3.6, boxRows: [0.3, 0.5, 0.7, 0.9],
    barriers: [-3, 0, 3].map(center => ({ from: 130, to: 150, center, halfWidth: 1.2, taper: 4, scenery: 'pillar' as const })) };
  const offRoadTrack = buildTrack(offRoadDef);
  const offRoad = KART_RADIUS + 4.2;

  it.each([3, -3, 6, -6, 7.5])('is never pulled back toward the centre when bands cover the road (offset %s)', (offset) => {
    expect(() => validateTrackDef(offRoadDef)).not.toThrow();
    const { state, kart } = onStraight(offRoadTrack, 115, offset);
    expect(assistPassage(state, kart, 0, 16).center * Math.sign(offset)).toBeGreaterThanOrEqual(Math.abs(offset) - 0.2);
  });

  it('keeps an off-road escape target while the kart is still on the road before the pillars', () => {
    const { state, kart } = onStraight(offRoadTrack, 110, 1.5);
    expect(assistPassage(state, kart, 0, 16).center).toBeGreaterThanOrEqual(offRoad);
  });

  it('starts steering around the pillars from 100 m, before the look-ahead reaches them', () => {
    const { state, kart } = onStraight(pillarTrack, 100, 0.5);
    // lookAhead is 16 m at 20 m/s: only the doubled scan reaches the nose at 129 m.
    const avoiding = applySteerAssist(state, kart, input, 1).steer;
    const { state: plainState, kart: plainKart } = onStraight(plainTrack, 100, 0.5);
    expect(avoiding - applySteerAssist(plainState, plainKart, input, 1).steer).toBeGreaterThan(0.1);
  });

  it('keeps an off-road target when the doubled look-ahead lies past the pillars', () => {
    const { state, kart } = onStraight(offRoadTrack, 122, -7);
    kart.speed = 16;
    expect(assistPassage(state, kart, 0, 10 + 16 * 0.3).center).toBeLessThanOrEqual(-offRoad);
  });

  // Property sweep: 2 courses x 4 starts x 7 offsets x 3 speeds = 168 runs, neutral input for 8 s.
  // Excluded, with the reason:
  // - touching: alongside a pillar with the kart centre inside or within 0.3 m of its exclusion,
  //   already in contact with the band (24 runs);
  // - out of reach: even the assist's largest correction (|steer| 0.35) held constantly to either
  //   side meets a band, so no neutral-input assist can avoid it (2 runs, 3 pillars, 20 m out at 24
  //   and 32 m/s from the centre).
  // - no safe path: at the start the assist's own path model finds no passable path, so by rule it
  //   does not intervene (the frame passes through) and the run is the unassisted one. Constant
  //   |steer| 0.35 would just clear these, beyond the authority the model assumes (2 runs, 3
  //   pillars, 20 m out at 32 m/s from offsets -1.5 and 1.5).
  const sweep = [
    { name: 'one pillar', track: pillarTrack },
    { name: 'three pillars', track: offRoadTrack },
  ].flatMap(({ name, track }) => [70, 90, 110, 140].flatMap(start => [-7, -4, -1.5, 0, 1.5, 4, 7].flatMap(offset =>
    [16, 24, 32].map(speed => ({ name, track, start, offset, speed })))));

  const drive = (track: Track, start: number, offset: number, speed: number, steer: (state: RaceState) => number) => {
    const { state, kart } = onStraight(track, start, offset);
    kart.speed = speed;
    let bandHits = 0;
    for (let tick = 0; tick < 8 * 60 && kart.trackDistance <= 150 + KART_RADIUS; tick++) {
      stepRace(state, [{ ...input, steer: steer(state) }]);
      bandHits += state.events.filter(event => event.type === 'hit' && event.value === 1).length;
    }
    return { bandHits, distance: kart.trackDistance };
  };

  it('sweeps 2 courses, 4 starts, 7 offsets and 3 speeds without a band hit', { timeout: 120_000 }, () => {
    const excluded: string[] = [];
    let checked = 0;
    for (const { name, track, start, offset, speed } of sweep) {
      const label = JSON.stringify({ name, start, offset, speed });
      const touching = (track.def.barriers ?? []).some(barrier => {
        const exclusion = exclusionAt(track, barrier, start, 0);
        return exclusion !== null && Math.abs(offset - barrier.center) < exclusion.halfWidth + 0.3;
      });
      if (touching) { excluded.push(`touching ${label}`); continue; }
      if ([-0.35, 0.35].every(steer => drive(track, start, offset, speed, () => steer).bandHits > 0)) {
        excluded.push(`out of reach ${label}`);
        continue;
      }
      const start0 = onStraight(track, start, offset);
      start0.kart.speed = speed;
      if (assistPassage(start0.state, start0.kart, 0, 10 + speed * 0.3).aim === null) {
        excluded.push(`no safe path ${label}`);
        continue;
      }
      checked++;
      const run = drive(track, start, offset, speed, state => {
        const kart = state.karts[0]!;
        // Deliberate input of 0.05 or more keeps its direction here too.
        for (const steer of [-0.5, -0.05, 0.05, 0.5]) {
          expect(applySteerAssist(state, kart, { ...input, steer }, 1).steer * steer, label).toBeGreaterThanOrEqual(0);
        }
        return applySteerAssist(state, kart, input, 1).steer;
      });
      expect(run.bandHits, label).toBe(0);
      expect(run.distance, label).toBeGreaterThan(150 + KART_RADIUS);
    }
    expect(sweep).toHaveLength(168);
    expect(excluded.filter(reason => reason.startsWith('touching'))).toHaveLength(3 * 3 + 5 * 3);
    expect(excluded.filter(reason => reason.startsWith('out of reach'))).toEqual([
      'out of reach {"name":"three pillars","start":110,"offset":0,"speed":24}',
      'out of reach {"name":"three pillars","start":110,"offset":0,"speed":32}',
    ]);
    expect(excluded.filter(reason => reason.startsWith('no safe path'))).toEqual([
      'no safe path {"name":"three pillars","start":110,"offset":-1.5,"speed":32}',
      'no safe path {"name":"three pillars","start":110,"offset":1.5,"speed":32}',
    ]);
    expect(checked).toBe(168 - 28);
  });

  const bandHits = (track: Track, start: number, offset: number, speed: number, assisted: boolean) => {
    const { state, kart } = onStraight(track, start, offset);
    kart.speed = speed;
    let hits = 0;
    for (let tick = 0; tick < 8 * 60; tick++) {
      stepRace(state, [assisted ? applySteerAssist(state, kart, input, 1) : input]);
      hits += state.events.filter(event => event.type === 'hit' && event.value === 1).length;
    }
    return hits;
  };

  // A gentle curve: a 100 m circle (16 control points).
  const circleDef: TrackDef = { ...straightDef, roadHalfWidth: 5, wallHalfWidth: 6, checkpointCount: 1,
    boxRows: [0.3, 0.5, 0.7, 0.9],
    controlPoints: Array.from({ length: 16 }, (_, i) => [100 * Math.cos(i * Math.PI / 8), 0, 100 * Math.sin(i * Math.PI / 8)] as [number, number, number]) };

  // A band contact: a band hit (value 1), or the kart centre within 0.05 m of a band's exclusion edge
  // or inside it. collideCorridor can stop a kart dead on a nose next to a wall without a hit event
  // (seen: 23.6 -> 1.2 m/s, no event), so hits alone would credit the unassisted run for that crash.
  const bandContacts = (track: Track, start: number, offset: number, speed: number, assisted: boolean, heading = 0) => {
    const { state, kart } = onStraight(track, start, offset);
    kart.speed = speed;
    kart.heading += heading;
    let contacts = 0;
    let touching = false;
    for (let tick = 0; tick < 8 * 60; tick++) {
      stepRace(state, [assisted ? applySteerAssist(state, kart, input, 1) : input]);
      const wall = widthAt(track, kart.trackDistance).wallHalfWidth;
      const clearance = Math.max(...corridorAt(track, kart.trackDistance, state.time).map(({ min, max }) =>
        Math.min(min === -wall ? Infinity : kart.lateralOffset - min, max === wall ? Infinity : max - kart.lateralOffset)));
      const now = state.events.some(event => event.type === 'hit' && event.value === 1) || clearance < 0.05;
      if (now && !touching) contacts++;
      touching = now;
    }
    return contacts;
  };

  it('does not intervene when no path clears the band (reversed loop, angled start at a nose)', () => {
    const def: TrackDef = { ...straightDef, controlPoints: [...straightDef.controlPoints].reverse(),
      roadHalfWidth: 5, wallHalfWidth: 8.06, checkpointCount: 1, boxRows: [0.3, 0.5, 0.7, 0.9],
      barriers: [{ from: 519.41, to: 560.2, center: -6.17, halfWidth: 2.17, taper: 4.58 }] };
    expect(() => validateTrackDef(def)).not.toThrow();
    const track = buildTrack(def);
    const on = bandContacts(track, 512.84, -6.07, 18.87, true, -0.69);
    const off = bandContacts(track, 512.84, -6.07, 18.87, false, -0.69);
    expect(on).toBeLessThanOrEqual(off);
    // At the start no path is passable: the frame passes through untouched, steering or not.
    const { state, kart } = onStraight(track, 512.84, -6.07);
    Object.assign(kart, { speed: 18.87, heading: kart.heading - 0.69 });
    expect(assistPassage(state, kart, 0, 10 + 18.87 * 0.3).aim).toBeNull();
    for (const steer of [0, -0.5, -0.05, 0.05, 0.5]) {
      const frame = { ...input, steer };
      expect(applySteerAssist(state, kart, frame, 1)).toBe(frame);
    }
  });

  it('steers the chosen path, not beyond it, past a wall-side band on a gentle curve (75 starts)', () => {
    const def: TrackDef = { ...circleDef, barriers: [{ from: 160, to: 180, center: 5, halfWidth: 1.2, taper: 4 }] };
    expect(() => validateTrackDef(def)).not.toThrow();
    const track = buildTrack(def);
    const worse: string[] = [];
    for (const start of [138, 139, 140, 141, 142]) {
      for (const offset of [3.8, 3.9, 4, 4.1, 4.2]) {
        for (const speed of [30, 32, 34]) {
          const on = bandContacts(track, start, offset, speed, true);
          const off = bandContacts(track, start, offset, speed, false);
          if (on > off) worse.push(JSON.stringify({ start, offset, speed, on, off }));
        }
      }
    }
    expect(worse).toEqual([]);
    expect(bandHits(track, 140, 4, 32, true)).toBeLessThanOrEqual(bandHits(track, 140, 4, 32, false));
  });

  it('does not cross the current safe passage toward the centre beside a short wall-side band', () => {
    const def: TrackDef = { ...straightDef, roadHalfWidth: 3.6, boxRows: [0.3, 0.5, 0.7, 0.9],
      barriers: [{ from: 130, to: 134, center: -3, halfWidth: 1.2, taper: 4 }] };
    expect(() => validateTrackDef(def)).not.toThrow();
    const track = buildTrack(def);
    expect(bandHits(track, 100, -7, 32, true)).toBe(0);
    expect(bandHits(track, 100, -7, 32, false)).toBe(0);
  });

  // Fuzz: random validated layouts (short bands, varied tapers, wall-side bands, 1-3 pillars, on
  // straights, curves, a gentle circle and across the lap seam) with random tangent starts, offsets
  // and speeds. Neutral
  // input for 8 s with the assist ON never makes more band contacts than with it OFF.
  it('never adds band contacts over the unassisted kart on 400 random validated layouts', () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const between = (min: number, max: number) => min + (max - min) * random();
    const circleTrack = buildTrack(circleDef);
    const failures: string[] = [];
    const multiBandFailures: string[] = [];
    let multiBand = 0;
    let cases = 0;
    let attempts = 0;
    const kinds = new Set<string>();
    while (cases < 400) {
      attempts++;
      expect(attempts).toBeLessThan(20_000);
      const circle = random() < 0.35;
      const base = circle ? circleDef : straightDef;
      const length = circle ? circleTrack.length : plainTrack.length;
      const roadHalfWidth = [3.6, 5, 7.2][Math.floor(random() * 3)]!;
      const wallHalfWidth = roadHalfWidth + between(0.5, 5);
      const anchor = random() < 0.15 ? length - between(0, 20) : between(0, length);
      const single = circle && random() < 0.5;
      const count = single ? 1 : 1 + Math.floor(random() * 3);
      const barriers = Array.from({ length: count }, () => {
        const taper = between(2, 9);
        const halfWidth = between(0.3, Math.min(3, taper / 2));
        const span = random() < 0.4 ? between(2, 8) : between(8, 50);
        const from = (anchor + between(-6, 6) + length) % length;
        const wallSide = single || random() < 0.25;
        const center = wallSide ? Math.sign(random() - 0.5) * (wallHalfWidth - between(0, 1.5)) : between(-wallHalfWidth, wallHalfWidth);
        return { from, to: (from + span) % length, center, halfWidth, taper };
      });
      const def: TrackDef = { ...base, roadHalfWidth, wallHalfWidth, boxRows: [0.3, 0.5, 0.7, 0.9], barriers };
      try { validateTrackDef(def); } catch { continue; }
      cases++;
      kinds.add(`${count} bands`);
      if (barriers.some(barrier => (barrier.to - barrier.from + length) % length < 8)) kinds.add('short');
      if (barriers.some(barrier => Math.abs(barrier.center) > wallHalfWidth - 1.5)) kinds.add('wall side');
      if (barriers.some(barrier => barrier.to < barrier.from)) kinds.add('seam');
      if (circle) kinds.add(single ? 'circle, one wall-side band' : 'circle');
      else if (anchor > 330 && anchor < 1100) kinds.add('curve');
      const track = buildTrack(def);
      const start = (anchor - between(10, 70) + length) % length;
      const offset = between(-wallHalfWidth + 1, wallHalfWidth - 1);
      const speed = between(10, 34);
      const on = bandContacts(track, start, offset, speed, true);
      const off = bandContacts(track, start, offset, speed, false);
      if (count > 1) multiBand++;
      if (on > off) (count === 1 ? failures : multiBandFailures)
        .push(JSON.stringify({ circle, barriers, roadHalfWidth, wallHalfWidth, start, offset, speed, on, off }));
    }
    // One band: never worse. Two or three bands packed within a few metres (often in a turn) may
    // be worse in up to 3 % of such layouts (an upper bound for this fixed seed): synthetic packed
    // layouts where a kart stopped head-on at a nose, still facing forward, touches a band again as
    // the assist steers away. Real courses are covered by the M1-06 E2E.
    expect(failures).toEqual([]);
    expect(multiBandFailures.length).toBeLessThanOrEqual(Math.ceil(multiBand * 0.03));
    expect([...kinds].sort()).toEqual(['1 bands', '2 bands', '3 bands', 'circle', 'circle, one wall-side band', 'curve', 'seam', 'short', 'wall side']);
  }, 120_000);

  it('keeps the road centre and roadHalfWidth - |offset| exactly on roads without bands', () => {
    // Courses with bands or width keys (CANYON since M1-05) are covered by the banded tests above.
    const plain = TRACK_IDS.filter(id => !getTrack(id).def.barriers?.length && !getTrack(id).def.widthKeys?.length);
    expect(plain.length).toBeGreaterThanOrEqual(3);
    for (const trackId of plain) {
      const track = getTrack(trackId);
      const state = solo(trackId);
      const kart = state.karts[0]!;
      for (const distance of [0, 123.4, track.length / 2]) {
        for (const offset of [-11, -7.25, -0.3, 0, 0.3, 2, 6.9, 11]) {
          Object.assign(kart, { trackDistance: distance, lateralOffset: offset });
          for (const steer of [-1, 0, 0.5]) {
            expect(assistPassage(state, kart, steer, 16)).toEqual({ center: 0,
              edgeDistance: track.def.roadHalfWidth - Math.abs(offset), banded: false });
          }
        }
      }
    }
  });

  it('gives bit-identical output away from the pillar', () => {
    for (const distance of [60, 160, 300]) {
      for (const offset of [-7.6, -5, -1, 0, 1, 5, 7.6]) {
        for (const heading of [-0.3, 0, 0.3]) {
          for (const steer of [-1, -0.2, -0.01, 0, 0.01, 0.2, 1]) {
            const run = (track: Track) => {
              const { state, kart } = onStraight(track, distance, offset);
              kart.heading += heading;
              return applySteerAssist(state, kart, { ...input, steer }, 1).steer;
            };
            expect(run(pillarTrack), JSON.stringify({ distance, offset, heading, steer })).toBe(run(plainTrack));
          }
        }
      }
    }
  });
});

// Controls integration lives here because Controls.test.ts is outside H4's file lock.
describe('Controls steer assist', () => {
  let controls: Controls | undefined;
  afterEach(() => { controls?.dispose(); vi.unstubAllGlobals(); });

  function setup(touch: boolean) {
    const win = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: touch }) });
    const root = Object.assign(new EventTarget(), {
      querySelector: () => null,
      classList: { toggle: () => undefined },
    });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal('navigator', { getGamepads: () => [] });
    controls = new Controls(root as unknown as HTMLElement);
    controls.setEnabled(true);
    controls.setAutoAccelerate(true);
    return { controls, win, root };
  }

  it.each([true, false])('defaults to touch=%s and applies the actual ON/OFF setting in sample', (touch) => {
    const { controls } = setup(touch);
    const { state, kart } = straight();
    kart.heading += 0.25;
    expect(controls.steerAssist).toBe(touch);
    controls.setSteerAssist(false);
    const off = controls.sample(state, kart.id);
    expect(off.steer).toBe(0);
    controls.setSteerAssist(true);
    expect(controls.sample(state, kart.id)).toEqual(applySteerAssist(state, kart, off, 1));
    expect(controls.sample(state, kart.id).steer).toBeLessThan(0);
    controls.setEnabled(false);
    expect(controls.sample(state, kart.id).steer).toBe(0);
  });

  it('defaults to OFF for an active gamepad and keeps explicit preferences', () => {
    const { controls } = setup(true);
    const { state, kart } = straight();
    vi.stubGlobal('navigator', { getGamepads: () => [{ connected: true, axes: [0.5], buttons: [] }] });
    controls.sample(state, kart.id);
    expect(controls.steerAssist).toBe(false);
    controls.setSteerAssist(true);
    controls.sample(state, kart.id);
    expect(controls.steerAssist).toBe(true);
  });

  it('preserves the first gamepad item press when switching from touch', () => {
    const { controls } = setup(true);
    const { state, kart } = straight();
    const buttons = Array.from({ length: 6 }, (_, index) => ({ pressed: index === 5, value: index === 5 ? 1 : 0 }));
    vi.stubGlobal('navigator', { getGamepads: () => [{ connected: true, axes: [0], buttons }] });
    expect(controls.sample(state, kart.id).useItem).toBe(true);
    expect(controls.steerAssist).toBe(false);
    controls.reset();
    expect(controls.sample(state, kart.id).useItem).toBe(false);
  });

  it('follows late touch/keyboard detection until the player chooses a preference', () => {
    const { controls, root, win } = setup(false);
    const touch = () => root.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerType: 'touch' }));
    const keyboard = () => win.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyW' }));
    touch();
    expect(controls.steerAssist).toBe(true);
    keyboard();
    expect(controls.steerAssist).toBe(false);
    controls.setSteerAssist(false);
    touch();
    expect(controls.steerAssist).toBe(false);
  });
});

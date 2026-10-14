import { vi } from 'vitest';
import { createRace, stepRace } from '../sim/race';
import { buildTrack, sampleTrack } from '../sim/track';
import * as tracks from '../sim/tracks';
import { KART_RADIUS, validateCoursePlayability, validateTrackDef, widthAt } from '../sim/corridor';
import { islandSplit } from '../sim/tracks/features';
import type { InputFrame, RaceState, Track, TrackDef } from '../sim/types';
import { applySteerAssist } from './assist';

// M2-03 fixtures: the assist on islands (islandSplit), accepted statistically. The scenarios live in
// separate assist.island*.test.ts files so vitest runs them in parallel workers.

/** Fuzz runs per scenario (budget: each island test file within 15 s locally, 3x on CI). */
export const RUNS = 500;

export const input: InputFrame = { steer: 0, throttle: 1, brake: false, drift: false, useItem: false };

// The straight of assist.test.ts (arc ~100 to ~330 m).
export const straightDef: TrackDef = {
  ...tracks.TRACKS.meadow, scale: 1, roadHalfWidth: 8, wallHalfWidth: 10,
  controlPoints: [[-200, 0, 0], [-100, 0, 0], [0, 0, 0], [100, 0, 0], [200, 0, 0], [260, 0, 60],
    [200, 0, 120], [100, 0, 120], [0, 0, 120], [-100, 0, 120], [-200, 0, 120], [-260, 0, 60]],
  surfaces: [], racingLine: [],
};

export function onStraight(track: Track, distance: number, offset: number): { state: RaceState; kart: RaceState['karts'][number] } {
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

export const seeded = (initial: number) => {
  let seed = initial;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return { random, between: (min: number, max: number) => min + (max - min) * random() };
};
// The straight (arc ~100 to ~330 m) and a radius-40 circle (all curve). Coarser samples keep the
// fuzz within its time budget; item boxes and the start grid are kept clear of the bands.
export const courses = [
  { def: { ...straightDef, samplesPerSegment: 8, boxRows: [0.5, 0.6, 0.7, 0.8] }, from: 170 },
  { def: { ...straightDef, samplesPerSegment: 4, checkpointCount: 1, boxRows: [0.1, 0.2, 0.3, 0.34],
    controlPoints: Array.from({ length: 16 }, (_, i) =>
      [40 * Math.cos(i * Math.PI / 8), 0, 40 * Math.sin(i * Math.PI / 8)] as [number, number, number]) }, from: 145 },
];

/** A validated layout: one islandSplit (half-width 5-8), plus `pillars` bands placed until it validates. */
export const islandCourse = (between: (min: number, max: number) => number, curve: boolean, pillars: number, minLane = 6) => {
  const { def: base, from } = courses[curve ? 1 : 0]!;
  for (let attempt = 0; attempt < 2000; attempt++) {
    const islandHalf = between(5, 8);
    const taper = between(8, 16);
    const to = from + Math.max(2 * (KART_RADIUS + Math.max(taper, 2 * islandHalf)) + 4, between(50, 75));
    const island = islandSplit({ from, to, islandHalf, laneWidth: between(minLane, 12), taper, scenery: 'rock', risky: 'inner', bend: 1 });
    const wide = island.widthKeys[1]!.wallHalfWidth;
    // Pillars either before the 35 m lane-selection approach (anywhere across) or against a lane's wall.
    const extra = Array.from({ length: pillars }, () => {
      const halfWidth = between(0.4, 1.5);
      const early = between(0, 1) < 0.5;
      const start = early ? between(from - 50, from - 45) : between(from, to - 4);
      const center = early ? between(-4, 4) : Math.sign(between(-1, 1)) * (wide - between(0, 1));
      return { from: start, to: start + between(2, 12), center, halfWidth, taper: Math.max(2 * halfWidth, between(2, 6)), scenery: 'pillar' as const };
    });
    const def: TrackDef = { ...base, ...island, barriers: [...island.barriers, ...extra] };
    // validateCoursePlayability too, so the layout set never depends on which rules validateTrackDef runs.
    try { validateTrackDef(def); validateCoursePlayability(def); } catch { continue; }
    return { def, track: buildTrack(def), from, islandHalf };
  }
  throw new Error('no valid island layout');
};

/**
 * Band hits (value 1) and other hits except pits (value 2), with head-on band hits (> 30 % speed lost),
 * the ticks driven (the denominator when `stop` ends the run early) and wallContactTicks: the longest
 * run of consecutive ticks, from a wall hit on, with |lateralOffset| >= wallHalfWidth - R - 0.2
 * (a brush counts a tick or two; sliding along the wall counts its whole length).
 */
export const run = (track: Track, start: number, offset: number, heading: number, speed: number, steer: number,
  assisted: boolean, ticks: number, stop: (kart: RaceState['karts'][number]) => boolean) => {
  const { state, kart } = onStraight(track, start, offset);
  kart.speed = speed;
  kart.heading += heading;
  let band = 0;
  let wall = 0;
  let headOn = 0;
  let driven = 0;
  let wallContactTicks = 0;
  let contact = -1;
  const frame = { ...input, steer };
  for (; driven < ticks && !stop(kart); driven++) {
    const before = kart.speed;
    stepRace(state, [assisted ? applySteerAssist(state, kart, frame, 1) : frame]);
    for (const event of state.events) {
      if (event.type !== 'hit') continue;
      if (event.value === 1) {
        band++;
        if (kart.speed < before * 0.7) headOn++;
      } else if (event.value !== 2) {
        wall++;
        contact = Math.max(contact, 0);
      }
    }
    if (contact < 0) continue;
    const near = Math.abs(kart.lateralOffset) >= widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS - 0.2;
    contact = near ? contact + 1 : -1;
    wallContactTicks = Math.max(wallContactTicks, contact);
  }
  return { band, wall, headOn, ticks: driven, wallContactTicks, kart };
};

// `count` runs per layout set from fixed seeds: lateral offset across the wall, heading error ±25°,
// 12-32 m/s, steer 0 / ±0.3 held, full throttle for 4 s from 5-60 m before the island. A run stops
// early past the last band, so wall hits are counted per tick driven (totals.onTicks / offTicks).
export const fuzz = (seed: number, curve: boolean | null, pillars: number, count: number) => {
  const { random, between } = seeded(seed);
  const worse: string[] = [];
  const totals = { onBand: 0, offBand: 0, onWall: 0, offWall: 0, onTicks: 0, offTicks: 0 };
  // Per run, wallContactTicks of the assisted and the plain run (0 without a wall hit).
  const wallContact = { on: [] as number[], off: [] as number[] };
  for (let i = 0; i < count; i++) {
    const isCurve = curve ?? random() < 0.5;
    const { def, track, from } = islandCourse(between, isCurve, pillars);
    const start = from - between(5, 60);
    const limit = widthAt(track, start).wallHalfWidth - KART_RADIUS;
    const offset = between(-limit, limit);
    const heading = between(-25, 25) * Math.PI / 180;
    const speed = between(12, 32);
    const steer = [0, 0.3, -0.3][Math.floor(random() * 3)]!;
    // Past every band nothing more can be hit (the lap cannot wrap within 4 s): stop there.
    const end = Math.max(...(def.barriers ?? []).map(barrier => barrier.to)) + KART_RADIUS;
    const past = (kart: RaceState['karts'][number]) => kart.trackDistance > end && kart.trackDistance < end + 50;
    const on = run(track, start, offset, heading, speed, steer, true, 4 * 60, past);
    const off = run(track, start, offset, heading, speed, steer, false, 4 * 60, past);
    totals.onBand += on.band;
    totals.offBand += off.band;
    totals.onWall += on.wall;
    totals.offWall += off.wall;
    totals.onTicks += on.ticks;
    totals.offTicks += off.ticks;
    wallContact.on.push(on.wallContactTicks);
    wallContact.off.push(off.wallContactTicks);
    if (on.band > off.band) {
      worse.push(JSON.stringify({ i, curve: isCurve, barriers: def.barriers, start, offset, heading, speed, steer, on: on.band, off: off.band }));
    }
  }
  return { worse, totals, wallContact };
};

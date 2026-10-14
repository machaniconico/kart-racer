import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAIInput } from './ai';
import { createRace, DRIFT_BLUE_TIME, DRIFT_ORANGE_TIME, FIXED_DT, KART_RADIUS, NEUTRAL_INPUT, stepRace } from './race';
import { buildTrack, sampleTrack } from './track';
import * as tracks from './tracks';
import { LEGACY_MEADOW } from './tracks/legacyMeadow.fixture';
import { corridorAt, exclusionAt, widthAt } from './corridor';
import { applySteerAssist } from '../input/assist';
import { getAiLineOffset } from './itemAi';
import { islandSplit } from './tracks/features';
import type { Barrier, RaceState, Track } from './types';

afterEach(() => vi.restoreAllMocks());

// A wide straight isolates turning from walls, grass, items and other karts.
const handlingTrack = buildTrack({
  ...LEGACY_MEADOW, scale: 1, roadHalfWidth: 300, wallHalfWidth: 400,
  controlPoints: [[-1500, 0, 0], [-1000, 0, 0], [-500, 0, 0], [0, 0, 0],
    [500, 0, 0], [1000, 0, 0], [1500, 0, 0], [1500, 0, 1000], [-1500, 0, 1000]],
  surfaces: [], racingLine: [],
});

function soloRace(speed: number, steer = 0, direction = 0): RaceState {
  vi.spyOn(tracks, 'getTrack').mockReturnValue(handlingTrack);
  const state = createRace(1);
  state.phase = 'racing';
  state.karts = [state.karts[0]!];
  state.boxes = [];
  const kart = state.karts[0]!;
  const start = sampleTrack(handlingTrack, 1500);
  Object.assign(kart, { x: start.x, y: start.y, z: start.z, heading: Math.atan2(start.tx, start.tz),
    speed, steer, trackDistance: 1500, lateralOffset: 0, driftDirection: direction,
    driftTime: direction ? 1 : 0, previousDrift: direction !== 0 });
  return state;
}

function turn(speed: number, steer: number, direction = 0) {
  const state = soloRace(speed, steer, direction);
  const kart = state.karts[0]!;
  let distance = 0;
  let angle = 0;
  let oldAngle = 0;
  let maxYaw = 0;
  for (let tick = 0; tick < 30; tick++) {
    // Hold the operating speed so acceleration cannot hide a steering regression.
    kart.speed = speed;
    const { x, z, heading } = kart;
    stepRace(state, [{ ...NEUTRAL_INPUT, steer, throttle: 1, drift: direction !== 0 }]);
    distance += Math.hypot(kart.x - x, kart.z - z);
    const yaw = Math.atan2(Math.sin(kart.heading - heading), Math.cos(kart.heading - heading));
    angle += yaw;
    maxYaw = Math.max(maxYaw, Math.abs(yaw) / FIXED_DT);
    oldAngle += steer * (direction ? 1.95 : 1.72) * Math.min(1, kart.speed / 12) * FIXED_DT;
    expect(state.events.some(event => event.type === 'hit')).toBe(false);
  }
  return { radius: distance / Math.abs(angle), oldRadius: distance / Math.abs(oldAngle), angle, maxYaw };
}

describe('H1 handling', () => {
  it.each([8, 15, 25])('turns tighter than v7 at %i m/s with full steer and throttle', speed => {
    const result = turn(speed, 1);
    expect(result.radius).toBeLessThan(result.oldRadius);
  });

  it.each([25, 30, 35, 45, 60, 90])('caps high-speed yaw at 1.3x v7 at %i m/s', speed => {
    expect(turn(speed, 1).maxYaw).toBeLessThanOrEqual(1.72 * 1.3);
    for (const direction of [-1, 1]) {
      expect(turn(speed, direction, direction).maxYaw).toBeLessThanOrEqual(1.95 * 1.3);
    }
  });

  it.each([-1, 1])('keeps drift direction %i under neutral and reverse steering', direction => {
    const inside = turn(15, direction, direction);
    const neutral = turn(15, 0, direction);
    const outside = turn(15, -direction, direction);
    expect(outside.angle * direction).toBeGreaterThan(0);
    expect(neutral.angle * direction).toBeGreaterThan(outside.angle * direction);
    expect(inside.angle * direction).toBeGreaterThan(neutral.angle * direction);
    for (const speed of [9, 15, 25, 35]) {
      expect(turn(speed, direction, direction).radius).toBeLessThanOrEqual(turn(speed, direction).radius * 0.75);
    }
  });

  it.each([-1, 1])('latches direction %i on entry and keeps it through sustained countersteering', direction => {
    const state = soloRace(20);
    const kart = state.karts[0]!;
    stepRace(state, [{ ...NEUTRAL_INPUT, steer: direction, throttle: 1, drift: true }]);
    expect(kart.driftDirection).toBe(direction);
    for (let tick = 0; tick < 120; tick++) {
      const heading = kart.heading;
      stepRace(state, [{ ...NEUTRAL_INPUT, steer: -direction, throttle: 1, drift: true }]);
      expect(kart.driftDirection).toBe(direction);
      const angle = Math.atan2(Math.sin(kart.heading - heading), Math.cos(kart.heading - heading));
      expect(angle * direction).toBeGreaterThan(0);
    }
  });

  it.each([[0.65 - FIXED_DT, 0], [0.65, 0.65], [1.5 - FIXED_DT, 0.65], [1.5, 1.25]])(
    'preserves the mini-turbo boundary at %s seconds and awards %s seconds', (charge, duration) => {
      expect(DRIFT_BLUE_TIME).toBe(0.65);
      expect(DRIFT_ORANGE_TIME).toBe(1.5);
      const state = soloRace(20, 1, 1);
      const kart = state.karts[0]!;
      kart.driftTime = charge!;
      stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
      expect(kart.boostTime).toBe(duration);
      expect(kart.driftDirection).toBe(0);
      expect(kart.driftTime).toBe(0);
    },
  );
});

// BASELINE: recorded CPU pace per course. Only a story that changes a course's data may replace
// its row, listing the old and new values with the reason (plan §2.1).
// Version v7: measured with the v7 sim (5e3aedc) on darwin-arm64 before the H1 physics/AI edits.
// Method: eight CPUs (racers: []), seeds [1, 42, 98765], three laps each (72 laps per course).
// wallHits counts hits at the outer corridor edge; bandHits counts hits on a band (none in v7).
// M1-05 / CANYON layout 2: 4m half-width passage, 50m dirt and two centre pillars.
// Fix pass: move pillar one to 136–152m for 8m of item-row clearance and hold its approach line;
// delay the narrow section by 20m for steering recovery; start the move for pillar two at 320m.
// Band hits by seed [1, 42, 98765]: [0, 0, 0].
// Recorded on darwin-arm64 with the same 8 CPUs × 3 seeds × 3 laps; table for M1-07 SPEC handoff:
// | Layout / protocol | Mean lap (s)        | Wall hits | Band hits | Band budget |
// | 1 / v7 (old)       | 18.825925925925926  | 0         | 0         | 0           |
// | 2 / v9 (new)       | 21.48611111111111   | 0         | 0         | 2           |
// M2-05 / CANYON layout 3: inner dirt/boost/jump/pit, paved outer lane and a rock island.
// Recorded on darwin-arm64, 8 CPUs × seeds [1, 42, 98765] × 3 laps:
// | Layout / protocol | Mean lap (s)       | Wall hits | Band hits | Pit falls | Risky passes | Band budget |
// | 2 / v9 (old)       | 21.48611111111111  | 0         | 0         | 0         | n/a          | 2           |
// | 3 / v10 (new)      | 20.094907407407405 | 0         | 1         | 0         | 24 / 72      | 4           |
// Both lanes were used by all 8 CPU IDs across the three seeds; safe/risky passes: 48/24.
// The one band hit is an item spin-out into the first centre pillar (seed 98765, 135 m), not the island.
// M2.5-01: +30% road/wall widths and box lanes; open MEADOW/SNOWPEAK bends, widen NEON's line.
// Recorded on darwin-arm64, 8 CPUs × seeds [1, 42, 98765] × 3 laps (72 laps per course).
// | Course   | Protocol  | Mean lap (s)       | Wall hits | Band hits |
// | meadow   | v7 (old)  | 18.50972222222222   | 3         | 0         |
// | meadow   | v11 (new) | 18.537268518518516  | 0         | 0         |
// | snowpeak | v7 (old)  | 18.057175925925925  | 0         | 0         |
// | snowpeak | v11 (new) | 17.939814814814813  | 0         | 0         |
// | neon     | v7 (old)  | 18.24861111111111   | 1         | 0         |
// | neon     | v11 (new) | 18.441435185185185  | 0         | 0         |
// M2.5-02 / CANYON layout 4: +30% widths (narrow passage 5.2 / 9.49, island lanes 11.7, line -5.85),
// inner dirt from +26 instead of +32. Recorded on darwin-arm64, 8 CPUs × seeds [1, 42, 98765] × 3 laps:
// | Layout / protocol | Mean lap (s)       | Wall hits | Band hits | Pit falls | Risky passes | Band budget |
// | 3 / v10 (old)      | 20.094907407407405 | 0         | 1         | 0         | 24 / 72      | 4           |
// | 4 / v11 (new)      | 19.67476851851852  | 0         | 0         | 0         | 24 / 72      | 4           |
// Ratio new/old 0.979. Both lanes were used by all 8 CPU IDs in every seed; safe/risky passes: 48/24.
// M3-05 / NEON layout 3: sweep, gate and spin floor with early detours.
// Placement adjustments: sweep center 0 -> -2 m; gate taper 4 -> 8 m (halfWidth / taper <= 0.5).
// Recorded on darwin-arm64, 8 CPUs × seeds [1, 42, 98765] × 3 laps (72 laps):
// | Layout / protocol | Mean lap (s)       | Wall hits | Band hits |
// | 2 / v11 (old)     | 18.441435185185185 | 0         | 0         |
// | 3 / v12 (new)     | 18.308796296296297 | 0         | 3         |
// Band hits by seed: [2, 1, 0]; all at the gate. New/old mean-lap ratio: 0.993.
// M4-01: slope physics (grade scales maxSpeed / acceleration, gravity while coasting) acts on the
// existing heights of MEADOW / CANYON / SNOWPEAK; NEON is flat and unchanged bit for bit.
// Recorded on darwin-arm64, 8 CPUs × seeds [1, 42, 98765] × 3 laps (72 laps per course):
// | Course   | Protocol  | Mean lap (s)       | Wall hits | Band hits | New/old |
// | meadow   | v11 (old) | 18.537268518518516 | 0         | 0         |         |
// | meadow   | v13 (new) | 18.854398148148153 | 0         | 0         | 1.017   |
// | canyon   | v11 (old) | 19.67476851851852  | 0         | 4         |         |
// | canyon   | v13 (new) | 19.76342592592593  | 0         | 0         | 1.005   |
// | snowpeak | v11 (old) | 17.939814814814813 | 0         | 0         |         |
// | snowpeak | v13 (new) | 17.86990740740741  | 0         | 0         | 0.996   |
// CANYON keeps its band-hit budget of 4 (measured 0 here).
// M4-05 / SNOWPEAK layout 3: 19.43m elevation range, 20.11% climb and one banked sweeper.
// Recorded on darwin-arm64, 8 CPUs × seeds [1, 42, 98765] × 3 laps (72 laps):
// | Layout / protocol | Mean lap (s)       | Wall hits | Band hits | New/old |
// | 2 / v13 (M4-01)   | 17.86990740740741  | 0         | 0         |         |
// | 3 / v13 (M4-05)   | 17.727314814814815 | 0         | 0         | 0.992   |
// M4.5-03 / v14: 24 boxes change CPU pickups and item use; course layout versions stay unchanged.
// Measured on darwin-arm64, 8 CPUs × seeds [1, 42, 98765] × 3 laps (72 laps per course):
// | Course   | Old version / mean lap (s) | New mean lap (s)   | New/old | Wall old/new | Band old/new |
// | meadow   | v13 / 18.854398148148153   | 19.105555555555558 | 1.0133  | 0 / 0        | 0 / 0        |
// | canyon   | v13 / 19.76342592592593    | 20.39398148148148  | 1.0319  | 0 / 0        | 4 / 1        |
// | snowpeak | v13 / 17.727314814814815   | 18.92245370370371  | 1.0674  | 0 / 0        | 0 / 0        |
// | neon     | v12 / 18.308796296296297   | 19.16759259259259  | 1.0469  | 0 / 0        | 3 / 2        |
// NEON's added rows at ~158 / 309 m caused 5 band hits; moving them to ~132 / 283 m
// clears the bands and their 40 m approaches. Band hits by seed are now [1, 0, 1].
// M5-05 / v15: rebuilt courses, measured on darwin-arm64 with the same 72-lap method.
// | Course   | v14 mean lap (s)   | v15 mean lap (s)   | Wall old/new | Band old/new |
// | meadow   | 19.105555555555558 | 68.5011574074074   | 0 / 0        | 0 / 0        |
// | canyon   | 20.39398148148148  | 68.49583333333334  | 0 / 0        | 1 / 0        |
// | snowpeak | 18.92245370370371  | 67.89120370370368  | 0 / 0        | 0 / 0        |
// | neon     | 19.16759259259259  | 64.32939814814814  | 0 / 0        | 2 / 1        |
// All values match the M5-01–04 reports (rounding only); NEON's band hit is seed 1.
type Baseline = { version: 'v15'; meanLap: number; wallHits: number; bandHits: number };
const BASELINE: Record<(typeof tracks.TRACK_IDS)[number], Baseline> = {
  meadow: { version: 'v15', meanLap: 68.5011574074074, wallHits: 0, bandHits: 0 },
  canyon: { version: 'v15', meanLap: 68.49583333333334, wallHits: 0, bandHits: 0 },
  snowpeak: { version: 'v15', meanLap: 67.89120370370368, wallHits: 0, bandHits: 0 },
  neon: { version: 'v15', meanLap: 64.32939814814814, wallHits: 0, bandHits: 1 },
};
const SEEDS = [1, 42, 98765];

/**
 * Splits hit events: value 1 (collideCorridor) is a band hit; a hit without a value with the kart
 * at the outer wall limit (wallHalfWidth at its arc distance) is a wall hit; anything else (an item hit) is neither.
 */
function countHits(state: RaceState, track: Track): { wall: number; band: number } {
  let wall = 0;
  let band = 0;
  for (const event of state.events) {
    if (event.type !== 'hit') continue;
    if (event.value === 1) { band++; continue; }
    if (event.value === 2) continue;
    const kart = state.karts[event.kartId]!;
    const offset = kart.lateralOffset;
    const limit = widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS;
    if (Math.abs(offset) >= limit - 0.01) wall++;
  }
  return { wall, band };
}

describe('H1 CPU balance: absolute range and recorded baseline', () => {
  it.each(tracks.TRACK_IDS)('finishes and replays all 72 laps on %s within pace and hit budgets', trackId => {
    let totalLapTime = 0;
    let wallHits = 0;
    let bandHits = 0;
    let pitFalls = 0;
    let riskyPasses = 0;
    const track = tracks.getTrack(trackId);
    const split = track.def.splits?.[0];
    const passes = new Set<string>();
    for (const seed of SEEDS) {
      const laneUsers = split?.lanes.map(() => new Set<number>());
      const state = createRace(seed, { trackId, racers: [] });
      let restored: RaceState = JSON.parse(JSON.stringify(state));
      for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
        if (split) {
          for (const kart of state.karts) {
            if (kart.finishTime !== null || kart.trackDistance < split.from ||
              kart.trackDistance >= split.to) continue;
            const key = `${seed}:${kart.id}:${kart.lap}`;
            if (passes.has(key)) continue;
            const laneIndex = split.lanes.findIndex(lane =>
              kart.lateralOffset >= lane.offsetMin && kart.lateralOffset <= lane.offsetMax);
            if (laneIndex < 0) continue;
            passes.add(key);
            laneUsers![laneIndex]!.add(kart.id);
            if (split.lanes[laneIndex]!.risk === 1) riskyPasses++;
          }
        }
        stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
        pitFalls += state.events.filter(event => event.type === 'hit' && event.value === 2).length;
        stepRace(restored, restored.karts.map(kart => getAIInput(restored, kart.id)));
        expect(JSON.stringify(restored), `${trackId}, seed ${seed}, tick ${tick}`).toBe(JSON.stringify(state));
        if (tick % 137 === 0) restored = JSON.parse(JSON.stringify(restored));
        const hits = countHits(state, track);
        wallHits += hits.wall;
        bandHits += hits.band;
      }
      expect(state.phase).toBe('finished');
      if (laneUsers) for (const users of laneUsers) expect(users.size).toBeGreaterThanOrEqual(2);
      expect(state.karts).toHaveLength(8);
      for (const kart of state.karts) {
        expect(kart.human).toBe(false);
        expect(kart.lap).toBe(3);
        expect(kart.lapTimes).toHaveLength(3);
        expect(kart.finishTime).not.toBeNull();
        totalLapTime += kart.lapTimes.reduce((sum, time) => sum + time, 0);
      }
    }
    const meanLap = totalLapTime / 72;
    expect(meanLap).toBeGreaterThanOrEqual(60);
    const baseline = BASELINE[trackId];
    if (trackId === 'canyon') {
      expect(split).toBeDefined();
      expect(passes.size).toBe(72);
      expect(riskyPasses).toBeGreaterThan(0);
      expect(pitFalls).toBeLessThanOrEqual(riskyPasses * 0.3);
      expect(bandHits).toBeLessThanOrEqual(4);
    }
    // Stage 1: absolute range, an average pace of 20 to 40 m/s.
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    // Stage 2: ratio to the recorded baseline.
    const ratio = meanLap / baseline.meanLap;
    expect(ratio).toBeGreaterThanOrEqual(0.95);
    expect(ratio).toBeLessThanOrEqual(1.05);
    expect(wallHits).toBeLessThanOrEqual(baseline.wallHits);
    expect(bandHits).toBeLessThanOrEqual(baseline.bandHits);
  }, 120_000);
});

// A stadium loop whose first straight (arc ~100 to ~330 m) carries three centre pillars.
const pillar = (from: number): Barrier => ({ from, to: from + 20, center: 0, halfWidth: 1.2, taper: 4, scenery: 'pillar' });
const pillarTrack = buildTrack({
  ...LEGACY_MEADOW, scale: 1, roadHalfWidth: 8, wallHalfWidth: 10,
  controlPoints: [[-200, 0, 0], [-100, 0, 0], [0, 0, 0], [100, 0, 0], [200, 0, 0], [260, 0, 60],
    [200, 0, 120], [100, 0, 120], [0, 0, 120], [-100, 0, 120], [-200, 0, 120], [-260, 0, 60]],
  // The added 0.24 row would sit inside the third pillar; put it beyond the passage.
  boxRows: [0.02, 0.12, 0.30, 0.36, 0.47, 0.58, 0.695, 0.81],
  surfaces: [], racingLine: [], barriers: [pillar(130), pillar(200), pillar(270)],
});

/** Lateral clearance from the nearest pillar exclusion at the kart's arc distance, if any. */
function pillarClearance(kart: { trackDistance: number; lateralOffset: number }, time: number): number {
  let clearance = Infinity;
  for (const barrier of pillarTrack.def.barriers!) {
    const exclusion = exclusionAt(pillarTrack, barrier, kart.trackDistance, time);
    if (exclusion) clearance = Math.min(clearance, Math.abs(kart.lateralOffset - barrier.center) - exclusion.halfWidth);
  }
  return clearance;
}

describe('M1-03 passages around centre pillars', () => {
  it('keeps an assisted, neutral-steer kart clear of three pillars for 8 seconds', () => {
    vi.spyOn(tracks, 'getTrack').mockReturnValue(pillarTrack);
    const state = createRace(1);
    state.phase = 'racing';
    state.karts = [state.karts[0]!];
    state.boxes = [];
    const kart = state.karts[0]!;
    const start = sampleTrack(pillarTrack, 60);
    Object.assign(kart, { human: true, x: start.x, y: start.y, z: start.z, heading: Math.atan2(start.tx, start.tz),
      speed: 20, trackDistance: 60, lateralOffset: 0 });
    for (let tick = 0; tick < 8 * 60; tick++) {
      stepRace(state, [applySteerAssist(state, kart, { ...NEUTRAL_INPUT, throttle: 1 }, 1)]);
      expect(state.events.filter(event => event.type === 'hit'), `tick ${tick}`).toEqual([]);
      expect(pillarClearance(kart, state.time), `tick ${tick}`).toBeGreaterThanOrEqual(0.3);
    }
    // All three pillars were actually passed.
    expect(kart.trackDistance).toBeGreaterThan(pillarTrack.def.barriers![2]!.to + KART_RADIUS);
  });

  // Band hits (value 1) come from M1-02's collideCorridor; entries into an exclusion (judged by
  // corridorAt alone) also catch a kart that slips into a band without a counted hit.
  it.each(SEEDS)('8 CPUs finish seed %i with at most 4 band hits and 4 exclusion entries', seed => {
    vi.spyOn(tracks, 'getTrack').mockReturnValue(pillarTrack);
    const state = createRace(seed, { racers: [] });
    const inside = state.karts.map(() => false);
    let bandHits = 0;
    let entries = 0;
    for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
      stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
      bandHits += countHits(state, pillarTrack).band;
      for (const kart of state.karts) {
        const now = !corridorAt(pillarTrack, kart.trackDistance, state.time)
          .some(({ min, max }) => kart.lateralOffset >= min && kart.lateralOffset <= max);
        if (now && !inside[kart.id]) entries++;
        inside[kart.id] = now;
      }
    }
    expect(state.phase).toBe('finished');
    for (const kart of state.karts) {
      expect(kart.lap).toBe(3);
      expect(kart.finishTime).not.toBeNull();
    }
    expect(bandHits).toBeLessThanOrEqual(4);
    expect(entries).toBeLessThanOrEqual(4);
  }, 120_000);
});

// The pillar stadium with one islandSplit on its first straight (approach 125-160 m, island 160-230 m).
const island = islandSplit({ from: 160, to: 230, islandHalf: 6, laneWidth: 9, taper: 10,
  scenery: 'rock', risky: 'inner', bend: 1 });
const islandTrack = buildTrack({
  ...LEGACY_MEADOW, scale: 1, roadHalfWidth: 8, wallHalfWidth: 10,
  controlPoints: pillarTrack.def.controlPoints,
  surfaces: [], racingLine: [], ...island,
});

describe('M2-02 CPU lane choice at an island split', () => {
  const split = island.splits[0]!;
  const middle = (split.from + split.to) / 2;
  const riskyLane = split.lanes.findIndex(lane => lane.risk === 1);

  it('uses both lanes, picks the risky one 25-45% of the time, never switches on the approach, and finishes', () => {
    vi.spyOn(tracks, 'getTrack').mockReturnValue(islandTrack);
    let passes = 0;
    let riskyPasses = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { racers: [] });
      const users = split.lanes.map(() => new Set<number>());
      const approachSign = state.karts.map(() => 0);
      let switches = 0;
      let bandHits = 0;
      for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
        for (const kart of state.karts) {
          const ahead = ((split.from - kart.trackDistance) % islandTrack.length + islandTrack.length) % islandTrack.length;
          if (kart.finishTime !== null || ahead === 0 || ahead > 35) { approachSign[kart.id] = 0; continue; }
          const sign = Math.sign(getAiLineOffset(state, kart));
          if (sign === 0) continue;
          if (approachSign[kart.id] !== 0 && approachSign[kart.id] !== sign) switches++;
          approachSign[kart.id] = sign;
        }
        const before = state.karts.map(kart => kart.trackDistance);
        stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
        bandHits += countHits(state, islandTrack).band;
        for (const kart of state.karts) {
          if (!(before[kart.id]! < middle && kart.trackDistance >= middle && kart.trackDistance - before[kart.id]! < 5)) continue;
          const lane = split.lanes.findIndex(candidate =>
            kart.lateralOffset >= candidate.offsetMin && kart.lateralOffset <= candidate.offsetMax);
          expect(lane, `seed ${seed}, kart ${kart.id}`).toBeGreaterThanOrEqual(0);
          users[lane]!.add(kart.id);
          passes++;
          if (lane === riskyLane) riskyPasses++;
        }
      }
      expect(state.phase).toBe('finished');
      for (const kart of state.karts) {
        expect(kart.lap).toBe(3);
        expect(kart.finishTime).not.toBeNull();
      }
      expect(switches, `seed ${seed}`).toBe(0);
      expect(bandHits, `seed ${seed}`).toBeLessThanOrEqual(2);
      for (const lane of users) expect(lane.size, `seed ${seed}`).toBeGreaterThanOrEqual(2);
    }
    expect(passes).toBeGreaterThanOrEqual(72);
    expect(riskyPasses / passes).toBeGreaterThanOrEqual(0.25);
    expect(riskyPasses / passes).toBeLessThanOrEqual(0.45);
  }, 120_000);
});

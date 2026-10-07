import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAIInput } from './ai';
import { createRace, DRIFT_BLUE_TIME, DRIFT_ORANGE_TIME, FIXED_DT, KART_RADIUS, NEUTRAL_INPUT, stepRace } from './race';
import { buildTrack, sampleTrack } from './track';
import * as tracks from './tracks';
import type { RaceState } from './types';

afterEach(() => vi.restoreAllMocks());

// A wide straight isolates turning from walls, grass, items and other karts.
const handlingTrack = buildTrack({
  ...tracks.TRACKS.meadow, scale: 1, roadHalfWidth: 300, wallHalfWidth: 400,
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

// Measured with the v7 sim (5e3aedc) on darwin-arm64 before the H1 physics/AI edits.
// Three seeds [1, 42, 98765], eight CPUs, three laps each (72 laps per course).
const V7_CPU = {
  meadow: { meanLap: 18.50972222222222, wallHits: 3 },
  canyon: { meanLap: 18.825925925925926, wallHits: 0 },
  snowpeak: { meanLap: 18.057175925925925, wallHits: 0 },
  neon: { meanLap: 18.24861111111111, wallHits: 1 },
};

describe('H1 CPU balance against v7', () => {
  it.each(tracks.TRACK_IDS)('finishes and replays all 72 laps on %s within the old pace/wall budget', trackId => {
    let totalLapTime = 0;
    let wallHits = 0;
    const limit = tracks.getTrack(trackId).def.wallHalfWidth - KART_RADIUS;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId, racers: [] });
      let restored: RaceState = JSON.parse(JSON.stringify(state));
      for (let tick = 0; tick < 60 * 180 && state.phase !== 'finished'; tick++) {
        stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
        stepRace(restored, restored.karts.map(kart => getAIInput(restored, kart.id)));
        expect(JSON.stringify(restored), `${trackId}, seed ${seed}, tick ${tick}`).toBe(JSON.stringify(state));
        if (tick % 137 === 0) restored = JSON.parse(JSON.stringify(restored));
        // Item hits away from the rail do not count as wall impacts.
        wallHits += state.events.filter(event => event.type === 'hit' &&
          Math.abs(state.karts[event.kartId]!.lateralOffset) >= limit - 0.01).length;
      }
      expect(state.phase).toBe('finished');
      expect(state.karts).toHaveLength(8);
      for (const kart of state.karts) {
        expect(kart.human).toBe(false);
        expect(kart.lap).toBe(3);
        expect(kart.lapTimes).toHaveLength(3);
        expect(kart.finishTime).not.toBeNull();
        totalLapTime += kart.lapTimes.reduce((sum, time) => sum + time, 0);
      }
    }
    const ratio = totalLapTime / 72 / V7_CPU[trackId].meanLap;
    expect(ratio).toBeGreaterThanOrEqual(0.85);
    expect(ratio).toBeLessThanOrEqual(1.05);
    expect(wallHits).toBeLessThanOrEqual(V7_CPU[trackId].wallHits);
  }, 30_000);
});

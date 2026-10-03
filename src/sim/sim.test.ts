import { describe, expect, it } from 'vitest';
import {
  BOX_RESPAWN_TIME, CHECKPOINT_COUNT, DRIFT_BLUE_TIME, DRIFT_ORANGE_TIME, FIXED_DT,
  KART_RADIUS, NEUTRAL_INPUT, ROAD_HALF_WIDTH, TOTAL_LAPS, TRACK_LENGTH,
  WALL_HALF_WIDTH, chooseItem, createRace, getAIInput, getRank, projectToTrack,
  sampleTrack, stepRace, updateLapTracking,
} from './index';
import type { InputFrame, KartState, RaceState } from './types';

const accelerate: InputFrame = { ...NEUTRAL_INPUT, throttle: 1 };

function startRace(seed = 42): RaceState {
  const state = createRace(seed);
  for (let i = 0; i < 180; i++) stepRace(state, []);
  return state;
}

function place(kart: KartState, distance: number, offset = 0): void {
  const sample = sampleTrack(distance);
  kart.x = sample.x + sample.nx * offset;
  kart.y = sample.y;
  kart.z = sample.z + sample.nz * offset;
  kart.heading = Math.atan2(sample.tx, sample.tz);
  kart.trackDistance = sample.distance;
  kart.lateralOffset = offset;
}

function trackMove(state: RaceState, distance: number, time: number, offset = 0): void {
  const kart = state.karts[0]!;
  const previous = { x: kart.x, z: kart.z, trackDistance: kart.trackDistance };
  place(kart, distance, offset);
  state.time = time;
  updateLapTracking(state, kart, previous);
}

function armLap(state: RaceState): void {
  place(state.karts[0]!, TRACK_LENGTH - 0.5);
  trackMove(state, 0.5, 0.5);
}

function travelLap(state: RaceState, lapTime: number): void {
  const startTime = state.time;
  const steps = Math.ceil(TRACK_LENGTH);
  for (let i = 1; i <= steps; i++) trackMove(state, 0.5 + i / steps * TRACK_LENGTH, startTime + i / steps * lapTime);
}

describe('course and clock', () => {
  it('builds an elevated closed course with consistent tangent and projection', () => {
    expect(TRACK_LENGTH).toBeGreaterThan(500);
    expect(TRACK_LENGTH).toBeLessThan(750);
    expect(sampleTrack(TRACK_LENGTH)).toEqual(sampleTrack(0));
    const heights: number[] = [];
    for (let d = 0; d < TRACK_LENGTH; d += 17) {
      const point = sampleTrack(d);
      heights.push(point.y);
      const projected = projectToTrack(point.x + point.nx * 3, point.z + point.nz * 3);
      expect(projected.offset).toBeCloseTo(3, 1);
      expect(Math.hypot(point.tx, point.tz)).toBeCloseTo(1, 10);
      expect(point.tx * point.nx + point.tz * point.nz).toBeCloseTo(0, 10);
    }
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(5);
  });

  it('holds the grid for exactly 180 ticks and starts timing on GO', () => {
    const state = createRace(12);
    const initial = { x: state.karts[0]!.x, z: state.karts[0]!.z };
    for (let i = 0; i < 179; i++) stepRace(state, [accelerate]);
    expect(state.phase).toBe('countdown');
    expect(state.time).toBe(0);
    expect(state.karts[0]!.x).toBe(initial.x);
    expect(state.karts[0]!.z).toBe(initial.z);
    stepRace(state, [accelerate]);
    expect(state.phase).toBe('racing');
    expect(state.events).toContainEqual({ type: 'go', kartId: 0 });
    stepRace(state, [accelerate]);
    expect(state.time).toBe(FIXED_DT);
    expect(state.karts[0]!.speed).toBeGreaterThan(0);
  });
});

describe('ordered directional checkpoints and lap timing', () => {
  it('counts three full laps, records each time, and preserves total race time', () => {
    const state = startRace();
    const kart = state.karts[0]!;
    armLap(state);
    expect(kart.startedLap).toBe(true);
    expect(kart.nextCheckpoint).toBe(1);
    expect(kart.lap).toBe(0);
    travelLap(state, 26);
    expect(kart.lap).toBe(1);
    expect(kart.lapTimes[0]).toBeCloseTo(26.5, 6);
    travelLap(state, 24);
    travelLap(state, 25);
    expect(kart.lap).toBe(TOTAL_LAPS);
    expect(kart.finishTime).toBeCloseTo(75.5, 6);
    expect(kart.lapTimes).toHaveLength(3);
    expect(kart.lapTimes.reduce((sum, time) => sum + time, 0)).toBeCloseTo(kart.finishTime!, 10);
  });

  it('rejects reverse finish crossings and out-of-order checkpoints', () => {
    const state = startRace();
    armLap(state);
    const kart = state.karts[0]!;
    trackMove(state, -0.5, 1);
    expect(kart.lap).toBe(0);
    expect(kart.nextCheckpoint).toBe(1);
    // The second checkpoint cannot replace the first, even on a forward crossing.
    const distance = TRACK_LENGTH * 2 / CHECKPOINT_COUNT;
    place(kart, distance - 0.4);
    trackMove(state, distance + 0.4, 5);
    expect(kart.nextCheckpoint).toBe(1);
    expect(kart.lap).toBe(0);
  });

  it('invalidates a teleport shortcut and refuses a skipped checkpoint lap', () => {
    const state = startRace();
    armLap(state);
    const kart = state.karts[0]!;
    trackMove(state, TRACK_LENGTH * 0.65, 1);
    expect(kart.lapValid).toBe(false);
    trackMove(state, TRACK_LENGTH - 0.5, 1.5);
    trackMove(state, TRACK_LENGTH + 0.5, 2);
    expect(kart.lap).toBe(0);
    expect(kart.nextCheckpoint).toBe(1);
    expect(kart.lapValid).toBe(true);
    // Crossing a finite gate outside the track does not satisfy it.
    const checkpoint = TRACK_LENGTH / CHECKPOINT_COUNT;
    place(kart, checkpoint - 0.4, WALL_HALF_WIDTH + 2);
    trackMove(state, checkpoint + 0.4, 5, WALL_HALF_WIDTH + 2);
    expect(kart.nextCheckpoint).toBe(1);
  });

  it('orders completed racers by time and the rest by validated progress', () => {
    const state = startRace();
    state.karts[1]!.finishTime = 80;
    state.karts[2]!.finishTime = 79;
    state.karts[0]!.startedLap = true;
    state.karts[0]!.lapProgress = 100;
    expect(getRank(state, 2)).toBe(1);
    expect(getRank(state, 1)).toBe(2);
    expect(getRank(state, 0)).toBe(3);
  });
});

describe('deterministic inputs, PRNG and saves', () => {
  it('replays the same inputs and resumes a JSON snapshot exactly', () => {
    const first = startRace(991);
    for (let i = 0; i < 350; i++) stepRace(first, first.karts.map((kart) => getAIInput(first, kart.id)));
    const restored: RaceState = JSON.parse(JSON.stringify(first));
    for (let i = 0; i < 400; i++) {
      const inputs = first.karts.map((kart) => getAIInput(first, kart.id));
      stepRace(first, inputs);
      stepRace(restored, inputs);
    }
    expect(restored).toEqual(first);
    const replay = startRace(991);
    for (let i = 0; i < 750; i++) stepRace(replay, replay.karts.map((kart) => getAIInput(replay, kart.id)));
    expect(replay).toEqual(first);
  });

  it('draws identical item sequences from one seed and helps trailing racers', () => {
    const first = { seed: 9 };
    const second = { seed: 9 };
    const leading = { seed: 817 };
    const trailing = { seed: 817 };
    let leaderDashes = 0;
    let lastDashes = 0;
    for (let i = 0; i < 3000; i++) {
      expect(chooseItem(first, i % 6 + 1)).toBe(chooseItem(second, i % 6 + 1));
      if (chooseItem(leading, 1) === 'dash') leaderDashes++;
      if (chooseItem(trailing, 6) === 'dash') lastDashes++;
    }
    expect(lastDashes).toBeGreaterThan(leaderDashes * 2.5);
    expect(createRace(0).seed).not.toBe(0);
  });

  it('sanitizes malformed or missing input without corrupting state', () => {
    const state = startRace();
    stepRace(state, [{ ...accelerate, steer: NaN, throttle: Infinity }]);
    expect(state.karts[0]!.speed).toBe(0);
    expect(Number.isFinite(state.karts[0]!.heading)).toBe(true);
  });
});

describe('driving and items', () => {
  it('charges two drift stages and hops before releasing a mini turbo', () => {
    for (const [charge, expected] of [[DRIFT_BLUE_TIME + 0.01, 0.65], [DRIFT_ORANGE_TIME + 0.01, 1.25]]) {
      const state = startRace();
      const kart = state.karts[0]!;
      place(kart, 10);
      kart.speed = 20;
      stepRace(state, [{ ...accelerate, drift: true, steer: 0.5 }]);
      expect(kart.hopTime).toBeGreaterThan(0);
      for (let i = 1; i < Math.ceil(charge! / FIXED_DT); i++) {
        stepRace(state, [{ ...getAIInput(state, 0), drift: true }]);
      }
      expect(kart.driftTime).toBeGreaterThanOrEqual(charge!);
      stepRace(state, [{ ...getAIInput(state, 0), drift: false }]);
      expect(kart.boostTime).toBeCloseTo(expected!, 8);
      expect(kart.driftTime).toBe(0);
    }
  });

  it('slows down in grass and at guardrails and separates touching karts', () => {
    const road = startRace();
    const grass = startRace();
    place(road.karts[0]!, 25);
    place(grass.karts[0]!, 25, ROAD_HALF_WIDTH + 0.5);
    road.karts[0]!.speed = 30;
    grass.karts[0]!.speed = 30;
    for (let i = 0; i < 20; i++) { stepRace(road, [accelerate]); stepRace(grass, [accelerate]); }
    expect(grass.karts[0]!.speed).toBeLessThan(road.karts[0]!.speed - 8);
    const wall = startRace();
    const kart = wall.karts[0]!;
    place(kart, 25, WALL_HALF_WIDTH - KART_RADIUS - 0.05);
    kart.heading += Math.PI / 2;
    kart.speed = 25;
    stepRace(wall, [accelerate]);
    expect(Math.abs(kart.lateralOffset)).toBeLessThanOrEqual(WALL_HALF_WIDTH - KART_RADIUS + 0.01);
    expect(kart.speed).toBeLessThan(20);
    const contact = startRace();
    place(contact.karts[0]!, 40);
    place(contact.karts[1]!, 40, 0.5);
    stepRace(contact, []);
    expect(Math.hypot(contact.karts[0]!.x - contact.karts[1]!.x, contact.karts[0]!.z - contact.karts[1]!.z)).toBeGreaterThanOrEqual(KART_RADIUS * 2);
  });

  it('picks up a box, respawns it, and consumes a dash on an input edge', () => {
    const state = startRace();
    const kart = state.karts[0]!;
    const box = state.boxes[0]!;
    kart.x = box.x; kart.y = box.y; kart.z = box.z;
    stepRace(state, []);
    expect(kart.item).not.toBeNull();
    expect(box.respawnTime).toBe(BOX_RESPAWN_TIME);
    kart.item = 'dash';
    stepRace(state, [{ ...NEUTRAL_INPUT, useItem: true }]);
    expect(kart.item).toBeNull();
    expect(kart.boostTime).toBeGreaterThan(1.8);
    kart.item = 'trap';
    stepRace(state, [{ ...NEUTRAL_INPUT, useItem: true }]);
    expect(kart.item).toBe('trap');
    for (let i = 0; i < 302; i++) stepRace(state, []);
    expect(box.respawnTime).toBe(0);
  });

  it('spins a following kart with a trap and hits forward with a bolt', () => {
    for (const item of ['trap', 'bolt'] as const) {
      const state = startRace();
      const owner = state.karts[0]!;
      const victim = state.karts[1]!;
      place(owner, 30);
      owner.item = item;
      place(victim, item === 'trap' ? 27.4 : 33.5);
      stepRace(state, [{ ...NEUTRAL_INPUT, useItem: true }]);
      expect(victim.spinTime).toBeGreaterThan(0);
      expect(state.events).toContainEqual({ type: 'hit', kartId: 1 });
      expect(state.traps.length + state.projectiles.length).toBe(0);
    }
  });

  it('reflects bolts at rails and expires them after four bounces', () => {
    const state = startRace();
    const sample = sampleTrack(35);
    const bolt = { id: 999, ownerId: 0, x: sample.x + sample.nx * 9.8, y: sample.y,
      z: sample.z + sample.nz * 9.8, heading: Math.atan2(sample.nx, sample.nz), life: 5, bounces: 0 };
    state.projectiles.push(bolt);
    stepRace(state, []);
    expect(bolt.bounces).toBe(1);
    expect(Math.sin(bolt.heading) * sample.nx + Math.cos(bolt.heading) * sample.nz).toBeLessThan(0);
    for (let i = 0; i < 180 && state.projectiles.length; i++) stepRace(state, []);
    expect(state.projectiles).toHaveLength(0);
    expect(bolt.bounces).toBe(4);
  });
});

describe('CPU race integration', () => {
  it('drives all six input sources around the course and completes a three lap race', () => {
    const state = createRace(2026);
    const uses = new Set<string>();
    for (let i = 0; i < 60 * 180 && state.phase !== 'finished'; i++) {
      const frames = state.karts.map((kart) => getAIInput(state, kart.id));
      for (const kart of state.karts) if (kart.item && frames[kart.id]!.useItem) uses.add(kart.item);
      stepRace(state, frames);
    }
    expect(state.phase, JSON.stringify(state.karts.map((kart) => ({ id: kart.id, lap: kart.lap, checkpoint: kart.nextCheckpoint, progress: kart.lapProgress, offset: kart.lateralOffset, speed: kart.speed })))).toBe('finished');
    expect(state.karts[0]!.lapTimes).toHaveLength(3);
    expect(state.karts[0]!.finishTime).toBeGreaterThan(35);
    expect(state.karts.every((kart) => kart.lap >= 2)).toBe(true);
    expect(uses.size).toBe(3);
  }, 20_000);
});


describe('CPU finish independence', () => {
  it('lets all five CPU racers complete three laps while the human remains on the grid', () => {
    const state = createRace(681);
    for (let i = 0; i < 60 * 180 && state.karts.slice(1).some((kart) => kart.finishTime === null); i++) {
      stepRace(state, state.karts.map((kart) => kart.id === 0 ? NEUTRAL_INPUT : getAIInput(state, kart.id)));
    }
    expect(state.karts.slice(1).map((kart) => kart.lap)).toEqual([3, 3, 3, 3, 3]);
    expect(state.phase).toBe('racing');
  }, 20_000);
});

describe('kart contact impulses', () => {
  it('pushes a rear-impact target forward and behaves identically when kart IDs swap', () => {
    const outcomes = [false, true].map((swapIds) => {
      const state = startRace();
      const rear = state.karts[swapIds ? 1 : 0]!;
      const front = state.karts[swapIds ? 0 : 1]!;
      place(rear, 50);
      place(front, 51.2);
      front.heading = rear.heading;
      rear.speed = 20;
      front.speed = 5;
      stepRace(state, []);
      expect(rear.speed).toBeLessThan(20);
      expect(front.speed).toBeGreaterThan(5);
      expect(rear.speed + front.speed).toBeCloseTo(25 - 2 * 5.5 * FIXED_DT, 8);
      return { rear: rear.speed, front: front.speed };
    });
    expect(outcomes[0]!.rear).toBeCloseTo(outcomes[1]!.rear, 8);
    expect(outcomes[0]!.front).toBeCloseTo(outcomes[1]!.front, 8);
  });

  it('keeps a full-throttle player accelerating through glancing grid contact', () => {
    for (const seed of [42, 2026]) {
      const state = startRace(seed);
      for (let tick = 0; tick < 75; tick++) {
        stepRace(state, state.karts.map((kart) => kart.id === 0 ? accelerate : getAIInput(state, kart.id)));
      }
      expect(state.karts[0]!.speed).toBeGreaterThan(18);
      expect(state.karts[0]!.spinTime).toBe(0);
    }
  });
});

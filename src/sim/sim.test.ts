import { describe, expect, it } from 'vitest';
import {
  BOX_RESPAWN_TIME, CHECKPOINT_COUNT, DRIFT_BLUE_TIME, DRIFT_ORANGE_TIME, FIXED_DT,
  KART_RADIUS, NEUTRAL_INPUT, ROAD_HALF_WIDTH, TOTAL_LAPS, TRACK_LENGTH,
  WALL_HALF_WIDTH, chooseItem, createRace, getAIInput, getRank, projectToTrack,
  sampleTrack, stepRace, updateLapTracking, TRACK_SAMPLES, RACE_FINISH_TIMEOUT,
  getFinishTimeRemaining, isRaceTimedOut, KART_EFFECT_LAYOUT, ENTITY_KINDS,
  decideItemUse, getKartModifiers, onKartContact, hitKart, useItem, advanceItems,
} from './index';
import type { InputFrame, KartState, RaceState } from './types';
import { formatResultTime } from '../ui/GameUI';

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

function minimumRadius(points: readonly { x: number; z: number }[]): number {
  return Math.min(...points.map((b, i) => {
    const a = points[(i + points.length - 1) % points.length]!;
    const c = points[(i + 1) % points.length]!;
    const twiceArea = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    return Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) *
      Math.hypot(c.x - a.x, c.z - a.z) / (2 * twiceArea);
  }));
}

function expectSafeRadius(points: readonly { x: number; z: number }[]): void {
  expect(minimumRadius(points)).toBeGreaterThan(WALL_HALF_WIDTH);
  expect(minimumRadius(points)).toBeGreaterThanOrEqual(13);
}

describe('eight racer roster and grid', () => {
  it('creates ordered unique racers with one human and accepts custom profiles by slot', () => {
    const state = createRace(42);
    expect(state.karts.map((kart) => kart.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(state.karts.map((kart) => kart.name)).size).toBe(8);
    expect(new Set(state.karts.map((kart) => kart.color)).size).toBe(8);
    expect(state.karts.filter((kart) => kart.human).map((kart) => kart.id)).toEqual([0]);
    const racers = state.karts.map((kart) => ({ name: `Driver ${kart.id}`, color: kart.id, human: kart.id === 2 || kart.id === 5 }));
    const custom = createRace(42, { racers });
    expect(custom.karts.map(({ name, color, human }) => ({ name, color, human }))).toEqual(racers);
    expect(custom.karts.map((kart) => kart.id)).toEqual(state.karts.map((kart) => kart.id));
    racers[2]!.name = 'Changed';
    expect(custom.karts[2]!.name).toBe('Driver 2');
    const partial = createRace(42, { racers: [{ name: 'Host', color: 0, human: true }] });
    expect(partial.karts).toHaveLength(8);
    expect(partial.karts[0]).toMatchObject({ name: 'Host', color: 0, human: true });
    expect(partial.karts.slice(1).every((kart) => !kart.human)).toBe(true);
    expect(() => createRace(42, { racers: [...racers, racers[0]!] })).toThrow(RangeError);
  });

  it('places every grid slot inside the road, tangent-aligned and at least 2.2m apart', () => {
    const { karts } = createRace(42);
    for (const kart of karts) {
      const projection = projectToTrack(kart.x, kart.z);
      expect(Math.abs(kart.lateralOffset)).toBeLessThanOrEqual(2.5);
      expect(Math.abs(projection.offset)).toBeLessThanOrEqual(2.5);
      const angle = kart.heading - projection.heading;
      expect(Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)))).toBeLessThan(0.1);
      for (const other of karts.filter((candidate) => candidate.id > kart.id)) {
        expect(Math.hypot(kart.x - other.x, kart.z - other.z)).toBeGreaterThanOrEqual(2.2);
      }
    }
  });

  it('initializes independent inactive effects with a complete nonoverlapping eight-byte layout', () => {
    const state = createRace(42);
    for (const kart of state.karts) {
      expect(kart.effects.rapidUnused).toBe(1);
      expect(Object.entries(kart.effects).every(([key, value]) => key === 'rapidUnused' || value === 0)).toBe(true);
    }
    expect(KART_EFFECT_LAYOUT.map((field) => field.field).sort()).toEqual(Object.keys(state.karts[0]!.effects).sort());
    const usedBits = Array<number>(8).fill(0);
    for (const field of KART_EFFECT_LAYOUT) {
      expect(field.byteOffset).toBeLessThan(8);
      const bits = field.mask << field.shift;
      expect(usedBits[field.byteOffset]! & bits).toBe(0);
      usedBits[field.byteOffset]! |= bits;
    }
    expect(new Set(Object.values(ENTITY_KINDS)).size).toBe(Object.keys(ENTITY_KINDS).length);
    state.karts[0]!.effects.inkTime = 4;
    expect(state.karts.slice(1).every((kart) => kart.effects.inkTime === 0)).toBe(true);
    expect(createRace(42).karts[0]!.effects.inkTime).toBe(0);
  });
});

describe('human roster completion', () => {
  function multiplayer(): RaceState {
    const racers = createRace(42).karts.map(({ id, name, color }) => ({ name, color, human: id === 2 || id === 5 }));
    const state = createRace(42, { racers });
    for (let i = 0; i < 180; i++) stepRace(state, []);
    return state;
  }

  it('uses the same driving speed for humans in any slot', () => {
    const speeds = [0, 6].map((id) => {
      const state = multiplayer();
      for (const kart of state.karts) kart.human = kart.id === id;
      const human = state.karts[id]!;
      place(human, 30);
      human.speed = 40;
      stepRace(state, []);
      return human.speed;
    });
    expect(speeds[0]).toBe(speeds[1]);
  });

  it('rubber-bands CPUs against the leading human, independent of slot order', () => {
    const speed = (humanSlots: number[], cpuLeader: boolean): number => {
      const state = multiplayer();
      for (const kart of state.karts) {
        kart.human = humanSlots.includes(kart.id);
        kart.startedLap = true;
        kart.lapProgress = -300;
      }
      const leadingHuman = state.karts[5]!;
      leadingHuman.lapProgress = 300;
      if (cpuLeader) state.karts[0]!.lapProgress = 1000;
      const cpu = state.karts[7]!;
      place(cpu, 30);
      cpu.lapProgress = 0;
      cpu.speed = 40;
      stepRace(state, []);
      return cpu.speed;
    };
    expect(speed([2, 5], true)).toBe(speed([5], false));
    expect(speed([2, 5], false)).toBeGreaterThan(speed([2], false));
  });

  it('waits for both nonzero human slots and finishes immediately after the second finishes', () => {
    const state = multiplayer();
    state.karts[0]!.finishTime = 0;
    state.karts[2]!.finishTime = 0;
    stepRace(state, []);
    expect(state.phase).toBe('racing');
    expect(isRaceTimedOut(state)).toBe(false);
    state.karts[5]!.finishTime = FIXED_DT;
    stepRace(state, []);
    expect(state.phase).toBe('finished');
    expect(isRaceTimedOut(state)).toBe(false);
  });

  it('times out at exactly 45 seconds with one human unfinished, including after JSON restore', () => {
    const state = multiplayer();
    state.karts[2]!.finishTime = 0;
    for (let tick = 0; tick < 45 / FIXED_DT - 1; tick++) stepRace(state, []);
    expect(state.phase).toBe('racing');
    expect(getFinishTimeRemaining(state)).toBeCloseTo(FIXED_DT, 10);
    const restored: RaceState = JSON.parse(JSON.stringify(state));
    for (const race of [state, restored]) {
      stepRace(race, []);
      expect(race.phase).toBe('finished');
      expect(race.time).toBe(45);
      expect(race.karts[5]!.finishTime).toBeNull();
      expect(isRaceTimedOut(race)).toBe(true);
    }
    expect(restored).toEqual(state);
  });

  it('gives the last human finish on the deadline precedence over a timeout', () => {
    const state = multiplayer();
    state.karts[2]!.finishTime = 0;
    state.racingTicks = 45 / FIXED_DT - 1;
    const last = state.karts[5]!;
    place(last, TRACK_LENGTH - 0.1);
    last.startedLap = true;
    last.lap = 2;
    last.nextCheckpoint = 0;
    last.lapProgress = TRACK_LENGTH - 0.1;
    last.speed = 20;
    stepRace(state, state.karts.map(() => accelerate));
    expect(last.finishTime).toBe(45);
    expect(state.phase).toBe('finished');
    expect(isRaceTimedOut(state)).toBe(false);
  });

  it('keeps an all-CPU race running until all finish or the timeout expires', () => {
    const state = createRace(42, { racers: [] });
    for (let tick = 0; tick < 181; tick++) stepRace(state, []);
    expect(state.phase).toBe('racing');
    state.karts[0]!.finishTime = state.time;
    stepRace(state, []);
    expect(state.phase).toBe('racing');
    for (const kart of state.karts) kart.finishTime ??= state.time;
    stepRace(state, []);
    expect(state.phase).toBe('finished');
    expect(isRaceTimedOut(state)).toBe(false);
  });
});

describe('course and clock', () => {
  it('keeps the minimum course radius at least 13 metres and beyond the guardrails', () => {
    expectSafeRadius(TRACK_SAMPLES);
  });

  it('rejects the original self-intersecting hairpin with the same radius assertion', () => {
    // Original X/Z control points from 55ece2b, before the round-one course fix.
    const points = [[0, 82], [46, 74], [87, 47], [91, 2], [65, -27], [86, -70],
      [32, -91], [-26, -86], [-75, -62], [-91, -10], [-68, 38], [-31, 58]];
    const legacy = points.flatMap((_, i) => Array.from({ length: 32 }, (_, j) => {
      const t = j / 32;
      const coordinate = (axis: number): number => {
        const [a, b, c, d] = [-1, 0, 1, 2].map((offset) => points[(i + offset + points.length) % points.length]![axis]!);
        return 0.55 * (2 * b! + (-a! + c!) * t + (2 * a! - 5 * b! + 4 * c! - d!) * t ** 2 +
          (-a! + 3 * b! - 3 * c! + d!) * t ** 3);
      };
      return { x: coordinate(0), z: coordinate(1) };
    }));
    expect(minimumRadius(legacy)).toBeCloseTo(7.4, 0);
    expect(() => expectSafeRadius(legacy)).toThrow();
  });

  it('projects continuous half-metre steps around the entire course at offsets from -10 to +10', () => {
    for (let offset = -10; offset <= 10; offset++) {
      let previousDistance = 0;
      for (let distance = 0; distance < TRACK_LENGTH + 1; distance += 0.5) {
        const sample = sampleTrack(distance);
        const projection = projectToTrack(sample.x + sample.nx * offset, sample.z + sample.nz * offset, previousDistance);
        const delta = Math.atan2(Math.sin((projection.distance - previousDistance) / TRACK_LENGTH * Math.PI * 2),
          Math.cos((projection.distance - previousDistance) / TRACK_LENGTH * Math.PI * 2)) * TRACK_LENGTH / (Math.PI * 2);
        expect(Math.abs(delta), `offset ${offset}, distance ${distance}`).toBeLessThan(2);
        previousDistance = projection.distance;
      }
    }
  });

  it('reacquires a distant teleport from a stale projection hint without awarding checkpoint progress', () => {
    const state = startRace();
    armLap(state);
    const kart = state.karts[0]!;
    const target = sampleTrack(TRACK_LENGTH * 0.6);
    kart.x = target.x + target.nx * 3;
    kart.z = target.z + target.nz * 3;
    const global = projectToTrack(kart.x, kart.z);
    expect(projectToTrack(kart.x, kart.z, kart.trackDistance)).toEqual(global);
    stepRace(state, []);
    expect(kart.trackDistance).toBeCloseTo(target.distance, 1);
    expect(kart.lapValid).toBe(false);
    expect(kart.lap).toBe(0);
    expect(kart.nextCheckpoint).toBe(1);
  });

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
  it.each([8.5, 9, 9.5, 10])('finishes three laps along the inside hairpin at offset %s without projection jumps', (offset) => {
    const state = startRace();
    const kart = state.karts[0]!;
    place(kart, TRACK_LENGTH - 0.5, offset);
    let elapsed = 0;
    for (let distance = 0; distance <= TRACK_LENGTH * TOTAL_LAPS + 1; distance += 0.5) {
      const previous = { x: kart.x, z: kart.z, trackDistance: kart.trackDistance };
      const point = sampleTrack(distance);
      kart.x = point.x + point.nx * offset;
      kart.z = point.z + point.nz * offset;
      const projection = projectToTrack(kart.x, kart.z, previous.trackDistance);
      kart.trackDistance = projection.distance;
      kart.lateralOffset = projection.offset;
      kart.heading = Math.atan2(point.tx, point.tz);
      kart.speed = 12;
      state.time = elapsed += 0.5 / kart.speed;
      updateLapTracking(state, kart, previous);
      expect(kart.lapValid, `inside hairpin at ${point.distance.toFixed(1)}m`).toBe(true);
    }
    expect(kart.lap).toBe(TOTAL_LAPS);
    expect(kart.lapTimes).toHaveLength(TOTAL_LAPS);
    expect(kart.finishTime).not.toBeNull();
  });

  it.each([8.5, 9, 9.5, 10])('completes a fixed-tick driving probe targeting inside offset %s', (offset) => {
    const state = startRace();
    const kart = state.karts[0]!;
    state.karts = [kart];
    state.boxes = [];
    place(kart, TRACK_LENGTH - 1, offset);
    for (let tick = 0; tick < 60 * 360 && state.phase !== 'finished'; tick++) {
      const target = sampleTrack(kart.trackDistance + 4);
      const heading = Math.atan2(target.x + target.nx * offset - kart.x, target.z + target.nz * offset - kart.z);
      const error = Math.atan2(Math.sin(heading - kart.heading), Math.cos(heading - kart.heading));
      stepRace(state, [{ ...NEUTRAL_INPUT, throttle: kart.speed < 12 ? 1 : 0, steer: error * 3 }]);
      expect(kart.lapValid, `offset ${offset}, distance ${kart.trackDistance.toFixed(1)}`).toBe(true);
    }
    expect(state.phase, JSON.stringify({ lap: kart.lap, checkpoint: kart.nextCheckpoint, progress: kart.lapProgress,
      distance: kart.trackDistance, speed: kart.speed, offset: kart.lateralOffset })).toBe('finished');
    expect(kart.lapTimes).toHaveLength(3);
    expect(kart.finishTime).not.toBeNull();
  }, 10_000);

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
    expect(first.karts).toHaveLength(8);
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
    const DASH_FAMILY = new Set<string | null>(['dash', 'tripleDash', 'rapidDash']);
    const first = { seed: 9 };
    const second = { seed: 9 };
    const leading = { seed: 817 };
    const trailing = { seed: 817 };
    let leaderDashes = 0;
    let lastDashes = 0;
    for (let i = 0; i < 3000; i++) {
      expect(chooseItem(first, i % 8 + 1)).toBe(chooseItem(second, i % 8 + 1));
      if (DASH_FAMILY.has(chooseItem(leading, 1))) leaderDashes++;
      if (DASH_FAMILY.has(chooseItem(trailing, 8))) lastDashes++;
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
  it('keeps the extracted modifier/contact hooks neutral for the original items', () => {
    const state = startRace();
    const first = state.karts[0]!;
    const second = state.karts[1]!;
    const saved = JSON.parse(JSON.stringify(state));
    expect(getKartModifiers(state, first, accelerate)).toEqual({
      input: accelerate, maxSpeedMultiplier: 1, contactHit: false, invulnerable: false,
    });
    onKartContact(state, first, second);
    expect(state).toEqual(saved);
  });

  it.each(['trap', 'bolt'] as const)('exports typed %s entities and preserves lifetime and input edges', (item) => {
    const state = startRace();
    const kart = state.karts[0]!;
    place(kart, 30);
    kart.item = item;
    const entityId = state.nextEntityId;
    useItem(state, kart, { ...NEUTRAL_INPUT, useItem: true });
    expect(kart.effects.holding).toBe(1);
    useItem(state, kart, NEUTRAL_INPUT);
    const entities = item === 'trap' ? state.traps : state.projectiles;
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ kind: item, id: entityId, ownerId: kart.id });
    expect(ENTITY_KINDS[entities[0]!.kind]).toBeGreaterThan(0);
    const life = entities[0]!.life;
    kart.item = item;
    useItem(state, kart, { ...NEUTRAL_INPUT, useItem: true });
    expect(entities).toHaveLength(1);
    expect(kart.item).toBe(item);
    advanceItems(state, FIXED_DT);
    expect(entities[0]!.life).toBeCloseTo(life - FIXED_DT, 10);
    expect(kart.spinTime).toBe(0);
    useItem(state, kart, NEUTRAL_INPUT);
    expect(state.traps.length + state.projectiles.length).toBe(2);
  });

  it('keeps hit response idempotent during a spin and clears drift and boost', () => {
    const state = startRace();
    const kart = state.karts[3]!;
    kart.speed = 20;
    kart.driftDirection = 1;
    kart.driftTime = 1;
    kart.boostTime = 1;
    hitKart(state, kart);
    expect(kart).toMatchObject({ speed: 6, spinTime: 1.05, driftTime: 0, driftDirection: 0, boostTime: 0 });
    hitKart(state, kart);
    expect(kart.speed).toBe(6);
    expect(state.events.filter((event) => event.type === 'hit')).toEqual([{ type: 'hit', kartId: 3 }]);
  });

  it('delegates CPU item decisions and adds bounded deterministic ink steering noise', () => {
    const state = startRace();
    const kart = state.karts[3]!;
    place(kart, 30);
    kart.item = 'trap';
    state.racingTicks = 190 - kart.id * 47;
    expect(decideItemUse(state, kart)).toBe(true);
    expect(getAIInput(state, kart.id).useItem).toBe(true);
    state.racingTicks++;
    expect(decideItemUse(state, kart)).toBe(false);
    kart.aiPhase = Math.PI / 2;
    const clear = getAIInput(state, kart.id);
    expect(Math.abs(clear.steer)).toBeLessThan(0.6);
    kart.effects.inkTime = 4;
    const inked = getAIInput(state, kart.id);
    expect(inked.steer).toBeCloseTo(clear.steer + 0.35, 10);
    expect(inked.throttle).toBe(clear.throttle);
    expect(getAIInput(JSON.parse(JSON.stringify(state)), kart.id)).toEqual(inked);
  });

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
      stepRace(state, [NEUTRAL_INPUT]);
      expect(victim.spinTime).toBeGreaterThan(0);
      expect(state.events).toContainEqual({ type: 'hit', kartId: 1 });
      expect(state.traps.length + state.projectiles.length).toBe(0);
    }
  });

  it('reflects bolts at rails and expires them after four bounces', () => {
    const state = startRace();
    const sample = sampleTrack(35);
    const bolt = { kind: 'bolt' as const, id: 999, ownerId: 0, x: sample.x + sample.nx * 9.8, y: sample.y,
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
  it('finishes three laps with eight CPUs across ten seeds, using all fourteen items from boxes', () => {
    const uses = new Set<string>();
    const orbitKinds = new Set<number>();
    for (let seed = 1; seed <= 10; seed++) {
      const racers = createRace(seed).karts.map(({ name, color }) => ({ name, color, human: false }));
      const state = createRace(seed, { racers });
      let restored: RaceState = JSON.parse(JSON.stringify(state));
      for (let tick = 0; tick < 60 * 180 && state.phase !== 'finished'; tick++) {
        const inventory = state.karts.map(kart => kart.item);
        stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
        stepRace(restored, restored.karts.map(kart => getAIInput(restored, kart.id)));
        for (const kart of state.karts) {
          if (kart.item === 'barrier') orbitKinds.add(kart.effects.orbitKind);
        }
        for (const event of state.events) {
          if (event.type === 'use') {
            expect(inventory[event.kartId]).not.toBeNull();
            uses.add(inventory[event.kartId]!);
          }
        }
        if (tick % 137 === 0) {
          expect(restored).toEqual(state);
          restored = JSON.parse(JSON.stringify(restored));
        }
      }
      expect(state.phase, `seed ${seed}`).toBe('finished');
      expect(isRaceTimedOut(state), `seed ${seed}`).toBe(false);
      expect(state.karts.every(kart => !kart.human && kart.lapTimes.length === 3 &&
        kart.lap === 3 && kart.finishTime !== null), `seed ${seed}`).toBe(true);
      expect(restored).toEqual(state);
    }
    expect([...orbitKinds].sort()).toEqual([1, 2]);
    expect([...uses].sort()).toEqual(['dash', 'trap', 'bolt', 'seeker', 'skycomet', 'tripleDash',
      'rapidDash', 'aura', 'storm', 'ink', 'decoy', 'bomb', 'autopilot', 'barrier'].sort());
  }, 20_000);

  it('drives all eight input sources around the course and completes a three lap race', () => {
    const racers = createRace(2026).karts.map(({ name, color }) => ({ name, color, human: true }));
    const state = createRace(2026, { racers });
    const uses = new Set<string>();
    for (let i = 0; i < 60 * 180 && state.phase !== 'finished'; i++) {
      const frames = state.karts.map((kart) => getAIInput(state, kart.id));
      const inventory = state.karts.map(kart => kart.item);
      stepRace(state, frames);
      for (const event of state.events) {
        if (event.type === 'use' && inventory[event.kartId]) uses.add(inventory[event.kartId]!);
      }
    }
    expect(state.phase, JSON.stringify(state.karts.map((kart) => ({ id: kart.id, lap: kart.lap, checkpoint: kart.nextCheckpoint, progress: kart.lapProgress, offset: kart.lateralOffset, speed: kart.speed })))).toBe('finished');
    expect(state.karts[0]!.lapTimes).toHaveLength(3);
    expect(state.karts[0]!.finishTime).toBeGreaterThan(35);
    expect(state.karts.every((kart) => kart.lap === 3 && kart.finishTime !== null)).toBe(true);
    expect(uses.size).toBeGreaterThanOrEqual(3);
    expect(['dash', 'trap', 'bolt'].some(item => uses.has(item))).toBe(true);
  }, 20_000);
});


describe('CPU finish independence', () => {
  it.each([600, 3605])('ends exactly 45 seconds after first finish tick %s and preserves DNF through JSON replay', (firstFinishTick) => {
    expect(RACE_FINISH_TIMEOUT).toBe(45);
    const state = startRace();
    const firstFinish = firstFinishTick * FIXED_DT;
    const deadlineTick = firstFinishTick + RACE_FINISH_TIMEOUT / FIXED_DT;
    const deadline = deadlineTick * FIXED_DT;
    state.karts[1]!.finishTime = firstFinish;
    state.karts[2]!.finishTime = firstFinish + 5;
    state.racingTicks = deadlineTick - 2;
    state.time = state.racingTicks * FIXED_DT;
    const restored: RaceState = JSON.parse(JSON.stringify(state));
    for (const race of [state, restored]) {
      stepRace(race, []);
      expect(race.phase).toBe('racing');
      expect(getFinishTimeRemaining(race)).toBeCloseTo(FIXED_DT, 10);
      expect(isRaceTimedOut(race)).toBe(false);
      expect(race.time).toBeCloseTo(deadline - FIXED_DT, 10);
      stepRace(race, []);
      expect(race.phase).toBe('finished');
      expect(getFinishTimeRemaining(race)).toBe(0);
      expect(isRaceTimedOut(race)).toBe(true);
      expect(formatResultTime(race, race.karts[0]!)).toBe('DNF · 未完走');
      expect(formatResultTime(race, race.karts[3]!)).toBe('DNF · 未完走');
      expect(race.time).toBe(deadline);
      expect(race.karts[0]!.finishTime).toBeNull();
      expect(race.karts[1]!.finishTime).toBe(firstFinish);
      expect(race.karts[2]!.finishTime).toBe(firstFinish + 5);
      expect(getRank(race, 1)).toBe(1);
      expect(getRank(race, 2)).toBe(2);
      stepRace(race, []);
      expect(race.time).toBe(deadline);
    }
    expect(restored).toEqual(state);
  });

  it('announces 45 seconds at the first finish and counts down without resetting for later finishers', () => {
    const state = startRace();
    expect(getFinishTimeRemaining(state)).toBeNull();
    state.time = 80;
    state.karts[1]!.finishTime = 80;
    expect(getFinishTimeRemaining(state)).toBe(45);
    state.time = 81.2;
    expect(Math.ceil(getFinishTimeRemaining(state)!)).toBe(44);
    state.time = 100;
    state.karts[2]!.finishTime = 100;
    expect(getFinishTimeRemaining(state)).toBe(25);
    expect(getFinishTimeRemaining(JSON.parse(JSON.stringify(state)))).toBe(25);
  });

  it.each([80, 125])('labels unfinished CPUs as running in progress order when the player finishes at %s', (time) => {
    const state = startRace();
    state.karts[1]!.finishTime = 80;
    state.karts[0]!.finishTime = time;
    state.racingTicks = Math.round(time / FIXED_DT) - 1;
    const ahead = state.karts[4]!;
    ahead.startedLap = true;
    ahead.lap = 2;
    ahead.lapProgress = 300;
    stepRace(state, []);
    expect(state.phase).toBe('finished');
    expect(isRaceTimedOut(state)).toBe(false);
    expect(getRank(state, ahead.id)).toBe(3);
    expect(getRank(state, 2)).toBeGreaterThan(getRank(state, ahead.id));
    expect(formatResultTime(state, ahead)).toBe('走行中 · 推定順位');
    expect(formatResultTime(state, state.karts[2]!)).toBe('走行中 · 推定順位');
    expect(formatResultTime(state, state.karts[1]!)).toBe('01:20.00');
    const replay: RaceState = JSON.parse(JSON.stringify(state));
    expect(formatResultTime(replay, replay.karts[4]!)).toBe('走行中 · 推定順位');
  });

  it('keeps the race open before anyone finishes and ends immediately on the human finish', () => {
    const state = startRace();
    state.racingTicks = 180 / FIXED_DT;
    stepRace(state, []);
    expect(state.phase).toBe('racing');
    state.karts[0]!.finishTime = state.time;
    stepRace(state, []);
    expect(state.phase).toBe('finished');
  });

  it('keeps a finished CPU driving slowly without changing its recorded laps, time, or rank', () => {
    const state = startRace();
    const cpu = state.karts[1]!;
    place(cpu, 5);
    cpu.speed = 25;
    cpu.lap = TOTAL_LAPS;
    cpu.finishTime = 1;
    cpu.lapTimes = [0.3, 0.3, 0.4];
    const initial = { x: cpu.x, z: cpu.z };
    for (let tick = 0; tick < 180; tick++) stepRace(state, []);
    expect(Math.hypot(cpu.x - initial.x, cpu.z - initial.z)).toBeGreaterThan(15);
    expect(cpu.speed).toBeGreaterThan(5);
    expect(cpu.speed).toBeLessThan(13);
    expect(cpu.finishTime).toBe(1);
    expect(cpu.lapTimes).toEqual([0.3, 0.3, 0.4]);
    expect(cpu.lap).toBe(TOTAL_LAPS);
    expect(getRank(state, cpu.id)).toBe(1);
  });

  it('keeps finished CPU karts solid for rear impacts but excludes item hits', () => {
    const state = startRace();
    const player = state.karts[0]!;
    const cpu = state.karts[1]!;
    place(player, 50);
    place(cpu, 51.2);
    player.speed = 20;
    cpu.finishTime = 1;
    stepRace(state, []);
    expect(Math.hypot(cpu.x - player.x, cpu.z - player.z)).toBeGreaterThanOrEqual(KART_RADIUS * 2);
    expect(cpu.speed).toBeGreaterThan(5);
    expect(player.speed).toBeLessThan(15);
    state.traps.push({ kind: 'trap', id: 999, ownerId: 0, x: cpu.x, y: cpu.y, z: cpu.z,
      heading: cpu.heading, life: 20, age: 2 });
    stepRace(state, []);
    expect(cpu.spinTime).toBe(0);
    expect(state.traps).toHaveLength(1);
    expect(cpu.finishTime).toBe(1);
  });

  it('lets all seven CPU racers complete three laps while the human remains on the grid', () => {
    const state = createRace(681);
    for (let i = 0; i < 60 * 180 && state.karts.slice(1).some((kart) => kart.finishTime === null); i++) {
      stepRace(state, state.karts.map((kart) => kart.id === 0 ? NEUTRAL_INPUT : getAIInput(state, kart.id)));
    }
    expect(state.karts.slice(1).map((kart) => kart.lap)).toEqual([3, 3, 3, 3, 3, 3, 3]);
    expect(state.phase).toBe('racing');
  }, 20_000);
});

describe('wall contact velocity', () => {
  it('loses speed in proportion to impact angle and removes the outward velocity once', () => {
    const impact = (angle: number, offset: number): RaceState => {
      const state = startRace();
      const kart = state.karts[0]!;
      place(kart, 25, offset);
      kart.heading += angle;
      kart.speed = 14;
      stepRace(state, [accelerate]);
      return state;
    };
    const limit = WALL_HALF_WIDTH - KART_RADIUS;
    const free = impact(0.12, limit - 1);
    const shallow = impact(0.12, limit - 0.01);
    const steep = impact(1.2, limit - 0.01);
    expect(shallow.karts[0]!.speed).toBeGreaterThan(free.karts[0]!.speed * 0.97);
    expect(steep.karts[0]!.speed).toBeLessThan(free.karts[0]!.speed * 0.5);
    expect(steep.events).toContainEqual({ type: 'hit', kartId: 0 });
    for (const state of [shallow, steep]) {
      const kart = state.karts[0]!;
      const sample = sampleTrack(kart.trackDistance);
      const normal = Math.sin(kart.heading) * sample.nx + Math.cos(kart.heading) * sample.nz;
      expect(normal).toBeCloseTo(0, 8);
      const speed = kart.speed;
      stepRace(state, [accelerate]);
      expect(kart.speed).toBeGreaterThan(speed * 0.99);
      expect(state.events).not.toContainEqual({ type: 'hit', kartId: 0 });
    }
  });

  it.each([false, true])('slides along the rail under sustained outward steering (drift=%s)', (drift) => {
    const state = startRace();
    const kart = state.karts[0]!;
    place(kart, 25, WALL_HALF_WIDTH - KART_RADIUS - 0.01);
    kart.heading += 0.12;
    kart.speed = 14;
    for (let tick = 0; tick < 120; tick++) {
      stepRace(state, [{ ...accelerate, steer: 0.15, drift }]);
      expect(Math.abs(kart.lateralOffset)).toBeLessThanOrEqual(WALL_HALF_WIDTH - KART_RADIUS + 0.01);
    }
    expect(kart.speed).toBeGreaterThan(11);
    expect(kart.trackDistance).toBeGreaterThan(45);
  });
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

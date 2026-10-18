import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAIInput } from './ai';
import { figureEightCourse, figureEightCrossings, FIGURE_EIGHT_UPPER_Y } from './elevation.fixture';
import { advanceItems, useItem } from './items';
import { updateLapTracking } from './laps';
import { createRace, FIXED_DT, NEUTRAL_INPUT, stepRace } from './race';
import { random } from './random';
import { buildTrack, LEVEL_GAP, projectToTrack, sameLevel, sampleTrack } from './track';
import * as tracks from './tracks';
import type { KartState, RaceState, Track } from './types';

const def = figureEightCourse();
const figureEight = buildTrack(def);
const { lower, upper } = figureEightCrossings(def);

afterEach(() => vi.restoreAllMocks());

function arcGap(track: Track, from: number, to: number): number {
  const gap = Math.abs(to - from);
  return Math.min(gap, track.length - gap);
}

function place(kart: KartState, track: Track, distance: number, offset = 0): void {
  const sample = sampleTrack(track, distance);
  Object.assign(kart, {
    x: sample.x + sample.nx * offset, y: sample.y, z: sample.z + sample.nz * offset,
    heading: Math.atan2(sample.tx, sample.tz), speed: 0, trackDistance: sample.distance, lateralOffset: offset,
  });
}

function racingOn(track: Track, karts: number): RaceState {
  vi.spyOn(tracks, 'getTrack').mockReturnValue(track);
  const state = createRace(1, { racers: [] });
  state.phase = 'racing';
  state.countdown = 0;
  state.karts = state.karts.slice(0, karts);
  state.boxes = [];
  return state;
}

describe('level gate', () => {
  it('treats |Δy| ≤ 6.0 as the same deck', () => {
    expect(LEVEL_GAP).toBe(6.0);
    expect(sameLevel(0, 6)).toBe(true);
    expect(sameLevel(12.5, 6.5)).toBe(true);
    expect(sameLevel(0, 6.0001)).toBe(false);
    expect(sameLevel(0, FIGURE_EIGHT_UPPER_Y)).toBe(false);
  });
});

describe('figure eight crossover', () => {
  it('finishes 8 CPUs × 3 laps with every per-tick trackDistance step below 5 m', () => {
    vi.spyOn(tracks, 'getTrack').mockReturnValue(figureEight);
    const state = createRace(7, { racers: [] });
    expect(state.karts).toHaveLength(8);
    let largest = 0;
    for (let tick = 0; tick < 60 * 300 && state.phase !== 'finished'; tick++) {
      const before = state.karts.map(kart => kart.trackDistance);
      stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
      state.karts.forEach((kart, i) => { largest = Math.max(largest, arcGap(figureEight, before[i]!, kart.trackDistance)); });
    }
    expect(state.phase).toBe('finished');
    expect(state.karts.every(kart => kart.lap === 3 && kart.finishTime !== null)).toBe(true);
    expect(largest).toBeLessThan(5);
  }, 60_000);

  it('does not advance nextCheckpoint when the other deck crosses a gate line in XZ', () => {
    const distances = [...figureEight.checkpointDistances];
    distances[1] = lower;
    const gated: Track = { ...figureEight, checkpointDistances: distances };
    const gate = sampleTrack(gated, lower);
    const cross = (trackDistance: number): KartState => {
      const state = racingOn(gated, 1);
      const kart = state.karts[0]!;
      Object.assign(kart, { startedLap: true, lapValid: true, nextCheckpoint: 1, lapProgress: 0, trackDistance,
        x: gate.x + gate.tx * 0.5, z: gate.z + gate.tz * 0.5, heading: Math.atan2(gate.tx, gate.tz), speed: 10 });
      updateLapTracking(gated, state, kart,
        { x: gate.x - gate.tx * 0.5, z: gate.z - gate.tz * 0.5, trackDistance });
      return kart;
    };
    // The same XZ step over the gate line counts on its own deck...
    expect(cross(lower).nextCheckpoint).toBe(2);
    // ...but not from the upper deck, more than 40 m of arc away.
    expect(arcGap(gated, upper, lower)).toBeGreaterThan(40);
    expect(cross(upper).nextCheckpoint).toBe(1);
  });

  it('keeps an upper-deck bolt on its deck across the crossing', () => {
    const state = racingOn(figureEight, 1);
    const owner = state.karts[0]!;
    // 4 m off the upper centre line, the lower centre line is nearer in XZ for |s| < 4 m.
    place(owner, figureEight, upper - 15, 4);
    owner.y = FIGURE_EIGHT_UPPER_Y;
    owner.item = 'bolt';
    useItem(state, owner, NEUTRAL_INPUT);
    useItem(state, owner, { ...NEUTRAL_INPUT, useItem: true });
    // A bolt is held while pressed and fired on release.
    useItem(state, owner, NEUTRAL_INPUT);
    const bolt = state.projectiles[0]!;
    expect(bolt.kind).toBe('bolt');
    let distance = projectToTrack(figureEight, bolt.x, bolt.z, owner.trackDistance).distance;
    let passed = false;
    let ticks = 0;
    for (; ticks < 60 && state.projectiles.length > 0 && !passed; ticks++) {
      advanceItems(figureEight, state, FIXED_DT);
      const next = projectToTrack(figureEight, bolt.x, bolt.z, distance).distance;
      expect(arcGap(figureEight, distance, next)).toBeLessThan(5);
      // The sim's own projection (bolt.y is its height) stays on the upper deck.
      expect(bolt.y).toBe(sampleTrack(figureEight, next).y);
      expect(bolt.y).toBeGreaterThan(FIGURE_EIGHT_UPPER_Y - LEVEL_GAP);
      distance = next;
      passed = arcGap(figureEight, distance, upper) > 10 && distance > upper;
    }
    expect(passed).toBe(true);
  });

  it('neither collides nor pushes karts 12.5 m apart that overlap in XZ', () => {
    const run = (secondDistance: number): RaceState => {
      const state = racingOn(figureEight, 2);
      const [first, second] = state.karts as [KartState, KartState];
      place(first, figureEight, lower);
      place(second, figureEight, secondDistance);
      first.effects.auraTime = 5;
      stepRace(state, [NEUTRAL_INPUT, NEUTRAL_INPUT]);
      return state;
    };
    const apart = run(upper);
    const [low, high] = apart.karts as [KartState, KartState];
    expect(high.y - low.y).toBe(FIGURE_EIGHT_UPPER_Y);
    expect(Math.hypot(low.x - high.x, low.z - high.z)).toBeLessThan(1e-9);
    expect(apart.events.filter(event => event.type === 'hit')).toEqual([]);
    expect(high.spinTime).toBe(0);
    // The same overlap on one deck does collide (control).
    const together = run(lower);
    expect(together.events.some(event => event.type === 'hit' && event.kartId === 1)).toBe(true);
    const [a, b] = together.karts as [KartState, KartState];
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0);
  });

  it('explodes onto a kart 4.9 m above inside 4.5 m but not one 6.1 m above', () => {
    const state = racingOn(figureEight, 3);
    const [owner, near, far] = state.karts as [KartState, KartState, KartState];
    place(owner, figureEight, lower - 60);
    const at = lower - 30;
    const ground = sampleTrack(figureEight, at);
    for (const [kart, dy] of [[near, 4.9], [far, 6.1]] as const) {
      place(kart, figureEight, at, kart === near ? 3 : -3);
      kart.y = ground.y + dy;
    }
    state.projectiles.push({ kind: 'bomb', id: state.nextEntityId++, ownerId: owner.id, x: ground.x, y: ground.y,
      z: ground.z, heading: Math.atan2(ground.tx, ground.tz), life: FIXED_DT / 2, bounces: 1,
      aux: FIXED_DT / 2, speed: 0 } as never);
    advanceItems(figureEight, state, FIXED_DT);
    const explosion = state.events.find(event => event.type === 'explode');
    expect(explosion?.value).toBe(1 << near.id);
    expect(near.spinTime).toBeGreaterThan(0);
    expect(far.spinTime).toBe(0);
  });
});

describe('yHint determinism', () => {
  it('reprojects every sample and 2000 seeded points identically with the surface height as yHint', () => {
    const courses = [...tracks.TRACK_IDS.map(id => tracks.getTrack(id))];
    expect(courses).toHaveLength(20);
    const rng = { seed: 20261014 };
    for (const track of courses) {
      let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
      for (const sample of track.samples) {
        minX = Math.min(minX, sample.x); maxX = Math.max(maxX, sample.x);
        minZ = Math.min(minZ, sample.z); maxZ = Math.max(maxZ, sample.z);
      }
      const points: [number, number][] = track.samples.map(sample => [sample.x, sample.z]);
      for (let i = 0; i < 2000; i++) {
        points.push([minX - 20 + (maxX - minX + 40) * random(rng), minZ - 20 + (maxZ - minZ + 40) * random(rng)]);
      }
      for (const [x, z] of points) {
        const p = projectToTrack(track, x, z);
        expect(projectToTrack(track, x, z, undefined, sampleTrack(track, p.distance).y)).toEqual(p);
      }
    }
  });
});

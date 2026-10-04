import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAIInput } from '../ai';
import { TOTAL_LAPS } from '../laps';
import { createRace, FIXED_DT, stepRace } from '../race';
import { crossedZone, racingLineOffset } from '../surfaces';
import { sampleTrack } from '../track';
import type { TrackId, TrackSample } from '../types';
import { getTrack } from './index';
import { NEON_TUNNEL } from './neon';

const track = getTrack('neon');

function radius(a: TrackSample, b: TrackSample, c: TrackSample): number {
  const twiceArea = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
  return Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) *
    Math.hypot(c.x - a.x, c.z - a.z) / (2 * twiceArea);
}

function runRace(trackId: TrackId, seed: number) {
  const state = createRace(seed, { trackId, racers: [] });
  const boosts = state.karts.map(() => new Set<number>());
  let hits = 0;
  for (let tick = 0; tick < 60 * 180 && state.phase !== 'finished'; tick++) {
    const previous = state.karts.map(kart => kart.trackDistance);
    const before = trackId === 'neon' ? structuredClone(state) : null;
    const inputs = state.karts.map(kart => getAIInput(state, kart.id));
    stepRace(state, inputs);
    hits += state.events.filter(event => event.type === 'hit').length;
    if (trackId !== 'neon') continue;
    for (const kart of state.karts) {
      if (!kart.startedLap || kart.finishTime !== null) continue;
      if (crossedZone(track, 'boost', previous[kart.id]!, kart.trackDistance, kart.lateralOffset)) {
        expect(kart.trackDistance).toBeGreaterThanOrEqual(NEON_TUNNEL.from);
        expect(kart.trackDistance).toBeLessThan(NEON_TUNNEL.to);
        expect(kart.boostTime).toBeGreaterThan(0);
        // Replay this entrance with competing boosts capped below the panel's
        // duration. Keep an active boost for this tick's acceleration.
        const entrance = structuredClone(before!);
        const enteringKart = entrance.karts[kart.id]!;
        enteringKart.boostTime = Math.min(enteringKart.boostTime, 2 * FIXED_DT);
        enteringKart.driftTime = 0;
        const previousBoostTime = enteringKart.boostTime;
        stepRace(entrance, inputs.map(input => ({ ...input, useItem: false })));
        expect(crossedZone(track, 'boost', previous[kart.id]!, enteringKart.trackDistance,
          enteringKart.lateralOffset)).toBe(true);
        expect(enteringKart.boostTime).toBeGreaterThan(previousBoostTime);
        expect(enteringKart.boostTime).toBe(0.5);
        boosts[kart.id]!.add(kart.lap);
      }
    }
  }
  expect(state.phase).toBe('finished');
  expect(state.karts).toHaveLength(8);
  for (const kart of state.karts) {
    expect(kart.human).toBe(false);
    expect(kart.lap).toBe(TOTAL_LAPS);
    expect(kart.lapTimes).toHaveLength(TOTAL_LAPS);
    expect(kart.finishTime).not.toBeNull();
    expect(kart.finishTime).toBeLessThanOrEqual(180);
  }
  return { hits, boosts };
}

describe('NEON NIGHTLINE', () => {
  it('has four safe right-angle corners on a distinct, flat 560–700m loop', () => {
    expect(track.length).toBeGreaterThanOrEqual(560);
    expect(track.length).toBeLessThanOrEqual(700);
    const hash = (samples: readonly TrackSample[]) => createHash('sha256').update(JSON.stringify(samples)).digest('hex');
    expect(hash(track.samples)).not.toBe(hash(getTrack('meadow').samples));
    expect(track.samples.every(point => point.y === 0)).toBe(true);
    let minimumRadius = Infinity;
    for (let i = 0; i < track.samples.length; i++) {
      minimumRadius = Math.min(minimumRadius, radius(
        track.samples[(i + track.samples.length - 1) % track.samples.length]!,
        track.samples[i]!, track.samples[(i + 1) % track.samples.length]!,
      ));
    }
    expect(minimumRadius).toBeGreaterThanOrEqual(13);
    for (let corner = 0; corner < 4; corner++) {
      const apex = track.length * (corner / 4) + 137;
      const entry = sampleTrack(track, apex - 45);
      const exit = sampleTrack(track, apex + 45);
      const cross = entry.tx * exit.tz - entry.tz * exit.tx;
      const dot = entry.tx * exit.tx + entry.tz * exit.tz;
      const turn = Math.atan2(cross, dot);
      expect(Math.abs(turn) * 180 / Math.PI).toBeGreaterThanOrEqual(80);
      expect(Math.abs(turn) * 180 / Math.PI).toBeLessThanOrEqual(100);
      const offset = racingLineOffset(track, apex);
      expect(Math.abs(offset)).toBeGreaterThanOrEqual(2);
      // Track normals point right, so a left turn has negative inside offset.
      expect(offset * turn).toBeLessThan(0);
    }
  });

  it('places one float32-exact boost panel at the entrance of a straight tunnel', () => {
    expect(NEON_TUNNEL.to - NEON_TUNNEL.from).toBeGreaterThanOrEqual(60);
    expect(track.def.surfaces).toEqual([
      { kind: 'boost', from: NEON_TUNNEL.from, to: NEON_TUNNEL.from + 6 },
    ]);
    expect(Math.fround(NEON_TUNNEL.from)).toBe(NEON_TUNNEL.from);
    for (let i = 0; i < track.samples.length; i++) {
      const point = track.samples[i]!;
      if (point.distance < NEON_TUNNEL.from || point.distance > NEON_TUNNEL.to) continue;
      expect(radius(track.samples[i - 1]!, point, track.samples[i + 1]!)).toBeGreaterThanOrEqual(200);
    }
  });

  it.each([1, 42, 98765])('boosts every CPU on every lap and stays within MEADOW’s wall-hit budget (seed %i)', seed => {
    const meadow = runRace('meadow', seed);
    const neon = runRace('neon', seed);
    for (const laps of neon.boosts) expect([...laps].sort()).toEqual([0, 1, 2]);
    expect(neon.hits).toBeLessThanOrEqual(meadow.hits * 2);
  }, 30_000);
});

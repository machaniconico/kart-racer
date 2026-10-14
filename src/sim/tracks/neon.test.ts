import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAIInput } from '../ai';
import { validateTrackDef } from '../corridor';
import { DEFAULT_LAPS } from '../laps';
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
    expect(kart.lap).toBe(DEFAULT_LAPS);
    expect(kart.lapTimes).toHaveLength(DEFAULT_LAPS);
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
    expect(track.def.surfaces.filter(zone => zone.kind === 'boost')).toEqual([
      { kind: 'boost', from: NEON_TUNNEL.from, to: NEON_TUNNEL.from + 6 },
    ]);
    expect(Math.fround(NEON_TUNNEL.from)).toBe(NEON_TUNNEL.from);
    for (let i = 0; i < track.samples.length; i++) {
      const point = track.samples[i]!;
      if (point.distance < NEON_TUNNEL.from || point.distance > NEON_TUNNEL.to) continue;
      expect(radius(track.samples[i - 1]!, point, track.samples[i + 1]!)).toBeGreaterThanOrEqual(200);
    }
  });

  it('validates layout 3 with one sweep, one gate and one 12m spin floor', () => {
    expect(track.def.layoutVersion).toBe(3);
    expect(track.def.barriers).toEqual([
      {
        from: 176, to: 208, center: -2, halfWidth: 1.2, taper: 4, scenery: 'pillar',
        motion: { kind: 'sweep', amplitude: 4.0, period: 6, phase: 0 },
      },
      {
        from: 340, to: 370, center: 0, halfWidth: 3.6, taper: 8, scenery: 'block',
        motion: { kind: 'gate', amplitude: 0, period: 5, phase: 0, minWidth: 1.2 },
      },
    ]);
    expect(track.def.surfaces.filter(zone => zone.kind === 'spin')).toEqual([
      { kind: 'spin', from: 558, to: 570, offsetMin: -6, offsetMax: 6, rate: 1.0 },
    ]);
    expect(() => validateTrackDef(track.def)).not.toThrow();
  });

  it('starts detours at least 30m early with lateral slopes no greater than 0.30', () => {
    expect(track.def.racingLine).toEqual([
      { distance: 0, offset: 0 },
      { distance: 95, offset: 0 }, { distance: 137, offset: -3.25 },
      { distance: 176, offset: 6.8 }, { distance: 208, offset: 6.8 }, { distance: 240, offset: 0 },
      { distance: 260, offset: 0 }, { distance: 302, offset: -3.25 },
      { distance: 340, offset: 5.2 }, { distance: 370, offset: 5.2 }, { distance: 400, offset: 0 },
      { distance: 425, offset: 0 }, { distance: 467, offset: -3.25 }, { distance: 507, offset: 0 },
      { distance: 590, offset: 0 }, { distance: 632, offset: -3.25 },
    ]);
    for (const barrier of track.def.barriers!) {
      const approach = track.def.racingLine.filter(point => point.distance < barrier.from).at(-1)!;
      expect(barrier.from - approach.distance).toBeGreaterThanOrEqual(30);
    }
    for (let i = 1; i < track.def.racingLine.length; i++) {
      const previous = track.def.racingLine[i - 1]!;
      const point = track.def.racingLine[i]!;
      expect(Math.abs(point.offset - previous.offset) / (point.distance - previous.distance))
        .toBeLessThanOrEqual(0.30);
    }
    for (const distance of [558, 564, 570]) expect(racingLineOffset(track, distance)).toBe(0);
  });

  it.each([1, 42, 98765])('boosts every CPU on every lap and stays within MEADOW’s wall-hit budget (seed %i)', seed => {
    const meadow = runRace('meadow', seed);
    const neon = runRace('neon', seed);
    for (const laps of neon.boosts) expect([...laps].sort()).toEqual([0, 1, 2]);
    expect(neon.hits).toBeLessThanOrEqual(meadow.hits * 2);
  }, 30_000);
});

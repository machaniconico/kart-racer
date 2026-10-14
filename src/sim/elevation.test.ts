import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAIInput } from './ai';
import { validateTrackDef } from './corridor';
import { bankCourse, figureEightCourse, figureEightCrossings, FIGURE_EIGHT_UPPER_Y, slopeCourse, SLOPE_RISE, stadiumSections } from './elevation.fixture';
import { createRace, FIXED_DT, stepRace } from './race';
import { buildTrack, rollAt, sampleTrack, slopeAt, surfaceHeightAt } from './track';
import * as tracks from './tracks';
import type { InputFrame, RaceState, Track } from './types';

afterEach(() => vi.restoreAllMocks());

// sha256 after 2000 AI ticks on slopeCourse(0), measured on darwin-arm64 after M4.5-03.
// Allocating 24 boxes changes nextEntityId from 112 to 124, even after soloRace clears the boxes.
// Before M4.5-03: ef1b943f61224fb1a8f954dee4448729c48b8425856379c203864489eeaf491f.
// Before M4.5-00 (laps / lastBand): 4e48385419ddf18007f71f58761bb09b5cb935a10a1abc029fbf102adce00dba.
const FLAT_COURSE_PIN = '57d81719ab07d03cb68cf820057334f55c91c57085fd727a6e5f163ed52a388e';

function soloRace(track: Track, distance: number, speed = 0, offset = 0): RaceState {
  vi.spyOn(tracks, 'getTrack').mockReturnValue(track);
  const state = createRace(1);
  state.phase = 'racing';
  state.karts = [state.karts[0]!];
  state.boxes = [];
  const sample = sampleTrack(track, distance);
  Object.assign(state.karts[0]!, {
    x: sample.x + sample.nx * offset, y: sample.y, z: sample.z + sample.nz * offset,
    heading: Math.atan2(sample.tx, sample.tz), speed, trackDistance: distance, lateralOffset: offset,
  });
  return state;
}

const FULL_THROTTLE: InputFrame = { steer: 0, throttle: 1, brake: false, drift: false, useItem: false };

/** Speed when the kart first reaches `to`, driving straight at full throttle from `from`. */
function speedAt(track: Track, from: number, to: number): number {
  const state = soloRace(track, from);
  const kart = state.karts[0]!;
  for (let tick = 0; tick < 60 * 20; tick++) {
    stepRace(state, [FULL_THROTTLE]);
    if (kart.trackDistance >= to) return kart.speed;
  }
  throw new Error(`kart did not reach ${to}`);
}

describe('slope physics', () => {
  it('pins slopeCourse(0) JSON after 24-box allocation', () => {
    const state = soloRace(buildTrack(slopeCourse(0)), 10);
    for (let tick = 0; tick < 2000; tick++) stepRace(state, [getAIInput(state, 0)]);
    expect(state.karts[0]!.nextCheckpoint).toBeGreaterThan(0);
    expect(createHash('sha256').update(JSON.stringify(state)).digest('hex')).toBe(FLAT_COURSE_PIN);
  });

  it('settles at 0.80–0.90× flat speed up a 0.3 grade and 1.10–1.20× down it', () => {
    const flat = buildTrack(slopeCourse(0));
    const steep = buildTrack(slopeCourse(0.3));
    const { up, down } = stadiumSections(steep.def);
    for (let t = 0; t <= 1; t += 0.05) {
      expect(slopeAt(steep, up[0] + (up[1] - up[0]) * t)).toBeCloseTo(0.3, 12);
      expect(slopeAt(steep, down[0] + (down[1] - down[0]) * t)).toBeCloseTo(-0.3, 12);
    }
    const upRatio = speedAt(steep, ...up) / speedAt(flat, ...up);
    const downRatio = speedAt(steep, ...down) / speedAt(flat, ...down);
    expect(upRatio).toBeGreaterThanOrEqual(0.80 - 1e-9);
    expect(upRatio).toBeLessThanOrEqual(0.90 + 1e-9);
    expect(downRatio).toBeGreaterThanOrEqual(1.10 - 1e-9);
    expect(downRatio).toBeLessThanOrEqual(1.20 + 1e-9);
  });

  it('holds a stopped kart on a 0.3 grade (static friction below 0.5 m/s) but lets a moving one roll', () => {
    const track = buildTrack(slopeCourse(0.3));
    const { up, down } = stadiumSections(track.def);
    const downMiddle = (down[0] + down[1]) / 2;
    for (const distance of [(up[0] + up[1]) / 2, downMiddle]) {
      for (const input of [{ ...FULL_THROTTLE, throttle: 0 }, { ...FULL_THROTTLE, throttle: 0, brake: true }]) {
        const state = soloRace(track, distance);
        const kart = state.karts[0]!;
        const { x, z } = kart;
        for (let tick = 0; tick < 120; tick++) stepRace(state, [input]);
        expect(kart.speed).toBe(0);
        expect([kart.x, kart.z]).toEqual([x, z]);
      }
    }
    // Facing down the top straight, a coasting kart at 5 m/s gains speed from gravity.
    const state = soloRace(track, downMiddle, 5);
    stepRace(state, [{ ...FULL_THROTTLE, throttle: 0 }]);
    expect(state.karts[0]!.speed).toBeCloseTo(5 - 5.5 * FIXED_DT + 9.8 * 0.6 * 0.3 * FIXED_DT, 12);
  });

  it('matches the sample segment grade on all four courses and is exactly 0 on a flat fixture', () => {
    for (const id of tracks.TRACK_IDS) {
      const track = tracks.getTrack(id);
      const { samples } = track;
      samples.forEach((sample, i) => {
        const next = samples[(i + 1) % samples.length]!;
        const run = i === samples.length - 1 ? track.length - sample.distance : next.distance - sample.distance;
        if (run === 0) return;
        // Exactly at the sample distance and inside the segment.
        expect(slopeAt(track, sample.distance), `${id} sample ${i}`).toBe((next.y - sample.y) / run);
        expect(slopeAt(track, sample.distance + run / 2), `${id} sample ${i}`).toBe((next.y - sample.y) / run);
      });
    }
    const flat = buildTrack(slopeCourse(0));
    for (const sample of flat.samples) {
      expect(slopeAt(flat, sample.distance)).toBe(0);
      expect(slopeAt(flat, sample.distance + 0.5)).toBe(0);
    }
  });
});

describe('bank physics', () => {
  const roll = 0.3;
  const banked = buildTrack(bankCourse(roll));
  const level = buildTrack(bankCourse(0));
  const [cornerFrom, cornerTo] = stadiumSections(banked.def).rightCorner;

  it('ramps the roll with twist ≤ 0.02 rad/m and matching keys at 0 and length', () => {
    const keys = banked.def.bankKeys!;
    expect(keys[0]).toEqual({ distance: 0, roll: 0 });
    expect(keys.at(-1)).toEqual({ distance: banked.length, roll: 0 });
    for (let i = 1; i < keys.length; i++) {
      expect(Math.abs(keys[i]!.roll - keys[i - 1]!.roll)).toBeLessThanOrEqual(0.02 * (keys[i]!.distance - keys[i - 1]!.distance));
    }
    expect(rollAt(banked, (cornerFrom + cornerTo) / 2)).toBe(roll);
    expect(rollAt(banked, 10)).toBe(0);
    expect(rollAt(level, cornerFrom)).toBe(0);
  });

  it('keeps every tick on the banked surface height', () => {
    const state = soloRace(banked, 10, 0, 3);
    const kart = state.karts[0]!;
    let bankedTicks = 0;
    for (let tick = 0; tick < 2000; tick++) {
      stepRace(state, [getAIInput(state, 0)]);
      expect(kart.y).toBeCloseTo(surfaceHeightAt(banked, kart.trackDistance, kart.lateralOffset), 12);
      if (rollAt(banked, kart.trackDistance) !== 0 && kart.lateralOffset !== 0) bankedTicks++;
    }
    expect(bankedTicks).toBeGreaterThan(60);
  });

  it('turns (1 + 0.3 × |roll| / 0.35)× harder toward the low side and unchanged toward the high side', () => {
    const middle = (cornerFrom + cornerTo) / 2;
    const turn = (track: Track, steer: number): number => {
      const state = soloRace(track, middle, 20);
      const kart = state.karts[0]!;
      kart.steer = steer;
      const before = kart.heading;
      stepRace(state, [{ ...FULL_THROTTLE, steer }]);
      return kart.heading - before;
    };
    // roll > 0 raises +offset, so negative steering (toward −offset) faces the low side.
    expect(turn(banked, -1) / turn(level, -1)).toBeCloseTo(1 + 0.3 * roll / 0.35, 9);
    expect(turn(banked, 1)).toBe(turn(level, 1));
  });
});

describe('elevation fixtures', () => {
  /** Circumradius through consecutive samples, as in tracks.test.ts. */
  const radiusAt = (track: Track, i: number): number => {
    const points = track.samples;
    const a = points[(i + points.length - 1) % points.length]!;
    const b = points[i]!;
    const c = points[(i + 1) % points.length]!;
    const twiceArea = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    return Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) *
      Math.hypot(c.x - a.x, c.z - a.z) / (2 * twiceArea);
  };

  it('keeps the banked span of bankCourse at radius ≥ 40 m', () => {
    const track = buildTrack(bankCourse(0.3));
    let banked = 0;
    track.samples.forEach((sample, i) => {
      if (rollAt(track, sample.distance) === 0) return;
      banked++;
      expect(radiusAt(track, i), `distance ${sample.distance}`).toBeGreaterThanOrEqual(40);
    });
    expect(banked).toBeGreaterThan(30);
  });

  it('keeps slopeCourse corners exactly flat at their end heights', () => {
    for (const grade of [0.3, -0.3, 0]) {
      const track = buildTrack(slopeCourse(grade));
      const { rightCorner, leftCorner } = stadiumSections(track.def);
      for (const [[from, to], y] of [[rightCorner, SLOPE_RISE * grade], [leftCorner, 0]] as const) {
        for (const sample of track.samples) {
          if (sample.distance < from || sample.distance > to) continue;
          expect(sample.y, `grade ${grade} distance ${sample.distance}`).toBe(y);
          expect(slopeAt(track, sample.distance)).toBe(0);
        }
      }
      // One sample per control point, so sample grades are chord grades and never overshoot.
      for (const sample of track.samples) {
        expect(Math.abs(slopeAt(track, sample.distance))).toBeLessThanOrEqual(Math.abs(grade) + 1e-12);
      }
    }
  });

  it('are not registered as courses', () => {
    const names = [slopeCourse(0.3), bankCourse(0.3), figureEightCourse()].map(def => def.name);
    for (const id of tracks.TRACK_IDS) expect(names).not.toContain(tracks.TRACKS[id].name);
    expect(tracks.TRACK_IDS).toEqual(['meadow', 'canyon', 'snowpeak', 'neon']);
  });

  it('pass corridor validation with four gates, 24 boxes and no zones', () => {
    for (const def of [slopeCourse(0), slopeCourse(0.3), bankCourse(0.3), figureEightCourse()]) {
      expect(() => validateTrackDef(def)).not.toThrow();
      expect(def.checkpointCount).toBe(4);
      expect(buildTrack(def).boxPoses).toHaveLength(24);
      expect(def.surfaces).toEqual([]);
      expect(def.barriers ?? []).toEqual([]);
      expect(def.splits ?? []).toEqual([]);
    }
  });

  it('builds a figure eight crossing at 90° with flat, unbanked decks 12.5 m apart', () => {
    const def = figureEightCourse();
    const track = buildTrack(def);
    const { lower, upper } = figureEightCrossings(def);
    const low = sampleTrack(track, lower);
    const high = sampleTrack(track, upper);
    for (const sample of [low, high]) {
      expect(Math.hypot(sample.x, sample.z)).toBeLessThan(1e-9);
    }
    expect(low.y).toBe(0);
    expect(high.y).toBe(FIGURE_EIGHT_UPPER_Y);
    expect(Math.abs(low.tx * high.tx + low.tz * high.tz)).toBeLessThan(1e-9);
    expect(def.decks).toEqual([{ from: upper - 20, to: upper + 20 }]);
    expect(def.bankKeys).toBeUndefined();
    for (const crossing of [lower, upper]) {
      for (let s = -20; s <= 20; s += 0.5) {
        expect(Math.abs(slopeAt(track, crossing + s))).toBeLessThanOrEqual(0.10);
        expect(rollAt(track, crossing + s)).toBe(0);
      }
      for (const gate of track.checkpointDistances) {
        const gap = Math.abs(gate - crossing);
        expect(Math.min(gap, track.length - gap)).toBeGreaterThanOrEqual(25);
      }
    }
    for (const sample of track.samples) expect(Math.abs(slopeAt(track, sample.distance))).toBeLessThanOrEqual(0.30);
  });
});

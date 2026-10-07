import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRace, FIXED_DT, KART_RADIUS, NEUTRAL_INPUT, stepRace } from './race';
import { buildTrack, projectToTrack, sampleTrack } from './track';
import * as tracks from './tracks';
import type { RaceState } from './types';

// The long straight makes incidence exact and keeps curvature, items and other
// karts out of the speed comparison. The shoulder still applies its normal drag.
const track = buildTrack({
  ...tracks.TRACKS.meadow, scale: 1,
  controlPoints: [[-1500, 0, 0], [-1000, 0, 0], [-500, 0, 0], [0, 0, 0],
    [500, 0, 0], [1000, 0, 0], [1500, 0, 0], [1500, 0, 1000], [-1500, 0, 1000]],
  surfaces: [], racingLine: [],
});
const limit = track.def.wallHalfWidth - KART_RADIUS;

afterEach(() => vi.restoreAllMocks());

function approach(angle: number, side: number, direction: number, airborne = false, clearance = 1e-6): RaceState {
  vi.spyOn(tracks, 'getTrack').mockReturnValue(track);
  const state = createRace(1);
  state.phase = 'racing';
  state.karts = [state.karts[0]!];
  state.boxes = [];
  const sample = sampleTrack(track, 1500);
  const radians = angle * Math.PI / 180;
  const offset = side * (limit - clearance);
  Object.assign(state.karts[0]!, {
    x: sample.x + sample.nx * offset, z: sample.z + sample.nz * offset, y: sample.y,
    heading: Math.atan2(sample.tx * direction * Math.cos(radians) + sample.nx * side * Math.sin(radians),
      sample.tz * direction * Math.cos(radians) + sample.nz * side * Math.sin(radians)),
    speed: 14, trackDistance: sample.distance, lateralOffset: offset, airTime: airborne ? 0.4 : 0,
  });
  return state;
}

function expectInside(state: RaceState): void {
  const kart = state.karts[0]!;
  // Check actual coordinates as well as the cached offset: clamping only the
  // latter must not hide penetration.
  expect(Math.abs(projectToTrack(track, kart.x, kart.z).offset)).toBeLessThanOrEqual(limit + 1e-8);
  expect(Math.abs(kart.lateralOffset)).toBeLessThanOrEqual(limit + 1e-8);
}

describe.each([-1, 1])('wall side %i', side => {
  describe.each([-1, 1])('travel direction %i', direction => {
    it.each([1, 10, 20, 30, 40, 50, 60, 75, 89, 89.999, 90])(
      'retains the intended speed at %i degrees and cannot penetrate', angle => {
        for (const airborne of [false, true]) {
          const state = approach(angle, side, direction, airborne);
          const free = approach(angle, side, direction, airborne, 2);
          stepRace(free, [NEUTRAL_INPUT]);
          stepRace(state, [NEUTRAL_INPUT]);
          const kart = state.karts[0]!;
          const retained = kart.speed / free.karts[0]!.speed;
          if (angle <= 20) {
            expect(kart.speed).toBeGreaterThanOrEqual(14 * 0.9);
            expect(retained).toBeCloseTo(1, 10);
          } else if (angle >= 60) {
            expect(retained).toBeCloseTo(Math.cos(angle * Math.PI / 180), 10);
          } else {
            const expected = new Map([[30, 0.9665063509461097], [40, 0.883022221559489], [50, 0.7320907072649045]]);
            expect(retained).toBeCloseTo(expected.get(angle)!, 10);
          }
          expectInside(state);
          const sample = sampleTrack(track, kart.trackDistance);
          expect(Math.sin(kart.heading) * sample.nx + Math.cos(kart.heading) * sample.nz).toBeCloseTo(0, 10);
          if (angle < 90) {
            expect((Math.sin(kart.heading) * sample.tx + Math.cos(kart.heading) * sample.tz) * direction).toBeCloseTo(1, 10);
          }
          const speed = kart.speed;
          stepRace(state, [NEUTRAL_INPUT]);
          expect(kart.speed).toBeCloseTo(Math.max(0, speed - (airborne ? 0 : 5.5 * FIXED_DT)), 10);
          expectInside(state);
          expect(state.events).not.toContainEqual({ type: 'hit', kartId: 0 });
        }
      },
    );

    it.each([false, true])('slides for 240 ticks without heading reversals (drift=%s)', drift => {
      const state = approach(10, side, direction);
      const kart = state.karts[0]!;
      const input = { ...NEUTRAL_INPUT, throttle: 1, steer: side * direction * 0.15, drift };
      for (let tick = 0; tick < 240; tick++) {
        const heading = kart.heading;
        stepRace(state, [input]);
        expectInside(state);
        expect(Math.cos(kart.heading - heading)).toBeGreaterThan(0.98);
        const sample = sampleTrack(track, kart.trackDistance);
        const slip = kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
        const travel = kart.heading - slip;
        expect((Math.sin(travel) * sample.tx + Math.cos(travel) * sample.tz) * direction).toBeGreaterThan(0.99);
      }
      expect(kart.speed).toBeGreaterThan(13);
      expect((kart.trackDistance - 1500) * direction).toBeGreaterThan(50);
    });

    it('corrects a displaced kart moving inward without changing its direction or collision speed', () => {
      const state = approach(-20, side, direction, true, -0.2);
      const heading = state.karts[0]!.heading;
      stepRace(state, [NEUTRAL_INPUT]);
      expectInside(state);
      expect(state.karts[0]!.heading).toBe(heading);
      expect(state.karts[0]!.speed).toBe(14);
      expect(state.events).not.toContainEqual({ type: 'hit', kartId: 0 });
    });
  });
});

it('decreases retained speed continuously across both angle boundaries', () => {
  let previous = 1;
  for (const angle of [0, 10, 19.999, 20, 20.001, 30, 40, 50, 59.999, 60, 60.001, 75, 90]) {
    const state = approach(angle, 1, 1, true, -1e-6);
    stepRace(state, [NEUTRAL_INPUT]);
    const retained = state.karts[0]!.speed / 14;
    expect(retained).toBeLessThanOrEqual(previous + 1e-12);
    expect(retained).toBeGreaterThanOrEqual(0);
    if (angle === 20 || angle === 20.001 || angle === 60 || angle === 60.001) {
      expect(Math.abs(retained - previous)).toBeLessThan(0.0001);
    }
    previous = retained;
    expectInside(state);
  }
});

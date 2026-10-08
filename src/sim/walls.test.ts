import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRace, FIXED_DT, KART_RADIUS, NEUTRAL_INPUT, stepRace } from './race';
import { buildTrack, insideBarrier, projectToTrack, sampleTrack } from './track';
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

describe('collideCorridor: barrier bands and width profiles', () => {
  const barrier = { from: 1500, to: 1530, center: 0, halfWidth: 1, taper: 4 };
  const banded = buildTrack({ ...track.def, barriers: [barrier] });

  function solo(on: typeof track, distance: number, offset: number, speed: number, angle = 0): RaceState {
    vi.spyOn(tracks, 'getTrack').mockReturnValue(on);
    const state = createRace(1);
    state.phase = 'racing';
    state.karts = [state.karts[0]!];
    state.boxes = [];
    const sample = sampleTrack(on, distance);
    const radians = angle * Math.PI / 180;
    Object.assign(state.karts[0]!, {
      x: sample.x + sample.nx * offset, z: sample.z + sample.nz * offset, y: sample.y,
      heading: Math.atan2(sample.tx * Math.cos(radians) + sample.nx * Math.sin(radians),
        sample.tz * Math.cos(radians) + sample.nz * Math.sin(radians)),
      speed, trackDistance: distance, lateralOffset: offset,
    });
    return state;
  }
  const inside = (state: RaceState): boolean => {
    const kart = state.karts[0]!;
    const projection = projectToTrack(banded, kart.x, kart.z);
    return insideBarrier(banded, barrier, projection.distance, projection.offset, 0);
  };

  it('slows a 32 m/s head-on entry with one band hit and bounded steps', () => {
    const state = solo(banded, 1490, 0, 32);
    const kart = state.karts[0]!;
    const hits: unknown[] = [];
    let minSpeed = 32;
    for (let tick = 0; tick < 90; tick++) {
      const x = kart.x;
      const z = kart.z;
      vi.spyOn(tracks, 'getTrack').mockReturnValue(banded);
      stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
      expect(Math.hypot(kart.x - x, kart.z - z)).toBeLessThanOrEqual(1.2);
      expect(inside(state)).toBe(false);
      hits.push(...state.events.filter(event => event.type === 'hit'));
      minSpeed = Math.min(minSpeed, kart.speed);
    }
    expect(minSpeed).toBeLessThan(32);
    expect(kart.trackDistance).toBeLessThan(barrier.from);
    expect(hits).toEqual([{ type: 'hit', kartId: 0, value: 1 }]);
  });

  it('treats a nose jumped in one tick at 70 m/s as head-on (swept from the previous position)', () => {
    let headOn = 0;
    for (let gap = 0.01; gap < 70 * FIXED_DT; gap += 0.1) {
      const state = solo(banded, barrier.from - KART_RADIUS - gap, 0, 70);
      stepRace(state, [NEUTRAL_INPUT]);
      const kart = state.karts[0]!;
      expect(inside(state)).toBe(false);
      if (kart.speed < 60) {
        // The push is longitudinal: the kart stays on the centre line in front of the nose.
        expect(Math.abs(kart.lateralOffset)).toBeLessThan(1e-6);
        expect(kart.trackDistance).toBeLessThan(barrier.from - KART_RADIUS + 1e-3);
        expect(state.events).toContainEqual({ type: 'hit', kartId: 0, value: 1 });
        headOn++;
      }
    }
    // Every gap shorter than one 70 m/s step reaches the band, including ones that land past the nose.
    expect(headOn).toBe(12);
  });

  it.each([0, 5, 10, 15, 20])('keeps at least 98%% of its speed when sliding into the band side at %i degrees', angle => {
    for (const side of [-1, 1]) {
      const edge = barrier.halfWidth + KART_RADIUS;
      const state = solo(banded, 1515, side * (edge + 1e-6), 14, -side * angle);
      const free = solo(track, 1515, side * (edge + 1e-6), 14, -side * angle);
      stepRace(free, [NEUTRAL_INPUT]);
      vi.spyOn(tracks, 'getTrack').mockReturnValue(banded);
      stepRace(state, [NEUTRAL_INPUT]);
      expect(state.karts[0]!.speed / free.karts[0]!.speed).toBeGreaterThan(0.98);
      expect(inside(state)).toBe(false);
    }
  });

  it('moves a kart spawned inside the band to the nearest edge in one tick, then leaves it alone', () => {
    for (const offset of [-0.6, -0.1, 0.3, 1.2]) {
      const state = solo(banded, 1515, offset, 0);
      const kart = state.karts[0]!;
      stepRace(state, [NEUTRAL_INPUT]);
      expect(inside(state)).toBe(false);
      expect(Math.sign(kart.lateralOffset)).toBe(Math.sign(offset));
      expect(Math.abs(kart.lateralOffset)).toBeCloseTo(barrier.halfWidth + KART_RADIUS, 4);
      const { x, z } = kart;
      for (let tick = 0; tick < 10; tick++) {
        stepRace(state, [NEUTRAL_INPUT]);
        expect(kart.x).toBe(x);
        expect(kart.z).toBe(z);
      }
    }
  });

  it('settles between two overlapping bands outside both (regression A)', () => {
    const pair = buildTrack({ ...track.def, barriers: [{ ...barrier, center: -1 }, { ...barrier, center: 1 }] });
    for (const offset of [0, -0.4, 0.4]) {
      const state = solo(pair, 1515, offset, 0);
      const kart = state.karts[0]!;
      stepRace(state, [NEUTRAL_INPUT]);
      for (const band of pair.def.barriers!) {
        expect(insideBarrier(pair, band, kart.trackDistance, kart.lateralOffset, 0)).toBe(false);
      }
      expect(Math.abs(kart.lateralOffset)).toBeCloseTo(2 + KART_RADIUS, 4);
    }
  });

  it('never pushes a kart out of a band through the outer wall (regression B)', () => {
    const narrow = buildTrack({ ...track.def, roadHalfWidth: 6, wallHalfWidth: 7.2, barriers: [{ ...barrier, center: 6 }] });
    for (const offset of [6.1, 5.5, 6.24]) {
      const state = solo(narrow, 1515, offset, 0);
      const kart = state.karts[0]!;
      stepRace(state, [NEUTRAL_INPUT]);
      expect(Math.abs(kart.lateralOffset)).toBeLessThanOrEqual(7.2 - KART_RADIUS + 1e-9);
      expect(insideBarrier(narrow, narrow.def.barriers![0]!, kart.trackDistance, kart.lateralOffset, 0)).toBe(false);
      expect(kart.lateralOffset).toBeCloseTo(6 - 1 - KART_RADIUS, 4);
    }
  });

  it('bounds one-tick pushes at 70 m/s: lateral <= 0.59 m, longitudinal <= 1.17 m', () => {
    const cases: [number, number, number][] = [];
    // Head-on and off-centre nose contacts, parallel taper contact, and angled taper contact.
    for (let gap = 0.01; gap < 1.17; gap += 0.13) for (const offset of [0, 0.3, 0.6, 0.9]) {
      cases.push([barrier.from - KART_RADIUS - gap, offset, 0]);
    }
    for (const along of [0.5, 1.5, 2.5, 3.2]) {
      const edge = barrier.halfWidth * along / barrier.taper + KART_RADIUS;
      for (const angle of [0, -5, -10]) cases.push([barrier.from + along, edge + 1e-6, angle]);
    }
    let checked = 0;
    for (const [distance, offset, angle] of cases) {
      const state = solo(banded, distance, offset, 70, angle);
      const free = solo(track, distance, offset, 70, angle);
      stepRace(free, [NEUTRAL_INPUT]);
      vi.spyOn(tracks, 'getTrack').mockReturnValue(banded);
      stepRace(state, [NEUTRAL_INPUT]);
      const kart = state.karts[0]!;
      const sample = sampleTrack(banded, kart.trackDistance);
      const dx = kart.x - free.karts[0]!.x;
      const dz = kart.z - free.karts[0]!.z;
      expect(Math.abs(dx * sample.nx + dz * sample.nz)).toBeLessThanOrEqual(0.59);
      expect(Math.abs(dx * sample.tx + dz * sample.tz)).toBeLessThanOrEqual(1.17);
      expect(inside(state)).toBe(false);
      if (Math.hypot(dx, dz) > 1e-9) checked++;
    }
    expect(checked).toBeGreaterThan(cases.length / 2);
  });

  it('keeps the 70 m/s lateral push <= 0.59 m on a curve, including the swept nose residual (regression)', () => {
    // MEADOW bends here, so arc metres differ from world metres off the centre line. The swept
    // push must stay along its contact normal instead of leaving a residual for the sideways settle.
    const plain = tracks.TRACKS.meadow;
    // [from, centre, distance, offset, heading angle]; the first row is the reviewer's reproduction.
    const cases: [number, number, number, number, number][] = [[200, 6, 198.85, 6, 0]];
    for (const [from, center] of [[200, 6], [200, -6], [120, -6], [120, 6]] as const) {
      for (let d = from - 1.4; d < from + 0.2; d += 0.15) for (const k of [-1.5, -0.75, 0, 0.75, 1.5]) {
        for (const angle of [0, 10, -10]) cases.push([from, center, d, center + k, angle]);
      }
    }
    let hits = 0;
    for (const [from, center, distance, offset, angle] of cases) {
      const curved = buildTrack({ ...plain, barriers: [{ from, to: from + 30, center, halfWidth: 1, taper: 4 }] });
      if (insideBarrier(curved, curved.def.barriers![0]!, distance, offset, 0)) continue;
      const state = solo(curved, distance, offset, 70, angle);
      const free = solo(buildTrack(plain), distance, offset, 70, angle);
      stepRace(free, [NEUTRAL_INPUT]);
      vi.spyOn(tracks, 'getTrack').mockReturnValue(curved);
      stepRace(state, [NEUTRAL_INPUT]);
      const kart = state.karts[0]!;
      const sample = sampleTrack(curved, kart.trackDistance);
      const dx = kart.x - free.karts[0]!.x;
      const dz = kart.z - free.karts[0]!.z;
      expect(Math.abs(dx * sample.nx + dz * sample.nz)).toBeLessThanOrEqual(0.59);
      expect(Math.abs(dx * sample.tx + dz * sample.tz)).toBeLessThanOrEqual(1.17);
      expect(insideBarrier(curved, curved.def.barriers![0]!, kart.trackDistance, kart.lateralOffset, 0)).toBe(false);
      if (state.events.some(event => event.type === 'hit' && event.value === 1)) hits++;
    }
    expect(hits).toBeGreaterThan(40);
  });

  it('reports a rail-side nose hit inside the rail cooldown and keeps facing forward (ring regression)', () => {
    // M1-03 reproduction: riding the outer rail (whose hit starts the 0.7 s cooldown) into a nose at the
    // rail. The stop must still emit value 1, and the near-perpendicular residual must not turn the kart
    // sideways, where the next rail contact would flip it backwards.
    const ring = buildTrack({ ...track.def, scale: 1, checkpointCount: 1, roadHalfWidth: 5, wallHalfWidth: 6,
      boxRows: [0.3, 0.5, 0.7, 0.9], surfaces: [], racingLine: [],
      controlPoints: Array.from({ length: 16 }, (_, i) =>
        [100 * Math.cos(i * Math.PI / 8), 0, 100 * Math.sin(i * Math.PI / 8)] as const),
      barriers: [{ from: 160, to: 180, center: 5, halfWidth: 1.2, taper: 4 }] });
    // [start distance, offset]; the first row is the reported case (stop at tick 33).
    const cases = [[142, 4.2], [130, 4.2], [145, 5], [150, 4.6], [140, 3.8], [148, 4.9]] as const;
    for (const [distance, offset] of cases) {
      const state = solo(ring, distance, offset, 34);
      const kart = state.karts[0]!;
      const bandHits: unknown[] = [];
      let stopped = false;
      for (let tick = 0; tick < 120; tick++) {
        const speed = kart.speed;
        stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
        bandHits.push(...state.events.filter(event => event.type === 'hit' && event.value === 1));
        if (speed > 15 && kart.speed < speed * 0.2) {
          stopped = true;
          expect(state.events).toContainEqual({ type: 'hit', kartId: 0, value: 1 });
        }
        const sample = sampleTrack(ring, kart.trackDistance);
        expect(Math.sin(kart.heading) * sample.tx + Math.cos(kart.heading) * sample.tz).toBeGreaterThan(0.5);
        expect(insideBarrier(ring, ring.def.barriers![0]!, kart.trackDistance, kart.lateralOffset, 0)).toBe(false);
      }
      expect(stopped).toBe(true);
      expect(bandHits).toEqual([{ type: 'hit', kartId: 0, value: 1 }]);
    }
  });

  it('keeps the heading on a straight head-on nose stop instead of turning onto the edge', () => {
    for (const offset of [0, 0.05, -0.1]) {
      const state = solo(banded, 1498.8, offset, 30);
      const kart = state.karts[0]!;
      const heading = kart.heading;
      stepRace(state, [NEUTRAL_INPUT]);
      expect(state.events).toContainEqual({ type: 'hit', kartId: 0, value: 1 });
      expect(kart.speed).toBeLessThan(30 * 0.2);
      expect(kart.heading).toBe(heading);
    }
  });

  it('reports one band hit for repeated nose contacts at full throttle after a head-on stop', () => {
    for (const offset of [0.15, -0.15, 0, 0.3, -0.45, 0.6]) {
      const state = solo(banded, 1498.8, offset, 30);
      const hits: unknown[] = [];
      for (let tick = 0; tick < 120; tick++) {
        stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
        // Count band hits only: a kart turned onto the edge may later meet the outer rail (value-less hit).
        hits.push(...state.events.filter(event => event.type === 'hit' && event.value === 1));
        expect(inside(state)).toBe(false);
      }
      expect(hits, `offset ${offset}`).toEqual([{ type: 'hit', kartId: 0, value: 1 }]);
    }
  });

  it('keeps the lap valid through a 20 m wall ramp (13 -> 7) at 32 m/s', () => {
    const ramp = buildTrack({ ...track.def, widthKeys: [
      { distance: 0, roadHalfWidth: 10, wallHalfWidth: 13 },
      { distance: 1500, roadHalfWidth: 10, wallHalfWidth: 13 },
      { distance: 1520, roadHalfWidth: 4, wallHalfWidth: 7 },
      { distance: 2500, roadHalfWidth: 4, wallHalfWidth: 7 },
      { distance: 2520, roadHalfWidth: 10, wallHalfWidth: 13 },
    ] });
    for (const side of [-1, 1]) {
      const state = solo(ramp, 1480, side * 9.5, 32);
      const kart = state.karts[0]!;
      for (let tick = 0; tick < 150; tick++) {
        const x = kart.x;
        const z = kart.z;
        stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
        expect(Math.hypot(kart.x - x, kart.z - z)).toBeLessThan(3.5);
        expect(Math.abs(kart.lateralOffset)).toBeLessThanOrEqual(13 - KART_RADIUS + 1e-6);
        expect(kart.lapValid).toBe(true);
      }
      expect(kart.trackDistance).toBeGreaterThan(1530);
      expect(Math.abs(kart.lateralOffset)).toBeLessThanOrEqual(7 - KART_RADIUS + 1e-6);
    }
  });

  it('counts a checkpoint crossed at offset 13 on a course widened from 7.2 to 15', () => {
    // The 7.2 m default only applies without keys; the gate must use widthAt.
    const wide = buildTrack({ ...track.def, roadHalfWidth: 6, wallHalfWidth: 7.2,
      widthKeys: [{ distance: 0, roadHalfWidth: 14, wallHalfWidth: 15 }] });
    const gate = wide.checkpointDistances[1]!;
    const state = solo(wide, gate - 10, 13, 30);
    const kart = state.karts[0]!;
    Object.assign(kart, { startedLap: true, nextCheckpoint: 1, lapProgress: gate - 10 });
    for (let tick = 0; tick < 40; tick++) stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
    expect(kart.trackDistance).toBeGreaterThan(gate);
    expect(kart.lateralOffset).toBeCloseTo(13, 6);
    expect(kart.nextCheckpoint).toBe(2);
    expect(kart.lapValid).toBe(true);
  });
});

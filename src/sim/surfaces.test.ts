import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAIInput } from './ai';
import { getSteeringError } from './itemAi';
import { createRace, FIXED_DT, KART_RADIUS, NEUTRAL_INPUT, stepRace } from './race';
import { crossedZone, JUMP_DURATION, JUMP_HEIGHT, racingLineOffset, surfaceAt } from './surfaces';
import { buildTrack, projectToTrack, sampleTrack } from './track';
import * as tracks from './tracks';
import type { InputFrame, RaceState, Track, TrackDef } from './types';

// Protocol v8 final JSON after a full 8-CPU MEADOW race, pinned outside the test.
// Long races amplify floating-point differences between architectures, so each
// platform has its own column. darwin-arm64 was measured after H5; linux-x64
// stays 'pending-ci' until the coordinator records the first v8 CI run.
const MEADOW_FINAL_JSON = [
  [1, '4e0b96af5c90c7ccc2a99aced4f5e92f2755c04735ffcde8434c92725ae092a8', 'pending-ci'],
  [2, '56cd64b8cebb47826b3209c37b5e716c94716088bee71d89b88614215456c639', 'pending-ci'],
  [3, 'cc4128a4b835698a3cb894fa01c0fc3c4eadf26ba43bf03b1abe30b6bf4f337c', 'pending-ci'],
  [4, 'fcae47d127ea8995909a12351cc6b44e6a533586712b2e8cf1927565db7c39e8', 'pending-ci'],
  [5, '9acdc82a96cb83b9d949b629f78b9330ac3a693876c9f7932cf5c713c700847b', 'pending-ci'],
  [42, '80dadc978c30de16ae4ec1e9fb1f41a28c256bb7ade3e7892c58349f546ed655', 'pending-ci'],
  [123, '89c67f4179ec10afdf9909cd671be414220f79ae67c86b3bc062e1298296bf6b', 'pending-ci'],
  [999, '0464fa8755b2ef7030378d3df2c7150487d2e784245574d8684e3f00ec6cba4b', 'pending-ci'],
  [12345, 'b8569b60de380fa0403f29dc8de0be2a5bb2164e89cbc4850a2c389e6d5e323d', 'pending-ci'],
  [98765, '7d86c6acd3ea5f6597e51d29796c7cc08c6fded9cc53f4132048c9fc7c144f7e', 'pending-ci'],
] as const;
const PLATFORM_COLUMN: Record<string, 1 | 2> = { 'darwin-arm64': 1, 'linux-x64': 2 };
const column = PLATFORM_COLUMN[`${process.platform}-${process.arch}`];

afterEach(() => vi.restoreAllMocks());

it.each(MEADOW_FINAL_JSON)('pins v8 MEADOW final JSON (seed %i)', (seed, ...hashes) => {
  const state = createRace(seed, { racers: [] });
  for (let tick = 0; tick < 60 * 180 && state.phase !== 'finished'; tick++) {
    stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
  }
  expect(state.phase).toBe('finished');
  expect(state.karts.every(kart => kart.lap === 3 && kart.finishTime !== null)).toBe(true);
  const digest = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  // An unlisted platform still checks completion above; add its column from a trusted run.
  const pinned: string | undefined = column ? hashes[column - 1] : undefined;
  if (pinned && pinned !== 'pending-ci') expect(digest).toBe(pinned);
  else console.info(`MEADOW final hash (${process.platform}-${process.arch}) seed ${seed}: ${digest}`);
}, 30_000);

function syntheticTrack(overrides: Partial<TrackDef> = {}): Track {
  return buildTrack({
    ...tracks.TRACKS.meadow, scale: 1,
    controlPoints: [
      [-1500, 3, 0], [-1000, 3, 0], [-500, 3, 0], [0, 3, 0],
      [500, 3, 0], [1000, 3, 0], [1500, 3, 0], [1500, 3, 1000], [-1500, 3, 1000],
    ],
    surfaces: [], racingLine: [], ...overrides,
  });
}

function soloRace(track: Track, distance = 1500, speed = 0, offset = 0): RaceState {
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

describe('pure surface queries', () => {
  const base = syntheticTrack();
  const track = syntheticTrack({ surfaces: [
    { kind: 'ice', from: base.length - 10, to: base.length },
    { kind: 'ice', from: 0, to: 10 },
    { kind: 'ice', from: 100, to: 120, offsetMin: 2, offsetMax: 4 },
    { kind: 'boost', from: 0, to: 5, offsetMin: -3, offsetMax: -1 },
    { kind: 'jump', from: 110, to: 112 },
  ] });

  it('wraps ice intervals across the seam with half-open distance bounds', () => {
    for (const distance of [-1, 0, 1, track.length - 1, track.length, track.length + 1]) {
      expect(surfaceAt(track, distance, 0)).toBe('ice');
    }
    expect(surfaceAt(track, 10, 0)).toBe('road');
    expect(surfaceAt(track, track.length - 10, 0)).toBe('ice');
    expect(surfaceAt(track, -11, 0)).toBe('road');
  });

  it('respects lane bounds, default road width, and overlapping event zones', () => {
    expect(surfaceAt(track, 100, 3)).toBe('ice');
    expect(surfaceAt(track, 120, 3)).toBe('road');
    for (const offset of [2, 3, 4]) expect(surfaceAt(track, 110, offset)).toBe('ice');
    for (const offset of [1.99, 4.01]) expect(surfaceAt(track, 110, offset)).toBe('road');
    expect(surfaceAt(track, 0, track.def.roadHalfWidth)).toBe('ice');
    expect(surfaceAt(track, 0, track.def.roadHalfWidth + 0.01)).toBe('road');
    expect(surfaceAt(track, 110, 0)).toBe('road');
    expect(surfaceAt(syntheticTrack({ surfaces: [{ kind: 'boost', from: 0, to: 10 }] }), 1, 0)).toBe('road');
  });

  it('fires once on a forward entry, even when a short zone is traversed in one tick', () => {
    expect(crossedZone(track, 'jump', 109, 110, 0)).toBe(true);
    expect(crossedZone(track, 'jump', 109, 113, 0)).toBe(true);
    expect(crossedZone(track, 'jump', 110, 111, 0)).toBe(false);
    expect(crossedZone(track, 'jump', 110, 110, 0)).toBe(false);
    expect(crossedZone(track, 'jump', 111, 109, 0)).toBe(false);
    expect(crossedZone(track, 'boost', 109, 113, 0)).toBe(false);
  });

  it('detects forward start-line entries and rejects reverse and out-of-lane entries', () => {
    for (const offset of [-3, -2, -1]) {
      expect(crossedZone(track, 'boost', track.length - 1, 1, offset)).toBe(true);
      expect(crossedZone(track, 'boost', track.length - 1, 0, offset)).toBe(true);
      expect(crossedZone(track, 'boost', -1, 1, offset)).toBe(true);
      expect(crossedZone(track, 'boost', 1, track.length - 1, offset)).toBe(false);
      expect(crossedZone(track, 'boost', 0, 1, offset)).toBe(false);
    }
    for (const offset of [-3.01, -0.99, 0]) {
      expect(crossedZone(track, 'boost', track.length - 1, 1, offset)).toBe(false);
    }
  });

  it('does not mutate its frozen track or retain query history', () => {
    const json = JSON.stringify(track);
    const query = () => [surfaceAt(track, 110, 3), crossedZone(track, 'jump', 109, 111, 0)];
    expect(query()).toEqual(['ice', true]);
    surfaceAt(base, 110, 3);
    crossedZone(base, 'jump', 109, 111, 0);
    expect(query()).toEqual(['ice', true]);
    expect(JSON.stringify(track)).toBe(json);
  });

  it('also accepts a wrapped interval represented by a single zone', () => {
    const wrapped = syntheticTrack({ surfaces: [{ kind: 'ice', from: base.length - 10, to: 10 }] });
    expect(surfaceAt(wrapped, -1, 0)).toBe('ice');
    expect(surfaceAt(wrapped, 1, 0)).toBe('ice');
    expect(surfaceAt(wrapped, 10, 0)).toBe('road');
    expect(surfaceAt(wrapped, 100, 0)).toBe('road');
  });
});

describe('racing line', () => {
  const base = syntheticTrack();
  const track = syntheticTrack({ racingLine: [
    { distance: 10, offset: -4 }, { distance: 30, offset: 4 },
    { distance: base.length - 10, offset: 4 },
  ] });

  it('interpolates linearly between knots and across the start line', () => {
    expect(racingLineOffset(base, 123)).toBe(0);
    for (const [distance, offset] of [[10, -4], [15, -2], [20, 0], [25, 2], [30, 4], [0, 0], [-5, 2], [5, -2]]) {
      expect(racingLineOffset(track, distance!)).toBeCloseTo(offset!, 10);
    }
    expect(racingLineOffset(track, track.length)).toBe(0);
    expect(racingLineOffset(track, track.length + 20)).toBe(0);
  });

  it('clamps to the safe road width and supports a single knot without mutation', () => {
    for (const offset of [-100, 100]) {
      const single = syntheticTrack({ racingLine: [{ distance: 12, offset }] });
      for (const distance of [-100, 0, 12, 300, single.length]) {
        expect(racingLineOffset(single, distance)).toBe(Math.sign(offset) * (single.def.roadHalfWidth - 1));
      }
    }
    const json = JSON.stringify(track);
    const reversed = syntheticTrack({ racingLine: [...track.def.racingLine].reverse() });
    expect(racingLineOffset(reversed, 15)).toBe(racingLineOffset(track, 15));
    expect(JSON.stringify(track)).toBe(json);
  });
});

describe('surface physics', () => {
  const road = syntheticTrack({ roadHalfWidth: 300, wallHalfWidth: 400 });
  const ice = syntheticTrack({ roadHalfWidth: 300, wallHalfWidth: 400,
    surfaces: [{ kind: 'ice', from: 0, to: road.length }] });
  const jump = syntheticTrack({ surfaces: [{ kind: 'jump', from: 1500, to: 1510 }] });

  it('increases the mean turn radius by at least 1.3x under identical two-second inputs', () => {
    const radius = (track: Track) => {
      const state = soloRace(track);
      const kart = state.karts[0]!;
      let distance = 0;
      let angle = 0;
      for (let tick = 0; tick < 120; tick++) {
        const { x, z, heading } = kart;
        stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1, steer: 1 }]);
        distance += Math.hypot(kart.x - x, kart.z - z);
        angle += Math.abs(Math.atan2(Math.sin(kart.heading - heading), Math.cos(kart.heading - heading)));
      }
      expect(state.events.filter(event => event.type === 'hit')).toHaveLength(0);
      return distance / angle;
    };
    const roadRadius = radius(road);
    expect(radius(ice)).toBeGreaterThanOrEqual(roadRadius * 1.3);
  });

  it('coasts at least twice as far before stopping on ice', () => {
    const stoppingDistance = (track: Track) => {
      const state = soloRace(track, 1500, 20);
      const kart = state.karts[0]!;
      let distance = 0;
      for (let tick = 0; tick < 60 * 20 && kart.speed > 0; tick++) {
        const { x, z } = kart;
        stepRace(state, [NEUTRAL_INPUT]);
        distance += Math.hypot(kart.x - x, kart.z - z);
      }
      expect(kart.speed).toBe(0);
      return distance;
    };
    const roadDistance = stoppingDistance(road);
    expect(stoppingDistance(ice)).toBeGreaterThanOrEqual(roadDistance * 2);
  });

  it('launches on the entry tick, clears drifting, preserves flight motion, and lands on the projection', () => {
    const state = soloRace(jump, 1499.8, 20);
    const kart = state.karts[0]!;
    kart.driftDirection = 1;
    kart.driftTime = 1;
    kart.previousDrift = true;
    stepRace(state, [{ ...NEUTRAL_INPUT, drift: true }]);
    expect(kart.airTime).toBe(JUMP_DURATION);
    expect(kart.driftDirection).toBe(0);
    expect(kart.driftTime).toBe(0);
    expect(kart.hopTime).toBe(0);
    const { speed, heading } = kart;
    let peak = 0;
    for (let tick = 1; tick <= 48; tick++) {
      stepRace(state, [{ steer: tick % 2 ? 1 : -1, throttle: 1, brake: true, drift: true, useItem: false }]);
      const height = projectToTrack(jump, kart.x, kart.z, kart.trackDistance).height;
      expect(kart.speed).toBe(speed);
      expect(kart.heading).toBe(heading);
      expect(kart.driftTime).toBe(0);
      expect(kart.driftDirection).toBe(0);
      if (tick < 48) expect(kart.y).toBeGreaterThan(height);
      peak = Math.max(peak, kart.y - height);
    }
    expect(peak).toBeCloseTo(JUMP_HEIGHT, 12);
    expect(kart.airTime).toBe(0);
    expect(kart.y).toBe(projectToTrack(jump, kart.x, kart.z, kart.trackDistance).height);
    expect(state.events.some(event => event.type === 'boost')).toBe(false);
  });

  it.each([9, 9.99])('does not launch below speed 10 (%s)', speed => {
    const state = soloRace(jump, 1499.9, speed);
    stepRace(state, [NEUTRAL_INPUT]);
    expect(state.karts[0]!.trackDistance).toBeGreaterThan(1500);
    expect(state.karts[0]!.airTime).toBe(0);
  });

  it('launches at exactly speed 10 at the crossing', () => {
    const state = soloRace(jump, 1499.9, 10 + 5.5 * FIXED_DT);
    stepRace(state, [NEUTRAL_INPUT]);
    expect(state.karts[0]!.speed).toBe(10);
    expect(state.karts[0]!.airTime).toBe(JUMP_DURATION);
  });

  it('rejects reverse, lateral-only and out-of-lane jump entries', () => {
    const reverse = soloRace(jump, 1500.1, 20);
    reverse.karts[0]!.heading += Math.PI;
    stepRace(reverse, [NEUTRAL_INPUT]);
    expect(reverse.karts[0]!.trackDistance).toBeLessThan(1500);
    expect(reverse.karts[0]!.airTime).toBe(0);
    const narrow = syntheticTrack({ surfaces: [{ kind: 'jump', from: 1500, to: 1510, offsetMin: 2, offsetMax: 4 }] });
    const outside = soloRace(narrow, 1499.8, 20);
    stepRace(outside, [NEUTRAL_INPUT]);
    expect(outside.karts[0]!.airTime).toBe(0);
    const inside = soloRace(narrow, 1505, 20, 3);
    stepRace(inside, [NEUTRAL_INPUT]);
    expect(inside.karts[0]!.airTime).toBe(0);
  });

  it('boosts once on entry without refreshing while staying in the zone', () => {
    const track = syntheticTrack({ surfaces: [{ kind: 'boost', from: 1500, to: 1600 }] });
    const state = soloRace(track, 1499.8, 20);
    const kart = state.karts[0]!;
    stepRace(state, [NEUTRAL_INPUT]);
    expect(kart.boostTime).toBe(0.5);
    expect(state.events.filter(event => event.type === 'boost')).toHaveLength(1);
    for (let tick = 0; tick < 35; tick++) {
      const previous = kart.boostTime;
      stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
      expect(kart.boostTime).toBeLessThanOrEqual(previous);
      expect(state.events.filter(event => event.type === 'boost')).toHaveLength(0);
    }
    expect(kart.trackDistance).toBeLessThan(1600);
    expect(kart.boostTime).toBe(0);
  });

  it('uses items in flight and matches a JSON-restored replay every tick', () => {
    const state = soloRace(jump, 1499.8, 20);
    stepRace(state, [NEUTRAL_INPUT]);
    const kart = state.karts[0]!;
    const speed = kart.speed;
    kart.item = 'dash';
    let replay: RaceState = JSON.parse(JSON.stringify(state));
    for (let tick = 0; tick < 60; tick++) {
      const input: InputFrame = { ...NEUTRAL_INPUT, steer: 1, throttle: 1, drift: true, useItem: tick === 0 };
      stepRace(state, [input]);
      stepRace(replay, [input]);
      expect(JSON.stringify(replay)).toBe(JSON.stringify(state));
      if (tick === 0) {
        expect(kart.item).toBeNull();
        expect(kart.boostTime).toBeGreaterThan(0);
        expect(kart.speed).toBe(speed);
      }
      if (tick === 20) replay = JSON.parse(JSON.stringify(replay));
    }
  });

  it('retains airborne wall collisions and updates the jump height after kart contacts', () => {
    for (const [angle, speed] of [[20, 20], [60, 10], [90, 0]] as const) {
      const state = soloRace(jump, 1500, 20, jump.def.wallHalfWidth - KART_RADIUS - 1e-6);
      const kart = state.karts[0]!;
      kart.airTime = 0.4;
      kart.heading += angle * Math.PI / 180;
      stepRace(state, [NEUTRAL_INPUT]);
      expect(Math.abs(projectToTrack(jump, kart.x, kart.z).offset) + KART_RADIUS)
        .toBeLessThanOrEqual(jump.def.wallHalfWidth + 1e-8);
      expect(kart.speed).toBeCloseTo(speed, 10);
      expect(kart.airTime).toBeGreaterThan(0);
    }

    const contact = soloRace(jump, 1500, 20);
    const first = contact.karts[0]!;
    first.airTime = 0.4;
    const second = { ...first, id: 1, effects: { ...first.effects }, lapTimes: [] };
    second.z += 0.5;
    contact.karts.push(second);
    stepRace(contact, [NEUTRAL_INPUT, NEUTRAL_INPUT]);
    expect(Math.hypot(first.x - second.x, first.z - second.z)).toBeGreaterThanOrEqual(1.9);
    for (const racer of contact.karts) {
      const height = projectToTrack(jump, racer.x, racer.z, racer.trackDistance).height;
      const t = 1 - racer.airTime / JUMP_DURATION;
      expect(racer.y).toBeCloseTo(height + JUMP_HEIGHT * 4 * t * (1 - t), 12);
    }
  });
});

describe('CPU surface awareness', () => {
  it('uses the same racing line for steering and item decisions', () => {
    const road = syntheticTrack();
    const state = soloRace(road, 1500, 20);
    const kart = state.karts[0]!;
    kart.aiPhase = 0;
    const baseline = getSteeringError(state, kart);
    vi.mocked(tracks.getTrack).mockReturnValue(syntheticTrack({ racingLine: [{ distance: 0, offset: 4 }] }));
    const error = getSteeringError(state, kart);
    expect(Math.abs(error)).toBeGreaterThan(Math.abs(baseline) + 0.2);
    expect(getAIInput(state, kart.id).steer).toBeCloseTo(error * 2.3, 12);
  });

  it('reduces throttle when its look-ahead target is icy', () => {
    const track = syntheticTrack({ surfaces: [{ kind: 'ice', from: 1510, to: 1530 }] });
    const state = soloRace(track, 1500, 20);
    expect(getAIInput(state, 0).throttle).toBe(0.7);
  });

  it.each([12, 20])('suppresses drift %im before a jump and in flight', distance => {
    const state = soloRace(syntheticTrack(), 1500, 20);
    state.karts[0]!.heading += 0.25;
    expect(getAIInput(state, 0).drift).toBe(true);
    vi.mocked(tracks.getTrack).mockReturnValue(syntheticTrack({ surfaces: [{ kind: 'jump', from: 1500 + distance, to: 1502 + distance }] }));
    expect(getAIInput(state, 0).drift).toBe(false);
    vi.mocked(tracks.getTrack).mockReturnValue(syntheticTrack());
    state.karts[0]!.airTime = 0.4;
    expect(getAIInput(state, 0).drift).toBe(false);
  });
});

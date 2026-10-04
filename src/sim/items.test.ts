import { describe, expect, it } from 'vitest';
import { getAIInput } from './ai';
import { decideItemUse, getSteeringError } from './itemAi';
import { LAYOUT_FINGERPRINT, PROTOCOL_VERSION, isRaceState } from '../net/protocol';
import { decodeSnapshot, encodeSnapshot, SNAPSHOT_LAYOUT } from '../net/snapshotCodec';
import { chooseItem } from './itemTable';
import { createKartEffects, ENTITY_KINDS, KART_EFFECT_LAYOUT } from './itemTypes';
import type { ProjectileState } from './itemTypes';
import { advanceItems, getKartModifiers, hitKart, onKartContact, useItem } from './items';
import { chooseItem as publicChooseItem } from './index';
import { getRank } from './laps';
import { random } from './random';
import { createRace, FIXED_DT, NEUTRAL_INPUT, stepRace } from './race';
import { projectToTrack, sampleTrack, TRACK_LENGTH, WALL_HALF_WIDTH, wrapDistance } from './track';
import type { InputFrame, ItemType, KartState, Projectile, RaceState } from './types';

const PRESS: InputFrame = { ...NEUTRAL_INPUT, useItem: true };
const ITEMS: readonly ItemType[] = ['dash', 'trap', 'bolt', 'seeker', 'skycomet',
  'tripleDash', 'rapidDash', 'aura', 'storm', 'ink', 'decoy', 'bomb', 'autopilot', 'barrier'];
// Independent copy of the design's rows, so editing production weights changes the result.
const EXPECTED_WEIGHTS = [
  [8, 30, 12, 4, 0, 0, 0, 0, 0, 6, 20, 10, 0, 10],
  [12, 20, 16, 12, 0, 0, 0, 0, 0, 8, 12, 12, 0, 8],
  [14, 10, 16, 16, 0, 8, 0, 0, 0, 10, 6, 12, 0, 8],
  [12, 0, 12, 16, 8, 14, 0, 4, 2, 10, 2, 10, 0, 10],
  [8, 0, 8, 14, 12, 18, 2, 8, 6, 8, 0, 6, 0, 10],
  [4, 0, 4, 10, 14, 18, 8, 12, 12, 4, 0, 4, 4, 6],
  [2, 0, 2, 6, 12, 16, 14, 16, 16, 2, 0, 2, 12, 0],
  [2, 0, 0, 4, 10, 12, 18, 18, 16, 0, 0, 0, 20, 0],
];

function place(kart: KartState, distance: number): void {
  const sample = sampleTrack(distance);
  Object.assign(kart, { x: sample.x, y: sample.y, z: sample.z,
    heading: Math.atan2(sample.tx, sample.tz), trackDistance: sample.distance, lateralOffset: 0 });
}

function race(seed = 42): RaceState {
  const state = createRace(seed);
  state.phase = 'racing';
  state.countdown = 0;
  state.boxes = [];
  state.karts.forEach((kart, index) => place(kart, 30 + index * 30));
  return state;
}

function press(state: RaceState, kart: KartState): void {
  useItem(state, kart, NEUTRAL_INPUT);
  useItem(state, kart, PRESS);
}

function boxAt(state: RaceState, kart: KartState): void {
  state.boxes = [{ id: state.nextEntityId++, x: kart.x, y: kart.y, z: kart.z,
    heading: kart.heading, respawnTime: 0 }];
}

describe('ranked item table (§7.3)', () => {
  it.each(EXPECTED_WEIGHTS.map((weights, index) => ({ rank: index + 1, weights })))
  ('matches every weight within two percentage points across 20,000 draws at rank $rank', ({ rank, weights }) => {
    const state = { seed: 0x12345678 };
    const counts = new Map<ItemType, number>();
    for (let draw = 0; draw < 20_000; draw++) {
      const item = chooseItem(state, rank);
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    ITEMS.forEach((item, index) => {
      const count = counts.get(item) ?? 0;
      expect(Math.abs(count / 20_000 - weights[index]! / total), item).toBeLessThanOrEqual(0.02);
      if (weights[index] === 0) expect(count, item).toBe(0);
    });
  });

  it('uses one PRNG draw and exposes the same deterministic chooser through the sim API', () => {
    expect(publicChooseItem).toBe(chooseItem);
    const first = { seed: 991 };
    const second = { seed: 991 };
    const expectedSeed = { seed: 991 };
    for (let draw = 0; draw < 1000; draw++) {
      const rank = draw % 8 + 1;
      expect(chooseItem(first, rank)).toBe(chooseItem(second, rank));
      random(expectedSeed);
      expect(first.seed).toBe(expectedSeed.seed);
    }
  });

  it.each([-Infinity, -10, 0, 1, NaN])('clamps rank %s to first place', (rank) => {
    const first = { seed: 871 };
    const clamped = { seed: 871 };
    for (let draw = 0; draw < 100; draw++) expect(chooseItem(clamped, rank)).toBe(chooseItem(first, 1));
  });

  it('clamps the upper rank to the roster size, or eight for seed-only calls', () => {
    for (const rank of [8, 9, 100, Infinity]) {
      const short = { seed: 12, karts: [{}, {}, {}] };
      const third = { seed: 12 };
      const full = { seed: 12 };
      const eighth = { seed: 12 };
      for (let draw = 0; draw < 100; draw++) {
        expect(chooseItem(short, rank)).toBe(chooseItem(third, 3));
        expect(chooseItem(full, rank)).toBe(chooseItem(eighth, 8));
      }
    }
  });

  it('gives trailing racers more dash-family items', () => {
    const leading = { seed: 817 };
    const trailing = { seed: 817 };
    const dashes = new Set<ItemType>(['dash', 'tripleDash', 'rapidDash']);
    let first = 0;
    let last = 0;
    for (let draw = 0; draw < 20_000; draw++) {
      if (dashes.has(chooseItem(leading, 1))) first++;
      if (dashes.has(chooseItem(trailing, 8))) last++;
    }
    expect(last).toBeGreaterThan(first);
  });
});

describe('dash charges and timed presses', () => {
  it('keeps tripleDash until the third press and blocks boxes between charges', () => {
    const state = race();
    const kart = state.karts[0]!;
    kart.item = 'tripleDash';
    boxAt(state, kart);
    for (let remaining = 2; remaining >= 0; remaining--) {
      press(state, kart);
      expect(kart.effects.charges).toBe(remaining);
      expect(kart.boostTime).toBe(1.4);
      expect(kart.item).toBe(remaining > 0 ? 'tripleDash' : null);
      useItem(state, kart, PRESS);
      expect(kart.effects.charges).toBe(remaining);
      if (remaining > 0) {
        advanceItems(state, FIXED_DT);
        expect(state.boxes[0]!.respawnTime).toBe(0);
        expect(kart.item).toBe('tripleDash');
      }
    }
    expect(state.events.filter((event) => event.type === 'boost')).toHaveLength(3);
    advanceItems(state, FIXED_DT);
    expect(kart.item).not.toBeNull();
    expect(state.boxes[0]!.respawnTime).toBe(5);
  });

  it('initializes all three charges on an actual tripleDash pickup', () => {
    const state = race();
    const kart = state.karts[0]!;
    // Put the recipient last without moving it away from its box.
    state.karts.slice(1).forEach((racer) => { racer.lap = 1; });
    const rank = getRank(state, kart.id);
    let seed = 1;
    while (chooseItem({ seed }, rank) !== 'tripleDash') seed++;
    state.seed = seed;
    boxAt(state, kart);
    advanceItems(state, FIXED_DT);
    expect(kart.item).toBe('tripleDash');
    expect(kart.effects.charges).toBe(3);
    press(state, kart);
    expect(kart.effects.charges).toBe(2);
  });

  it.each([false, true])('expires rapidDash after 480 ticks even when held=%s', (held) => {
    const state = race();
    const kart = state.karts[0]!;
    kart.item = 'rapidDash';
    // Carrying it before activation does not start the window.
    advanceItems(state, 10);
    expect(kart.item).toBe('rapidDash');
    press(state, kart);
    expect(kart.effects.rapidTime).toBe(8);
    expect(kart.boostTime).toBe(0.45);
    boxAt(state, kart);
    for (let tick = 0; tick < 479; tick++) advanceItems(state, FIXED_DT);
    expect(kart.effects.rapidTime).toBeCloseTo(FIXED_DT, 8);
    expect(state.boxes[0]!.respawnTime).toBe(0);
    state.boxes = [];
    press(state, kart);
    expect(kart.effects.rapidTime).toBeCloseTo(FIXED_DT, 8);
    useItem(state, kart, held ? PRESS : NEUTRAL_INPUT);
    advanceItems(state, FIXED_DT);
    expect(kart.effects.rapidTime).toBe(0);
    expect(kart.item).toBeNull();
    press(state, kart);
    expect(kart.effects.rapidTime).toBe(0);
  });

  it('refreshes rapid boost on each press but neither on holding nor on release', () => {
    const state = race();
    const kart = state.karts[0]!;
    kart.item = 'rapidDash';
    press(state, kart);
    advanceItems(state, 1);
    kart.boostTime = 0.1;
    useItem(state, kart, PRESS);
    expect(kart.boostTime).toBe(0.1);
    useItem(state, kart, NEUTRAL_INPUT);
    expect(kart.boostTime).toBe(0.1);
    useItem(state, kart, PRESS);
    expect(kart.boostTime).toBe(0.45);
    expect(kart.effects.rapidTime).toBe(7);
    expect(state.events.filter((event) => event.type === 'boost')).toHaveLength(2);
  });

  it.each(['tripleDash', 'rapidDash', 'aura', 'storm'] as const)
  ('does not activate %s while spinning or finished', (item) => {
    const state = race();
    const kart = state.karts[0]!;
    kart.item = item;
    kart.spinTime = 0.5;
    press(state, kart);
    expect(kart.effects).toEqual(createKartEffects());
    expect(kart.item).toBe(item);
    kart.spinTime = 0;
    kart.finishTime = 1;
    press(state, kart);
    expect(kart.effects).toEqual(createKartEffects());
    expect(kart.item).toBe(item);
    expect(state.events).toEqual([]);
  });
});

describe('aura and storm', () => {
  it('grants seven seconds of speed, immunity and contact damage then expires', () => {
    const state = race();
    const kart = state.karts[0]!;
    kart.item = 'aura';
    press(state, kart);
    expect(kart.item).toBeNull();
    expect(kart.effects.auraTime).toBe(7);
    expect(getKartModifiers(state, kart, PRESS)).toEqual({
      input: PRESS, maxSpeedMultiplier: 1.3, invulnerable: true, contactHit: true,
    });
    expect(state.events).toContainEqual({ type: 'aura_start', kartId: kart.id });
    for (let tick = 0; tick < 419; tick++) advanceItems(state, FIXED_DT);
    expect(getKartModifiers(state, kart, PRESS).invulnerable).toBe(true);
    advanceItems(state, FIXED_DT);
    expect(kart.effects.auraTime).toBe(0);
    expect(getKartModifiers(state, kart, PRESS)).toEqual({
      input: PRESS, maxSpeedMultiplier: 1, invulnerable: false, contactHit: false,
    });
    hitKart(state, kart);
    expect(kart.spinTime).toBe(1.05);
  });

  it.each(['trap', 'bolt'] as const)('blocks an actual %s collision while preserving drift and boost', (kind) => {
    const state = race();
    const kart = state.karts[0]!;
    kart.effects.auraTime = 7;
    kart.speed = 20;
    kart.boostTime = 1;
    kart.driftTime = 1;
    kart.driftDirection = 1;
    const entity = { id: state.nextEntityId++, ownerId: 1, x: kart.x, y: kart.y,
      z: kart.z, heading: kart.heading, life: 5 };
    if (kind === 'trap') state.traps.push({ ...entity, kind, age: 2 });
    else state.projectiles.push({ ...entity, kind, bounces: 0 });
    advanceItems(state, FIXED_DT);
    expect(kart).toMatchObject({ spinTime: 0, speed: 20, boostTime: 1, driftTime: 1, driftDirection: 1 });
    expect(state.events.filter((event) => event.type === 'hit')).toEqual([]);
    expect(state.traps.length + state.projectiles.length).toBe(0);
  });

  it.each([false, true])('spins the contact opponent in either argument order (reverse=%s)', (reverse) => {
    const state = race();
    const first = state.karts[0]!;
    const second = state.karts[1]!;
    first.effects.auraTime = 7;
    second.speed = 20;
    if (reverse) onKartContact(state, second, first);
    else onKartContact(state, first, second);
    expect(first.spinTime).toBe(0);
    expect(second.spinTime).toBe(1.05);
    expect(second.speed).toBe(6);
    onKartContact(state, first, second);
    expect(state.events.filter((event) => event.type === 'hit')).toHaveLength(1);
  });

  it('keeps two aura karts immune to one another and applies contact through stepRace', () => {
    const state = race();
    const first = state.karts[0]!;
    const second = state.karts[1]!;
    first.effects.auraTime = 7;
    second.effects.auraTime = 7;
    onKartContact(state, first, second);
    expect(first.spinTime + second.spinTime).toBe(0);
    second.effects.auraTime = 0;
    place(second, first.trackDistance + 0.5);
    stepRace(state, []);
    expect(first.spinTime).toBe(0);
    expect(second.spinTime).toBe(1.05);
  });

  it('shrinks every unprotected opponent for five seconds and clears all held inventory', () => {
    const state = race();
    const user = state.karts[0]!;
    const protectedKart = state.karts[1]!;
    state.karts.forEach((kart, index) => {
      kart.item = index % 2 ? 'tripleDash' : 'rapidDash';
      Object.assign(kart.effects, { charges: 2, rapidTime: 3, holding: 1, orbitKind: 2, orbitCount: 3 });
    });
    user.item = 'storm';
    protectedKart.effects.auraTime = 7;
    const protectedBefore = JSON.stringify(protectedKart);
    press(state, user);
    expect(user.item).toBeNull();
    expect(user.effects.shrinkTime).toBe(0);
    expect(JSON.stringify(protectedKart)).toBe(protectedBefore);
    for (const target of state.karts.slice(2)) {
      expect(target.item).toBeNull();
      expect(target.effects).toMatchObject({ shrinkTime: 5, charges: 0, rapidTime: 0,
        holding: 0, orbitKind: 0, orbitCount: 0 });
      expect(getKartModifiers(state, target, PRESS).maxSpeedMultiplier).toBe(0.65);
      press(state, target);
      expect(target.boostTime).toBe(0);
    }
    expect(state.events.filter((event) => event.type === 'storm')).toEqual([{ type: 'storm', kartId: user.id }]);
    for (let tick = 0; tick < 299; tick++) advanceItems(state, FIXED_DT);
    expect(state.karts[2]!.effects.shrinkTime).toBeGreaterThan(0);
    advanceItems(state, FIXED_DT);
    expect(state.karts[2]!.effects.shrinkTime).toBe(0);
    expect(getKartModifiers(state, state.karts[2]!, PRESS).maxSpeedMultiplier).toBe(1);
  });

  it('refreshes shrink instead of stacking it and combines independent speed effects', () => {
    const state = race();
    const user = state.karts[0]!;
    const target = state.karts[2]!;
    user.item = 'storm';
    press(state, user);
    advanceItems(state, 2);
    expect(target.effects.shrinkTime).toBe(3);
    user.item = 'storm';
    press(state, user);
    expect(target.effects.shrinkTime).toBe(5);
    target.item = 'aura';
    press(state, target);
    expect(getKartModifiers(state, target, PRESS).maxSpeedMultiplier).toBeCloseTo(1.3 * 0.65);
  });

  it('applies aura and shrink speed modifiers to race physics', () => {
    const ordinary = race();
    const aura = race();
    const shrunk = race();
    for (const state of [ordinary, aura, shrunk]) state.karts[0]!.speed = 32;
    aura.karts[0]!.effects.auraTime = 7;
    shrunk.karts[0]!.effects.shrinkTime = 5;
    for (const state of [ordinary, aura, shrunk]) stepRace(state, [{ ...NEUTRAL_INPUT, throttle: 1 }]);
    expect(aura.karts[0]!.speed).toBeGreaterThan(ordinary.karts[0]!.speed);
    expect(shrunk.karts[0]!.speed).toBeLessThan(ordinary.karts[0]!.speed);
  });
});

describe('effect snapshot compatibility and deterministic replay', () => {
  it('registers every effect field and matches the protocol v4 fingerprint', () => {
    expect(KART_EFFECT_LAYOUT.map(({ field }) => field).sort()).toEqual(Object.keys(createKartEffects()).sort());
    for (const field of ['charges', 'rapidTime', 'auraTime', 'shrinkTime']) {
      expect(KART_EFFECT_LAYOUT.some((entry) => entry.field === field)).toBe(true);
    }
    let hash = 0x811c9dc5;
    for (const character of JSON.stringify(SNAPSHOT_LAYOUT)) {
      hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
    }
    expect(hash.toString(16).padStart(8, '0')).toBe(LAYOUT_FINGERPRINT);
    expect(PROTOCOL_VERSION).toBe(4);
    const state = race();
    state.karts[0]!.item = 'rapidDash';
    press(state, state.karts[0]!);
    state.karts[1]!.item = 'tripleDash';
    press(state, state.karts[1]!);
    state.karts[2]!.item = 'aura';
    press(state, state.karts[2]!);
    state.karts[3]!.effects.shrinkTime = 5;
    expect(isRaceState(JSON.parse(JSON.stringify(state)))).toBe(true);
  });

  it('replays 3,000 randomized ticks exactly across repeated JSON resumes', () => {
    const first = race(981);
    const replay = race(981);
    first.boxes = createRace(981).boxes;
    replay.boxes = createRace(981).boxes;
    let restored: RaceState = JSON.parse(JSON.stringify(first));
    const inputsSeed = { seed: 78123 };
    const used = new Set<ItemType>();
    const eventTypes = new Set<string>();
    for (let tick = 0; tick < 3000; tick++) {
      // Grants cover every implemented handler; boxes also exercise pickup and charge initialization.
      if (tick % 120 === 0) {
        for (let id = 0; id < first.karts.length; id++) {
          const item = ITEMS[(tick / 120 + id) % ITEMS.length]!;
          for (const state of [first, replay, restored]) {
            const kart = state.karts[id]!;
            kart.item = item;
            kart.effects.charges = item === 'tripleDash' ? 3 : 0;
            kart.effects.rapidTime = 0;
            kart.effects.rapidUnused = item === 'rapidDash' ? 1 : 0;
            kart.effects.holding = 0;
            kart.effects.aiHoldTicks = 0;
            kart.previousItem = false;
          }
        }
      }
      if (tick % 120 === 60) {
        for (const state of [first, replay, restored]) {
          const kart = state.karts[0]!;
          kart.item = null;
          kart.spinTime = 0;
          kart.effects.holding = 0;
          Object.assign(state.boxes[0]!, { x: kart.x, z: kart.z, respawnTime: 0 });
        }
      }
      const inputs = first.karts.map((): InputFrame => ({
        steer: random(inputsSeed) * 2 - 1, throttle: random(inputsSeed),
        brake: random(inputsSeed) < 0.05, drift: random(inputsSeed) < 0.4,
        useItem: random(inputsSeed) < 0.3,
      }));
      const inventory = first.karts.map((kart) => kart.item);
      for (const state of [first, replay, restored]) stepRace(state, inputs);
      for (const event of first.events) {
        eventTypes.add(event.type);
        if (event.type === 'use' && inventory[event.kartId]) used.add(inventory[event.kartId]!);
      }
      expect(JSON.stringify(restored), `restored at tick ${tick}`).toBe(JSON.stringify(first));
      expect(JSON.stringify(replay), `replayed at tick ${tick}`).toBe(JSON.stringify(first));
      if (tick % 137 === 0) restored = JSON.parse(JSON.stringify(restored));
    }
    expect(first.racingTicks).toBe(3000);
    for (const item of ITEMS) expect(used.has(item), item).toBe(true);
    for (const type of ['pickup', 'boost', 'hit', 'aura_start', 'storm', 'explode', 'ink', 'auto_start']) expect(eventTypes.has(type), type).toBe(true);
  });
});

describe('I2 projectiles and decoys', () => {
  it('locks a seeker onto the nearest higher-progress opponent within 45 m ahead', () => {
    const state = race();
    const owner = state.karts[0]!;
    owner.lap = 1;
    state.karts[1]!.lap = 1;
    state.karts[2]!.lap = 1;
    place(state.karts[1]!, 50);
    place(state.karts[2]!, 40);
    place(state.karts[3]!, 35);
    state.karts[3]!.lap = 0; // Closer, but behind in race progress.
    place(state.karts[4]!, 25);
    state.karts[4]!.lap = 2; // Higher progress, but physically behind.
    owner.item = 'seeker';
    press(state, owner);
    const seeker = state.projectiles[0] as Projectile & ProjectileState;
    expect(seeker).toMatchObject({ kind: 'seeker', target: 2, life: 6, bounces: 0 });
    expect(ENTITY_KINDS[seeker.kind]).toBeGreaterThan(0);
    const heading = seeker.heading;
    const x = seeker.x;
    const z = seeker.z;
    place(state.karts[3]!, 180); // Move the non-target out of the projectile's collision path.
    state.karts[2]!.x += 3;
    advanceItems(state, FIXED_DT);
    const turn = Math.atan2(Math.sin(seeker.heading - heading), Math.cos(seeker.heading - heading));
    expect(Math.abs(turn)).toBeGreaterThan(0);
    expect(Math.abs(turn)).toBeLessThanOrEqual(2.4 * FIXED_DT + 1e-10);
    expect(Math.hypot(seeker.x - x, seeker.z - z)).toBeCloseTo(48 * FIXED_DT, 8);
    for (let tick = 0; tick < 60 && state.projectiles.length; tick++) advanceItems(state, FIXED_DT);
    expect(state.karts[2]!.spinTime).toBeGreaterThan(0);
    expect(state.projectiles).toHaveLength(0);
  });

  it('flies straight without a target, excludes finished opponents and enforces the 45 m limit', () => {
    const state = race();
    const owner = state.karts[0]!;
    place(state.karts[1]!, 40);
    state.karts[1]!.finishTime = 1;
    for (const kart of state.karts.slice(2)) place(kart, 120 + kart.id * 10);
    owner.item = 'seeker';
    press(state, owner);
    const seeker = state.projectiles[0] as Projectile & ProjectileState;
    expect(seeker.target).toBeNull();
    const heading = seeker.heading;
    // A later arrival does not change a launch with no target into a homing shot.
    place(state.karts[2]!, 45);
    advanceItems(state, FIXED_DT);
    expect(seeker.heading).toBe(heading);
    expect(seeker.target).toBeNull();
  });

  it.each([44.99, 45.01])('limits seeker acquisition at %s m and resolves equal-distance targets by ID', distance => {
    const state = race();
    const owner = state.karts[0]!;
    for (const target of state.karts.slice(1)) {
      target.lap = 1;
      target.x = owner.x + Math.sin(owner.heading) * distance;
      target.z = owner.z + Math.cos(owner.heading) * distance;
    }
    state.karts.reverse();
    owner.item = 'seeker';
    press(state, owner);
    expect((state.projectiles[0] as Projectile & ProjectileState).target).toBe(distance < 45 ? 1 : null);
  });

  it('expires at six seconds and resolves a seeker hit before wall expiry without bouncing', () => {
    const state = race();
    const owner = state.karts[0]!;
    owner.lap = 10;
    owner.item = 'seeker';
    press(state, owner);
    const seeker = state.projectiles[0]!;
    const start = { x: seeker.x, z: seeker.z };
    for (let tick = 0; tick < 359; tick++) {
      // Isolate the timer from wall/collision expiry on a closed course.
      Object.assign(seeker, start);
      advanceItems(state, FIXED_DT);
    }
    expect(state.projectiles).toHaveLength(1);
    advanceItems(state, FIXED_DT);
    expect(state.projectiles).toHaveLength(0);
    owner.item = 'seeker';
    press(state, owner);
    const wallShot = state.projectiles[0]!;
    const sample = sampleTrack(35);
    Object.assign(wallShot, { x: sample.x + sample.nx * (WALL_HALF_WIDTH - 0.5),
      z: sample.z + sample.nz * (WALL_HALF_WIDTH - 0.5), heading: Math.atan2(sample.nx, sample.nz) });
    const victim = state.karts[1]!;
    victim.x = sample.x + sample.nx * (WALL_HALF_WIDTH - 1);
    victim.z = sample.z + sample.nz * (WALL_HALF_WIDTH - 1);
    advanceItems(state, FIXED_DT);
    expect(state.projectiles).toHaveLength(0);
    expect(wallShot.bounces).toBe(0);
    expect(victim.spinTime).toBeGreaterThan(0);
    owner.item = 'seeker';
    press(state, owner);
    const missedShot = state.projectiles[0]!;
    Object.assign(missedShot, { x: wallShot.x, z: wallShot.z, heading: wallShot.heading });
    place(victim, 180);
    advanceItems(state, FIXED_DT);
    expect(state.projectiles).toHaveLength(0);
    expect(missedShot.bounces).toBe(0);
  });

  it.each([false, true])('follows the centerline to the best opponent (launcher first=%s), then blasts 4.5 m', first => {
    const state = race();
    const owner = state.karts[0]!;
    const target = state.karts[1]!;
    owner.lap = first ? 3 : 1;
    target.lap = 2;
    place(owner, TRACK_LENGTH - 20);
    place(target, 20);
    const sample = sampleTrack(target.trackDistance);
    target.lateralOffset = 3;
    target.x += sample.nx * 3;
    target.z += sample.nz * 3;
    owner.item = 'skycomet';
    press(state, owner);
    const comet = state.projectiles[0] as Projectile & ProjectileState;
    expect(comet.target).toBe(target.id);
    advanceItems(state, FIXED_DT);
    expect(comet.aux).toBeCloseTo(wrapDistance(TRACK_LENGTH - 20 + 70 * FIXED_DT), 8);
    expect(Math.abs(projectToTrack(comet.x, comet.z).offset)).toBeLessThan(0.01);
    const near = state.karts[2]!;
    const far = state.karts[3]!;
    near.x = target.x + 4.49;
    near.z = target.z;
    far.x = target.x + 4.51;
    far.z = target.z;
    for (let tick = 0; tick < 60 && state.projectiles.length; tick++) advanceItems(state, FIXED_DT);
    expect(state.projectiles).toHaveLength(0);
    expect(target.spinTime).toBeGreaterThan(0);
    expect(near.spinTime).toBeGreaterThan(0);
    expect(far.spinTime).toBe(0);
    expect(state.events.filter(event => event.type === 'explode')).toEqual([
      { type: 'explode', kartId: owner.id, x: target.x, z: target.z },
    ]);
  });

  it('retargets a skycomet when the leading opponent changes', () => {
    const state = race();
    state.karts[1]!.lap = 1;
    state.karts[0]!.item = 'skycomet';
    press(state, state.karts[0]!);
    const comet = state.projectiles[0] as Projectile & ProjectileState;
    expect(comet.target).toBe(1);
    state.karts[2]!.lap = 2;
    advanceItems(state, FIXED_DT);
    expect(comet.target).toBe(2);
  });

  it.each([false, true])('throws a bomb %s brake, slows to a stop after 12 m and explodes at 2.5 s', brake => {
    const state = race();
    const owner = state.karts[0]!;
    owner.item = 'bomb';
    useItem(state, owner, PRESS);
    useItem(state, owner, { ...NEUTRAL_INPUT, brake });
    const bomb = state.projectiles[0] as Projectile & ProjectileState;
    const sx = Math.sin(owner.heading);
    const sz = Math.cos(owner.heading);
    expect((bomb.x - owner.x) * sx + (bomb.z - owner.z) * sz).toBeCloseTo(brake ? -2.3 : 4);
    const start = { x: bomb.x, z: bomb.z };
    for (const kart of state.karts) place(kart, 200 + kart.id * 20);
    for (let tick = 0; tick < 60; tick++) advanceItems(state, FIXED_DT);
    expect(Math.hypot(bomb.x - start.x, bomb.z - start.z)).toBeCloseTo(12, 8);
    const stopped = { x: bomb.x, z: bomb.z };
    for (let tick = 0; tick < 89; tick++) advanceItems(state, FIXED_DT);
    expect({ x: bomb.x, z: bomb.z }).toEqual(stopped);
    expect(state.projectiles).toHaveLength(1);
    advanceItems(state, FIXED_DT);
    expect(state.projectiles).toHaveLength(0);
    expect(state.events.filter(event => event.type === 'explode')).toEqual([
      { type: 'explode', kartId: owner.id, ...stopped },
    ]);
  });

  it('detonates on approach and can spin its own launcher inside the blast radius', () => {
    const state = race();
    const owner = state.karts[0]!;
    owner.item = 'bomb';
    useItem(state, owner, PRESS);
    useItem(state, owner, NEUTRAL_INPUT);
    const bomb = state.projectiles[0]!;
    for (let tick = 0; tick < 18; tick++) advanceItems(state, FIXED_DT);
    Object.assign(owner, { x: bomb.x + 3, z: bomb.z });
    state.karts[1]!.x = bomb.x;
    state.karts[1]!.z = bomb.z;
    advanceItems(state, FIXED_DT);
    expect(state.projectiles).toHaveLength(0);
    expect(owner.spinTime).toBeGreaterThan(0);
    expect(state.karts[1]!.spinTime).toBeGreaterThan(0);
    expect(state.events.filter(event => event.type === 'explode')).toHaveLength(1);
  });

  it('lets the owner trigger a settled bomb and excludes aura from blast damage', () => {
    const state = race();
    const owner = state.karts[0]!;
    owner.item = 'bomb';
    useItem(state, owner, PRESS);
    useItem(state, owner, NEUTRAL_INPUT);
    const bomb = state.projectiles[0]!;
    for (let tick = 0; tick < 60; tick++) advanceItems(state, FIXED_DT);
    expect(state.projectiles).toHaveLength(1);
    Object.assign(owner, { x: bomb.x, z: bomb.z });
    Object.assign(state.karts[1]!, { x: bomb.x + 3, z: bomb.z });
    state.karts[1]!.effects.auraTime = 7;
    advanceItems(state, FIXED_DT);
    expect(owner.spinTime).toBeGreaterThan(0);
    expect(state.karts[1]!.spinTime).toBe(0);
    expect(state.projectiles).toHaveLength(0);
  });

  it('resumes a nearly expired bomb from a snapshot and still detonates at the float fuse deadline', () => {
    const state = race();
    state.boxes = createRace(42).boxes;
    const sample = sampleTrack(350);
    const bomb: Projectile & ProjectileState = { kind: 'bomb', id: state.nextEntityId++, ownerId: 0,
      x: sample.x, y: sample.y, z: sample.z, heading: 0, life: 2 / 60, aux: 2 / 60, bounces: 0 };
    state.projectiles.push(bomb);
    const resumed = decodeSnapshot(encodeSnapshot(state, 0, 0), createRace(42))!.state;
    expect(resumed.projectiles[0]!.life).toBe(0); // Tenths-of-a-second wire quantization.
    advanceItems(resumed, FIXED_DT);
    expect(resumed.projectiles).toHaveLength(1);
    expect(resumed.events.some(event => event.type === 'explode')).toBe(false);
    advanceItems(resumed, FIXED_DT);
    expect(resumed.projectiles).toHaveLength(0);
    expect(resumed.events.filter(event => event.type === 'explode')).toHaveLength(1);
  });

  it('drops a decoy behind the kart and spins a kart stepping onto it', () => {
    const state = race();
    const owner = state.karts[0]!;
    owner.item = 'decoy';
    useItem(state, owner, PRESS);
    useItem(state, owner, NEUTRAL_INPUT);
    const decoy = state.traps[0]!;
    expect(decoy.kind).toBe('decoy');
    expect(Math.hypot(owner.x - decoy.x, owner.z - decoy.z)).toBeCloseTo(2.6);
    Object.assign(state.karts[1]!, { x: decoy.x, z: decoy.z });
    advanceItems(state, FIXED_DT);
    expect(state.karts[1]!.spinTime).toBeGreaterThan(0);
    expect(state.traps).toHaveLength(0);
  });

  it('keeps finished karts and their inventory unchanged by storm', () => {
    const state = race();
    state.karts[1]!.finishTime = 1;
    state.karts[1]!.item = 'bomb';
    const before = structuredClone(state.karts[1]);
    state.karts[0]!.item = 'storm';
    press(state, state.karts[0]!);
    expect(state.karts[1]).toEqual(before);
  });
});

describe('I2 reviewer regressions', () => {
  it.each([10, 20, 30])('hits second place %s m behind a first-place skycomet launcher', gap => {
    const state = race();
    const [owner, target] = state.karts;
    place(owner, 100);
    place(target, 100 - gap);
    owner.lap = target.lap = 1;
    expect(getRank(state, owner.id)).toBe(1);
    expect(getRank(state, target.id)).toBe(2);
    owner.item = 'skycomet';
    press(state, owner);
    const comet = state.projectiles[0] as Projectile & ProjectileState;
    advanceItems(state, FIXED_DT);
    expect(comet.aux).toBeCloseTo(100 - 70 * FIXED_DT, 8);
    for (let tick = 0; tick < 60 && state.projectiles.length; tick++) advanceItems(state, FIXED_DT);
    expect(target.spinTime).toBeGreaterThan(0);
    expect(state.events).toContainEqual({ type: 'explode', kartId: owner.id, x: target.x, z: target.z });
  });

  it.each(Array.from({ length: 10 }, (_, index) => index + 1))
  ('explodes after a first-place launch in an AI race with seed %s', seed => {
    const state = createRace(seed);
    state.boxes = [];
    for (let tick = 0; tick < 900; tick++) stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
    const owner = state.karts.find(kart => getRank(state, kart.id) === 1)!;
    owner.item = 'skycomet';
    press(state, owner);
    expect(state.projectiles).toHaveLength(1);
    let exploded = false;
    for (let tick = 0; tick < 60 * 25 && state.projectiles.length; tick++) {
      stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
      exploded ||= state.events.some(event => event.type === 'explode' && event.kartId === owner.id);
    }
    expect(exploded).toBe(true);
  });

  it.each(['seeker', 'bolt'] as const)('does not hit its boosted launcher with a newly fired %s', kind => {
    for (let launch = 0; launch < 25; launch++) {
      const state = race(launch + 1);
      const owner = state.karts[0];
      place(owner, launch * TRACK_LENGTH / 25);
      owner.speed = 64;
      owner.boostTime = 3;
      owner.effects.auraTime = 0; // Do not hide self-hits behind invulnerability.
      owner.lap = 2;
      owner.item = kind;
      press(state, owner);
      if (kind === 'bolt') useItem(state, owner, NEUTRAL_INPUT);
      const shot = state.projectiles[0];
      for (let tick = 0; tick < 30 && state.projectiles.length && shot.bounces === 0; tick++) {
        stepRace(state, [{ ...getAIInput(state, owner.id), useItem: false }]);
        expect(owner.spinTime, `${kind} launch ${launch}, tick ${tick}`).toBe(0);
      }
    }
  });

  it('keeps a seeker immune to its owner throughout its lifetime', () => {
    const state = race();
    const owner = state.karts[0];
    owner.item = 'seeker';
    owner.lap = 2;
    press(state, owner);
    const shot = state.projectiles[0];
    advanceItems(state, 0.1);
    for (let tick = 0; tick < 353; tick++) {
      Object.assign(shot, { x: owner.x, z: owner.z });
      advanceItems(state, FIXED_DT);
      expect(owner.spinTime).toBe(0);
      expect(state.projectiles).toHaveLength(1);
    }
    advanceItems(state, FIXED_DT);
    expect(state.projectiles).toHaveLength(0);
  });

  it.each([0, 32, 64])('launches a seeker at max(48, owner speed + 8) for speed %s', speed => {
    const state = race();
    const owner = state.karts[0];
    owner.speed = speed;
    owner.lap = 2;
    owner.item = 'seeker';
    press(state, owner);
    const shot = state.projectiles[0] as Projectile & ProjectileState;
    const start = { x: shot.x, z: shot.z };
    expect(shot.aux).toBe(Math.max(48, speed + 8));
    owner.speed = 0; // Launch speed is retained when the kart later slows down.
    advanceItems(state, FIXED_DT);
    expect(Math.hypot(shot.x - start.x, shot.z - start.z)).toBeCloseTo(Math.max(48, speed + 8) * FIXED_DT, 8);
  });

  it('arms a bolt against its owner only after it has cleared three metres', () => {
    const state = race();
    const owner = state.karts[0];
    owner.item = 'bolt';
    press(state, owner);
    useItem(state, owner, NEUTRAL_INPUT);
    const shot = state.projectiles[0];
    for (let tick = 0; tick < 60; tick++) {
      Object.assign(shot, { x: owner.x, z: owner.z });
      advanceItems(state, FIXED_DT);
      expect(owner.spinTime).toBe(0);
    }
    shot.x = owner.x + Math.sin(owner.heading) * 4;
    shot.z = owner.z + Math.cos(owner.heading) * 4;
    advanceItems(state, FIXED_DT);
    Object.assign(shot, { x: owner.x, z: owner.z });
    advanceItems(state, FIXED_DT);
    expect(owner.spinTime).toBeGreaterThan(0);
    expect(state.projectiles).toHaveLength(0);
  });

  it.each([false, true])('adds launcher speed only to a forward bomb throw (brake=%s)', brake => {
    const state = race();
    const owner = state.karts[0];
    owner.speed = 32;
    owner.item = 'bomb';
    press(state, owner);
    useItem(state, owner, { ...NEUTRAL_INPUT, brake });
    const bomb = state.projectiles[0];
    const start = { x: bomb.x, z: bomb.z };
    advanceItems(state, FIXED_DT);
    expect(Math.hypot(bomb.x - start.x, bomb.z - start.z))
      .toBeCloseTo((brake ? 24 : 56) * FIXED_DT - 12 * FIXED_DT ** 2, 8);
  });

  it.each([32, 64])('does not let a speed-%s launcher overtake its bomb during launch', speed => {
    const state = race();
    const owner = state.karts[0];
    state.karts.slice(1).forEach(kart => { kart.finishTime = 1; });
    owner.speed = speed;
    owner.item = 'bomb';
    press(state, owner);
    useItem(state, owner, NEUTRAL_INPUT);
    for (let tick = 0; tick < 30; tick++) {
      owner.x += Math.sin(owner.heading) * speed * FIXED_DT;
      owner.z += Math.cos(owner.heading) * speed * FIXED_DT;
      advanceItems(state, FIXED_DT);
      expect(owner.spinTime).toBe(0);
      expect(state.projectiles).toHaveLength(1);
      const bomb = state.projectiles[0];
      expect((bomb.x - owner.x) * Math.sin(owner.heading) + (bomb.z - owner.z) * Math.cos(owner.heading)).toBeGreaterThan(2);
    }
  });

  it.each([32, 64])('avoids bomb self-hits through the full fuse at 25 track positions, speed %s', speed => {
    for (let launch = 0; launch < 25; launch++) {
      const state = race(launch + 1);
      const owner = state.karts[0];
      place(owner, launch * TRACK_LENGTH / 25);
      state.karts.slice(1).forEach(kart => { kart.finishTime = 1; });
      owner.speed = speed;
      owner.boostTime = speed > 32 ? 3 : 0;
      owner.item = 'bomb';
      press(state, owner);
      useItem(state, owner, NEUTRAL_INPUT);
      let exploded = false;
      for (let tick = 0; tick < 150 && state.projectiles.length; tick++) {
        stepRace(state, [{ ...getAIInput(state, owner.id), useItem: false }]);
        expect(owner.spinTime, `launch ${launch}, tick ${tick}`).toBe(0);
        exploded ||= state.events.some(event => event.type === 'explode');
      }
      expect(exploded).toBe(true);
      expect(state.projectiles).toHaveLength(0);
    }
  });

  it.each([
    { speed: 0, stopTick: 60 }, { speed: 7.25, stopTick: 79 }, { speed: 8, stopTick: 80 },
    { speed: 24, stopTick: 120 }, { speed: 31.25, stopTick: 139 }, { speed: 32, stopTick: 140 },
  ])('allows owner proximity only at stopping tick $stopTick for speed $speed', ({ speed, stopTick }) => {
    for (const cleared of [false, true]) {
      const state = race();
      state.boxes = createRace(42).boxes;
      const owner = state.karts[0];
      owner.speed = speed;
      owner.item = 'bomb';
      press(state, owner);
      useItem(state, owner, NEUTRAL_INPUT);
      const bomb = state.projectiles[0] as Projectile & ProjectileState;
      bomb.bounces = 1; // A wall stop must not shorten the launch-speed safety period.
      bomb.ownerCleared = cleared; // Bomb arming no longer depends on leaving a safety radius.
      Object.assign(bomb, { x: owner.x, z: owner.z });
      for (let tick = 1; tick < stopTick; tick++) {
        // Resume immediately before each tick, including the exact stopping deadline.
        const guest = decodeSnapshot(encodeSnapshot(state, 0, 0), createRace(42))!.state;
        advanceItems(state, FIXED_DT);
        advanceItems(guest, FIXED_DT);
        expect(owner.spinTime, `speed ${speed}, tick ${tick}`).toBe(0);
        expect(guest.karts[0].spinTime).toBe(0);
        expect(guest.projectiles).toHaveLength(1);
      }
      expect(state.projectiles).toHaveLength(1);
      const guest = decodeSnapshot(encodeSnapshot(state, 0, 0), createRace(42))!.state;
      advanceItems(state, FIXED_DT);
      advanceItems(guest, FIXED_DT);
      expect(owner.spinTime).toBeGreaterThan(0);
      expect(guest.karts[0].spinTime).toBeGreaterThan(0);
      expect(state.projectiles).toHaveLength(0);
      expect(guest.projectiles).toHaveLength(0);
      expect(state.events.filter(event => event.type === 'explode')).toHaveLength(1);
    }
  });

  it.each([false, true])('ignores all proximity for the first 0.3 s of a bomb throw (brake=%s)', brake => {
    const state = race();
    const [owner, target] = state.karts;
    owner.item = 'bomb';
    press(state, owner);
    useItem(state, owner, { ...NEUTRAL_INPUT, brake });
    const bomb = state.projectiles[0];
    for (let tick = 1; tick < 18; tick++) {
      Object.assign(target, { x: bomb.x, z: bomb.z });
      advanceItems(state, FIXED_DT);
      expect(state.projectiles, `tick ${tick}`).toHaveLength(1);
      expect(target.spinTime).toBe(0);
      expect(state.events.some(event => event.type === 'explode')).toBe(false);
    }
    Object.assign(target, { x: bomb.x, z: bomb.z });
    advanceItems(state, FIXED_DT);
    expect(state.projectiles).toHaveLength(0);
    expect(target.spinTime).toBeGreaterThan(0);
  });

  it('preserves bolt owner immunity and later re-entry hits after a snapshot resume', () => {
    const state = race();
    state.boxes = createRace(42).boxes;
    const owner = state.karts[0];
    owner.item = 'bolt';
    press(state, owner);
    useItem(state, owner, NEUTRAL_INPUT);
    const shot = state.projectiles[0] as Projectile & ProjectileState;
    for (const cleared of [false, true]) {
      shot.ownerCleared = cleared;
      Object.assign(shot, { x: owner.x, z: owner.z });
      const resumed = decodeSnapshot(encodeSnapshot(state, 0, 0), createRace(42))!.state;
      advanceItems(resumed, FIXED_DT);
      expect(resumed.karts[0].spinTime > 0).toBe(cleared);
      expect(resumed.projectiles).toHaveLength(cleared ? 0 : 1);
    }
  });

  it.each([
    { speed: 0.24, launchSpeed: 24 }, { speed: 0.25, launchSpeed: 24.5 },
    { speed: 7.24, launchSpeed: 31 }, { speed: 7.25, launchSpeed: 31.5 },
    { speed: 31.24, launchSpeed: 55 }, { speed: 31.25, launchSpeed: 55.5 },
    { speed: 32.123, launchSpeed: 56 }, { speed: 64.37, launchSpeed: 88.5 },
  ])('quantizes bomb launch speed $speed to $launchSpeed for host and guest flight', ({ speed, launchSpeed }) => {
    for (const brake of [false, true]) {
      const host = race();
      host.boxes = createRace(42).boxes;
      const owner = host.karts[0];
      owner.speed = speed;
      owner.item = 'bomb';
      press(host, owner);
      useItem(host, owner, { ...NEUTRAL_INPUT, brake });
      const bomb = host.projectiles[0] as Projectile & ProjectileState;
      const guest = decodeSnapshot(encodeSnapshot(host, 0, 0), createRace(42))!.state;
      const predicted = guest.projectiles[0] as Projectile & ProjectileState;
      expect(bomb.speed).toBe(brake ? 24 : launchSpeed);
      expect(predicted.speed).toBe(bomb.speed);
      for (let tick = 0; tick < 12; tick++) {
        const start = { x: bomb.x, z: bomb.z };
        const guestStart = { x: predicted.x, z: predicted.z };
        advanceItems(host, FIXED_DT);
        advanceItems(guest, FIXED_DT);
        expect(Math.hypot(predicted.x - guestStart.x, predicted.z - guestStart.z))
          .toBeCloseTo(Math.hypot(bomb.x - start.x, bomb.z - start.z), 8);
        expect(predicted.aux).toBe(bomb.aux);
      }
    }
  });

  it.each([1, 7, 42, 314, 981, 65535])('avoids forward bomb proximity self-hits in an eight-kart AI pack (seed %s)', seed => {
    const state = createRace(seed);
    state.boxes = [];
    let launches = 0;
    let proximityExplosions = 0;
    let selfHits = 0;
    for (let tick = 0; tick < 3600 && state.phase !== 'finished'; tick++) {
      const inputs = state.karts.map(kart => ({ ...getAIInput(state, kart.id), useItem: false }));
      // Keep AI driving, but schedule forward throws so only one bomb can cause a spin.
      for (const kart of state.karts) if (kart.effects.holding) {
        // Exercise forward flight directly; I3 CPU tactics may deliberately throw backwards.
        useItem(state, kart, { ...inputs[kart.id], brake: false });
        if (state.projectiles.length) launches++;
      }
      if (tick >= 360 && tick % 200 === 0) {
        expect(state.projectiles).toHaveLength(0);
        const slot = Math.floor(tick / 200) % 8;
        state.karts[slot].item = 'bomb';
        inputs[slot].useItem = true;
      }
      const bomb = state.projectiles[0] as (Projectile & ProjectileState) | undefined;
      const fuse = bomb?.aux ?? 0;
      const spinTime = bomb ? state.karts[bomb.ownerId].spinTime : 0;
      stepRace(state, inputs);
      expect(state.projectiles.length).toBeLessThanOrEqual(1);
      if (bomb && fuse > FIXED_DT + 1e-7 &&
        state.events.some(event => event.type === 'explode')) {
        proximityExplosions++;
        if (spinTime === 0 && state.karts[bomb.ownerId].spinTime > 0) selfHits++;
      }
    }
    expect(state.karts).toHaveLength(8);
    expect(launches).toBeGreaterThanOrEqual(10);
    expect(proximityExplosions).toBeGreaterThan(0);
    expect(selfHits).toBe(0);
  });

  it.each(['seeker', 'bomb'] as const)('retains %s launch speed after a snapshot even if its owner slows down', kind => {
    const state = race();
    state.boxes = createRace(42).boxes;
    const owner = state.karts[0];
    owner.speed = 64;
    owner.lap = 2;
    owner.item = kind;
    press(state, owner);
    useItem(state, owner, NEUTRAL_INPUT);
    const resumed = decodeSnapshot(encodeSnapshot(state, 0, 0), createRace(42))!.state;
    const shot = resumed.projectiles[0];
    const start = { x: shot.x, z: shot.z };
    resumed.karts[0].speed = 0;
    advanceItems(resumed, FIXED_DT);
    expect(Math.hypot(shot.x - start.x, shot.z - start.z))
      .toBeCloseTo(kind === 'seeker' ? 72 * FIXED_DT : 88 * FIXED_DT - 12 * FIXED_DT ** 2, 8);
  });

  it.each(['bolt', 'seeker'] as const)('flies through a finished kart with %s and still hits an active opponent', kind => {
    const state = race();
    const target = state.karts[1];
    target.finishTime = 1;
    const shot: Projectile = { kind, id: state.nextEntityId++, ownerId: 0,
      x: target.x, y: target.y, z: target.z, heading: target.heading, life: 4, bounces: 0 };
    state.projectiles.push(shot);
    advanceItems(state, FIXED_DT);
    expect(target.spinTime).toBe(0);
    expect(state.projectiles).toHaveLength(1);
    Object.assign(state.karts[2], { x: shot.x, z: shot.z });
    advanceItems(state, FIXED_DT);
    expect(state.karts[2].spinTime).toBeGreaterThan(0);
    expect(state.projectiles).toHaveLength(0);
  });

  it('excludes finished karts from direct hits, proximity triggers, traps and blasts', () => {
    const state = race();
    const owner = state.karts[0];
    const finished = state.karts[1];
    finished.finishTime = 1;
    finished.speed = 20;
    const before = structuredClone(finished);
    hitKart(state, finished);
    expect(finished).toEqual(before);
    const pose = { id: state.nextEntityId++, ownerId: owner.id, x: finished.x,
      y: finished.y, z: finished.z, heading: finished.heading, life: 1 };
    state.traps.push({ ...pose, kind: 'decoy', age: 2 });
    state.projectiles.push({ ...pose, id: state.nextEntityId++, kind: 'bomb', bounces: 1, aux: 1 } as Projectile & ProjectileState);
    advanceItems(state, FIXED_DT);
    expect(state.traps).toHaveLength(1);
    expect(state.projectiles).toHaveLength(1);
    expect(finished).toEqual(before);
    advanceItems(state, 1);
    expect(state.events.some(event => event.type === 'explode')).toBe(true);
    expect(finished).toEqual(before);
  });
});

describe('I3 ink and autopilot', () => {
  it('starts a fresh rapid dash from its explicit bit even if a predictor inferred a residual timer', () => {
    const state = race();
    const kart = state.karts[0];
    kart.item = 'rapidDash';
    kart.effects.rapidTime = FIXED_DT;
    kart.effects.rapidUnused = 1;
    press(state, kart);
    expect(kart.effects).toMatchObject({ rapidTime: 8, rapidUnused: 0 });
    expect(kart.item).toBe('rapidDash');
    advanceItems(state, FIXED_DT);
    expect(kart.effects.rapidTime).toBeCloseTo(8 - FIXED_DT);
  });

  it('inks every active higher-ranked kart for exactly four seconds and emits both events', () => {
    const state = race();
    state.karts.forEach((kart, id) => { kart.startedLap = true; kart.lapProgress = id * 10; });
    const owner = state.karts[3];
    state.karts[7].finishTime = 1;
    owner.item = 'ink';
    press(state, owner);
    expect(owner.item).toBeNull();
    expect(state.karts.map(kart => kart.effects.inkTime)).toEqual([0, 0, 0, 0, 4, 4, 4, 0]);
    expect(state.events).toEqual([{ type: 'use', kartId: 3 }, { type: 'ink', kartId: 3 }]);
    for (let tick = 0; tick < 239; tick++) advanceItems(state, FIXED_DT);
    expect(state.karts[4].effects.inkTime).toBeCloseTo(FIXED_DT, 8);
    advanceItems(state, FIXED_DT);
    expect(state.karts.every(kart => kart.effects.inkTime === 0)).toBe(true);
  });

  it('applies the specified deterministic ink noise, clamps steering, and restores clear input', () => {
    const state = race();
    const kart = state.karts[1];
    for (const time of [0, 0.25, 1, 3.9]) {
      state.time = time;
      kart.effects.inkTime = 0;
      const clear = getAIInput(state, kart.id);
      kart.effects.inkTime = 4;
      const inked = getAIInput(state, kart.id);
      expect(inked.steer).toBeCloseTo(Math.max(-1, Math.min(1,
        getSteeringError(state, kart) * 1.8 + 0.35 * Math.sin(time * 7 + kart.aiPhase))), 10);
      expect(inked.throttle).toBe(clear.throttle);
      expect(getAIInput(JSON.parse(JSON.stringify(state)), kart.id)).toEqual(inked);
      advanceItems(state, 4);
      expect(getAIInput(state, kart.id)).toEqual(clear);
    }
  });

  it('replaces all controls with AI, multiplies speed by 1.5, and expires after 240 ticks', () => {
    const state = race();
    const kart = state.karts[0];
    kart.item = 'autopilot';
    const activating = getKartModifiers(state, kart, { ...PRESS, steer: -1, throttle: 0, brake: true });
    expect(activating.input).toEqual({ ...getAIInput(state, kart.id), useItem: true });
    expect(activating.maxSpeedMultiplier).toBe(1.5);
    press(state, kart);
    expect(kart.effects.autoTime).toBe(4);
    expect(kart.item).toBeNull();
    expect(state.events).toEqual([{ type: 'use', kartId: 0 }, { type: 'auto_start', kartId: 0 }]);
    for (let tick = 0; tick < 240; tick++) {
      const expected = getAIInput(state, kart.id);
      expect(getKartModifiers(state, kart, { ...PRESS, steer: -1, throttle: 0, brake: true }))
        .toEqual({ input: expected, maxSpeedMultiplier: 1.5, contactHit: true, invulnerable: true });
      advanceItems(state, FIXED_DT);
    }
    expect(kart.effects.autoTime).toBe(0);
    expect(getKartModifiers(state, kart, NEUTRAL_INPUT)).toEqual({
      input: NEUTRAL_INPUT, maxSpeedMultiplier: 1, contactHit: false, invulnerable: false,
    });
  });

  it('drives despite contrary human inputs during autopilot and returns control at expiry', () => {
    const state = race();
    const kart = state.karts[0];
    kart.item = 'autopilot';
    stepRace(state, [PRESS]);
    for (let tick = 1; tick < 240; tick++) {
      stepRace(state, [{ ...NEUTRAL_INPUT, brake: true, steer: -1 }]);
    }
    expect(kart.speed).toBeGreaterThan(20);
    expect(kart.effects.autoTime).toBe(0);
    const speed = kart.speed;
    for (let tick = 0; tick < 20; tick++) stepRace(state, [{ ...NEUTRAL_INPUT, brake: true }]);
    expect(kart.speed).toBeLessThan(speed);
  });

  it('ignores direct hits and storm, spins contact opponents, and preserves other invulnerable karts', () => {
    const state = race();
    const [owner, target, stormer, aura] = state.karts;
    owner.effects.autoTime = 4;
    owner.item = 'dash';
    owner.speed = 32;
    hitKart(state, owner);
    expect(owner.spinTime).toBe(0);
    expect(owner.speed).toBe(32);
    stormer.item = 'storm';
    press(state, stormer);
    expect(owner.effects.shrinkTime).toBe(0);
    expect(owner.item).toBe('dash');
    onKartContact(state, target, owner);
    expect(target.spinTime).toBeGreaterThan(0);
    expect(owner.spinTime).toBe(0);
    aura.effects.auraTime = 4;
    onKartContact(state, owner, aura);
    expect(aura.spinTime).toBe(0);
    owner.effects.autoTime = 0;
    hitKart(state, owner);
    expect(owner.spinTime).toBeGreaterThan(0);
  });
});

describe('I3 CPU item tactics (§7.5)', () => {
  function situation(item: ItemType, rank = 4, error = 0) {
    const state = race();
    const kart = state.karts[0];
    kart.human = false;
    kart.item = item;
    kart.aiPhase = 0;
    kart.startedLap = true;
    kart.lapProgress = 0;
    kart.heading += getSteeringError(state, kart) - error;
    state.karts.slice(1).forEach((other, index) => {
      other.lapProgress = index < rank - 1 ? 100 : -100;
      other.startedLap = true;
      other.x = kart.x + 100 + index * 10;
      other.z = kart.z + 100;
    });
    state.racingTicks = 95;
    return { state, kart };
  }

  function opponent(state: RaceState, kart: KartState, distance: number) {
    const other = state.karts[1];
    other.x = kart.x + Math.sin(kart.heading) * distance;
    other.z = kart.z + Math.cos(kart.heading) * distance;
    return other;
  }

  it.each(ITEMS)('uses %s under its specified rank, aim and proximity conditions', item => {
    const { state, kart } = situation(item);
    opponent(state, kart, 10);
    expect(decideItemUse(state, kart)).toBe(true);
    const before = JSON.stringify(state);
    expect(getAIInput(state, kart.id).useItem).toBe(true);
    expect(decideItemUse(state, kart)).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
    kart.finishTime = 1;
    expect(decideItemUse(state, kart)).toBe(false);
    kart.finishTime = null;
    kart.spinTime = 1;
    expect(decideItemUse(state, kart)).toBe(false);
  });

  it.each(['dash', 'tripleDash', 'rapidDash'] as const)('requires a straight line and the 95-tick cadence for fresh %s', item => {
    const { state, kart } = situation(item, 4, 0.36);
    expect(decideItemUse(state, kart)).toBe(false);
    kart.heading += 0.02;
    expect(decideItemUse(state, kart)).toBe(true);
    state.racingTicks++;
    expect(decideItemUse(state, kart)).toBe(false);
  });

  it('presses active rapidDash at twelve-tick intervals without restarting its eight-second timer', () => {
    const { state, kart } = situation('rapidDash');
    useItem(state, kart, { ...NEUTRAL_INPUT, useItem: decideItemUse(state, kart) });
    expect(kart.effects.rapidUnused).toBe(0);
    const ticks: number[] = [];
    for (let tick = 96; tick <= 132; tick++) {
      state.racingTicks = tick;
      const use = decideItemUse(state, kart);
      if (use) ticks.push(tick);
      useItem(state, kart, { ...NEUTRAL_INPUT, useItem: use });
      advanceItems(state, FIXED_DT);
    }
    expect(ticks).toEqual([108, 120, 132]);
    expect(kart.effects.rapidTime).toBeCloseTo(8 - 37 * FIXED_DT, 8);
  });

  it.each(['bolt', 'seeker', 'barrier'] as const)('requires an active opponent ahead within range for %s', item => {
    const { state, kart } = situation(item);
    const range = item === 'barrier' ? 20 : 35;
    expect(decideItemUse(state, kart)).toBe(false);
    const other = opponent(state, kart, range - 0.01);
    expect(decideItemUse(state, kart)).toBe(true);
    other.finishTime = 1;
    expect(decideItemUse(state, kart)).toBe(false);
    other.finishTime = null;
    opponent(state, kart, range + 0.01);
    expect(decideItemUse(state, kart)).toBe(false);
    opponent(state, kart, -5);
    expect(decideItemUse(state, kart)).toBe(false);
    opponent(state, kart, 10);
    kart.heading -= 0.39;
    expect(decideItemUse(state, kart)).toBe(item === 'barrier');
  });

  it.each(['trap', 'decoy'] as const)('uses %s on a straight or with a rear opponent within fifteen metres', item => {
    const { state, kart } = situation(item, 1, 0.6);
    expect(decideItemUse(state, kart)).toBe(false);
    opponent(state, kart, -14.99);
    expect(decideItemUse(state, kart)).toBe(true);
    opponent(state, kart, -15.01);
    expect(decideItemUse(state, kart)).toBe(false);
    opponent(state, kart, 10);
    expect(decideItemUse(state, kart)).toBe(false);
    kart.heading += 0.6;
    expect(decideItemUse(state, kart)).toBe(true);
  });

  it.each([
    { item: 'skycomet', minimum: 3 }, { item: 'ink', minimum: 2 },
    { item: 'aura', minimum: 4 }, { item: 'storm', minimum: 4 },
  ] as const)('requires rank $minimum or worse for $item', ({ item, minimum }) => {
    for (let rank = 1; rank <= 8; rank++) {
      const { state, kart } = situation(item, rank);
      expect(decideItemUse(state, kart), `rank ${rank}`).toBe(rank >= minimum);
      state.racingTicks++;
      expect(decideItemUse(state, kart)).toBe((item === 'aura' || item === 'storm') && rank >= minimum);
    }
  });

  it('uses autopilot immediately independent of periodic timing or rank', () => {
    const { state, kart } = situation('autopilot', 1, 0.9);
    state.racingTicks = 13;
    expect(decideItemUse(state, kart)).toBe(true);
  });

  it.each([-11.99, -12.01, 5])('aims CPU bombs backwards only with a rear opponent within 12m (%s)', distance => {
    const { state, kart } = situation('bomb');
    opponent(state, kart, distance);
    const input = getAIInput(state, kart.id);
    useItem(state, kart, input);
    state.racingTicks++;
    const release = getKartModifiers(state, kart, getAIInput(state, kart.id)).input;
    expect(release.useItem).toBe(false);
    expect(release.brake).toBe(distance < 0 && distance >= -12);
    useItem(state, kart, release);
    expect(Math.cos(state.projectiles[0].heading - kart.heading))
      .toBeCloseTo(release.brake ? -1 : 1);
  });

  it.each(['trap', 'bolt', 'decoy', 'bomb'] as const)('holds %s against a targeting seeker for sixty ticks, then deploys once', item => {
    const { state, kart } = situation(item);
    state.racingTicks = 13; // Defense reacts between ordinary use slots.
    state.projectiles.push({ kind: 'seeker', id: state.nextEntityId++, ownerId: 1,
      x: kart.x, z: kart.z - 100, y: kart.y, heading: kart.heading, life: 6,
      bounces: 0, target: kart.id } as Projectile & ProjectileState);
    for (let tick = 0; tick < 60; tick++) {
      expect(decideItemUse(state, kart)).toBe(true);
      const before = JSON.stringify(state);
      getAIInput(state, kart.id);
      getAIInput(state, kart.id);
      expect(JSON.stringify(state)).toBe(before);
      useItem(state, kart, { ...NEUTRAL_INPUT, useItem: true });
      expect(kart.effects.aiHoldTicks).toBe(tick + 1);
      expect(kart.effects.holding).toBe(1);
      state.racingTicks++;
    }
    expect(decideItemUse(state, kart)).toBe(false);
    useItem(state, kart, NEUTRAL_INPUT);
    expect(kart.effects.aiHoldTicks).toBe(0);
    expect(kart.item).toBeNull();
    expect(state.events.filter(event => event.type === 'use')).toHaveLength(1);
    useItem(state, kart, NEUTRAL_INPUT);
    expect(state.events.filter(event => event.type === 'use')).toHaveLength(1);
  });

  it('releases a pressed input after a pickup before starting defense against a persistent threat', () => {
    const { state, kart } = situation('trap');
    kart.previousItem = true;
    state.projectiles.push({ kind: 'seeker', id: state.nextEntityId++, ownerId: 1,
      x: kart.x, z: kart.z - 100, y: kart.y, heading: kart.heading, life: 6,
      bounces: 0, target: kart.id } as Projectile & ProjectileState);
    expect(decideItemUse(state, kart)).toBe(false);
    useItem(state, kart, NEUTRAL_INPUT);
    for (let tick = 0; tick < 60; tick++) {
      expect(decideItemUse(state, kart)).toBe(true);
      useItem(state, kart, PRESS);
    }
    expect(kart.effects.holding).toBe(1);
    expect(kart.effects.aiHoldTicks).toBe(60);
    expect(decideItemUse(state, kart)).toBe(false);
  });

  it.each([-19.99, -20.01, 10])('detects only enemy bolts within twenty metres behind (%s)', distance => {
    const { state, kart } = situation('trap');
    state.racingTicks = 13;
    const shot: Projectile = { kind: 'bolt', id: state.nextEntityId++, ownerId: 1,
      x: kart.x + Math.sin(kart.heading) * distance, z: kart.z + Math.cos(kart.heading) * distance,
      y: kart.y, heading: kart.heading, life: 5, bounces: 0 };
    state.projectiles.push(shot);
    expect(decideItemUse(state, kart)).toBe(distance < 0 && distance >= -20);
    shot.ownerId = kart.id;
    expect(decideItemUse(state, kart)).toBe(false);
    shot.ownerId = 1;
    shot.life = 0;
    expect(decideItemUse(state, kart)).toBe(false);
  });

  it('releases defense when a seeker retargets and fires one barrier charge per pulse', () => {
    const { state, kart } = situation('barrier');
    opponent(state, kart, 10);
    for (let remaining = 2; remaining >= 0; remaining--) {
      const use = decideItemUse(state, kart);
      expect(use).toBe(true);
      useItem(state, kart, { ...NEUTRAL_INPUT, useItem: use });
      expect(kart.effects.orbitCount).toBe(remaining);
      expect(state.projectiles).toHaveLength(3 - remaining);
      expect(decideItemUse(state, kart)).toBe(false);
      useItem(state, kart, NEUTRAL_INPUT);
      state.racingTicks += 95;
    }
    expect(kart.item).toBeNull();
    kart.item = 'trap';
    kart.effects.holding = 1;
    kart.effects.aiHoldTicks = 10;
    state.projectiles = [{ ...state.projectiles[0], kind: 'seeker', ownerId: 1, target: 2 } as Projectile & ProjectileState];
    expect(decideItemUse(state, kart)).toBe(false);
  });

  it.each([1, 2])('deploys barrier kind %s in its intended direction even while braking', orbitKind => {
    const { state, kart } = situation('barrier');
    Object.assign(kart.effects, { orbitKind, orbitCount: 3 });
    for (let charge = 0; charge < 3; charge++) {
      useItem(state, kart, { ...PRESS, brake: true });
      if (orbitKind === 1) {
        const trap = state.traps[charge];
        expect((trap.x - kart.x) * Math.sin(kart.heading) +
          (trap.z - kart.z) * Math.cos(kart.heading)).toBeLessThan(0);
      } else {
        expect(Math.cos(state.projectiles[charge].heading - kart.heading)).toBeCloseTo(1);
      }
      useItem(state, kart, NEUTRAL_INPUT);
    }
    expect(kart.item).toBeNull();
  });
});

describe('I2 held-item defense', () => {
  const heldItems = ['trap', 'bolt', 'bomb', 'decoy'] as const;

  it.each(heldItems)('holds %s for thirty ticks, releases once, and supports a one-tick pulse', item => {
    for (const duration of [1, 30]) {
      const state = race();
      const owner = state.karts[0]!;
      owner.item = item;
      for (let tick = 0; tick < duration; tick++) {
        stepRace(state, [PRESS]);
        expect(owner.effects.holding).toBe(1);
        expect(owner.item).toBe(item);
        expect(state.projectiles.length + state.traps.length).toBe(0);
        expect(state.events.some(event => event.type === 'use')).toBe(false);
      }
      stepRace(state, [NEUTRAL_INPUT]);
      expect(owner.effects.holding).toBe(0);
      expect(owner.item).toBeNull();
      expect(state.projectiles.length + state.traps.length).toBe(1);
      expect(state.events.filter(event => event.type === 'use')).toHaveLength(1);
      stepRace(state, [NEUTRAL_INPUT]);
      expect(state.events.some(event => event.type === 'use')).toBe(false);
    }
  });

  it.each(heldItems.flatMap(item => (['bolt', 'seeker', 'bomb'] as const).map(kind => ({ item, kind }))))
  ('blocks a rear $kind with held $item, consuming both without an explosion or release', ({ item, kind }) => {
    const state = race();
    const owner = state.karts[0]!;
    owner.item = item;
    useItem(state, owner, PRESS);
    const projectile: Projectile & ProjectileState = { kind, id: state.nextEntityId++, ownerId: 1,
      x: owner.x - Math.sin(owner.heading) * 5, z: owner.z - Math.cos(owner.heading) * 5,
      y: owner.y, heading: owner.heading, life: kind === 'bomb' ? 2.5 : 5, bounces: 0 };
    if (kind === 'bomb') projectile.aux = 2.5;
    state.projectiles.push(projectile);
    advanceItems(state, 0.1);
    expect(state.projectiles).toHaveLength(0);
    expect(owner.item).toBeNull();
    expect(owner.effects.holding).toBe(0);
    expect(owner.spinTime).toBe(0);
    expect(state.events).toEqual([{ type: 'block', kartId: owner.id }]);
    useItem(state, owner, NEUTRAL_INPUT);
    expect(state.projectiles.length + state.traps.length).toBe(0);
  });

  it.each(['bolt', 'seeker', 'bomb'] as const)('does not block a %s attacking from the front', kind => {
    const state = race();
    const owner = state.karts[0]!;
    owner.item = 'trap';
    useItem(state, owner, PRESS);
    const projectile: Projectile & ProjectileState = { kind, id: state.nextEntityId++, ownerId: 1,
      x: owner.x + Math.sin(owner.heading) * 3, z: owner.z + Math.cos(owner.heading) * 3,
      y: owner.y, heading: owner.heading - Math.PI, life: kind === 'bomb' ? 2.2 : 5, bounces: 0 };
    if (kind === 'bomb') projectile.aux = 2.2;
    state.projectiles.push(projectile);
    advanceItems(state, 0.1);
    expect(owner.spinTime).toBeGreaterThan(0);
    expect(owner.effects.holding).toBe(0);
    expect(state.events.some(event => event.type === 'block')).toBe(false);
  });

  it.each([1.29, 1.31])('enforces the 1.3 m rear shield radius with lateral offset %s', offset => {
    const state = race();
    const owner = state.karts[0]!;
    owner.item = 'trap';
    useItem(state, owner, PRESS);
    const sx = Math.sin(owner.heading);
    const sz = Math.cos(owner.heading);
    state.projectiles.push({ kind: 'bolt', id: state.nextEntityId++, ownerId: 1,
      x: owner.x - sx * 5 + sz * offset, z: owner.z - sz * 5 - sx * offset,
      y: owner.y, heading: owner.heading, life: 5, bounces: 0 });
    advanceItems(state, 0.1);
    expect(state.events.some(event => event.type === 'block')).toBe(offset < 1.3);
    expect(owner.spinTime > 0).toBe(offset > 1.3);
  });

  it('consumes a shield once when two rear projectiles arrive in the same tick', () => {
    const state = race();
    const owner = state.karts[0]!;
    owner.item = 'decoy';
    useItem(state, owner, PRESS);
    for (let index = 0; index < 2; index++) {
      state.projectiles.push({ kind: 'bolt', id: state.nextEntityId++, ownerId: 1,
        x: owner.x - Math.sin(owner.heading) * 5, z: owner.z - Math.cos(owner.heading) * 5,
        y: owner.y, heading: owner.heading, life: 5, bounces: 0 });
    }
    advanceItems(state, 0.1);
    expect(owner.item).toBeNull();
    expect(owner.spinTime).toBeGreaterThan(0);
    expect(state.events.filter(event => event.type === 'block')).toHaveLength(1);
    expect(state.projectiles).toHaveLength(0);
  });

  it('fires a held bolt backwards when brake is down on release', () => {
    const state = race();
    const owner = state.karts[0]!;
    owner.item = 'bolt';
    useItem(state, owner, PRESS);
    useItem(state, owner, { ...NEUTRAL_INPUT, brake: true });
    const bolt = state.projectiles[0]!;
    expect(Math.cos(bolt.heading - owner.heading)).toBeCloseTo(-1);
    expect((bolt.x - owner.x) * Math.sin(owner.heading) +
      (bolt.z - owner.z) * Math.cos(owner.heading)).toBeCloseTo(-2.3);
  });

  it('does not hold an item picked up while the button stays down, or deploy after a spin', () => {
    const state = race();
    const owner = state.karts[0]!;
    useItem(state, owner, PRESS);
    owner.item = 'trap';
    useItem(state, owner, PRESS);
    useItem(state, owner, NEUTRAL_INPUT);
    expect(state.traps).toHaveLength(0);
    useItem(state, owner, PRESS);
    expect(owner.effects.holding).toBe(1);
    hitKart(state, owner);
    useItem(state, owner, NEUTRAL_INPUT);
    expect(owner.effects.holding).toBe(0);
    expect(state.traps).toHaveLength(0);
  });

  it('simulates forty projectiles while snapshots retain at most twenty-eight', () => {
    const state = race();
    state.boxes = createRace(42).boxes;
    const owner = state.karts[0]!;
    for (let count = 0; count < 40; count++) {
      owner.item = 'seeker';
      press(state, owner);
    }
    expect(state.projectiles).toHaveLength(40);
    advanceItems(state, FIXED_DT);
    expect(state.projectiles).toHaveLength(40);
    const buffer = encodeSnapshot(state, 0, 0);
    expect(buffer.byteLength).toBe(1196);
    const decoded = decodeSnapshot(buffer, createRace(42))!;
    expect(decoded.state.projectiles).toHaveLength(28);
    for (let tick = 0; tick < 360; tick++) advanceItems(state, FIXED_DT);
    expect(state.projectiles).toHaveLength(0);
    expect(isRaceState(JSON.parse(JSON.stringify(state)))).toBe(true);
  });
});

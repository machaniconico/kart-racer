import { describe, expect, it } from 'vitest';
import { getAIInput } from '../sim/ai';
import { ENTITY_KINDS, KART_EFFECT_LAYOUT } from '../sim/itemTypes';
import type { ItemType, ProjectileState } from '../sim/itemTypes';
import { advanceItems, useItem } from '../sim/items';
import { createRace, FIXED_DT, stepRace } from '../sim/race';
import { sampleTrack } from '../sim/track';
import type { InputFrame, Pose, Projectile, RaceState } from '../sim/types';
import { NEUTRAL_INPUT } from './inputBuffer';
import { LAYOUT_FINGERPRINT, PacketKind, PROTOCOL_VERSION } from './protocol';
import {
  decodeSnapshot, encodeSnapshot, MAX_SNAPSHOT_ENTITIES, SNAPSHOT_BOX_COUNT,
  SNAPSHOT_ENTITY_BYTES, SNAPSHOT_HEADER_BYTES, SNAPSHOT_KART_BYTES, SNAPSHOT_LAYOUT,
} from './snapshotCodec';

const inputs: InputFrame[] = Array.from({ length: 8 }, (_, id) => ({
  steer: (id - 3.5) / 3.5, throttle: id / 7,
  brake: (id & 1) !== 0, drift: (id & 2) !== 0, useItem: (id & 4) !== 0,
}));
const ENTITY_OFFSET = 496;

function projectile(id: number, x = id): Projectile {
  return { kind: 'bolt', id, ownerId: id % 8, x, y: 3.123456, z: -12.765432,
    heading: Math.PI - 0.00001, life: 4.716, bounces: id % 4 };
}

function fixture(entityCount = 28): RaceState {
  const state = createRace(98765);
  Object.assign(state, { tick: 780, racingTicks: 600, time: 10, phase: 'racing', nextEntityId: 900 });
  state.karts.forEach((kart, id) => {
    Object.assign(kart, {
      x: 245.123456 - id * 60, y: 3.987654 + id, z: -271.654321 + id * 40,
      heading: -Math.PI + id * Math.PI / 3.5, speed: 12.347 + id, steer: inputs[id].steer,
      trackDistance: 74.123456 + id, lapProgress: 51.654321 + id, lapStartTime: 4.123456,
      finishTime: id % 2 ? 9.234567 : null, lateralOffset: -3.1245 + id,
      lap: id % 4, nextCheckpoint: id % 5, driftTime: 10.0049 + id * 0.01,
      driftDirection: id % 3 - 1, boostTime: 0.457, spinTime: 1.347,
      hopTime: 0.157, hitCooldown: 0.657, item: [null, 'dash', 'trap', 'bolt'][id % 4],
      wrongWay: !!(id & 1), startedLap: !!(id & 2), lapValid: !!(id & 4),
      previousDrift: !!(id & 2), previousItem: !!(id & 1), human: id === 0 || id === 7,
      effects: { rapidTime: 6.127, rapidUnused: 0, auraTime: 7.532, shrinkTime: 8.132, inkTime: 4.124,
        autoTime: 3.467, charges: id % 4, holding: id % 2, aiHoldTicks: id * 8, orbitKind: id % 3, orbitCount: id % 4 },
    });
  });
  state.boxes.forEach((box, id) => { box.respawnTime = id * 0.417; });
  for (let index = 0; index < entityCount; index++) {
    const bolt = projectile(200 + index, index * 8.123456);
    if (index % 3 === 0) {
      const { bounces: _bounces, ...pose } = bolt;
      state.traps.push({ ...pose, kind: 'trap', age: index * 0.127, life: 20 - index * 0.127 });
    } else state.projectiles.push(bolt);
  }
  state.events = [{ type: 'lap', kartId: 0, value: 8 }];
  return state;
}

function roundTrip(state: RaceState, template = createRace(123)) {
  const buffer = encodeSnapshot(state, 23, 123456.789, inputs);
  const decoded = decodeSnapshot(buffer, template);
  expect(decoded).not.toBeNull();
  expect(new Uint8Array(encodeSnapshot(decoded!.state, decoded!.raceId, decoded!.hostTime,
    decoded!.lastAppliedInput))).toEqual(new Uint8Array(buffer));
  return decoded!;
}

function expectPose(actual: Pose, original: Pose) {
  for (const key of ['x', 'y', 'z'] as const) expect(Math.abs(actual[key] - original[key]), key).toBeLessThanOrEqual(1e-3);
  expect(Math.abs(actual.heading - original.heading)).toBeLessThanOrEqual(1e-4);
}

describe('snapshot codec', () => {
  it('fits eight karts, twelve boxes and 28 entities below 1,200 bytes; two bolts below 600', () => {
    const state = fixture();
    expect(state.karts).toHaveLength(8);
    expect(state.boxes).toHaveLength(12);
    expect(encodeSnapshot(state, 0, 0).byteLength).toBe(1196);
    expect(encodeSnapshot(state, 0, 0).byteLength).toBeLessThanOrEqual(1200);
    state.projectiles = [projectile(200), projectile(201)];
    state.traps = [];
    expect(encodeSnapshot(state, 0, 0).byteLength).toBe(546);
    expect(encodeSnapshot(state, 0, 0).byteLength).toBeLessThanOrEqual(600);
    expect(MAX_SNAPSHOT_ENTITIES).toBe(28);
    expect(SNAPSHOT_BOX_COUNT).toBe(12);
    expect([SNAPSHOT_HEADER_BYTES, SNAPSHOT_KART_BYTES, SNAPSHOT_ENTITY_BYTES]).toEqual([28, 57, 25]);
  });

  it('round-trips all moving poses within tolerance, including a ten-second drift', () => {
    const original = fixture();
    const decoded = roundTrip(original);
    expect(decoded.raceId).toBe(23);
    expect(decoded.hostTime).toBe(123456.789);
    expect(decoded.state).toMatchObject({ tick: 780, seed: original.seed, phase: 'racing',
      countdown: original.countdown, racingTicks: 600, time: 10, nextEntityId: 900, events: [] });
    decoded.state.karts.forEach((kart, id) => {
      const source = original.karts[id];
      expectPose(kart, source);
      expect(Math.abs(kart.driftTime - source.driftTime)).toBeLessThanOrEqual(0.01);
      for (const key of ['item', 'lap', 'nextCheckpoint', 'driftDirection', 'wrongWay', 'startedLap',
        'lapValid', 'previousDrift', 'previousItem', 'human'] as const) expect(kart[key]).toBe(source[key]);
      for (const key of ['trackDistance', 'lapProgress', 'lapStartTime'] as const) {
        expect(Math.abs(kart[key] - source[key])).toBeLessThanOrEqual(1e-3);
      }
      if (source.finishTime === null) expect(kart.finishTime).toBeNull();
      else expect(kart.finishTime).toBeCloseTo(source.finishTime, 4);
      expect(kart.speed).toBeCloseTo(source.speed, 2);
      expect(kart.steer).toBeCloseTo(source.steer, 2);
      expect(kart.lateralOffset).toBeCloseTo(source.lateralOffset, 2);
      for (const key of ['boostTime', 'spinTime', 'hopTime', 'hitCooldown'] as const) {
        expect(Math.abs(kart[key] - source[key])).toBeLessThanOrEqual(0.01);
      }
      for (const field of KART_EFFECT_LAYOUT) {
        expect(Math.abs(kart.effects[field.field] - source.effects[field.field])).toBeLessThanOrEqual(0.5 / field.scale);
      }
      const input = decoded.lastAppliedInput[id];
      expect(Math.abs(input.steer - inputs[id].steer)).toBeLessThanOrEqual(1 / 254);
      expect(Math.abs(input.throttle - inputs[id].throttle)).toBeLessThanOrEqual(1 / 510);
      for (const key of ['brake', 'drift', 'useItem'] as const) expect(input[key]).toBe(inputs[id][key]);
    });
    for (const entity of [...decoded.state.projectiles, ...decoded.state.traps]) {
      const source = [...original.projectiles, ...original.traps].find(entry => entry.id === entity.id)!;
      expectPose(entity, source);
      expect(entity.kind).toBe(source.kind);
      expect(entity.ownerId).toBe(source.ownerId);
      expect(Math.abs(entity.life - source.life)).toBeLessThanOrEqual(0.05);
      if ('age' in entity && 'age' in source) expect(entity.age).toBeCloseTo(source.age, 5);
      if ('bounces' in entity && 'bounces' in source) expect(entity.bounces).toBe(source.bounces);
    }
    decoded.state.boxes.forEach((box, index) => {
      expect(Math.abs(box.respawnTime - original.boxes[index].respawnTime)).toBeLessThanOrEqual(0.01);
    });
  });

  it('inherits profile, lap history, AI phase and box poses from a template without aliasing it', () => {
    const original = fixture();
    const template = createRace(222);
    template.karts.forEach((kart, id) => Object.assign(kart, {
      name: `Guest${id}`, color: 0x123456 + id, aiPhase: 0.789 + id, lapTimes: [12.345 + id, 14.56],
    }));
    template.karts.reverse(); // Slot identity, rather than template array position, selects the profile.
    template.boxes[0].x = 999;
    const beforeState = structuredClone(original);
    const beforeTemplate = structuredClone(template);
    const decoded = roundTrip(original, template).state;
    decoded.karts.forEach(kart => {
      const source = template.karts.find(entry => entry.id === kart.id)!;
      expect(kart).toMatchObject({ name: source.name, color: source.color, aiPhase: source.aiPhase, lapTimes: source.lapTimes });
      expect(kart.lapTimes).not.toBe(source.lapTimes);
      expect(kart.effects).not.toBe(source.effects);
    });
    expect(decoded.boxes[0].x).toBe(999);
    expect(original).toEqual(beforeState);
    expect(template).toEqual(beforeTemplate);
    decoded.karts[0].lapTimes.push(99);
    decoded.karts[0].effects.auraTime = 0;
    decoded.boxes[0].x = 0;
    expect(template).toEqual(beforeTemplate);
  });

  it.each([29, 40, 80, 512])('retains the closest 28 of %i entities to any human, ignoring nearer CPUs', count => {
    const state = fixture(0);
    state.karts.forEach((kart, index) => Object.assign(kart, { x: index === 7 ? count * 10 : 0, y: 0, z: 0, human: index === 7 }));
    state.projectiles = Array.from({ length: count }, (_, index) => ({ ...projectile(200 + index), x: index * 10, z: 0 }));
    const { bounces: _bounces, ...nearest } = state.projectiles.pop()!;
    state.traps = [{ ...nearest, kind: 'trap', age: 0 }];
    const decoded = roundTrip(state).state;
    const ids = [...decoded.projectiles, ...decoded.traps].map(entity => entity.id).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 28 }, (_, index) => 200 + count - 28 + index));
    expect(decoded.traps).toHaveLength(1);
  });

  it('considers all humans, breaks distance ties by ID and has a deterministic CPU-only fallback', () => {
    const state = fixture(0);
    state.karts.forEach((kart, id) => Object.assign(kart, { x: id === 7 ? 1000 : 0, y: 0, z: 0, human: id === 0 || id === 7 }));
    state.projectiles = Array.from({ length: 30 }, (_, id) => ({ ...projectile(229 - id), x: id % 2 ? 1000 : 0, z: 0 }));
    expect(roundTrip(state).state.projectiles.map(entity => entity.id)).toEqual(Array.from({ length: 28 }, (_, id) => 200 + id));
    state.karts.forEach(kart => { kart.human = false; });
    expect(roundTrip(state).state.projectiles.map(entity => entity.id)).toEqual(Array.from({ length: 28 }, (_, id) => 200 + id));
  });

  it('preserves quantization at boundaries and across a deterministic sweep of headings and timers', () => {
    const state = fixture();
    const headings = [-Math.PI, Math.PI, -3.37, 3.37, -1 / 16384, 1 / 16384, 0, 3.9998];
    state.karts.forEach((kart, id) => { kart.heading = headings[id]; });
    state.karts[0].driftTime = 655.35;
    state.karts[1].driftTime = 10;
    state.karts[2].finishTime = 0;
    state.karts[3].effects.rapidTime = 12.75;
    const decoded = roundTrip(state).state;
    decoded.karts.forEach((kart, id) => expectPose(kart, state.karts[id]));
    expect(decoded.karts[0].driftTime).toBe(655.35);
    expect(decoded.karts[1].driftTime).toBe(10);
    expect(decoded.karts[2].finishTime).toBe(0);
    for (let index = 0; index < 256; index++) {
      const kart = state.karts[index % 8];
      kart.heading = -Math.PI + index * Math.PI * 2 / 255;
      kart.driftTime = index * 2.57;
      kart.effects.rapidTime = index / 20;
      kart.hopTime = index / 100;
      state.countdown = index / 100;
      expectPose(roundTrip(state).state.karts[kart.id], kart);
    }
  });

  it('encodes real countdown/racing/finished states and default neutral inputs', () => {
    const state = createRace(11);
    for (let tick = 0; tick <= 240; tick++) {
      if (tick % 3 === 0) roundTrip(state);
      stepRace(state, inputs);
    }
    state.phase = 'finished';
    const decoded = decodeSnapshot(encodeSnapshot(state, 255, 0), createRace(11))!;
    expect(decoded.state.phase).toBe('finished');
    expect(decoded.state.time).toBe(state.racingTicks * FIXED_DT);
    expect(decoded.lastAppliedInput).toEqual(Array.from({ length: 8 }, () => ({ steer: 0, throttle: 0, brake: false, drift: false, useItem: false })));
    expect(decoded.raceId).toBe(255);
  });

  it('packs every valid byte 55 combination without changing neighboring effect fields', () => {
    const state = createRace(42);
    const kart = state.karts[0];
    Object.assign(kart.effects, { inkTime: 4, autoTime: 4, charges: 3, orbitKind: 2, orbitCount: 3 });
    for (let packed = 0; packed < 256; packed++) {
      const effects = { holding: packed & 1, rapidUnused: (packed >> 1) & 1, aiHoldTicks: packed >> 2 };
      if (effects.aiHoldTicks > 60) {
        const buffer = encodeSnapshot(state, 0, 0);
        new DataView(buffer).setUint8(SNAPSHOT_HEADER_BYTES + 55, packed);
        expect(decodeSnapshot(buffer, state), `reserved held count in byte ${packed}`).toBeNull();
        continue;
      }
      Object.assign(kart.effects, effects);
      const buffer = encodeSnapshot(state, 0, 0);
      const view = new DataView(buffer);
      expect(view.getUint8(SNAPSHOT_HEADER_BYTES + 55)).toBe(packed);
      expect(view.getUint8(SNAPSHOT_HEADER_BYTES + 54)).toBe(3);
      expect(view.getUint8(SNAPSHOT_HEADER_BYTES + 56)).toBe(14);
      const decoded = decodeSnapshot(buffer, state)!;
      expect(decoded.state.karts[0].effects).toEqual(kart.effects);
      expect(decoded.state.karts.slice(1).map(other => other.effects))
        .toEqual(state.karts.slice(1).map(other => other.effects));
      expect(new Uint8Array(encodeSnapshot(decoded.state, 0, 0))).toEqual(new Uint8Array(buffer));
    }
  });

  it('normalizes an already-running rapid dash before timer quantization without mutating the source', () => {
    const state = createRace(42);
    const kart = state.karts[0];
    kart.item = 'rapidDash';
    kart.effects.rapidTime = 0.01;
    const before = structuredClone(state);
    const decoded = decodeSnapshot(encodeSnapshot(state, 0, 0), state)!;
    expect(decoded.state.karts[0].effects).toMatchObject({ rapidTime: 0, rapidUnused: 0 });
    expect(state).toEqual(before);
  });

  it.each([
    { field: 'rapidUnused', max: 1 }, { field: 'aiHoldTicks', max: 60 },
  ])('rejects missing, fractional and out-of-range $field before encoding', ({ field, max }) => {
    for (const value of [undefined, null, false, '1', -1, 0.5, max + 1, NaN, Infinity]) {
      const state = createRace(42);
      Object.assign(state.karts[0].effects, { [field]: value });
      expect(() => encodeSnapshot(state, 0, 0), `${field}=${String(value)}`).toThrow(RangeError);
    }
  });

  it('keeps a fresh rapid dash usable after a zero-timer snapshot', () => {
    const state = createRace(42);
    state.boxes.forEach(box => { box.respawnTime = 5; });
    state.karts[0].item = 'rapidDash';
    const resumed = roundTrip(state).state;
    const kart = resumed.karts[0];
    expect(kart.effects).toMatchObject({ rapidTime: 0, rapidUnused: 1 });
    advanceItems(resumed, FIXED_DT);
    expect(kart.item).toBe('rapidDash');
    useItem(resumed, kart, { ...NEUTRAL_INPUT, useItem: true });
    expect(kart.effects).toMatchObject({ rapidTime: 8, rapidUnused: 0 });
    expect(kart.boostTime).toBe(0.45);
    expect(resumed.events.filter(event => event.type === 'use')).toHaveLength(1);
  });

  it.each(['press', 'advance'] as const)('expires an active rapid dash rounded to zero on %s without restarting it', action => {
    const state = createRace(42);
    state.boxes.forEach(box => { box.respawnTime = 5; });
    state.karts[0].item = 'rapidDash';
    Object.assign(state.karts[0].effects, { rapidTime: FIXED_DT, rapidUnused: 0 });
    const resumed = roundTrip(state).state;
    const kart = resumed.karts[0];
    expect(kart.effects).toMatchObject({ rapidTime: 0, rapidUnused: 0 });
    if (action === 'press') useItem(resumed, kart, { ...NEUTRAL_INPUT, useItem: true });
    else advanceItems(resumed, FIXED_DT);
    expect(kart.item).toBeNull();
    useItem(resumed, kart, NEUTRAL_INPUT);
    useItem(resumed, kart, { ...NEUTRAL_INPUT, useItem: true });
    advanceItems(resumed, FIXED_DT);
    expect(kart.effects).toMatchObject({ rapidTime: 0, rapidUnused: 0 });
    expect(kart.boostTime).toBe(0);
    expect(resumed.events).toEqual([]);
  });

  it.each(['trap', 'bolt', 'decoy', 'bomb'] as const)('resumes CPU %s defense at tick 59 and releases at the 60-tick cap', item => {
    const state = createRace(42);
    const source = state.karts[1];
    Object.assign(source, { item, previousItem: true });
    Object.assign(source.effects, { holding: 1, aiHoldTicks: 59 });
    state.projectiles = [{ ...projectile(500), kind: 'seeker', ownerId: 0, target: 1 } as Projectile & ProjectileState];
    let resumed = roundTrip(state, state).state;
    let kart = resumed.karts[1];
    expect(kart.effects).toMatchObject({ holding: 1, aiHoldTicks: 59 });
    for (let sample = 0; sample < 3; sample++) expect(getAIInput(resumed, 1).useItem).toBe(true);
    expect(kart.effects.aiHoldTicks).toBe(59);
    useItem(resumed, kart, getAIInput(resumed, 1));
    expect(kart.effects.aiHoldTicks).toBe(60);
    // A held input packet can outlast the CPU decision; its counter must saturate.
    useItem(resumed, kart, { ...NEUTRAL_INPUT, useItem: true });
    expect(kart.effects.aiHoldTicks).toBe(60);
    resumed = roundTrip(resumed, state).state;
    kart = resumed.karts[1];
    const release = getAIInput(resumed, 1);
    expect(release.useItem).toBe(false);
    useItem(resumed, kart, release);
    expect(kart.item).toBeNull();
    expect(kart.effects).toMatchObject({ holding: 0, aiHoldTicks: 0 });
    expect(resumed.events.filter(event => event.type === 'use')).toEqual([{ type: 'use', kartId: 1 }]);
    expect([...resumed.projectiles, ...resumed.traps].filter(entity => entity.ownerId === 1))
      .toMatchObject([{ kind: item }]);
  });

  it('preserves all fourteen inventory items and entity targeting/auxiliary values', () => {
    const state = fixture(0);
    const items: ItemType[] = ['dash', 'trap', 'bolt', 'seeker', 'skycomet', 'tripleDash',
      'rapidDash', 'aura', 'storm', 'ink', 'decoy', 'bomb', 'autopilot', 'barrier'];
    for (const item of items) {
      state.karts[0].item = item;
      expect(roundTrip(state).state.karts[0].item).toBe(item);
    }
    const bolt: Projectile & { target: number; aux: number } = { ...projectile(222), target: 7, aux: -0 };
    state.projectiles = [bolt];
    const decoded = roundTrip(state).state.projectiles[0] as typeof bolt;
    expect(decoded.target).toBe(7);
    expect(Object.is(decoded.aux, -0)).toBe(true);
  });

  it('round-trips every I2 kind with its targeting, fuse, track distance or trap age', () => {
    const state = fixture(0);
    const projectiles: (Projectile & ProjectileState)[] = [
      { ...projectile(201), kind: 'seeker', target: 7, aux: 72, life: 6 },
      { ...projectile(202), kind: 'seeker', target: null, life: 5.9 },
      { ...projectile(203), kind: 'skycomet', target: 1, aux: 123.456, life: 25 },
      { ...projectile(204), kind: 'bomb', aux: 2.416, life: 2.416, speed: 56.5, ownerCleared: true },
    ];
    state.projectiles = projectiles;
    const { bounces: _bounces, ...pose } = projectile(205);
    state.traps = [{ ...pose, kind: 'decoy', age: 1.234, life: 18.766 }];
    const decoded = roundTrip(state).state;
    expect(decoded.projectiles.map(entity => entity.kind)).toEqual(['seeker', 'seeker', 'skycomet', 'bomb']);
    expect(decoded.traps).toHaveLength(1);
    expect(decoded.traps[0].kind).toBe('decoy');
    expect(decoded.traps[0].age).toBeCloseTo(1.234, 5);
    for (let index = 0; index < projectiles.length; index++) {
      const original = projectiles[index];
      const actual = decoded.projectiles[index] as Projectile & ProjectileState;
      expect(actual.target).toBe(original.target);
      if (original.speed !== undefined) expect(actual.speed).toBe(original.speed);
      if (original.kind !== 'bolt') expect(actual.ownerCleared).toBeUndefined();
      else if (original.ownerCleared !== undefined) expect(actual.ownerCleared).toBe(original.ownerCleared);
      if (original.aux !== undefined) expect(actual.aux).toBeCloseTo(original.aux, 4);
      expectPose(actual, original);
    }
  });

  it.each([false, true])('preserves bolt launch safety (cleared=%s) and drops irrelevant bomb flags without losing bounce counts', ownerCleared => {
    const state = fixture(0);
    state.projectiles = [
      { ...projectile(201), ownerCleared },
      { ...projectile(202), kind: 'bomb', ownerCleared, speed: 63.123, aux: 2.1 },
    ] as (Projectile & ProjectileState)[];
    const decoded = roundTrip(state).state.projectiles as (Projectile & ProjectileState)[];
    expect(decoded.map(shot => shot.ownerCleared)).toEqual([ownerCleared, undefined]);
    expect(decoded.map(shot => shot.bounces)).toEqual(state.projectiles.map(shot => shot.bounces));
    expect(Math.abs(decoded[1].speed! - 63.123)).toBeLessThanOrEqual(0.25);
  });

  it.each([128, 143])('expires a float32 bomb fuse on the same tick as the host with %i ticks remaining', ticks => {
    const state = createRace(42);
    state.boxes.forEach(box => { box.respawnTime = 5; });
    const sample = sampleTrack(350);
    const fuse = ticks * FIXED_DT;
    state.projectiles = [{ kind: 'bomb', id: state.nextEntityId++, ownerId: 0,
      x: sample.x, y: sample.y, z: sample.z, heading: 0, life: fuse, aux: fuse, speed: 0, bounces: 0 } as Projectile & ProjectileState];
    const resumed = roundTrip(state, state).state;
    const restored = resumed.projectiles[0] as Projectile & ProjectileState;
    expect(restored.aux! - fuse).toBeGreaterThan(1e-7);
    for (let tick = 1; tick <= ticks; tick++) {
      for (const race of [state, resumed]) {
        advanceItems(race, FIXED_DT);
        expect(race.projectiles, `remaining at tick ${tick}`).toHaveLength(tick === ticks ? 0 : 1);
        expect(race.events.filter(event => event.type === 'explode')).toHaveLength(tick === ticks ? 1 : 0);
      }
    }
  });

  it('arms bomb proximity on the same tick after restoring a float32 fuse', () => {
    const state = createRace(42);
    state.boxes.forEach(box => { box.respawnTime = 5; });
    const sample = sampleTrack(350);
    const fuse = 143 * FIXED_DT; // Seven ticks elapsed; eleven remain until the 0.3 s arming time.
    Object.assign(state.karts[1], { x: sample.x + 1, z: sample.z });
    state.projectiles = [{ kind: 'bomb', id: state.nextEntityId++, ownerId: 0,
      x: sample.x, y: sample.y, z: sample.z, heading: 0, life: fuse, aux: fuse, speed: 0, bounces: 0 } as Projectile & ProjectileState];
    const resumed = roundTrip(state, state).state;
    for (let tick = 1; tick <= 11; tick++) {
      for (const race of [state, resumed]) {
        advanceItems(race, FIXED_DT);
        expect(race.projectiles, `remaining at tick ${tick}`).toHaveLength(tick === 11 ? 0 : 1);
        expect(race.events.filter(event => event.type === 'explode')).toHaveLength(tick === 11 ? 1 : 0);
      }
    }
    expect(resumed.karts[1].spinTime).toBe(state.karts[1].spinTime);
    expect(resumed.karts[1].spinTime).toBeGreaterThan(0);
  });

  it('uses the documented little-endian header and rejects truncated or oversized payloads', () => {
    const state = fixture();
    state.tick = 0x12345678;
    state.seed = 0xffffffff;
    const buffer = encodeSnapshot(state, 7, 4321.5);
    const view = new DataView(buffer);
    expect(view.getUint8(0)).toBe(PacketKind.SNAPSHOT);
    expect(view.getUint8(1)).toBe(7);
    expect(view.getUint32(2, true)).toBe(0x12345678);
    expect(view.getFloat64(6, true)).toBe(4321.5);
    expect(view.getUint32(14, true)).toBe(0xffffffff);
    expect(view.getUint32(21, true)).toBe(state.racingTicks);
    expect(view.getUint16(25, true)).toBe(state.nextEntityId);
    expect(view.getUint8(27)).toBe(28);
    for (let length = 0; length < buffer.byteLength; length++) {
      expect(decodeSnapshot(buffer.slice(0, length), state)).toBeNull();
    }
    const extended = new Uint8Array(buffer.byteLength + 1);
    extended.set(new Uint8Array(buffer));
    expect(decodeSnapshot(extended.buffer, state)).toBeNull();
    for (const data of [null, undefined, 'snapshot', {}, new Uint8Array(buffer)]) expect(decodeSnapshot(data, state)).toBeNull();
  });

  it('rejects corrupt discriminants, flags, floats, inputs, owners and duplicate entity IDs', () => {
    const state = fixture();
    const buffer = encodeSnapshot(state, 0, 0);
    const mutations: ((view: DataView) => void)[] = [
      view => view.setUint8(0, PacketKind.INPUT), view => view.setUint8(18, 3),
      view => view.setUint8(27, 29), view => view.setFloat64(6, NaN, true),
      view => view.setFloat32(28, Infinity, true), view => view.setInt8(28 + 16, -128),
      view => view.setFloat32(28 + 29, -2, true), view => view.setInt8(28 + 39, 2),
      view => view.setUint8(28 + 44, 255), view => view.setUint8(28 + 45, 64),
      view => view.setInt8(28 + 46, -128), view => view.setUint8(28 + 48, 8),
      view => view.setUint8(28 + 55, 61 << 2), view => view.setUint8(28 + 56, 16),
      view => view.setUint8(ENTITY_OFFSET, 255), view => view.setUint8(ENTITY_OFFSET + 3, 8),
      view => view.setUint8(ENTITY_OFFSET + 20, 8), view => view.setFloat32(ENTITY_OFFSET + 21, NaN, true),
      view => view.setUint16(ENTITY_OFFSET + 25 + 1, view.getUint16(ENTITY_OFFSET + 1, true), true),
    ];
    for (const mutate of mutations) {
      const corrupt = buffer.slice(0);
      mutate(new DataView(corrupt));
      expect(decodeSnapshot(corrupt, state)).toBeNull();
    }
  });

  it('rejects invalid source metadata and incompatible roster/box layouts', () => {
    const state = fixture();
    expect(() => encodeSnapshot(state, 256, 0)).toThrow(RangeError);
    expect(() => encodeSnapshot(state, 0, NaN)).toThrow(RangeError);
    expect(() => encodeSnapshot(state, 0, 0, [])).toThrow(RangeError);
    const buffer = encodeSnapshot(state, 0, 0);
    state.boxes.pop();
    expect(() => encodeSnapshot(state, 0, 0)).toThrow(RangeError);
    expect(decodeSnapshot(buffer, state)).toBeNull();
    const invalid = fixture();
    invalid.karts[0].id = 1;
    expect(() => encodeSnapshot(invalid, 0, 0)).toThrow(RangeError);
    expect(decodeSnapshot(buffer, invalid)).toBeNull();
  });
});

describe('protocol layout fingerprint', () => {
  function fingerprint(layout: unknown): string {
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(JSON.stringify(layout))) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    return hash.toString(16).padStart(8, '0');
  }

  it('matches the actual sim descriptors to the pinned protocol version', () => {
    const pinned: Record<number, string> = { 1: '584a661e', 2: '0af985f8', 3: 'fbe993cf', 4: '2daf5fc7' };
    expect(SNAPSHOT_LAYOUT.slice(0, 2)).toEqual([KART_EFFECT_LAYOUT, ENTITY_KINDS]);
    expect(fingerprint(SNAPSHOT_LAYOUT)).toBe(LAYOUT_FINGERPRINT);
    expect(LAYOUT_FINGERPRINT).toBe(pinned[PROTOCOL_VERSION]);
    const changed = KART_EFFECT_LAYOUT.map((field, index) => index === 0 ? { ...field, scale: 10 } : field);
    expect(fingerprint([changed, ...SNAPSHOT_LAYOUT.slice(1)])).not.toBe(LAYOUT_FINGERPRINT);
    expect(fingerprint([KART_EFFECT_LAYOUT, { ...ENTITY_KINDS, bolt: 7 }, ...SNAPSHOT_LAYOUT.slice(2)])).not.toBe(LAYOUT_FINGERPRINT);
    for (const index of [2, 3, 4]) {
      const layout: unknown[] = [...SNAPSHOT_LAYOUT];
      const entries = layout[index] as readonly unknown[];
      layout[index] = [...entries].reverse();
      expect(fingerprint(layout)).not.toBe(LAYOUT_FINGERPRINT);
      layout[index] = [...entries, 'added'];
      expect(fingerprint(layout)).not.toBe(LAYOUT_FINGERPRINT);
    }
    expect(fingerprint([...SNAPSHOT_LAYOUT.slice(0, 5), {
      ...SNAPSHOT_LAYOUT[5], bombSpeedScale: 1,
    }])).not.toBe(LAYOUT_FINGERPRINT);
  });
});

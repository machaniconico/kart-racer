import { createKartEffects, ENTITY_KINDS, KART_EFFECT_LAYOUT } from '../sim/itemTypes';
import type { ItemType, ProjectileState } from '../sim/itemTypes';
import { FIXED_DT } from '../sim/race';
import type { InputFrame, KartState, Projectile, RaceState, Trap } from '../sim/types';
import { NEUTRAL_INPUT, quantizeInput } from './inputBuffer';
import { isRaceState, MAX_PLAYERS, PacketKind } from './protocol';

// All multibyte fields are little endian. The design's field lists total
// 28/58/25 bytes, giving 1,179 bytes at capacity and 554 with two entities.
export const SNAPSHOT_HEADER_BYTES = 28;
export const SNAPSHOT_KART_BYTES = 58;
export const SNAPSHOT_ENTITY_BYTES = 25;
export const SNAPSHOT_BOX_COUNT = 12;
// With 58-byte karts, a 28th entity would exceed the 1,200-byte packet budget.
export const MAX_SNAPSHOT_ENTITIES = 27;
const BOX_OFFSET = SNAPSHOT_HEADER_BYTES + MAX_PLAYERS * SNAPSHOT_KART_BYTES;
const BASE_BYTES = BOX_OFFSET + SNAPSHOT_BOX_COUNT;
// A binary scale gives <= 0.000062 rad error and accommodates the sim's
// wall correction beyond +/-pi. The design's 10000/pi misses the 1e-4 bound.
const HEADING_SCALE = 8192;
const ITEMS: readonly (ItemType | null)[] = [null, 'dash', 'trap', 'bolt', 'seeker', 'skycomet',
  'tripleDash', 'rapidDash', 'aura', 'storm', 'ink', 'decoy', 'bomb', 'autopilot', 'barrier'];
const PHASES = ['countdown', 'racing', 'finished'] as const;
const FLAGS = ['wrongWay', 'startedLap', 'lapValid', 'previousDrift', 'previousItem', 'human'] as const;
const ENTITY_FLIGHT_LAYOUT = {
  bouncesMask: 0x7f, ownerClearedMask: 0x80, bombSpeedScale: 2,
  aux: ['bolt:aux', 'seeker:launchSpeed', 'skycomet:trackDistance', 'bomb:fuse', 'trap:age', 'decoy:age'],
} as const;
const AIR_TIME_LAYOUT = { field: 'airTime', byteOffset: 57, type: 'Uint8', scale: 100 } as const;
export const SNAPSHOT_LAYOUT = [KART_EFFECT_LAYOUT, ENTITY_KINDS, ITEMS, FLAGS, PHASES, ENTITY_FLIGHT_LAYOUT,
  AIR_TIME_LAYOUT, { kartBytes: SNAPSHOT_KART_BYTES, maxEntities: MAX_SNAPSHOT_ENTITIES }] as const;
type Entity = (Projectile | Trap) & ProjectileState;

export interface Snapshot {
  raceId: number;
  hostTime: number;
  state: RaceState;
  /** Indexed by kart ID, using the same three-byte lattice as input packets. */
  lastAppliedInput: InputFrame[];
}

function uint(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

function quantize(value: number, scale: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Non-finite snapshot value');
  return Math.max(min, Math.min(max, Math.round(value * scale)));
}

function float(view: DataView, offset: number, value: number): void {
  if (!Number.isFinite(Math.fround(value))) throw new RangeError('Snapshot float overflow');
  view.setFloat32(offset, value, true);
}

function layoutMatches(state: RaceState): boolean {
  return state.karts.length === MAX_PLAYERS && state.boxes.length === SNAPSHOT_BOX_COUNT &&
    new Set(state.karts.map(kart => kart.id)).size === MAX_PLAYERS &&
    state.karts.every(kart => uint(kart.id, MAX_PLAYERS - 1));
}

function selectEntities(state: RaceState): Entity[] {
  let entities: Entity[] = [...state.projectiles, ...state.traps];
  if (entities.length > MAX_SNAPSHOT_ENTITIES) {
    const humans = state.karts.filter(kart => kart.human);
    const distance = (entity: Entity): number => humans.reduce((nearest, kart) =>
      Math.min(nearest, (entity.x - kart.x) ** 2 + (entity.z - kart.z) ** 2), Infinity);
    entities = entities.map(entity => ({ entity, distance: distance(entity) }))
      .sort((a, b) => a.distance - b.distance || a.entity.id - b.entity.id)
      .slice(0, MAX_SNAPSHOT_ENTITIES).map(entry => entry.entity);
  }
  // Selection uses proximity; wire order uses kind group and ID, so splitting
  // the decoded entities into the sim arrays cannot change the next encoding.
  return entities.sort((a, b) => Number('age' in a) - Number('age' in b) || a.id - b.id);
}

/** Encode a full eight-kart race. Static box poses/profiles come from race_start. */
export function encodeSnapshot(
  state: RaceState, raceId: number, hostTime: number,
  lastAppliedInput: readonly InputFrame[] = state.karts.map(() => NEUTRAL_INPUT),
): ArrayBuffer {
  if (!layoutMatches(state) || !uint(raceId, 255) ||
    !Number.isFinite(hostTime) || hostTime < 0 || !uint(state.nextEntityId, 0xffff) ||
    lastAppliedInput.length !== MAX_PLAYERS) throw new RangeError('Invalid snapshot');
  const inputs = lastAppliedInput.map(quantizeInput);
  const entities = selectEntities(state);
  // Validate the transmitted subset, without imposing the control channel's
  // entity-array limit on a host simulation that will be culled to capacity anyway.
  if (!isRaceState({ ...state,
    projectiles: entities.filter(entity => 'bounces' in entity),
    traps: entities.filter(entity => 'age' in entity),
  })) throw new RangeError('Invalid snapshot state');
  if (new Set(entities.map(entity => entity.id)).size !== entities.length) {
    throw new RangeError('Duplicate snapshot entity ID');
  }
  const buffer = new ArrayBuffer(BASE_BYTES + entities.length * SNAPSHOT_ENTITY_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PacketKind.SNAPSHOT);
  view.setUint8(1, raceId);
  view.setUint32(2, state.tick, true);
  view.setFloat64(6, hostTime, true);
  view.setUint32(14, state.seed, true);
  view.setUint8(18, PHASES.indexOf(state.phase));
  view.setUint16(19, quantize(state.countdown, 100, 0, 0xffff), true);
  view.setUint32(21, state.racingTicks, true);
  view.setUint16(25, state.nextEntityId, true);
  view.setUint8(27, entities.length);
  for (const kart of state.karts) {
    const offset = SNAPSHOT_HEADER_BYTES + kart.id * SNAPSHOT_KART_BYTES;
    float(view, offset, kart.x);
    float(view, offset + 4, kart.z);
    float(view, offset + 8, kart.y);
    view.setInt16(offset + 12, quantize(kart.heading, HEADING_SCALE, -32768, 32767), true);
    view.setUint16(offset + 14, quantize(kart.speed, 200, 0, 0xffff), true);
    view.setInt8(offset + 16, quantize(kart.steer, 127, -127, 127));
    float(view, offset + 17, kart.trackDistance);
    float(view, offset + 21, kart.lapProgress);
    float(view, offset + 25, kart.lapStartTime);
    float(view, offset + 29, kart.finishTime ?? -1);
    view.setInt16(offset + 33, quantize(kart.lateralOffset, 500, -32768, 32767), true);
    view.setUint8(offset + 35, kart.lap);
    view.setUint8(offset + 36, kart.nextCheckpoint);
    view.setUint16(offset + 37, quantize(kart.driftTime, 100, 0, 0xffff), true);
    if (![-1, 0, 1].includes(kart.driftDirection)) throw new RangeError('Invalid drift direction');
    view.setInt8(offset + 39, kart.driftDirection);
    view.setUint8(offset + 40, quantize(kart.boostTime, 50, 0, 255));
    view.setUint8(offset + 41, quantize(kart.spinTime, 50, 0, 255));
    view.setUint8(offset + 42, quantize(kart.hopTime, 100, 0, 255));
    view.setUint8(offset + 43, quantize(kart.hitCooldown, 100, 0, 255));
    view.setUint8(offset + AIR_TIME_LAYOUT.byteOffset, quantize(kart.airTime, AIR_TIME_LAYOUT.scale, 0, 255));
    const item = ITEMS.indexOf(kart.item);
    if (item < 0) throw new RangeError('Unknown snapshot item');
    view.setUint8(offset + 44, item);
    view.setUint8(offset + 45, FLAGS.reduce((bits, key, index) => bits | (Number(kart[key]) << index), 0));
    const input = inputs[kart.id];
    view.setInt8(offset + 46, Math.round(input.steer * 127));
    view.setUint8(offset + 47, Math.round(input.throttle * 255));
    view.setUint8(offset + 48, Number(input.brake) | (Number(input.drift) << 1) | (Number(input.useItem) << 2));
    for (const field of KART_EFFECT_LAYOUT) {
      const index = offset + 49 + field.byteOffset;
      // A positive authoritative timer proves activation, even for a manually seeded state.
      // At zero (including quantization to zero), the explicit unused bit is essential.
      const value = field.field === 'rapidUnused' && kart.effects.rapidTime > 0 ? 0 : kart.effects[field.field];
      const bits = quantize(value, field.scale, 0, field.mask);
      view.setUint8(index, view.getUint8(index) | (bits << field.shift));
    }
  }
  state.boxes.forEach((box, index) => view.setUint8(BOX_OFFSET + index, quantize(box.respawnTime, 50, 0, 255)));
  entities.forEach((entity, index) => {
    const kind = ENTITY_KINDS[entity.kind];
    if (!kind || !uint(entity.id, 0xffff)) throw new RangeError('Invalid snapshot entity');
    const offset = BASE_BYTES + index * SNAPSHOT_ENTITY_BYTES;
    view.setUint8(offset, kind);
    view.setUint16(offset + 1, entity.id, true);
    view.setUint8(offset + 3, entity.ownerId);
    float(view, offset + 4, entity.x);
    float(view, offset + 8, entity.z);
    float(view, offset + 12, entity.y);
    view.setInt16(offset + 16, quantize(entity.heading, HEADING_SCALE, -32768, 32767), true);
    // Tenths of a second cover every lifetime, including the 25-second skycomet.
    view.setUint8(offset + 18, quantize(entity.life, 10, 0, 255));
    view.setUint8(offset + 19, 'bounces' in entity ? entity.bounces |
      (entity.kind === 'bolt' && entity.ownerCleared ? ENTITY_FLIGHT_LAYOUT.ownerClearedMask : 0) : 0);
    // Bombs do not target a kart; their target byte carries launch speed (0.5 m/s).
    view.setUint8(offset + 20, entity.kind === 'bomb'
      ? quantize(entity.speed ?? 24, ENTITY_FLIGHT_LAYOUT.bombSpeedScale, 0, 255) : entity.target ?? 255);
    float(view, offset + 21, 'age' in entity ? entity.age :
      entity.aux ?? (entity.kind === 'bomb' ? entity.life : entity.kind === 'seeker' ? 48 : 0));
  });
  return buffer;
}

/** Malformed network packets are discarded; neither the packet nor template is mutated. */
export function decodeSnapshot(data: unknown, template: RaceState): Snapshot | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength < BASE_BYTES || !layoutMatches(template)) return null;
  const view = new DataView(data);
  const count = view.getUint8(27);
  const phase = PHASES[view.getUint8(18)];
  const hostTime = view.getFloat64(6, true);
  if (view.getUint8(0) !== PacketKind.SNAPSHOT || count > MAX_SNAPSHOT_ENTITIES ||
    data.byteLength !== BASE_BYTES + count * SNAPSHOT_ENTITY_BYTES || !phase ||
    !Number.isFinite(hostTime) || hostTime < 0) return null;
  const racingTicks = view.getUint32(21, true);
  const state: RaceState = {
    tick: view.getUint32(2, true), seed: view.getUint32(14, true), phase,
    countdown: view.getUint16(19, true) / 100, racingTicks, time: racingTicks * FIXED_DT,
    karts: [], boxes: [], projectiles: [], traps: [], events: [],
    nextEntityId: view.getUint16(25, true), trackId: template.trackId,
  };
  const lastAppliedInput: InputFrame[] = [];
  for (let id = 0; id < MAX_PLAYERS; id++) {
    const offset = SNAPSHOT_HEADER_BYTES + id * SNAPSHOT_KART_BYTES;
    const base = template.karts.find(kart => kart.id === id)!;
    const flags = view.getUint8(offset + 45);
    const inputFlags = view.getUint8(offset + 48);
    const steer = view.getInt8(offset + 16);
    const inputSteer = view.getInt8(offset + 46);
    const item = ITEMS[view.getUint8(offset + 44)];
    const finishTime = view.getFloat32(offset + 29, true);
    const driftDirection = view.getInt8(offset + 39);
    if ((flags & ~63) !== 0 || (inputFlags & ~7) !== 0 || steer === -128 || inputSteer === -128 ||
      item === undefined || ![-1, 0, 1].includes(driftDirection) || (finishTime < 0 && finishTime !== -1)) return null;
    const kart: KartState = {
      ...base, lapTimes: [...base.lapTimes], effects: createKartEffects(),
      x: view.getFloat32(offset, true), z: view.getFloat32(offset + 4, true), y: view.getFloat32(offset + 8, true),
      heading: view.getInt16(offset + 12, true) / HEADING_SCALE,
      speed: view.getUint16(offset + 14, true) / 200, steer: steer / 127,
      trackDistance: view.getFloat32(offset + 17, true), lapProgress: view.getFloat32(offset + 21, true),
      lapStartTime: view.getFloat32(offset + 25, true), finishTime: finishTime === -1 ? null : finishTime,
      lateralOffset: view.getInt16(offset + 33, true) / 500,
      lap: view.getUint8(offset + 35), nextCheckpoint: view.getUint8(offset + 36),
      driftTime: view.getUint16(offset + 37, true) / 100, driftDirection,
      boostTime: view.getUint8(offset + 40) / 50, spinTime: view.getUint8(offset + 41) / 50,
      hopTime: view.getUint8(offset + 42) / 100, hitCooldown: view.getUint8(offset + 43) / 100, item,
      airTime: view.getUint8(offset + AIR_TIME_LAYOUT.byteOffset) / AIR_TIME_LAYOUT.scale,
    };
    FLAGS.forEach((key, index) => { kart[key] = (flags & (1 << index)) !== 0; });
    for (const field of KART_EFFECT_LAYOUT) {
      kart.effects[field.field] = ((view.getUint8(offset + 49 + field.byteOffset) >> field.shift) & field.mask) / field.scale;
    }
    if (kart.effects.aiHoldTicks > 60 || (view.getUint8(offset + 54) & ~15) !== 0) return null;
    state.karts.push(kart);
    lastAppliedInput.push({ steer: inputSteer / 127, throttle: view.getUint8(offset + 47) / 255,
      brake: (inputFlags & 1) !== 0, drift: (inputFlags & 2) !== 0, useItem: (inputFlags & 4) !== 0 });
  }
  state.boxes = template.boxes.map((box, index) => ({ ...box, respawnTime: view.getUint8(BOX_OFFSET + index) / 50 }));
  const ids = new Set<number>();
  for (let index = 0; index < count; index++) {
    const offset = BASE_BYTES + index * SNAPSHOT_ENTITY_BYTES;
    const kind = Object.entries(ENTITY_KINDS).find(([, code]) => code === view.getUint8(offset))?.[0];
    const target = view.getUint8(offset + 20);
    const aux = view.getFloat32(offset + 21, true);
    const entity = {
      id: view.getUint16(offset + 1, true), ownerId: view.getUint8(offset + 3),
      x: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true), y: view.getFloat32(offset + 12, true),
      heading: view.getInt16(offset + 16, true) / HEADING_SCALE, life: view.getUint8(offset + 18) / 10,
    };
    if (!kind || ids.has(entity.id) || (kind !== 'bomb' && target !== 255 && target >= MAX_PLAYERS) || !Number.isFinite(aux)) return null;
    ids.add(entity.id);
    switch (kind) {
      case 'trap':
      case 'decoy':
        if (view.getUint8(offset + 19) !== 0 || target !== 255) return null;
        state.traps.push({ ...entity, kind, age: aux });
        break;
      case 'bolt':
      case 'seeker':
      case 'skycomet':
      case 'bomb': {
        const projectile: Projectile & ProjectileState = {
          ...entity, kind, bounces: view.getUint8(offset + 19) & ENTITY_FLIGHT_LAYOUT.bouncesMask, aux,
        };
        const cleared = (view.getUint8(offset + 19) & ENTITY_FLIGHT_LAYOUT.ownerClearedMask) !== 0;
        if (kind === 'bolt') projectile.ownerCleared = cleared;
        else if (cleared) return null;
        if (kind === 'bomb') projectile.speed = target / ENTITY_FLIGHT_LAYOUT.bombSpeedScale;
        else if (target !== 255) projectile.target = target;
        else if (kind === 'seeker' || kind === 'skycomet') projectile.target = null;
        state.projectiles.push(projectile);
        break;
      }
      default: return null;
    }
  }
  return isRaceState(state) ? { raceId: view.getUint8(1), hostTime, state, lastAppliedInput } : null;
}

import { FIXED_DT } from '../sim/race';
import type { KartState, Pose } from '../sim/types';

export const SURFACE_DUST_CAPACITY = 128;
export const DRIFT_SMOKE_CAPACITY = 64;
export const TIRE_MARK_CAPACITY = 240;
export const DUST_LIFETIME = 0.55;
const LIFETIME_TICKS = Math.round(DUST_LIFETIME / FIXED_DT);

export interface DustEmitter extends Pick<KartState, 'id' | 'x' | 'y' | 'z' | 'heading' | 'speed' | 'airTime' | 'driftTime'> {
  grass: boolean;
  dirt: boolean;
  pitch: number;
  roll: number;
}

export interface DustParticle {
  readonly kartId: number;
  readonly born: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
}

export interface TireMark extends Pose {
  readonly born: number;
  readonly pitch: number;
  readonly roll: number;
}

interface Pool<T> {
  readonly slots: readonly (T | null)[];
  readonly next: number;
}

export interface DustState {
  readonly tick: number;
  readonly surface: Pool<DustParticle>;
  readonly drift: Pool<DustParticle>;
  readonly marks: Pool<TireMark>;
}

export function createDustState(tick = 0): DustState {
  const pool = <T>(capacity: number): Pool<T> => ({ slots: Array<T | null>(capacity).fill(null), next: 0 });
  return { tick, surface: pool(SURFACE_DUST_CAPACITY), drift: pool(DRIFT_SMOKE_CAPACITY), marks: pool(TIRE_MARK_CAPACITY) };
}

/** Fixed material opacity: growth followed by shrinking supplies the fade. */
export function dustScale(age: number): number {
  if (age < 0 || age >= DUST_LIFETIME) return 0;
  const t = age / DUST_LIFETIME;
  return t <= 0.7 ? 0.35 + 1.05 * t / 0.7 : 1.4 * (1 - t) / 0.3;
}

/** Rear-wheel contact in the kart's YXZ road orientation (the plane itself lies in XZ). */
function rearWheel(kart: DustEmitter, side: number): Pose {
  const x = side * 1.02 * Math.cos(kart.roll);
  const y = side * 1.02 * Math.sin(kart.roll);
  const z = -0.95;
  const tiltedY = y * Math.cos(kart.pitch) - z * Math.sin(kart.pitch);
  const tiltedZ = y * Math.sin(kart.pitch) + z * Math.cos(kart.pitch);
  return {
    x: kart.x + x * Math.cos(kart.heading) + tiltedZ * Math.sin(kart.heading),
    y: kart.y + tiltedY + 0.02,
    z: kart.z - x * Math.sin(kart.heading) + tiltedZ * Math.cos(kart.heading),
    heading: kart.heading,
  };
}

/**
 * Pure, render-owned state: no random numbers, sim mutation or Three objects. Repainting a tick
 * is a no-op. Missed emission ticks are caught up in chronological order, so the ring always
 * replaces the oldest request. A long seek only needs the final ring's worth of history.
 */
export function updateDust(previous: DustState, tick: number, karts: readonly DustEmitter[], localKartId: number): DustState {
  if (tick < previous.tick) return createDustState(tick);
  if (tick === previous.tick) return previous;
  const surface = { slots: previous.surface.slots.map(p => p && tick - p.born < LIFETIME_TICKS ? p : null), next: previous.surface.next };
  const drift = { slots: previous.drift.slots.map(p => p && tick - p.born < LIFETIME_TICKS ? p : null), next: previous.drift.next };
  const marks = { slots: previous.marks.slots.slice(), next: previous.marks.next };
  const insert = <T>(pool: { slots: (T | null)[]; next: number }, entry: T) => {
    pool.slots[pool.next] = entry;
    pool.next = (pool.next + 1) % pool.slots.length;
  };
  // Even a single drifter fills all 240 marks in 480 ticks. Older missed emissions cannot survive.
  for (let born = Math.max(previous.tick + 1, tick - TIRE_MARK_CAPACITY * 2 + 1); born <= tick; born++) {
    for (const kart of karts) {
      if (kart.airTime !== 0) continue;
      const drifting = kart.driftTime > 0;
      if (tick - born < LIFETIME_TICKS && born % (kart.id === localKartId ? 3 : 6) === 0
        && (kart.grass || kart.dirt || drifting)) {
        const rear = rearWheel(kart, (born / (kart.id === localKartId ? 3 : 6)) % 2 ? -1 : 1);
        insert(kart.grass || kart.dirt ? surface : drift, {
          kartId: kart.id, born, x: rear.x, y: rear.y + 0.15, z: rear.z,
          vx: -Math.sin(kart.heading) * kart.speed * 0.15,
          vz: -Math.cos(kart.heading) * kart.speed * 0.15,
        });
      }
      if (drifting && born % 4 === 0) {
        for (const side of [-1, 1]) insert(marks, { ...rearWheel(kart, side), born, pitch: kart.pitch, roll: kart.roll });
      }
    }
  }
  return { tick, surface, drift, marks };
}

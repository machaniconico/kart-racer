import { getRank } from './laps';
import { chooseItem } from './random';
import { WALL_HALF_WIDTH, projectToTrack, sampleTrack } from './track';
import type { InputFrame, KartState, RaceState } from './types';

export { chooseItem } from './random';
export const BOX_RESPAWN_TIME = 5;

export interface KartModifiers {
  input: InputFrame;
  maxSpeedMultiplier: number;
  contactHit: boolean;
  invulnerable: boolean;
}

/** Item effects can replace controls and modify driving without changing race.ts. */
export function getKartModifiers(_state: RaceState, _kart: KartState, input: InputFrame): KartModifiers {
  return { input, maxSpeedMultiplier: 1, contactHit: false, invulnerable: false };
}

export function onKartContact(state: RaceState, first: KartState, second: KartState): void {
  const neutral: InputFrame = { steer: 0, throttle: 0, brake: false, drift: false, useItem: false };
  const firstModifiers = getKartModifiers(state, first, neutral);
  const secondModifiers = getKartModifiers(state, second, neutral);
  if (firstModifiers.contactHit) hitKart(state, second);
  if (secondModifiers.contactHit) hitKart(state, first);
}

export function giveBoost(state: RaceState, kart: KartState, duration: number): void {
  kart.boostTime = Math.max(kart.boostTime, duration);
  state.events.push({ type: 'boost', kartId: kart.id });
}

/** Called each tick; item input edges belong to the item subsystem. */
export function useItem(state: RaceState, kart: KartState, input: InputFrame): void {
  const pressed = input.useItem && !kart.previousItem;
  kart.previousItem = input.useItem;
  if (!pressed || !kart.item || kart.spinTime > 0 || kart.finishTime !== null) return;
  const item = kart.item;
  kart.item = null;
  state.events.push({ type: 'use', kartId: kart.id });
  if (item === 'dash') giveBoost(state, kart, 1.9);
  else if (item === 'trap') {
    const x = kart.x - Math.sin(kart.heading) * 2.6;
    const z = kart.z - Math.cos(kart.heading) * 2.6;
    state.traps.push({ kind: 'trap', id: state.nextEntityId++, ownerId: kart.id, x, z,
      y: projectToTrack(x, z).height, heading: kart.heading, life: 20, age: 0 });
  } else {
    state.projectiles.push({ kind: 'bolt', id: state.nextEntityId++, ownerId: kart.id,
      x: kart.x + Math.sin(kart.heading) * 2.3, y: kart.y,
      z: kart.z + Math.cos(kart.heading) * 2.3, heading: kart.heading, life: 5, bounces: 0 });
  }
}

export function hitKart(state: RaceState, kart: KartState): void {
  if (kart.spinTime > 0 || getKartModifiers(state, kart,
    { steer: 0, throttle: 0, brake: false, drift: false, useItem: false }).invulnerable) return;
  kart.spinTime = 1.05;
  kart.speed *= 0.3;
  kart.driftTime = 0;
  kart.driftDirection = 0;
  kart.boostTime = 0;
  state.events.push({ type: 'hit', kartId: kart.id });
}

export function advanceItems(state: RaceState, dt: number): void {
  for (const box of state.boxes) {
    box.respawnTime = Math.max(0, box.respawnTime - dt);
    if (box.respawnTime > 0) continue;
    for (const kart of state.karts) {
      if (kart.finishTime !== null || kart.item || kart.spinTime > 0) continue;
      if (Math.hypot(kart.x - box.x, kart.z - box.z) < 1.9) {
        kart.item = chooseItem(state, getRank(state, kart.id));
        box.respawnTime = BOX_RESPAWN_TIME;
        state.events.push({ type: 'pickup', kartId: kart.id });
        break;
      }
    }
  }
  for (const trap of state.traps) {
    trap.life -= dt;
    trap.age += dt;
    for (const kart of state.karts) {
      if (kart.spinTime > 0 || (kart.id === trap.ownerId && trap.age < 1.2)) continue;
      if (Math.hypot(kart.x - trap.x, kart.z - trap.z) < 1.55) {
        hitKart(state, kart);
        trap.life = 0;
        break;
      }
    }
  }
  state.traps = state.traps.filter((trap) => trap.life > 0);
  for (const bolt of state.projectiles) {
    bolt.life -= dt;
    const previousX = bolt.x;
    const previousZ = bolt.z;
    bolt.x += Math.sin(bolt.heading) * 53 * dt;
    bolt.z += Math.cos(bolt.heading) * 53 * dt;
    const projection = projectToTrack(bolt.x, bolt.z);
    bolt.y = projection.height;
    if (Math.abs(projection.offset) > WALL_HALF_WIDTH - 0.4) {
      const sample = sampleTrack(projection.distance);
      const vx = Math.sin(bolt.heading);
      const vz = Math.cos(bolt.heading);
      const dot = vx * sample.nx + vz * sample.nz;
      bolt.heading = Math.atan2(vx - 2 * dot * sample.nx, vz - 2 * dot * sample.nz);
      const side = Math.sign(projection.offset);
      bolt.x = sample.x + sample.nx * side * (WALL_HALF_WIDTH - 0.45);
      bolt.z = sample.z + sample.nz * side * (WALL_HALF_WIDTH - 0.45);
      bolt.bounces++;
      if (bolt.bounces >= 4) bolt.life = 0;
    }
    for (const kart of state.karts) {
      if (kart.spinTime > 0 || (kart.id === bolt.ownerId && bolt.life > 4.7)) continue;
      // Swept segment collision prevents a fast bolt tunnelling through a kart.
      const dx = bolt.x - previousX;
      const dz = bolt.z - previousZ;
      const squared = dx * dx + dz * dz;
      const t = squared > 0 ? Math.max(0, Math.min(1, ((kart.x - previousX) * dx + (kart.z - previousZ) * dz) / squared)) : 0;
      if (Math.hypot(kart.x - (previousX + t * dx), kart.z - (previousZ + t * dz)) < 1.4) {
        hitKart(state, kart);
        bolt.life = 0;
        break;
      }
    }
  }
  state.projectiles = state.projectiles.filter((bolt) => bolt.life > 0);
}


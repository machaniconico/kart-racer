import { getRank, raceProgress } from './laps';
import { getAIInput } from './ai';
import { hasOpponent } from './itemAi';
import { chooseItem } from './itemTable';
import type { ProjectileState } from './itemTypes';
import { TRACK_LENGTH, WALL_HALF_WIDTH, projectToTrack, sampleTrack, wrapDistance } from './track';
import type { InputFrame, ItemType, KartState, Projectile, RaceState } from './types';

export { chooseItem } from './itemTable';
export const BOX_RESPAWN_TIME = 5;
type ItemProjectile = Projectile & ProjectileState;
const PROJECTILE_LIFETIMES = { bolt: 5, seeker: 6, skycomet: 25, bomb: 2.5 } as const;

function canHold(item: ItemType | null): boolean {
  return item === 'trap' || item === 'bolt' || item === 'decoy' || item === 'bomb';
}

function leadingOpponent(state: RaceState, ownerId: number): KartState | undefined {
  return state.karts.filter(kart => kart.id !== ownerId && kart.finishTime === null)
    .sort((a, b) => raceProgress(b) - raceProgress(a) || a.id - b.id)[0];
}

function seekerTarget(state: RaceState, owner: KartState): KartState | undefined {
  const tangent = sampleTrack(owner.trackDistance);
  return state.karts.filter(kart => kart.id !== owner.id && kart.finishTime === null &&
    raceProgress(kart) > raceProgress(owner) &&
    (kart.x - owner.x) * tangent.tx + (kart.z - owner.z) * tangent.tz > 0 &&
    Math.hypot(kart.x - owner.x, kart.z - owner.z) <= 45)
    .sort((a, b) => Math.hypot(a.x - owner.x, a.z - owner.z) -
      Math.hypot(b.x - owner.x, b.z - owner.z) || a.id - b.id)[0];
}

export interface KartModifiers {
  input: InputFrame;
  maxSpeedMultiplier: number;
  contactHit: boolean;
  invulnerable: boolean;
}

/** Item effects can replace controls and modify driving without changing race.ts. */
export function getKartModifiers(state: RaceState, kart: KartState, input: InputFrame): KartModifiers {
  const aura = kart.effects.auraTime > 0;
  const activatingAuto = kart.item === 'autopilot' && input.useItem && !kart.previousItem &&
    kart.spinTime === 0 && kart.finishTime === null;
  const auto = kart.effects.autoTime > 0 || activatingAuto;
  if (auto) {
    input = getAIInput(state, kart.id);
    if (activatingAuto) input = { ...input, useItem: true };
  }
  if ((!kart.human || auto) && kart.item === 'bomb' && kart.effects.holding && !input.useItem) {
    input = { ...input, brake: hasOpponent(state, kart, 12, -1) };
  }
  return {
    input,
    maxSpeedMultiplier: (auto ? 1.5 : aura ? 1.3 : 1) * (kart.effects.shrinkTime > 0 ? 0.65 : 1),
    contactHit: aura || auto,
    invulnerable: aura || auto,
  };
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
  if (!kart.item || kart.spinTime > 0 || kart.finishTime !== null) {
    kart.effects.holding = 0;
    kart.effects.aiHoldTicks = 0;
    return;
  }
  let item = kart.item;
  if (canHold(item)) {
    if (pressed) kart.effects.holding = 1;
    if (input.useItem && kart.effects.holding) {
      kart.effects.aiHoldTicks = Math.min(60, kart.effects.aiHoldTicks + 1);
    }
    if (input.useItem || !kart.effects.holding) return;
    kart.effects.holding = 0;
    kart.effects.aiHoldTicks = 0;
  } else {
    kart.effects.holding = 0;
    kart.effects.aiHoldTicks = 0;
    if (!pressed) return;
  }
  if (item === 'rapidDash' && !kart.effects.rapidUnused && kart.effects.rapidTime === 0) {
    kart.item = null;
    return;
  }
  const backwards = input.brake && (item === 'bolt' || item === 'bomb');
  if (item === 'barrier') {
    // CPU firing shares the normal deployment path; orbit contact belongs to I5.
    if (kart.effects.orbitCount === 0) {
      kart.effects.orbitKind = 2;
      kart.effects.orbitCount = 3;
    }
    item = kart.effects.orbitKind === 1 ? 'trap' : 'bolt';
    if (--kart.effects.orbitCount === 0) {
      kart.item = null;
      kart.effects.orbitKind = 0;
    }
  } else if (item !== 'tripleDash' && item !== 'rapidDash') kart.item = null;
  state.events.push({ type: 'use', kartId: kart.id });
  if (item === 'dash') giveBoost(state, kart, 1.9);
  else if (item === 'tripleDash') {
    kart.effects.charges = (kart.effects.charges || 3) - 1;
    giveBoost(state, kart, 1.4);
    if (kart.effects.charges === 0) kart.item = null;
  } else if (item === 'rapidDash') {
    if (kart.effects.rapidUnused) {
      kart.effects.rapidTime = 8;
    }
    kart.effects.rapidUnused = 0;
    giveBoost(state, kart, 0.45);
  } else if (item === 'aura') {
    kart.effects.auraTime = 7;
    state.events.push({ type: 'aura_start', kartId: kart.id });
  } else if (item === 'storm') {
    for (const target of state.karts) {
      if (target.id === kart.id || target.finishTime !== null ||
        target.effects.auraTime > 0 || target.effects.autoTime > 0) continue;
      target.effects.shrinkTime = 5;
      target.item = null;
      target.effects.charges = 0;
      target.effects.rapidTime = 0;
      target.effects.rapidUnused = 0;
      target.effects.holding = 0;
      target.effects.aiHoldTicks = 0;
      target.effects.orbitKind = 0;
      target.effects.orbitCount = 0;
    }
    state.events.push({ type: 'storm', kartId: kart.id });
  } else if (item === 'ink') {
    const rank = getRank(state, kart.id);
    for (const target of state.karts) {
      if (target.finishTime === null && getRank(state, target.id) < rank) target.effects.inkTime = 4;
    }
    state.events.push({ type: 'ink', kartId: kart.id });
  } else if (item === 'autopilot') {
    kart.effects.autoTime = 4;
    state.events.push({ type: 'auto_start', kartId: kart.id });
  } else if (item === 'trap' || item === 'decoy') {
    const x = kart.x - Math.sin(kart.heading) * 2.6;
    const z = kart.z - Math.cos(kart.heading) * 2.6;
    state.traps.push({ kind: item, id: state.nextEntityId++, ownerId: kart.id, x, z,
      y: projectToTrack(x, z).height, heading: kart.heading, life: 20, age: 0 });
  } else if (item === 'bolt' || item === 'seeker' || item === 'skycomet' || item === 'bomb') {
    const direction = kart.heading + (backwards ? Math.PI : 0);
    const heading = Math.atan2(Math.sin(direction), Math.cos(direction));
    const launchOffset = item === 'bomb' && !backwards ? 4 : 2.3;
    const projectile: ItemProjectile = { kind: item, id: state.nextEntityId++, ownerId: kart.id,
      x: kart.x + Math.sin(heading) * launchOffset, y: kart.y,
      z: kart.z + Math.cos(heading) * launchOffset, heading,
      life: PROJECTILE_LIFETIMES[item], bounces: 0 };
    if (item === 'seeker') {
      projectile.target = seekerTarget(state, kart)?.id ?? null;
      projectile.aux = Math.max(48, kart.speed + 8);
    }
    if (item === 'skycomet') {
      projectile.target = leadingOpponent(state, kart.id)?.id ?? null;
      projectile.aux = kart.trackDistance;
      const sample = sampleTrack(kart.trackDistance);
      projectile.x = sample.x;
      projectile.z = sample.z;
    }
    if (item === 'bolt') projectile.ownerCleared = false;
    if (item === 'bomb') {
      projectile.aux = projectile.life;
      // Use the snapshot's 0.5 m/s lattice for identical host/guest deceleration.
      projectile.speed = Math.round((24 + (backwards ? 0 : kart.speed)) * 2) / 2;
    }
    state.projectiles.push(projectile);
  }
}

export function hitKart(state: RaceState, kart: KartState): void {
  if (kart.finishTime !== null || kart.spinTime > 0 || getKartModifiers(state, kart,
    { steer: 0, throttle: 0, brake: false, drift: false, useItem: false }).invulnerable) return;
  kart.spinTime = 1.05;
  kart.speed *= 0.3;
  kart.driftTime = 0;
  kart.driftDirection = 0;
  kart.boostTime = 0;
  kart.effects.holding = 0;
  kart.effects.aiHoldTicks = 0;
  state.events.push({ type: 'hit', kartId: kart.id });
}

/** Distance to the swept path also catches projectiles crossing a shield in one tick. */
function pathDistance(x: number, z: number, startX: number, startZ: number, endX: number, endZ: number): number {
  const dx = endX - startX;
  const dz = endZ - startZ;
  const squared = dx * dx + dz * dz;
  const t = squared > 0 ? Math.max(0, Math.min(1, ((x - startX) * dx + (z - startZ) * dz) / squared)) : 0;
  return Math.hypot(x - startX - t * dx, z - startZ - t * dz);
}

function blockProjectile(state: RaceState, projectile: ItemProjectile, previousX: number, previousZ: number): boolean {
  for (const kart of state.karts) {
    if (!kart.effects.holding || !canHold(kart.item) || kart.spinTime > 0 || kart.finishTime !== null) continue;
    const sx = Math.sin(kart.heading);
    const sz = Math.cos(kart.heading);
    // A projectile crossing the kart from the front must hit before reaching its rear shield.
    if ((previousX - kart.x) * sx + (previousZ - kart.z) * sz >= 0) continue;
    if (pathDistance(kart.x - sx * 2.2, kart.z - sz * 2.2,
      previousX, previousZ, projectile.x, projectile.z) >= 1.3) continue;
    kart.item = null;
    kart.effects.holding = 0;
    kart.effects.aiHoldTicks = 0;
    projectile.life = 0;
    state.events.push({ type: 'block', kartId: kart.id });
    return true;
  }
  return false;
}

function explode(state: RaceState, projectile: ItemProjectile): void {
  projectile.life = 0;
  state.events.push({ type: 'explode', kartId: projectile.ownerId, x: projectile.x, z: projectile.z });
  for (const kart of state.karts) {
    if (kart.finishTime === null && Math.hypot(kart.x - projectile.x, kart.z - projectile.z) <= 4.5) hitKart(state, kart);
  }
}

function advanceSkycomet(state: RaceState, projectile: ItemProjectile, dt: number): void {
  const target = leadingOpponent(state, projectile.ownerId);
  projectile.target = target?.id ?? null;
  const distance = projectile.aux ?? projectToTrack(projectile.x, projectile.z).distance;
  // Follow the shorter arc, including backwards to second place when the owner leads.
  // Re-evaluate after retargeting and across the start seam to avoid a whole-lap chase.
  const delta = target ? wrapDistance(target.trackDistance - distance + TRACK_LENGTH / 2) - TRACK_LENGTH / 2 : Infinity;
  const direction = delta < 0 ? -1 : 1;
  const ahead = Math.abs(delta);
  const arrived = !!target && ahead <= 70 * dt;
  projectile.aux = wrapDistance(distance + (arrived ? delta : direction * 70 * dt));
  const sample = sampleTrack(projectile.aux);
  const offset = target ? target.lateralOffset * Math.max(0, 1 - Math.max(0, ahead - 70 * dt) / 12) : 0;
  projectile.x = sample.x + sample.nx * offset;
  projectile.z = sample.z + sample.nz * offset;
  projectile.y = sample.y;
  projectile.heading = Math.atan2(sample.tx * direction, sample.tz * direction);
  if (arrived) {
    projectile.x = target.x;
    projectile.z = target.z;
    explode(state, projectile);
  }
}

export function advanceItems(state: RaceState, dt: number): void {
  for (const kart of state.karts) {
    for (const field of ['rapidTime', 'auraTime', 'shrinkTime', 'inkTime', 'autoTime'] as const) {
      const remaining = kart.effects[field] - dt;
      // Fixed-step subtraction can leave a tiny positive remainder at expiry.
      kart.effects[field] = remaining > 1e-9 ? remaining : 0;
    }
    if (!kart.effects.rapidUnused && kart.item === 'rapidDash' && kart.effects.rapidTime === 0) {
      kart.item = null;
    }
  }
  for (const box of state.boxes) {
    box.respawnTime = Math.max(0, box.respawnTime - dt);
    if (box.respawnTime > 0) continue;
    for (const kart of state.karts) {
      if (kart.finishTime !== null || kart.item || kart.spinTime > 0) continue;
      if (Math.hypot(kart.x - box.x, kart.z - box.z) < 1.9) {
        kart.item = chooseItem(state, getRank(state, kart.id));
        kart.effects.charges = kart.item === 'tripleDash' ? 3 : 0;
        kart.effects.rapidTime = 0;
        kart.effects.rapidUnused = kart.item === 'rapidDash' ? 1 : 0;
        kart.effects.aiHoldTicks = 0;
        kart.effects.orbitKind = kart.item === 'barrier' ? 2 : 0;
        kart.effects.orbitCount = kart.item === 'barrier' ? 3 : 0;
        box.respawnTime = BOX_RESPAWN_TIME;
        state.events.push({ type: 'pickup', kartId: kart.id });
        break;
      }
    }
  }
  for (const trap of state.traps) {
    trap.life -= dt;
    trap.age += dt;
    if (trap.life <= 1e-9) continue;
    for (const kart of state.karts) {
      if (kart.finishTime !== null || kart.spinTime > 0 || (kart.id === trap.ownerId && trap.age < 1.2)) continue;
      if (Math.hypot(kart.x - trap.x, kart.z - trap.z) < 1.55) {
        hitKart(state, kart);
        trap.life = 0;
        break;
      }
    }
  }
  state.traps = state.traps.filter((trap) => trap.life > 1e-9);
  for (const projectile of state.projectiles as ItemProjectile[]) {
    const fuse = projectile.aux ?? projectile.life;
    if (projectile.life <= 0 && projectile.kind !== 'bomb') continue;
    projectile.life = Math.max(0, projectile.life - dt);
    if (projectile.kind !== 'bomb' && projectile.life <= 1e-9) continue;
    if (projectile.kind === 'skycomet') {
      advanceSkycomet(state, projectile, dt);
      continue;
    }
    const previousX = projectile.x;
    const previousZ = projectile.z;
    const ownerWasCleared = projectile.ownerCleared;
    if (projectile.kind === 'seeker') {
      const target = state.karts.find(kart => kart.id === projectile.target && kart.finishTime === null);
      if (target) {
        const desired = Math.atan2(target.x - projectile.x, target.z - projectile.z);
        const delta = Math.atan2(Math.sin(desired - projectile.heading), Math.cos(desired - projectile.heading));
        const heading = projectile.heading + Math.max(-2.4 * dt, Math.min(2.4 * dt, delta));
        projectile.heading = Math.atan2(Math.sin(heading), Math.cos(heading));
      }
    }
    let travel = (projectile.kind === 'seeker' ? projectile.aux ?? 48 : 53) * dt;
    if (projectile.kind === 'bomb') {
      const remaining = fuse - dt;
      // Allow the float32 snapshot's rounding error at an exact tick deadline.
      projectile.aux = remaining > 1e-6 ? remaining : 0;
      // The float fuse remains authoritative when snapshot life rounds down to zero.
      projectile.life = projectile.aux;
      // Decelerate at 24 m/s², retaining the forward launcher's ground speed.
      // A stationary/backward throw still travels 12 m before stopping.
      const initialSpeed = projectile.speed ?? 24;
      const before = Math.max(0, initialSpeed - 24 * (PROJECTILE_LIFETIMES.bomb - fuse));
      const after = Math.max(0, initialSpeed - 24 * (PROJECTILE_LIFETIMES.bomb - projectile.aux));
      travel = (before * before - after * after) / 48;
      if (projectile.bounces > 0) travel = 0;
    }
    projectile.x += Math.sin(projectile.heading) * travel;
    projectile.z += Math.cos(projectile.heading) * travel;
    const projection = projectToTrack(projectile.x, projectile.z);
    projectile.y = projection.height;
    // Seeker hits are resolved before wall expiry below.
    if (projectile.kind !== 'seeker' && Math.abs(projection.offset) > WALL_HALF_WIDTH - 0.4) {
      const sample = sampleTrack(projection.distance);
      const side = Math.sign(projection.offset);
      projectile.x = sample.x + sample.nx * side * (WALL_HALF_WIDTH - 0.45);
      projectile.z = sample.z + sample.nz * side * (WALL_HALF_WIDTH - 0.45);
      projectile.bounces++;
      if (projectile.kind === 'bolt') {
        const vx = Math.sin(projectile.heading);
        const vz = Math.cos(projectile.heading);
        const dot = vx * sample.nx + vz * sample.nz;
        projectile.heading = Math.atan2(vx - 2 * dot * sample.nx, vz - 2 * dot * sample.nz);
        if (projectile.bounces >= 4) {
          projectile.life = 0;
          continue;
        }
      }
    }
    const owner = state.karts.find(kart => kart.id === projectile.ownerId);
    if (projectile.kind === 'bolt' && !projectile.ownerCleared && owner) {
      if (Math.hypot(previousX - owner.x, previousZ - owner.z) >= 3 ||
        Math.hypot(projectile.x - owner.x, projectile.z - owner.z) >= 3) projectile.ownerCleared = true;
    }
    if (blockProjectile(state, projectile, previousX, previousZ)) continue;
    if (projectile.kind === 'bomb') {
      // Match float32 fuse deadlines after a snapshot, just as for timed expiry.
      const elapsed = PROJECTILE_LIFETIMES.bomb - projectile.life + 1e-6;
      const stopped = elapsed >= (projectile.speed ?? 24) / 24;
      if (projectile.life <= 1e-9 || (elapsed >= 0.3 && state.karts.some(kart =>
        kart.finishTime === null &&
        (kart.id !== projectile.ownerId || stopped) &&
        pathDistance(kart.x, kart.z, previousX, previousZ, projectile.x, projectile.z) < 2))) {
        explode(state, projectile);
      }
      continue;
    }
    for (const kart of state.karts) {
      if (kart.finishTime !== null || kart.spinTime > 0 || (kart.id === projectile.ownerId &&
        (projectile.kind === 'seeker' || !ownerWasCleared))) continue;
      if (pathDistance(kart.x, kart.z, previousX, previousZ, projectile.x, projectile.z) < 1.4) {
        hitKart(state, kart);
        projectile.life = 0;
        break;
      }
    }
    if (projectile.kind === 'seeker' && Math.abs(projection.offset) > WALL_HALF_WIDTH - 0.4) projectile.life = 0;
  }
  state.projectiles = state.projectiles.filter((projectile) => projectile.life > 1e-9);
}

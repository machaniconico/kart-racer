import { getRank, raceProgress, updateLapTracking } from './laps';
import { chooseItem, random } from './random';
import { ROAD_HALF_WIDTH, TRACK_LENGTH, WALL_HALF_WIDTH, projectToTrack, sampleTrack } from './track';
import type { InputFrame, KartState, RaceState } from './types';

export const FIXED_DT = 1 / 60;
export const DRIFT_BLUE_TIME = 0.65;
export const DRIFT_ORANGE_TIME = 1.5;
export const NEUTRAL_INPUT: Readonly<InputFrame> = Object.freeze({ steer: 0, throttle: 0, brake: false, drift: false, useItem: false });
export const BOX_RESPAWN_TIME = 5;
export const KART_RADIUS = 0.95;
const COLORS = [0xffbf38, 0xff5f80, 0x56d9c1, 0x8c7bff, 0x4dc6ff, 0xff854f];
const NAMES = ['YOU', 'PIP', 'NOVA', 'MOSS', 'ZIPP', 'ROCO'];

export function createRace(seed: number): RaceState {
  const state: RaceState = {
    tick: 0, seed: (seed >>> 0) || 0x51c3a97d, phase: 'countdown', countdown: 3,
    racingTicks: 0, time: 0, karts: [], boxes: [], projectiles: [], traps: [], events: [], nextEntityId: 100,
  };
  for (let id = 0; id < 6; id++) {
    // Start the player at the rear so the chase camera sees the whole grid ahead.
    const gridSlot = id === 0 ? 5 : id - 1;
    const distance = TRACK_LENGTH - 8 - Math.floor(gridSlot / 2) * 4.5;
    const sample = sampleTrack(distance);
    const offset = gridSlot % 2 === 0 ? -2 : 2;
    state.karts.push({
      id, name: NAMES[id]!, color: COLORS[id]!,
      x: sample.x + sample.nx * offset, y: sample.y, z: sample.z + sample.nz * offset,
      heading: Math.atan2(sample.tx, sample.tz), speed: 0, steer: 0,
      trackDistance: distance, lateralOffset: offset, lap: 0, nextCheckpoint: 0,
      lapStartTime: 0, lapTimes: [], finishTime: null, driftTime: 0, driftDirection: 0,
      boostTime: 0, spinTime: 0, hopTime: 0, item: null, wrongWay: false,
      startedLap: false, lapProgress: 0, lapValid: true, previousDrift: false,
      previousItem: false, aiPhase: random(state) * Math.PI * 2, hitCooldown: 0,
    });
  }
  for (const fraction of [0.12, 0.36, 0.58, 0.81]) {
    const sample = sampleTrack(TRACK_LENGTH * fraction);
    for (const offset of [-4.1, 0, 4.1]) {
      state.boxes.push({ id: state.nextEntityId++, x: sample.x + sample.nx * offset, y: sample.y,
        z: sample.z + sample.nz * offset, heading: Math.atan2(sample.tx, sample.tz), respawnTime: 0 });
    }
  }
  return state;
}

function normalizeInput(input: InputFrame | undefined): InputFrame {
  return {
    steer: Number.isFinite(input?.steer) ? Math.max(-1, Math.min(1, input!.steer)) : 0,
    throttle: Number.isFinite(input?.throttle) ? Math.max(0, Math.min(1, input!.throttle)) : 0,
    brake: input?.brake === true, drift: input?.drift === true, useItem: input?.useItem === true,
  };
}

function updateProjection(kart: KartState): void {
  const projection = projectToTrack(kart.x, kart.z);
  kart.trackDistance = projection.distance;
  kart.lateralOffset = projection.offset;
  kart.y = projection.height;
}

function collideWall(state: RaceState, kart: KartState): void {
  const limit = WALL_HALF_WIDTH - KART_RADIUS;
  if (Math.abs(kart.lateralOffset) <= limit) return;
  const sample = sampleTrack(kart.trackDistance);
  const side = Math.sign(kart.lateralOffset);
  kart.x = sample.x + sample.nx * limit * side;
  kart.z = sample.z + sample.nz * limit * side;
  kart.lateralOffset = limit * side;
  const outward = (Math.sin(kart.heading) * sample.nx + Math.cos(kart.heading) * sample.nz) * side;
  if (outward > 0.05) {
    if (kart.speed > 10 && kart.hitCooldown === 0) {
      state.events.push({ type: 'hit', kartId: kart.id });
      kart.hitCooldown = 0.7;
    }
    kart.speed *= 0.72;
    // Preserve the tangential component and let the kart slide along the rail.
    const vx = Math.sin(kart.heading) - sample.nx * side * outward * 0.32;
    const vz = Math.cos(kart.heading) - sample.nz * side * outward * 0.32;
    kart.heading = Math.atan2(vx, vz);
  }
}

function giveBoost(state: RaceState, kart: KartState, duration: number): void {
  kart.boostTime = Math.max(kart.boostTime, duration);
  state.events.push({ type: 'boost', kartId: kart.id });
}

function useItem(state: RaceState, kart: KartState): void {
  if (!kart.item || kart.spinTime > 0) return;
  const item = kart.item;
  kart.item = null;
  state.events.push({ type: 'use', kartId: kart.id });
  if (item === 'dash') giveBoost(state, kart, 1.9);
  else if (item === 'trap') {
    const x = kart.x - Math.sin(kart.heading) * 2.6;
    const z = kart.z - Math.cos(kart.heading) * 2.6;
    state.traps.push({ id: state.nextEntityId++, ownerId: kart.id, x, z,
      y: projectToTrack(x, z).height, heading: kart.heading, life: 20, age: 0 });
  } else {
    state.projectiles.push({ id: state.nextEntityId++, ownerId: kart.id,
      x: kart.x + Math.sin(kart.heading) * 2.3, y: kart.y,
      z: kart.z + Math.cos(kart.heading) * 2.3, heading: kart.heading, life: 5, bounces: 0 });
  }
}

function advanceKart(state: RaceState, kart: KartState, input: InputFrame): void {
  kart.boostTime = Math.max(0, kart.boostTime - FIXED_DT);
  kart.spinTime = Math.max(0, kart.spinTime - FIXED_DT);
  kart.hopTime = Math.max(0, kart.hopTime - FIXED_DT);
  kart.hitCooldown = Math.max(0, kart.hitCooldown - FIXED_DT);
  if (kart.finishTime !== null) { kart.speed = 0; return; }
  if (input.useItem && !kart.previousItem) useItem(state, kart);
  kart.previousItem = input.useItem;
  if (input.drift && !kart.previousDrift && kart.speed > 5 && kart.spinTime === 0) kart.hopTime = 0.32;
  if (input.drift && kart.speed > 8 && kart.spinTime === 0) {
    if (kart.driftDirection === 0 && Math.abs(input.steer) > 0.12) kart.driftDirection = Math.sign(input.steer);
    if (kart.driftDirection !== 0) kart.driftTime += FIXED_DT;
  } else if (kart.driftTime > 0 || kart.driftDirection !== 0) {
    if (!input.drift && kart.spinTime === 0 && kart.driftTime >= DRIFT_BLUE_TIME) {
      giveBoost(state, kart, kart.driftTime >= DRIFT_ORANGE_TIME ? 1.25 : 0.65);
    }
    kart.driftTime = 0;
    kart.driftDirection = 0;
  }
  kart.previousDrift = input.drift;
  const onGrass = Math.abs(kart.lateralOffset) > ROAD_HALF_WIDTH;
  let maxSpeed = kart.id === 0 ? 32 : 30.2 + (kart.id % 3) * 0.35;
  if (kart.id !== 0) {
    const player = state.karts[0]!;
    const difference = raceProgress(player) - raceProgress(kart);
    maxSpeed *= 1 + Math.max(-0.02, Math.min(0.04, difference / 1800));
  }
  if (kart.boostTime > 0) maxSpeed *= 1.46;
  if (onGrass) maxSpeed = Math.min(maxSpeed, kart.boostTime > 0 ? 26 : 14);
  const spinning = kart.spinTime > 0;
  const acceleration = spinning ? 0 : input.throttle * (kart.boostTime > 0 ? 36 : onGrass ? 13 : 22);
  const deceleration = spinning ? 12 : input.brake ? 42 : input.throttle > 0 ? 2.1 : 5.5;
  kart.speed = Math.max(0, kart.speed + (acceleration - deceleration) * FIXED_DT);
  if (kart.speed > maxSpeed) kart.speed += (maxSpeed - kart.speed) * Math.min(1, FIXED_DT * (onGrass ? 6 : 4));
  kart.steer += (input.steer - kart.steer) * Math.min(1, FIXED_DT * 12);
  if (!spinning) {
    const turnRate = (kart.driftDirection !== 0 ? 1.95 : 1.72) * Math.min(1, kart.speed / 12);
    kart.heading += kart.steer * turnRate * FIXED_DT;
    kart.heading = Math.atan2(Math.sin(kart.heading), Math.cos(kart.heading));
  }
  const slip = kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
  const travelHeading = kart.heading - slip;
  kart.x += Math.sin(travelHeading) * kart.speed * FIXED_DT;
  kart.z += Math.cos(travelHeading) * kart.speed * FIXED_DT;
  updateProjection(kart);
  collideWall(state, kart);
}

function collideKarts(state: RaceState): void {
  for (let a = 0; a < state.karts.length; a++) {
    const first = state.karts[a]!;
    if (first.finishTime !== null) continue;
    for (let b = a + 1; b < state.karts.length; b++) {
      const second = state.karts[b]!;
      if (second.finishTime !== null) continue;
      const dx = second.x - first.x;
      const dz = second.z - first.z;
      const distance = Math.hypot(dx, dz);
      if (distance >= KART_RADIUS * 2) continue;
      const nx = distance > 0.0001 ? dx / distance : 1;
      const nz = distance > 0.0001 ? dz / distance : 0;
      const push = (KART_RADIUS * 2 - distance) * 0.51;
      first.x -= nx * push;
      first.z -= nz * push;
      second.x += nx * push;
      second.z += nz * push;
      // Exchange velocity along the contact normal. Projecting the impulse onto
      // each forward axis lets a rear impact push its target, while side swipes
      // mostly separate the chassis instead of draining both engines every tick.
      const firstForward = Math.sin(first.heading) * nx + Math.cos(first.heading) * nz;
      const secondForward = Math.sin(second.heading) * nx + Math.cos(second.heading) * nz;
      const closing = first.speed * firstForward - second.speed * secondForward;
      if (closing > 0) {
        const impulse = closing * 0.45;
        first.speed = Math.max(0, first.speed - impulse * firstForward);
        second.speed = Math.max(0, second.speed + impulse * secondForward);
      }
      updateProjection(first);
      updateProjection(second);
      collideWall(state, first);
      collideWall(state, second);
    }
  }
}

function hitKart(state: RaceState, kart: KartState): void {
  if (kart.spinTime > 0 || kart.finishTime !== null) return;
  kart.spinTime = 1.05;
  kart.speed *= 0.3;
  kart.driftTime = 0;
  kart.driftDirection = 0;
  kart.boostTime = 0;
  state.events.push({ type: 'hit', kartId: kart.id });
}

function advanceItems(state: RaceState): void {
  for (const box of state.boxes) {
    box.respawnTime = Math.max(0, box.respawnTime - FIXED_DT);
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
    trap.life -= FIXED_DT;
    trap.age += FIXED_DT;
    for (const kart of state.karts) {
      if (kart.finishTime !== null || kart.spinTime > 0 || (kart.id === trap.ownerId && trap.age < 1.2)) continue;
      if (Math.hypot(kart.x - trap.x, kart.z - trap.z) < 1.55) {
        hitKart(state, kart);
        trap.life = 0;
        break;
      }
    }
  }
  state.traps = state.traps.filter((trap) => trap.life > 0);
  for (const bolt of state.projectiles) {
    bolt.life -= FIXED_DT;
    const previousX = bolt.x;
    const previousZ = bolt.z;
    bolt.x += Math.sin(bolt.heading) * 53 * FIXED_DT;
    bolt.z += Math.cos(bolt.heading) * 53 * FIXED_DT;
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
      if (kart.finishTime !== null || kart.spinTime > 0 || (kart.id === bolt.ownerId && bolt.life > 4.7)) continue;
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

/** Mutates only the supplied JSON-safe state by one deterministic 60 Hz tick. */
export function stepRace(state: RaceState, inputs: readonly InputFrame[]): void {
  state.events = [];
  if (state.phase === 'finished') return;
  state.tick++;
  if (state.phase === 'countdown') {
    const previousCount = Math.ceil(state.countdown);
    state.countdown = Math.max(0, (180 - state.tick) * FIXED_DT);
    if (Math.ceil(state.countdown) !== previousCount && state.countdown > 0) {
      state.events.push({ type: 'countdown', kartId: 0, value: Math.ceil(state.countdown) });
    }
    if (state.countdown === 0) {
      state.phase = 'racing';
      state.events.push({ type: 'go', kartId: 0 });
    }
    return;
  }
  state.racingTicks++;
  state.time = state.racingTicks * FIXED_DT;
  const previous = state.karts.map((kart) => ({ x: kart.x, z: kart.z, trackDistance: kart.trackDistance }));
  for (const kart of state.karts) advanceKart(state, kart, normalizeInput(inputs[kart.id]));
  collideKarts(state);
  advanceItems(state);
  for (let i = 0; i < state.karts.length; i++) updateLapTracking(state, state.karts[i]!, previous[i]!);
  if (state.karts[0]!.finishTime !== null) state.phase = 'finished';
}

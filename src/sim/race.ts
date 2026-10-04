import { raceProgress, updateLapTracking } from './laps';
import { getAIInput } from './ai';
import { random } from './random';
import { advanceItems, getKartModifiers, giveBoost, onKartContact, useItem } from './items';
import { createKartEffects } from './itemTypes';
import { ROAD_HALF_WIDTH, TRACK_LENGTH, WALL_HALF_WIDTH, projectToTrack, sampleTrack } from './track';
import type { InputFrame, KartState, RaceOptions, RaceState } from './types';

export const FIXED_DT = 1 / 60;
export const DRIFT_BLUE_TIME = 0.65;
export const DRIFT_ORANGE_TIME = 1.5;
export const NEUTRAL_INPUT: Readonly<InputFrame> = Object.freeze({ steer: 0, throttle: 0, brake: false, drift: false, useItem: false });
export { BOX_RESPAWN_TIME } from './items';
export const KART_RADIUS = 0.95;
export const RACE_FINISH_TIMEOUT = 45;
const COLORS = [0xffbf38, 0xff5f80, 0x56d9c1, 0x8c7bff, 0x4dc6ff, 0xff854f, 0xf04a4a, 0xf4f4f0];
const NAMES = ['YOU', 'PIP', 'NOVA', 'MOSS', 'ZIPP', 'ROCO', 'LUNE', 'TAFF'];

export function getFinishTimeRemaining(state: RaceState): number | null {
  const firstFinish = Math.min(...state.karts.map((kart) => kart.finishTime ?? Infinity));
  if (!Number.isFinite(firstFinish)) return null;
  // Race times are fixed ticks; discard floating-point dust at the deadline.
  const ticksLeft = Math.round((firstFinish + RACE_FINISH_TIMEOUT - state.time) / FIXED_DT);
  return Math.max(0, ticksLeft) * FIXED_DT;
}

export function isRaceTimedOut(state: RaceState): boolean {
  // A human finish on the deadline still takes precedence over the timeout.
  return state.phase === 'finished' && !allRacersFinished(state) && getFinishTimeRemaining(state) === 0;
}

function allRacersFinished(state: RaceState): boolean {
  const humans = state.karts.filter((kart) => kart.human);
  const racers = humans.length > 0 ? humans : state.karts;
  return racers.length > 0 && racers.every((kart) => kart.finishTime !== null);
}

export function createRace(seed: number, options: RaceOptions = {}): RaceState {
  if (options.racers && options.racers.length > NAMES.length) throw new RangeError('A race supports at most eight racers');
  const state: RaceState = {
    tick: 0, seed: (seed >>> 0) || 0x51c3a97d, phase: 'countdown', countdown: 3,
    racingTicks: 0, time: 0, karts: [], boxes: [], projectiles: [], traps: [], events: [], nextEntityId: 100,
  };
  for (let id = 0; id < NAMES.length; id++) {
    // Start the player at the rear so the chase camera sees the whole grid ahead.
    const gridSlot = NAMES.length - 1 - id;
    const racer = options.racers?.[id];
    const distance = TRACK_LENGTH - 8 - Math.floor(gridSlot / 2) * 4.5;
    const sample = sampleTrack(distance);
    const offset = gridSlot % 2 === 0 ? -2 : 2;
    state.karts.push({
      id, name: racer?.name ?? NAMES[id]!, color: racer?.color ?? COLORS[id]!,
      human: racer?.human ?? (options.racers === undefined && id === 0), effects: createKartEffects(),
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
  const projection = projectToTrack(kart.x, kart.z, kart.trackDistance);
  kart.trackDistance = projection.distance;
  kart.lateralOffset = projection.offset;
  kart.y = projection.height;
}

function collideWall(state: RaceState, kart: KartState): void {
  const limit = WALL_HALF_WIDTH - KART_RADIUS;
  if (Math.abs(kart.lateralOffset) <= limit) return;
  const sample = sampleTrack(kart.trackDistance);
  const side = Math.sign(kart.lateralOffset);
  // Correct only penetration; rebuilding from the centre sample erases travel
  // along the rail at polyline vertices and can pin a sliding kart in place.
  const penetration = kart.lateralOffset - limit * side;
  kart.x -= sample.nx * penetration;
  kart.z -= sample.nz * penetration;
  kart.lateralOffset = limit * side;
  const slip = kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
  const travelHeading = kart.heading - slip;
  const outward = (Math.sin(travelHeading) * sample.nx + Math.cos(travelHeading) * sample.nz) * side;
  if (outward > 0) {
    if (kart.speed * outward > 4 && kart.hitCooldown === 0) {
      state.events.push({ type: 'hit', kartId: kart.id });
      kart.hitCooldown = 0.7;
    }
    // Remove the incoming normal velocity once. Tangential velocity survives,
    // so sustained shallow contact slides instead of multiplying drag each tick.
    const vx = Math.sin(travelHeading) - sample.nx * side * outward;
    const vz = Math.cos(travelHeading) - sample.nz * side * outward;
    const tangent = Math.hypot(vx, vz);
    kart.speed *= tangent;
    kart.heading = (tangent > 0.0001 ? Math.atan2(vx, vz) : Math.atan2(sample.tx, sample.tz)) + slip;
  }
}

function advanceKart(state: RaceState, kart: KartState, input: InputFrame): void {
  kart.boostTime = Math.max(0, kart.boostTime - FIXED_DT);
  kart.spinTime = Math.max(0, kart.spinTime - FIXED_DT);
  kart.hopTime = Math.max(0, kart.hopTime - FIXED_DT);
  kart.hitCooldown = Math.max(0, kart.hitCooldown - FIXED_DT);
  if (kart.finishTime !== null) {
    input = getAIInput(state, kart.id);
    kart.boostTime = 0;
    kart.driftTime = 0;
    kart.driftDirection = 0;
  }
  const modifiers = getKartModifiers(state, kart, input);
  input = modifiers.input;
  useItem(state, kart, input);
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
  let maxSpeed = kart.human ? 32 : 30.2 + (kart.id % 3) * 0.35;
  if (!kart.human) {
    const humanProgress = state.karts.filter((racer) => racer.human).map(raceProgress);
    if (humanProgress.length > 0) {
      const difference = Math.max(...humanProgress) - raceProgress(kart);
      maxSpeed *= 1 + Math.max(-0.02, Math.min(0.04, difference / 1800));
    }
  }
  maxSpeed *= modifiers.maxSpeedMultiplier;
  if (kart.boostTime > 0) maxSpeed *= 1.46;
  if (onGrass) maxSpeed = Math.min(maxSpeed, kart.boostTime > 0 ? 26 : 14);
  if (kart.finishTime !== null) maxSpeed = 12;
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
    for (let b = a + 1; b < state.karts.length; b++) {
      const second = state.karts[b]!;
      const dx = second.x - first.x;
      const dz = second.z - first.z;
      const distance = Math.hypot(dx, dz);
      if (distance >= KART_RADIUS * 2) continue;
      onKartContact(state, first, second);
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
  advanceItems(state, FIXED_DT);
  for (let i = 0; i < state.karts.length; i++) updateLapTracking(state, state.karts[i]!, previous[i]!);
  if (allRacersFinished(state) || getFinishTimeRemaining(state) === 0) {
    // Preserve null times: results distinguish a timeout from a human finish.
    state.phase = 'finished';
  }
}

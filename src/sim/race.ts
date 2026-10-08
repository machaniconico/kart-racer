import { raceProgress, updateLapTracking } from './laps';
import { getAIInput } from './ai';
import { random } from './random';
import { advanceItems, getKartModifiers, giveBoost, onKartContact, useItem } from './items';
import { createKartEffects } from './itemTypes';
import { corridorAt, exclusionAt, freeIntervalFor, widthAt } from './corridor';
import type { CorridorNormal } from './corridor';
import { barrierEscape, insideBarrier, projectToTrack, sampleTrack } from './track';
import { getTrack } from './tracks';
import { crossedZone, JUMP_DURATION, JUMP_HEIGHT, surfaceAt } from './surfaces';
import type { InputFrame, KartState, RaceOptions, RaceState, Track } from './types';

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
  const { trackId = 'meadow' } = options;
  const track = getTrack(trackId);
  const state: RaceState = {
    tick: 0, seed: (seed >>> 0) || 0x51c3a97d, phase: 'countdown', countdown: 3,
    racingTicks: 0, time: 0, karts: [], boxes: [], projectiles: [], traps: [], events: [], nextEntityId: 100, trackId: track.def.id,
  };
  for (let id = 0; id < NAMES.length; id++) {
    // Start the player at the rear so the chase camera sees the whole grid ahead.
    const gridSlot = NAMES.length - 1 - id;
    const racer = options.racers?.[id];
    const distance = track.length - 8 - Math.floor(gridSlot / 2) * 4.5;
    const sample = sampleTrack(track, distance);
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
      previousItem: false, aiPhase: random(state) * Math.PI * 2, hitCooldown: 0, airTime: 0,
    });
  }
  for (const pose of track.boxPoses) {
    state.boxes.push({ id: state.nextEntityId++, ...pose, respawnTime: 0 });
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

function updateProjection(track: Track, kart: KartState): void {
  const projection = projectToTrack(track, kart.x, kart.z, kart.trackDistance);
  kart.trackDistance = projection.distance;
  kart.lateralOffset = projection.offset;
  kart.y = projection.height;
  if (kart.airTime > 0) {
    const t = 1 - kart.airTime / JUMP_DURATION;
    kart.y += JUMP_HEIGHT * 4 * t * (1 - t);
  }
}

interface PreviousPose { readonly x: number; readonly z: number; readonly trackDistance: number; readonly lateralOffset: number }

/** Outer walls first, then barrier bands. `previous` is the pre-move position for swept nose contact. */
function collideCorridor(track: Track, state: RaceState, kart: KartState, time: number, previous?: PreviousPose): void {
  collideWall(track, state, kart);
  const barriers = track.def.barriers;
  if (!barriers?.length) return;
  const contacts: { normal: CorridorNormal; band: boolean }[] = [];
  for (const barrier of barriers) {
    if (!insideBarrier(track, barrier, kart.trackDistance, kart.lateralOffset, time)) continue;
    if (!previous || insideBarrier(track, barrier, previous.trackDistance, previous.lateralOffset, time)) continue;
    // A fast kart can jump the 0.95 m nose in one tick; the swept entry point keeps it a head-on hit.
    // Sweep the straight world segment from the pre-move position, reprojecting each probe.
    const fromX = previous.x;
    const fromZ = previous.z;
    const toX = kart.x;
    const toZ = kart.z;
    const probe = (t: number) => projectToTrack(track, fromX + (toX - fromX) * t, fromZ + (toZ - fromZ) * t, kart.trackDistance);
    let low = 0;
    let high = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (low + high) / 2;
      const at = probe(mid);
      if (insideBarrier(track, barrier, at.distance, at.offset, time)) high = mid;
      else low = mid;
    }
    const entry = probe(high);
    const normal = exclusionAt(track, barrier, entry.distance, time)?.normalAt(entry.offset) ??
      exclusionAt(track, barrier, kart.trackDistance, time)!.normalAt(kart.lateralOffset);
    // Arc metres differ from world metres off the centre line of a curve: reproject and keep pushing
    // along the same contact normal, so a head-on residual is not later resolved sideways.
    // The world step is found by bisection on reprojected positions, so the arc estimate cannot overshoot.
    for (let correction = 0; correction < 4; correction++) {
      const sample = sampleTrack(track, kart.trackDistance);
      const wx = sample.tx * normal.d + sample.nx * normal.offset;
      const wz = sample.tz * normal.d + sample.nz * normal.offset;
      const blocked = (step: number): boolean => {
        const at = projectToTrack(track, kart.x + wx * step, kart.z + wz * step, kart.trackDistance);
        return insideBarrier(track, barrier, at.distance, at.offset, time);
      };
      let high = barrierEscape(track, barrier, kart.trackDistance, kart.lateralOffset, normal, time);
      for (let i = 0; i < 16 && blocked(high); i++) high *= 2;
      let low = 0;
      for (let i = 0; i < 40; i++) {
        const mid = (low + high) / 2;
        if (blocked(mid)) low = mid;
        else high = mid;
      }
      kart.x += wx * (high + 1e-6);
      kart.z += wz * (high + 1e-6);
      updateProjection(track, kart);
      if (!insideBarrier(track, barrier, kart.trackDistance, kart.lateralOffset, time)) break;
    }
    // Off the centre line of a curve the arc-space normal is not the world normal, and pushing along it can
    // exceed the distance back to the entry point. Never correct further than that: it bounds the push by
    // this tick's travel (<= 1.17 m at 70 m/s) and keeps lapValid's 3.5 m step check far away.
    const entryGap = Math.hypot(toX - fromX, toZ - fromZ) * (1 - low);
    if (Math.hypot(kart.x - toX, kart.z - toZ) > entryGap ||
      insideBarrier(track, barrier, kart.trackDistance, kart.lateralOffset, time)) {
      kart.x = fromX + (toX - fromX) * low;
      kart.z = fromZ + (toZ - fromZ) * low;
      updateProjection(track, kart);
    }
    contacts.push({ normal, band: true });
  }
  // Settle laterally into the nearest interval that satisfies every band and the wall at once.
  for (let correction = 0; correction < 4; correction++) {
    const limit = widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS;
    const free = corridorAt(track, kart.trackDistance, time)
      .map(interval => ({ min: Math.max(interval.min, -limit), max: Math.min(interval.max, limit) }))
      .filter(interval => interval.max >= interval.min);
    const interval = freeIntervalFor(free, kart.lateralOffset);
    // An empty corridor is unreachable on validated tracks: validateTrackDef keeps an interval of 2R + 0.6 m
    // at every distance. The wall clamp in collideWall still holds if it ever happens.
    if (!interval || (kart.lateralOffset >= interval.min - 1e-9 && kart.lateralOffset <= interval.max + 1e-9)) break;
    const margin = Math.min(1e-6, (interval.max - interval.min) / 2);
    const target = kart.lateralOffset < interval.min ? interval.min + margin : interval.max - margin;
    const shift = target - kart.lateralOffset;
    const sample = sampleTrack(track, kart.trackDistance);
    kart.x += sample.nx * shift;
    kart.z += sample.nz * shift;
    updateProjection(track, kart);
    if (contacts.length === 0) {
      const edge = shift > 0 ? interval.min : interval.max;
      contacts.push({ normal: { d: 0, offset: Math.sign(shift) }, band: Math.abs(edge) < limit });
    }
  }
  for (const { normal, band } of contacts) {
    const sample = sampleTrack(track, kart.trackDistance);
    // Outward from the obstacle in world space; the kart moves into it when travel opposes this.
    const wx = sample.tx * normal.d + sample.nx * normal.offset;
    const wz = sample.tz * normal.d + sample.nz * normal.offset;
    const slip = kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
    const travelHeading = kart.heading - slip;
    const inward = -(Math.sin(travelHeading) * wx + Math.cos(travelHeading) * wz);
    if (inward <= 0) continue;
    // Same incidence response as the outer wall, measured against the obstacle edge.
    const vx = Math.sin(travelHeading) + wx * inward;
    const vz = Math.cos(travelHeading) + wz * inward;
    const tangent = Math.hypot(vx, vz);
    const angle = Math.atan2(inward, tangent);
    // A full-slowdown (>= 60 degree) band impact at speed reports even inside a rail hit's cooldown:
    // riding the rail into a nose would otherwise stop the kart silently. The speed floor keeps the
    // follow-up nudges after a head-on stop (heading kept, speed nearly zero) under the cooldown.
    const heavyBand = band && angle >= Math.PI / 3 && kart.speed > 6;
    if (kart.speed * inward > 4 && (kart.hitCooldown === 0 || heavyBand)) {
      // Rail hits keep their original value-less event (value 0 by convention).
      state.events.push(band ? { type: 'hit', kartId: kart.id, value: 1 } : { type: 'hit', kartId: kart.id });
      kart.hitCooldown = 0.7;
    }
    const blend = Math.max(0, Math.min(1, (angle - Math.PI / 9) / (2 * Math.PI / 9)));
    kart.speed *= 1 + (tangent - 1) * blend;
    // Beyond 80 degrees the residual tangent is a near-perpendicular sliver: turning onto it leaves the kart
    // facing sideways and the next rail contact flips it backwards. Keep the heading on near head-on band hits.
    if (tangent > 1e-12 && !(band && angle > 4 * Math.PI / 9)) kart.heading = Math.atan2(vx, vz) + slip;
  }
}

function collideWall(track: Track, state: RaceState, kart: KartState): void {
  // Without widthKeys widthAt returns the definition's value, keeping the original arithmetic.
  let limit = widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS;
  if (Math.abs(kart.lateralOffset) <= limit) return;
  let sample = sampleTrack(track, kart.trackDistance);
  const side = Math.sign(kart.lateralOffset);
  // Correct only penetration; rebuilding from the centre sample erases travel
  // along the rail at polyline vertices and can pin a sliding kart in place.
  // Reproject after each correction: curved sections can change the nearest
  // segment and leave a small residual penetration along its new normal.
  for (let correction = 0; correction < 4; correction++) {
    const penetration = kart.lateralOffset - limit * side;
    kart.x -= sample.nx * penetration;
    kart.z -= sample.nz * penetration;
    updateProjection(track, kart);
    sample = sampleTrack(track, kart.trackDistance);
    limit = widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS;
    if (Math.abs(kart.lateralOffset) <= limit + 1e-9) break;
  }
  const slip = kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
  const travelHeading = kart.heading - slip;
  const outward = (Math.sin(travelHeading) * sample.nx + Math.cos(travelHeading) * sample.nz) * side;
  if (outward > 0) {
    if (kart.speed * outward > 4 && kart.hitCooldown === 0) {
      state.events.push({ type: 'hit', kartId: kart.id });
      kart.hitCooldown = 0.7;
    }
    // Measure incidence from the rail: glancing contact keeps its speed, while
    // impacts at 60 degrees or more retain the original tangential slowdown.
    const vx = Math.sin(travelHeading) - sample.nx * side * outward;
    const vz = Math.cos(travelHeading) - sample.nz * side * outward;
    const tangent = Math.hypot(vx, vz);
    const angle = Math.atan2(outward, tangent);
    const blend = Math.max(0, Math.min(1, (angle - Math.PI / 9) / (2 * Math.PI / 9)));
    kart.speed *= 1 + (tangent - 1) * blend;
    kart.heading = (tangent > 1e-12 ? Math.atan2(vx, vz) : Math.atan2(sample.tx, sample.tz)) + slip;
  }
}

function advanceKart(track: Track, state: RaceState, kart: KartState, input: InputFrame): void {
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
  const itemPressed = input.useItem;
  const modifiers = getKartModifiers(state, kart, input);
  input = modifiers.input;
  // Autopilot replaces driving controls, but roulette edges follow the physical button.
  useItem(state, kart, kart.effects.rouletteTime > 0 ? { ...input, useItem: itemPressed } : input);
  kart.previousItem = itemPressed;
  const previous: PreviousPose = { x: kart.x, z: kart.z, trackDistance: kart.trackDistance, lateralOffset: kart.lateralOffset };
  if (kart.airTime > 0) {
    kart.airTime = Math.max(0, kart.airTime - FIXED_DT);
    kart.previousDrift = input.drift;
    kart.x += Math.sin(kart.heading) * kart.speed * FIXED_DT;
    kart.z += Math.cos(kart.heading) * kart.speed * FIXED_DT;
    updateProjection(track, kart);
    collideCorridor(track, state, kart, state.time, previous);
    return;
  }
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
  const onGrass = Math.abs(kart.lateralOffset) > widthAt(track, kart.trackDistance).roadHalfWidth;
  const surface = surfaceAt(track, kart.trackDistance, kart.lateralOffset);
  const onIce = surface === 'ice';
  const onDirt = surface === 'dirt';
  let maxSpeed = kart.human ? 32 : 30.2 + (kart.id % 3) * 0.35;
  if (!kart.human) {
    const humanProgress = state.karts.filter((racer) => racer.human).map(racer => raceProgress(track, racer));
    if (humanProgress.length > 0) {
      const difference = Math.max(...humanProgress) - raceProgress(track, kart);
      maxSpeed *= 1 + Math.max(-0.02, Math.min(0.04, difference / 1800));
    }
  }
  maxSpeed *= modifiers.maxSpeedMultiplier;
  if (kart.boostTime > 0) maxSpeed *= 1.46;
  if (onGrass) maxSpeed = Math.min(maxSpeed, kart.boostTime > 0 ? 26 : 14);
  // Dirt mirrors grass: boosting raises its cap to 26, but the cap always holds.
  else if (onDirt) maxSpeed = Math.min(maxSpeed, kart.boostTime > 0 ? 26 : 20);
  if (kart.finishTime !== null) maxSpeed = 12;
  const spinning = kart.spinTime > 0;
  // Dirt stops driving at its cap (boosted or not) so full throttle settles there instead of overshooting the drag.
  const acceleration = spinning || (onDirt && kart.speed >= maxSpeed) ? 0 :
    input.throttle * (kart.boostTime > 0 ? 36 : onGrass ? 13 : onIce ? 15 : onDirt ? 16 : 22);
  const deceleration = spinning ? 12 : input.brake ? (onIce ? 18 : 42) : input.throttle > 0 ? 2.1 : onIce ? 1.8 : 5.5;
  kart.speed = Math.max(0, kart.speed + (acceleration - deceleration) * FIXED_DT);
  if (kart.speed > maxSpeed) kart.speed += (maxSpeed - kart.speed) * Math.min(1, FIXED_DT * (onGrass ? 6 : 4));
  kart.steer += (input.steer - kart.steer) * Math.min(1, FIXED_DT * (onIce ? 6 : 12));
  if (!spinning) {
    // Reach full steering at low speed, then ease it off through fast corners.
    const turnRate = Math.max(1.72, 2.1 - Math.max(0, kart.speed - 15) * 0.025) *
      Math.min(1, kart.speed / 6) * (onIce ? 0.5 : onDirt ? 0.85 : 1);
    // Countersteering opens the arc without reversing an established drift.
    const steering = kart.driftDirection === 0 ? kart.steer : kart.driftDirection * 0.75 + kart.steer * 0.6;
    kart.heading += steering * turnRate * FIXED_DT;
    kart.heading = Math.atan2(Math.sin(kart.heading), Math.cos(kart.heading));
  }
  const slip = kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
  const travelHeading = kart.heading - slip;
  kart.x += Math.sin(travelHeading) * kart.speed * FIXED_DT;
  kart.z += Math.cos(travelHeading) * kart.speed * FIXED_DT;
  updateProjection(track, kart);
  collideCorridor(track, state, kart, state.time, previous);
}

function collideKarts(track: Track, state: RaceState): void {
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
      updateProjection(track, first);
      updateProjection(track, second);
      collideCorridor(track, state, first, state.time);
      collideCorridor(track, state, second, state.time);
    }
  }
}

/** Mutates only the supplied JSON-safe state by one deterministic 60 Hz tick. */
export function stepRace(state: RaceState, inputs: readonly InputFrame[]): void {
  const track = getTrack(state.trackId);
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
  for (const kart of state.karts) advanceKart(track, state, kart, normalizeInput(inputs[kart.id]));
  collideKarts(track, state);
  for (let i = 0; i < state.karts.length; i++) {
    const kart = state.karts[i]!;
    if (kart.airTime > 0) continue;
    const from = previous[i]!.trackDistance;
    if (crossedZone(track, 'boost', from, kart.trackDistance, kart.lateralOffset)) giveBoost(state, kart, 0.5);
    if (kart.speed >= 10 && crossedZone(track, 'jump', from, kart.trackDistance, kart.lateralOffset)) {
      kart.airTime = JUMP_DURATION;
      kart.driftTime = 0;
      kart.driftDirection = 0;
      kart.hopTime = 0;
    }
  }
  advanceItems(track, state, FIXED_DT);
  for (let i = 0; i < state.karts.length; i++) updateLapTracking(track, state, state.karts[i]!, previous[i]!);
  if (allRacersFinished(state) || getFinishTimeRemaining(state) === 0) {
    // Preserve null times: results distinguish a timeout from a human finish.
    state.phase = 'finished';
  }
}

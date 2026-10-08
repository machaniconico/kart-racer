import { sampleTrack } from './track';
import { getTrack } from './tracks';
import { crossedZone, racingLineOffset, surfaceAt } from './surfaces';
import { decideItemUse, getSteeringError } from './itemAi';
import { corridorAt, freeIntervalFor, KART_RADIUS } from './corridor';
import type { InputFrame, RaceState } from './types';

function angleDifference(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** AI only produces the same input frame consumed by human/network drivers. */
export function getAIInput(state: RaceState, kartId: number): InputFrame {
  const track = getTrack(state.trackId);
  const kart = state.karts.find((candidate) => candidate.id === kartId);
  if (!kart) return { steer: 0, throttle: 0, brake: false, drift: false, useItem: false };
  const lookAhead = 7.5 + Math.max(0, kart.speed) * 0.24;
  const target = sampleTrack(track, kart.trackDistance + lookAhead);
  const error = getSteeringError(state, kart);
  const surfaceAhead = surfaceAt(track, kart.trackDistance + lookAhead,
    racingLineOffset(track, kart.trackDistance + lookAhead));
  const icyAhead = surfaceAhead === 'ice';
  const dirtAhead = surfaceAhead === 'dirt';
  const inkNoise = kart.effects.inkTime > 0 ? 0.35 * Math.sin(state.time * 7 + kart.aiPhase) : 0;
  let steer = Math.max(-1, Math.min(1, error * (icyAhead ? 2.7 : 2.3) + inkNoise));
  if (kart.finishTime !== null) {
    return { steer, throttle: kart.speed < 10 ? 0.45 : 0,
      brake: kart.speed > 12, drift: false, useItem: false };
  }
  const later = sampleTrack(track, kart.trackDistance + lookAhead + 12);
  const curvature = Math.abs(angleDifference(Math.atan2(later.tx, later.tz) - Math.atan2(target.tx, target.tz)));
  // Stronger cornering can bring the kart back onto its slowing bomb's path.
  const approachingBomb = state.projectiles.some(projectile => projectile.kind === 'bomb' &&
    projectile.ownerId === kart.id && projectile.life < 1.5 &&
    Math.hypot(projectile.x - kart.x, projectile.z - kart.z) < 24 &&
    (projectile.x - kart.x) * Math.sin(kart.heading) + (projectile.z - kart.z) * Math.cos(kart.heading) > 0);
  let narrowAhead = false;
  if (track.def.barriers?.length) {
    const passage = freeIntervalFor(corridorAt(track, kart.trackDistance + lookAhead,
      state.time + lookAhead / Math.max(kart.speed, 8)), kart.lateralOffset);
    narrowAhead = passage !== undefined && passage.max - passage.min < 2 * (KART_RADIUS + 1) && Math.abs(error) > 0.3;
  }
  const shouldBrake = approachingBomb ||
    ((Math.abs(error) > 0.65 || curvature > 0.62 || narrowAhead || dirtAhead) && kart.speed > 21);
  const driftWindow = (state.racingTicks + kartId * 61) % 220;
  const approachingJump = crossedZone(track, 'jump', kart.trackDistance, kart.trackDistance + lookAhead + 12, kart.lateralOffset);
  const drift = kart.airTime === 0 && !approachingJump && !approachingBomb && driftWindow < 115 &&
    Math.abs(error) > 0.1 && Math.abs(error) < 0.75 && kart.speed > 16 &&
    (kart.driftDirection === 0 || error * kart.driftDirection > 0.1);
  if (drift && kart.driftDirection !== 0) {
    // The drift supplies its own yaw; steer trims that arc toward the target.
    steer = Math.max(-1, Math.min(1, (steer - kart.driftDirection * 0.75) / 0.6));
  }
  const useItem = decideItemUse(state, kart);
  return { steer, throttle: shouldBrake ? 0.35 : icyAhead ? 0.7 : 1, brake: shouldBrake, drift, useItem };
}

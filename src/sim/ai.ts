import { sampleTrack } from './track';
import { getTrack } from './tracks';
import { crossedZone, racingLineOffset, surfaceAt } from './surfaces';
import { decideItemUse, getSteeringError } from './itemAi';
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
  const inkNoise = kart.effects.inkTime > 0 ? 0.35 * Math.sin(state.time * 7 + kart.aiPhase) : 0;
  const steer = Math.max(-1, Math.min(1, error * 1.8 + inkNoise));
  if (kart.finishTime !== null) {
    return { steer, throttle: kart.speed < 10 ? 0.45 : 0,
      brake: kart.speed > 12, drift: false, useItem: false };
  }
  const later = sampleTrack(track, kart.trackDistance + lookAhead + 12);
  const curvature = Math.abs(angleDifference(Math.atan2(later.tx, later.tz) - Math.atan2(target.tx, target.tz)));
  const shouldBrake = (Math.abs(error) > 0.65 || curvature > 0.62) && kart.speed > 21;
  const driftWindow = (state.racingTicks + kartId * 61) % 220;
  const approachingJump = crossedZone(track, 'jump', kart.trackDistance, kart.trackDistance + 12, kart.lateralOffset);
  const drift = kart.airTime === 0 && !approachingJump && driftWindow < 115 && Math.abs(error) > 0.1 && Math.abs(error) < 0.75 && kart.speed > 16;
  const useItem = decideItemUse(state, kart);
  const icyAhead = surfaceAt(track, kart.trackDistance + lookAhead,
    racingLineOffset(track, kart.trackDistance + lookAhead)) === 'ice';
  return { steer, throttle: shouldBrake ? 0.35 : icyAhead ? 0.7 : 1, brake: shouldBrake, drift, useItem };
}

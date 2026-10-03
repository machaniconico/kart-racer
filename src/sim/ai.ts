import { sampleTrack } from './track';
import type { InputFrame, RaceState } from './types';

function angleDifference(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** AI only produces the same input frame consumed by human/network drivers. */
export function getAIInput(state: RaceState, kartId: number): InputFrame {
  const kart = state.karts.find((candidate) => candidate.id === kartId);
  if (!kart || kart.finishTime !== null) return { steer: 0, throttle: 0, brake: false, drift: false, useItem: false };
  const lookAhead = 7.5 + Math.max(0, kart.speed) * 0.24;
  const target = sampleTrack(kart.trackDistance + lookAhead);
  const lineOffset = Math.sin(kart.aiPhase + state.time * 0.12) * 1.25;
  const desired = Math.atan2(target.x + target.nx * lineOffset - kart.x, target.z + target.nz * lineOffset - kart.z);
  const travelHeading = kart.heading - kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
  const error = angleDifference(desired - travelHeading);
  const later = sampleTrack(kart.trackDistance + lookAhead + 12);
  const curvature = Math.abs(angleDifference(Math.atan2(later.tx, later.tz) - Math.atan2(target.tx, target.tz)));
  const shouldBrake = (Math.abs(error) > 0.65 || curvature > 0.62) && kart.speed > 21;
  const driftWindow = (state.racingTicks + kartId * 61) % 220;
  const drift = driftWindow < 115 && Math.abs(error) > 0.1 && Math.abs(error) < 0.75 && kart.speed > 16;
  let useItem = false;
  if (kart.item && (state.racingTicks + kartId * 47) % 95 === 0) {
    if (kart.item === 'dash') useItem = Math.abs(error) < 0.35;
    else if (kart.item === 'trap') useItem = true;
    else useItem = Math.abs(error) < 0.38;
  }
  return { steer: Math.max(-1, Math.min(1, error * 1.8)), throttle: shouldBrake ? 0.35 : 1, brake: shouldBrake, drift, useItem };
}

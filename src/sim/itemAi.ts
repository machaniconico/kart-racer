import { sampleTrack } from './track';
import type { KartState, RaceState } from './types';

/** Shared by steering and item decisions so both use the same driving line. */
export function getSteeringError(state: RaceState, kart: KartState): number {
  const target = sampleTrack(kart.trackDistance + 7.5 + Math.max(0, kart.speed) * 0.24);
  const lineOffset = Math.sin(kart.aiPhase + state.time * 0.12) * 1.25;
  const desired = Math.atan2(target.x + target.nx * lineOffset - kart.x, target.z + target.nz * lineOffset - kart.z);
  const travelHeading = kart.heading - kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
  return Math.atan2(Math.sin(desired - travelHeading), Math.cos(desired - travelHeading));
}

export function decideItemUse(state: RaceState, kart: KartState): boolean {
  if (!kart.item || kart.finishTime !== null || (state.racingTicks + kart.id * 47) % 95 !== 0) return false;
  if (kart.item === 'trap') return true;
  return Math.abs(getSteeringError(state, kart)) < (kart.item === 'dash' ? 0.35 : 0.38);
}

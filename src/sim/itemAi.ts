import { sampleTrack } from './track';
import { getTrack } from './tracks';
import { racingLineOffset } from './surfaces';
import { corridorAt, freeIntervalFor, KART_RADIUS, widthAt } from './corridor';
import { getRank } from './laps';
import type { ProjectileState } from './itemTypes';
import type { KartState, RaceState, Track } from './types';

const LANE_APPROACH = 35;

function wrap(length: number, distance: number): number {
  const remainder = distance % length;
  return remainder < 0 ? remainder + length : remainder;
}

/**
 * The split lane a CPU commits to from `from - 35` to `to`: rank-free and stateless, so it cannot
 * flip during the approach. `ahead` is the distance left to `from` (0 inside the split).
 */
function splitLane(track: Track, kart: KartState): { center: number; ahead: number } | undefined {
  if (!track.def.splits?.length) return undefined;
  for (const split of track.def.splits) {
    const ahead = wrap(track.length, split.from - kart.trackDistance);
    const inside = wrap(track.length, kart.trackDistance - split.from) <= wrap(track.length, split.to - split.from);
    if (!inside && ahead > LANE_APPROACH) continue;
    // One lap in three per kart, with a seed-dependent (aiPhase) offset. The story's
    // `(id + lap) % 3 === 0 || sin(aiPhase + lap) > 0.6` picks risky ~53% of the time (61% measured),
    // above the 25-45% acceptance band.
    const risky = (kart.id + kart.lap + Math.floor(kart.aiPhase * 3 / (2 * Math.PI))) % 3 === 0;
    const lane = split.lanes.find(candidate => candidate.risk === (risky ? 1 : 0)) ?? split.lanes[0]!;
    return { center: (lane.offsetMin + lane.offsetMax) / 2, ahead: inside ? 0 : ahead };
  }
  return undefined;
}

/** The lateral target of the CPU driving line at its look-ahead point. */
export function getAiLineOffset(state: RaceState, kart: KartState): number {
  const track = getTrack(state.trackId);
  const targetDistance = kart.trackDistance + 7.5 + Math.max(0, kart.speed) * 0.24;
  // Tighter tracking still needs enough lane variety to reach the outer boxes.
  let lineOffset = Math.sin(kart.aiPhase + state.time * 0.12) * 2.5;
  if (track.def.racingLine.length > 0) {
    lineOffset += racingLineOffset(track, targetDistance);
    const limit = Math.max(0, widthAt(track, targetDistance).roadHalfWidth - 1);
    lineOffset = Math.max(-limit, Math.min(limit, lineOffset));
  }
  const lane = splitLane(track, kart);
  if (lane) {
    // Ease onto the lane centre over the approach, starting from the lane's side of the road so the
    // target never crosses the island's nose line.
    const t = 1 - lane.ahead / LANE_APPROACH;
    const side = Math.sign(lane.center);
    lineOffset = Math.max(0, lineOffset * side) * side * (1 - t) + lane.center * t;
  }
  if (track.def.barriers?.length) {
    // Stay in the passage nearest the kart (or its chosen split lane), evaluated when the kart will arrive there.
    const intervals = corridorAt(track, targetDistance, state.time + (targetDistance - kart.trackDistance) / Math.max(kart.speed, 8));
    const passage = freeIntervalFor(intervals, lane ? lane.center : kart.lateralOffset);
    if (passage) {
      const margin = KART_RADIUS + 0.6;
      lineOffset = passage.max - passage.min < 2 * margin ? (passage.min + passage.max) / 2 :
        Math.max(passage.min + margin, Math.min(passage.max - margin, lineOffset));
    }
  }
  return lineOffset;
}

/** Shared by steering and item decisions so both use the same driving line. */
export function getSteeringError(state: RaceState, kart: KartState): number {
  const track = getTrack(state.trackId);
  const targetDistance = kart.trackDistance + 7.5 + Math.max(0, kart.speed) * 0.24;
  const target = sampleTrack(track, targetDistance);
  const lineOffset = getAiLineOffset(state, kart);
  const desired = Math.atan2(target.x + target.nx * lineOffset - kart.x, target.z + target.nz * lineOffset - kart.z);
  const travelHeading = kart.heading - kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
  return Math.atan2(Math.sin(desired - travelHeading), Math.cos(desired - travelHeading));
}

function inDirection(kart: KartState, x: number, z: number, range: number, direction: number): boolean {
  return Math.hypot(x - kart.x, z - kart.z) <= range &&
    ((x - kart.x) * Math.sin(kart.heading) + (z - kart.z) * Math.cos(kart.heading)) * direction > 0;
}

export function hasOpponent(state: RaceState, kart: KartState, range: number, direction: 1 | -1): boolean {
  return state.karts.some(other => other.id !== kart.id && other.finishTime === null &&
    inDirection(kart, other.x, other.z, range, direction));
}

/** Pure decisions: held ticks are advanced by useItem, never by input sampling. */
export function decideItemUse(state: RaceState, kart: KartState): boolean {
  const item = kart.item;
  if (!item || kart.effects.rouletteTime > 0 || kart.finishTime !== null ||
    kart.spinTime > 0 || kart.effects.autoTime > 0) return false;
  // A pickup while pressed needs a release before it can become a shield.
  if (kart.previousItem && !kart.effects.holding) return false;
  const deployable = item === 'trap' || item === 'bolt' || item === 'decoy' || item === 'bomb';
  if (deployable) {
    const threatened = state.projectiles.some(shot => shot.life > 0 && shot.ownerId !== kart.id &&
      ((shot.kind === 'seeker' && (shot as ProjectileState).target === kart.id) ||
        (shot.kind === 'bolt' && inDirection(kart, shot.x, shot.z, 20, -1))));
    if (threatened) return kart.effects.aiHoldTicks < 60;
    if (kart.effects.holding) return false;
  }
  // Always release between pulses, including when a new item replaces a used one.
  if (kart.previousItem) return false;
  const rank = getRank(state, kart.id);
  if (item === 'autopilot') return true;
  if (item === 'aura' || item === 'storm') return rank >= 4;
  const error = Math.abs(getSteeringError(state, kart));
  if (item === 'rapidDash' && !kart.effects.rapidUnused) {
    return kart.effects.rapidTime > 0 && state.racingTicks % 12 === 0 && error < 0.35;
  }
  if ((state.racingTicks + kart.id * 47) % 95 !== 0) return false;
  switch (item) {
    case 'dash': case 'tripleDash': case 'rapidDash': return error < 0.35;
    case 'bolt': case 'seeker': return error < 0.38 && hasOpponent(state, kart, 35, 1);
    case 'skycomet': return rank >= 3;
    case 'ink': return rank > 1;
    case 'trap': case 'decoy': return error < 0.35 || hasOpponent(state, kart, 15, -1);
    case 'bomb': return true;
    case 'barrier': return hasOpponent(state, kart, 20, 1);
  }
}

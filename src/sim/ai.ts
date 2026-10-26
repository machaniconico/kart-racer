import { sampleTrack } from './track';
import { getTrack } from './tracks';
import { crossedZone, racingLineOffset, surfaceAt } from './surfaces';
import { decideItemUse, getAiLineOffset, getSteeringError } from './itemAi';
import { corridorAt, freeIntervalFor, KART_RADIUS, widthAt } from './corridor';
import type { CpuLevel, InputFrame, KartState, RaceState, SurfaceZone, Track } from './types';

function angleDifference(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Remove the CPU weave early enough to settle on the launch line, including across the lap seam. */
function jumpAlignmentError(state: RaceState, track: Track, kart: KartState, lookAhead: number): number | undefined {
  const hasFall = track.def.surfaces.some(zone => zone.kind === 'fall');
  let nearest = Infinity;
  let jump: SurfaceZone | undefined;
  for (const zone of track.def.surfaces) {
    if (zone.kind !== 'jump' || (zone.duration === undefined && !hasFall)) continue;
    const ahead = ((zone.from - kart.trackDistance) % track.length + track.length) % track.length;
    if (ahead < nearest) { nearest = ahead; jump = zone; }
  }
  if (!jump || nearest > Math.max(60, Math.max(0, kart.speed) * 2)) return undefined;
  const distance = kart.trackDistance + Math.min(lookAhead, nearest);
  const target = sampleTrack(track, distance);
  const lineOffset = getAiLineOffset(state, kart, { weave: false, distance });
  const { roadHalfWidth } = widthAt(track, jump.from);
  const offset = Math.max(jump.offsetMin ?? -roadHalfWidth, Math.min(jump.offsetMax ?? roadHalfWidth, lineOffset));
  const desired = Math.atan2(target.x + target.nx * offset - kart.x, target.z + target.nz * offset - kart.z);
  const travelHeading = kart.heading - kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
  return angleDifference(desired - travelHeading);
}

function mix32(value: number): number {
  let h = value >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const START_IDLE_THROTTLE = 0.3;

// Start-dash tier shares (big 1.0 s, small 0.5 s; the rest get none) per CPU level.
const START_TIERS: Record<CpuLevel, readonly [big: number, small: number]> = {
  easy: [0.25, 0.45], normal: [0.5, 0.4], hard: [0.75, 0.25],
};

/**
 * Throttle ticks this CPU holds before GO (tick 180), from hash(seed, kartId) only so the shared PRNG
 * is untouched. Karts in one race are spread by a golden-ratio stride so each grid gets a mix of tiers.
 * The sim judges the held ticks with the same rule as for humans (race.ts startDashBoost).
 */
export function aiStartHeldTicks(state: RaceState, kartId: number): number {
  const u = (mix32(state.seed ^ 0x9e3779b9) / 0x100000000 + kartId * 0.6180339887498949) % 1;
  const pick = mix32(state.seed + Math.imul(kartId + 1, 0x27d4eb2f));
  const [big, small] = START_TIERS[state.cpuLevel];
  const within = pick >>> 1;
  if (u < big) return 12 + within % 25;
  if (u < big + small) return pick % 2 === 0 ? 6 + within % 6 : 37 + within % 12;
  return 0;
}

/** AI only produces the same input frame consumed by human/network drivers. */
export function getAIInput(state: RaceState, kartId: number): InputFrame {
  const track = getTrack(state.trackId);
  const kart = state.karts.find((candidate) => candidate.id === kartId);
  if (!kart) return { steer: 0, throttle: 0, brake: false, drift: false, useItem: false };
  const lookAhead = 7.5 + Math.max(0, kart.speed) * 0.24;
  const target = sampleTrack(track, kart.trackDistance + lookAhead);
  const alignmentError = track.def.physics !== undefined && kart.finishTime === null && kart.airTime === 0
    ? jumpAlignmentError(state, track, kart, lookAhead) : undefined;
  const error = alignmentError ?? getSteeringError(state, kart);
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
  // Braking within 20 m of a pit would drop the kart into it instead of carrying it over the jump.
  const shouldBrake = (approachingBomb ||
    ((Math.abs(error) > 0.65 || curvature > 0.62 || narrowAhead || dirtAhead) && kart.speed > 21)) &&
    !crossedZone(track, 'pit', kart.trackDistance, kart.trackDistance + 20, kart.lateralOffset);
  const driftWindow = (state.racingTicks + kartId * 61) % 220;
  const approachingJump = crossedZone(track, 'jump', kart.trackDistance, kart.trackDistance + lookAhead + 12, kart.lateralOffset);
  const drift = alignmentError === undefined && kart.airTime === 0 && !approachingJump && !approachingBomb && driftWindow < (state.cpuLevel === 'easy' ? 70 : state.cpuLevel === 'hard' ? 150 : 115) &&
    Math.abs(error) > 0.1 && Math.abs(error) < 0.75 && kart.speed > 16 &&
    (kart.driftDirection === 0 || error * kart.driftDirection > 0.1);
  if (drift && kart.driftDirection !== 0) {
    // The drift supplies its own yaw; steer trims that arc toward the target.
    steer = Math.max(-1, Math.min(1, (steer - kart.driftDirection * 0.75) / 0.6));
  }
  const useItem = decideItemUse(state, kart);
  if (state.phase === 'countdown') {
    // Only throttle matters before GO. This input drives the step to tick state.tick + 1, so the
    // CPU holds from tick 180 - held through 179 (race.ts counts ticks 120..179). Until then it revs
    // below the 0.5 hold threshold rather than sending a neutral (all-zero) frame.
    const held = aiStartHeldTicks(state, kartId);
    return { steer, throttle: held > 0 && state.tick + 1 >= 180 - held ? 1 : START_IDLE_THROTTLE, brake: shouldBrake, drift, useItem };
  }
  return { steer, throttle: shouldBrake ? 0.35 : icyAhead ? 0.7 : 1, brake: shouldBrake, drift, useItem };
}

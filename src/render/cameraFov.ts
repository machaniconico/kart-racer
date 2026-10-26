import type { KartState } from '../sim';

export const BASE_FOV = 58;
export const BOOST_FOV_KICK = 7;
export const MAX_FOV = 66;
const RISE_SECONDS = 0.15;
const FALL_SECONDS = 0.4;

export interface BoostFovInput {
  boostTime: number;
  phase: 'countdown' | 'racing' | 'finished';
  reducedMotion: boolean;
}

const outCubic = (t: number): number => 1 - (1 - t) ** 3;
const inverseOutCubic = (u: number): number => 1 - (1 - u) ** (1 / 3);
const inOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const inverseInOutQuad = (u: number): number => (u < 0.5 ? Math.sqrt(u / 2) : 1 - Math.sqrt((1 - u) / 2));

/**
 * Next camera FOV (degrees). Stateless apart from `prev`: the easing progress is recovered from it, so a boost
 * rises over 0.15 s (easeOutCubic) and falls over 0.40 s (easeInOutQuad). Only a racing phase kicks the FOV.
 */
export function boostFov(prev: number, input: BoostFovInput, dt: number): number {
  if (input.reducedMotion || input.phase !== 'racing' || !Number.isFinite(prev)) return BASE_FOV;
  // No speed-only term: residual speed after a boost must not hold the FOV above base (AC: <= 58.2 deg 0.40 s after boost end).
  const goal = input.boostTime > 0 ? 1 : 0;
  const u = Math.min(1, Math.max(0, (prev - BASE_FOV) / BOOST_FOV_KICK));
  let next = u;
  if (goal > u) next = Math.min(goal, outCubic(Math.min(1, inverseOutCubic(u) + dt / RISE_SECONDS)));
  else if (goal < u) next = Math.max(goal, 1 - inOutQuad(Math.min(1, inverseInOutQuad(1 - u) + dt / FALL_SECONDS)));
  return Math.min(MAX_FOV, BASE_FOV + next * BOOST_FOV_KICK);
}

/** Karts as the flame/aura visuals should see them: boost, autopilot and aura timers only count while racing. */
export function racingEffectsKart(kart: KartState, phase: BoostFovInput['phase']): KartState {
  if (phase === 'racing') return kart;
  return { ...kart, boostTime: 0, effects: { ...kart.effects, autoTime: 0, auraTime: 0 } };
}

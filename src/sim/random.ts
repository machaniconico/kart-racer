import type { ItemType } from './types';

/** The mutable PRNG word lives in RaceState, so a JSON save resumes exactly. */
export function random(state: { seed: number }): number {
  let value = state.seed | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.seed = value >>> 0;
  return state.seed / 0x100000000;
}

export function chooseItem(state: { seed: number }, rank: number): ItemType {
  const roll = random(state);
  const dashChance = 0.17 + Math.max(0, Math.min(5, rank - 1)) * 0.095;
  if (roll < dashChance) return 'dash';
  return roll < dashChance + (1 - dashChance) * 0.52 ? 'trap' : 'bolt';
}

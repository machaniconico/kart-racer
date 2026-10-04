import { random } from './random';
import type { ItemType } from './itemTypes';

const ITEMS = ['dash', 'trap', 'bolt', 'seeker', 'skycomet', 'tripleDash',
  'rapidDash', 'aura', 'storm', 'ink', 'decoy', 'bomb', 'autopilot', 'barrier'] as const satisfies readonly ItemType[];

// Section 7.3 specifies weights, not percentages: some rows total more than 100.
const WEIGHTS = [
  [8, 30, 12, 4, 0, 0, 0, 0, 0, 6, 20, 10, 0, 10],
  [12, 20, 16, 12, 0, 0, 0, 0, 0, 8, 12, 12, 0, 8],
  [14, 10, 16, 16, 0, 8, 0, 0, 0, 10, 6, 12, 0, 8],
  [12, 0, 12, 16, 8, 14, 0, 4, 2, 10, 2, 10, 0, 10],
  [8, 0, 8, 14, 12, 18, 2, 8, 6, 8, 0, 6, 0, 10],
  [4, 0, 4, 10, 14, 18, 8, 12, 12, 4, 0, 4, 4, 6],
  [2, 0, 2, 6, 12, 16, 14, 16, 16, 2, 0, 2, 12, 0],
  [2, 0, 0, 4, 10, 12, 18, 18, 16, 0, 0, 0, 20, 0],
] as const;

/** One PRNG draw per pickup; the seed alone also supports deterministic tools. */
export function chooseItem(state: { seed: number; karts?: readonly unknown[] }, rank: number): ItemType {
  const maxRank = Math.max(1, Math.min(WEIGHTS.length, state.karts?.length ?? WEIGHTS.length));
  const clampedRank = Math.max(1, Math.min(maxRank, Math.trunc(rank) || 1));
  const weights = WEIGHTS[clampedRank - 1]!;
  let roll = random(state) * weights.reduce((sum: number, weight) => sum + weight, 0);
  for (let index = 0; index < weights.length; index++) {
    roll -= weights[index]!;
    if (roll < 0) return ITEMS[index]!;
  }
  // Floating-point rounding at the upper bound must not select a zero-weight item.
  let last = weights.length - 1;
  while (weights[last] === 0) last--;
  return ITEMS[last]!;
}

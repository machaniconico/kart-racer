import { random } from './random';
import type { ItemType } from './itemTypes';

const ITEMS = ['dash', 'trap', 'bolt', 'seeker', 'skycomet', 'tripleDash',
  'rapidDash', 'aura', 'storm', 'ink', 'decoy', 'bomb', 'autopilot', 'barrier'] as const satisfies readonly ItemType[];

// Section 7.3 specifies weights, not percentages: some rows total more than 100.
// M12-23 (C3), tuned against the thresholds in itemBalance.test.ts:
// rank 1 draws only trap/decoy/barrier/dash plus a little bomb, keeping its dash family under
// 1/2.5 of rank 8's; rank 2 seeker 12 -> 4; skycomet moves up to ranks 3-4 so the leader is still
// hit; ranks 7-8 never draw ink and rank 8 leans on tripleDash/rapidDash.
const WEIGHTS = [
  [16, 8, 0, 0, 0, 0, 0, 0, 0, 0, 8, 2, 0, 36],
  [20, 6, 14, 4, 0, 0, 0, 0, 0, 6, 6, 6, 0, 14],
  [14, 4, 18, 8, 10, 8, 0, 0, 0, 10, 4, 12, 0, 8],
  [12, 0, 12, 12, 16, 14, 0, 4, 2, 10, 2, 10, 0, 10],
  [8, 0, 8, 12, 16, 18, 2, 8, 6, 8, 0, 6, 0, 10],
  [4, 0, 4, 10, 14, 18, 8, 12, 12, 4, 0, 4, 4, 6],
  [2, 0, 2, 6, 12, 16, 14, 16, 16, 0, 0, 2, 12, 0],
  [8, 0, 0, 0, 6, 26, 28, 14, 8, 0, 0, 0, 10, 0],
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

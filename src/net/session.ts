import type { CpuLevel } from '../sim/types';

export type NetPhase = 'idle' | 'connecting' | 'lobby' | 'countdown' | 'racing' | 'results' | 'closed';

export interface RosterPlayer {
  slot: number;
  name: string;
  color: number;
  kind: 'host' | 'guest' | 'cpu';
  connected: boolean;
}

/** Read-only lobby data shared by sessions and the UI. */
export interface RosterView {
  readonly roomCode: string;
  readonly localSlot: number;
  readonly players: readonly Readonly<RosterPlayer>[];
}

/** Host-selected online race options (protocol v20); guests apply the host's values. */
export interface RaceSettings {
  cpuLevel: CpuLevel;
  /** true: CPUs fill the grid to eight karts; false: humans only. */
  cpuFill: boolean;
  items: boolean;
}

export const DEFAULT_RACE_SETTINGS: Readonly<RaceSettings> = { cpuLevel: 'normal', cpuFill: true, items: true };

/** Roster slot of each kart, indexed by kart ID. With CPU fill every slot races (kart ID = slot);
 * without it only the humans race, compacted in ascending slot order to kart IDs 0..n-1. Host and guest
 * derive it from the same race_start roster, so every player <-> kart mapping goes through it. */
export function raceKartSlots(players: readonly Readonly<RosterPlayer>[], cpuFill: boolean): number[] {
  const slots = players.filter(player => cpuFill || player.kind !== 'cpu').map(player => player.slot);
  return slots.sort((a, b) => a - b);
}

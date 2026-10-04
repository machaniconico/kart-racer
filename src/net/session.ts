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

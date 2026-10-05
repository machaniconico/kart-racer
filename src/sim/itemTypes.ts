export type ItemType = 'dash' | 'trap' | 'bolt' | 'seeker' | 'skycomet' |
  'tripleDash' | 'rapidDash' | 'aura' | 'storm' | 'ink' | 'decoy' | 'bomb' |
  'autopilot' | 'barrier';

/** Numeric fields keep saves and the snapshot layout JSON-safe.
 * charges counts remaining tripleDash uses; rapidTime starts on its first press.
 */
export interface KartEffects {
  /** Seconds until the already-selected pickup can be used. */
  rouletteTime: number;
  rapidTime: number;
  /** Distinguishes a fresh rapid dash from an active timer quantized to zero. */
  rapidUnused: number;
  auraTime: number;
  shrinkTime: number;
  inkTime: number;
  autoTime: number;
  charges: number;
  holding: number;
  /** Consecutive held input ticks, saturated at the CPU defense limit. */
  aiHoldTicks: number;
  /** 0=none, 1=rear traps, 2=forward bolts. */
  orbitKind: number;
  /** Remaining orbiters (0..3); their positions derive solely from race time. */
  orbitCount: number;
}

export function createKartEffects(): KartEffects {
  return { rouletteTime: 0, rapidTime: 0, rapidUnused: 1, auraTime: 0, shrinkTime: 0, inkTime: 0, autoTime: 0,
    charges: 0, holding: 0, aiHoldTicks: 0, orbitKind: 0, orbitCount: 0 };
}

/** Eight bytes. Encode round(value * scale), mask, then shift into byteOffset.
 * Orbit state uses two bytes: kind shares byte 5 with tripleDash charges,
 * count shares byte 7 with the roulette timer (0..1.55 seconds).
 * Packing charges preserves the 1,200B snapshot budget.
 * Changes to this layout or entity IDs require a network protocol version bump.
 */
export const KART_EFFECT_LAYOUT = [
  { field: 'rapidTime', byteOffset: 0, scale: 20, mask: 255, shift: 0 },
  { field: 'auraTime', byteOffset: 1, scale: 20, mask: 255, shift: 0 },
  { field: 'shrinkTime', byteOffset: 2, scale: 20, mask: 255, shift: 0 },
  { field: 'inkTime', byteOffset: 3, scale: 20, mask: 255, shift: 0 },
  { field: 'autoTime', byteOffset: 4, scale: 20, mask: 255, shift: 0 },
  { field: 'charges', byteOffset: 5, scale: 1, mask: 3, shift: 0 },
  { field: 'holding', byteOffset: 6, scale: 1, mask: 1, shift: 0 },
  { field: 'rapidUnused', byteOffset: 6, scale: 1, mask: 1, shift: 1 },
  { field: 'aiHoldTicks', byteOffset: 6, scale: 1, mask: 63, shift: 2 },
  { field: 'orbitKind', byteOffset: 5, scale: 1, mask: 3, shift: 2 },
  { field: 'orbitCount', byteOffset: 7, scale: 1, mask: 3, shift: 0 },
  { field: 'rouletteTime', byteOffset: 7, scale: 20, mask: 31, shift: 2 },
] as const satisfies readonly { field: keyof KartEffects; byteOffset: number; scale: number; mask: number; shift: number }[];

export const ENTITY_KINDS = { bolt: 1, trap: 2, seeker: 3, skycomet: 4, bomb: 5, decoy: 6 } as const;
export type ProjectileKind = 'bolt' | 'seeker' | 'skycomet' | 'bomb';
export type TrapKind = 'trap' | 'decoy';

/** Kind-specific flight state; snapshotCodec packs it into the 25-byte entity record. */
export interface ProjectileState {
  target?: number | null;
  /** Skycomet track distance, bomb fuse, or seeker launch speed. */
  aux?: number;
  /** Bomb launch speed in m/s, quantized to the snapshot's 0.5 m/s units. */
  speed?: number;
  /** Latched once a bolt has left its owner's launch safety radius; unused by bombs. */
  ownerCleared?: boolean;
}

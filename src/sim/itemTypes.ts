export type ItemType = 'dash' | 'trap' | 'bolt';

/** Numeric fields keep saves and the snapshot layout JSON-safe. */
export interface KartEffects {
  rapidTime: number;
  auraTime: number;
  shrinkTime: number;
  inkTime: number;
  autoTime: number;
  charges: number;
  holding: number;
  orbitKind: number;
  orbitCount: number;
}

export function createKartEffects(): KartEffects {
  return { rapidTime: 0, auraTime: 0, shrinkTime: 0, inkTime: 0, autoTime: 0,
    charges: 0, holding: 0, orbitKind: 0, orbitCount: 0 };
}

/** Eight bytes. Encode round(value * scale), mask, then shift into byteOffset.
 * orbitKind (0=none, 1=trap, 2=bolt) and orbitCount (0..3) share the last byte.
 * Changes to this layout or entity IDs require a network protocol version bump.
 */
export const KART_EFFECT_LAYOUT = [
  { field: 'rapidTime', byteOffset: 0, scale: 20, mask: 255, shift: 0 },
  { field: 'auraTime', byteOffset: 1, scale: 20, mask: 255, shift: 0 },
  { field: 'shrinkTime', byteOffset: 2, scale: 20, mask: 255, shift: 0 },
  { field: 'inkTime', byteOffset: 3, scale: 20, mask: 255, shift: 0 },
  { field: 'autoTime', byteOffset: 4, scale: 20, mask: 255, shift: 0 },
  { field: 'charges', byteOffset: 5, scale: 1, mask: 255, shift: 0 },
  { field: 'holding', byteOffset: 6, scale: 1, mask: 1, shift: 0 },
  { field: 'orbitKind', byteOffset: 7, scale: 1, mask: 3, shift: 0 },
  { field: 'orbitCount', byteOffset: 7, scale: 1, mask: 3, shift: 2 },
] as const satisfies readonly { field: keyof KartEffects; byteOffset: number; scale: number; mask: number; shift: number }[];

export const ENTITY_KINDS = { bolt: 1, trap: 2 } as const;
export type ProjectileKind = 'bolt';
export type TrapKind = 'trap';

import { ROOM_PREFIX } from './protocol';

export const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;
const validCode = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && validCode.test(value);
}

export function normalize(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[23456789abcdefghjkmnpqrstuvwxyz]{4}$/i.test(trimmed)) return null;
  const code = trimmed.toUpperCase();
  return isRoomCode(code) ? code : null;
}

/** Rejection sampling avoids bias for the alphabet's non-power-of-two length. */
export function generateRoomCode(): string {
  const bytes = new Uint8Array(8);
  const limit = 256 - (256 % ROOM_ALPHABET.length);
  let code = '';
  while (code.length < ROOM_CODE_LENGTH) {
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
      if (code.length === ROOM_CODE_LENGTH) break;
    }
  }
  return code;
}

export function toPeerId(value: string): string {
  const code = normalize(value);
  if (code === null) throw new TypeError('Invalid room code');
  return ROOM_PREFIX + code;
}

export function fromPeerId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(ROOM_PREFIX)) return null;
  const code = value.slice(ROOM_PREFIX.length);
  return isRoomCode(code) ? code : null;
}

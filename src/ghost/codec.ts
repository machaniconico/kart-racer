import type { InputFrame } from '../sim/types';

export function quantizeInput(frame: InputFrame): InputFrame {
  return {
    // Integer bytes have only one zero, so canonicalize Math.round's negative zero.
    steer: Math.round(frame.steer * 127) / 127 || 0,
    throttle: Math.round(frame.throttle * 255) / 255 || 0,
    brake: frame.brake, drift: frame.drift, useItem: frame.useItem,
  };
}

/** Each run is [steer int8, throttle uint8, flags uint8, unsigned LEB128 length]. */
export function encodeFrames(frames: InputFrame[]): string {
  const bytes: number[] = [];
  let steer = 0, throttle = 0, flags = 0, run = 0;
  const flush = () => {
    if (run === 0) return;
    bytes.push(steer & 255, throttle, flags);
    let remaining = run;
    do {
      const byte = remaining % 128;
      remaining = Math.floor(remaining / 128);
      bytes.push(byte | (remaining > 0 ? 128 : 0));
    } while (remaining > 0);
  };
  for (const frame of frames) {
    const nextSteer = Math.round(frame.steer * 127);
    const nextThrottle = Math.round(frame.throttle * 255);
    if (!Number.isInteger(nextSteer) || nextSteer < -127 || nextSteer > 127 ||
      !Number.isInteger(nextThrottle) || nextThrottle < 0 || nextThrottle > 255) {
      throw new RangeError('Ghost input is outside its byte range');
    }
    const nextFlags = Number(frame.brake) | (Number(frame.drift) << 1) | (Number(frame.useItem) << 2);
    if (run > 0 && steer === nextSteer && throttle === nextThrottle && flags === nextFlags) {
      run++;
    } else {
      flush();
      steer = nextSteer; throttle = nextThrottle; flags = nextFlags; run = 1;
    }
  }
  flush();
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Reject malformed runs and tick counts before expanding their payload. */
export function decodeFrames(text: string, ticks: number): InputFrame[] {
  if (!Number.isSafeInteger(ticks) || ticks < 0) throw new RangeError('Invalid ghost tick count');
  const binary = atob(text);
  const frames: InputFrame[] = [];
  let offset = 0;
  while (offset < binary.length) {
    if (offset + 4 > binary.length) throw new Error('Truncated ghost run');
    const steerByte = binary.charCodeAt(offset++);
    const throttle = binary.charCodeAt(offset++);
    const flags = binary.charCodeAt(offset++);
    if (steerByte === 128 || flags > 7) throw new Error('Invalid ghost input tuple');
    let run = 0, multiplier = 1, byte: number;
    do {
      if (offset >= binary.length || multiplier > 2 ** 28) throw new Error('Invalid ghost run length');
      byte = binary.charCodeAt(offset++);
      run += (byte & 127) * multiplier;
      multiplier *= 128;
    } while (byte & 128);
    if (run === 0 || run > ticks - frames.length) throw new Error('Ghost run exceeds tick count');
    const frame: InputFrame = {
      steer: (steerByte > 127 ? steerByte - 256 : steerByte) / 127,
      throttle: throttle / 255,
      brake: (flags & 1) !== 0, drift: (flags & 2) !== 0, useItem: (flags & 4) !== 0,
    };
    for (let i = 0; i < run; i++) frames.push({ ...frame });
  }
  if (frames.length !== ticks) throw new Error('Ghost tick count does not match frames');
  return frames;
}

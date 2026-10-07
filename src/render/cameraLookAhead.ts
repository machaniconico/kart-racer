export const LOOK_AHEAD_DISTANCE = 22;
const LOOK_AHEAD_GAIN = 6; // metres of lateral shift per radian of upcoming turn
export const LOOK_AHEAD_MAX = 3.5;

/** Signed angle (radians) turning from tangent (ax, az) to tangent (bx, bz); positive = toward the +lateral side (cos h, -sin h). */
export function trackTurn(ax: number, az: number, bx: number, bz: number): number {
  return Math.atan2(az * bx - ax * bz, ax * bx + az * bz);
}

/**
 * Lateral look-at offset (metres, +lateral = (cos h, -sin h)) toward the inside of an upcoming curve.
 * `alignment` is dot(kart forward, track tangent): the curve ahead only means "inside" when driving
 * along the track, so the offset fades out when sideways and is zero when facing backwards.
 */
export function lookAheadOffset(turn: number, reducedMotion: boolean, alignment = 1): number {
  if (reducedMotion || !Number.isFinite(turn) || !Number.isFinite(alignment) || alignment <= 0.3) return 0;
  const fade = Math.min(1, (alignment - 0.3) / 0.4);
  return Math.max(-LOOK_AHEAD_MAX, Math.min(LOOK_AHEAD_MAX, turn * LOOK_AHEAD_GAIN)) * fade;
}

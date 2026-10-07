import { sampleTrack } from '../sim/track';
import { getTrack } from '../sim/tracks';
import type { InputFrame, KartState, RaceState } from '../sim/types';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const angle = (value: number): number => Math.atan2(Math.sin(value), Math.cos(value));

/** Local human input only: the corrected frame is shared by prediction and networking. */
export function applySteerAssist(state: RaceState, kart: KartState, frame: InputFrame, strength: number): InputFrame {
  if (!kart.human || kart.wrongWay || kart.speed < 0 || kart.spinTime > 0 || kart.airTime > 0 ||
    kart.hopTime > 0 || (frame.drift && kart.driftDirection === 0) ||
    !Number.isFinite(strength) || strength <= 0) return frame;

  const track = getTrack(state.trackId);
  const tangent = sampleTrack(track, kart.trackDistance);
  const headingError = angle(Math.atan2(tangent.tx, tangent.tz) - kart.heading);
  if (Math.abs(headingError) >= Math.PI / 2) return frame;

  // Follow the upcoming tangent; lateral position only matters near the road edge.
  const lookAhead = 10 + Math.max(0, kart.speed) * 0.3;
  const ahead = sampleTrack(track, kart.trackDistance + lookAhead);
  const wallDistance = track.def.roadHalfWidth - Math.abs(kart.lateralOffset);
  const wallWeight = clamp(2 - wallDistance, 0, 3);
  const targetHeading = Math.atan2(ahead.tx, ahead.tz) - Math.atan2(kart.lateralOffset * wallWeight, lookAhead);
  const correction = clamp(angle(targetHeading - kart.heading) * 1.6, -0.35, 0.35);
  const input = Math.abs(frame.steer);
  // Ease into the extra reduction so crossing 0.8 never causes a steering jump.
  const strongInput = 1 - 0.5 * clamp((input - 0.6) / 0.2, 0, 1);
  const intent = (1 - 0.65 * clamp(input, 0, 1)) * strongInput;
  const drift = kart.driftDirection !== 0 ? 0.35 : 1;
  let assistance = correction * clamp(strength, 0, 1) * intent * drift;
  // Preserve deliberate steering direction, allowing full help around neutral; the cap fades in
  // over |input| 0..0.05 so a thumb drifting off-centre never switches the wall push off abruptly.
  if (assistance * frame.steer < 0) {
    const cap = input + Math.abs(assistance) * Math.max(0, 1 - input / 0.05);
    assistance = Math.sign(assistance) * Math.min(Math.abs(assistance), cap);
  }
  return { ...frame, steer: clamp(frame.steer + assistance, -1, 1) };
}

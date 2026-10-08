import { projectToTrack, sampleTrack } from '../sim/track';
import { getTrack } from '../sim/tracks';
import { corridorAt, KART_RADIUS, widthAt, type Interval } from '../sim/corridor';
import type { InputFrame, KartState, RaceState } from '../sim/types';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const angle = (value: number): number => Math.atan2(Math.sin(value), Math.cos(value));

const PATH_MARGIN = 0.3;
// Lateral acceleration per metre squared the assist can add, as AUTHORITY / speed (|steer| <= 0.35).
const AUTHORITY = 0.4;
const PURSUIT_GAIN = 2;
const PATH_FAMILY = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1, -1];
// The assist turns gently, so it must see a band well before the plain look-ahead.
const HORIZON = 3;
// Tangent following reaches further than the conservative path model's AUTHORITY assumes.
const HOLD_REACH = 3;

/** Clearance of `y` from band edges in a row (walls only stop the kart): negative inside a band. */
function bandClearance(row: readonly Interval[], y: number): number {
  let best = -Infinity;
  for (const { min, max } of row) best = Math.max(best, Math.min(y - min, max - y));
  return best;
}

/**
 * The assist's neutral target.
 * - Without a band from the kart to three look-aheads: the road centre, with edge distance
 *   roadHalfWidth - |offset|, exactly as before bands existed.
 * - Near bands, paths in (arc metres, lateral metres): the kart's own line (straight in the world,
 *   so a curve carries it outward; walls make it slide) plus a constant added lateral acceleration
 *   c * AUTHORITY / speed for each c in PATH_FAMILY. Clear means PATH_MARGIN off every band and
 *   off the wall limit (or the kart's current margin, if smaller). In order (numbered below): the
 *   own line if clear (no correction); when it only meets a wall and the kart is still off the
 *   wall, holding the offset along the track if clear and within HOLD_REACH times the assist's
 *   authority (the original tangent following); the band-clear path with the least |c|; with no
 *   band-clear path the assist does not intervene (`aim` null: the frame passes through).
 *   `center` is the lateral offset aimed at and `edgeDistance` the chosen path's band clearance.
 */
export function assistPassage(state: RaceState, kart: KartState, steer: number, lookAhead: number):
  { center: number; edgeDistance: number; banded: boolean; aim?: { x: number; z: number } | null } {
  const track = getTrack(state.trackId);
  const offset = kart.lateralOffset;
  const horizon = Math.ceil(HORIZON * lookAhead);
  const bandRow = (distance: number, ahead: number) => {
    const wall = widthAt(track, distance).wallHalfWidth;
    const intervals = corridorAt(track, distance, state.time + ahead / Math.max(kart.speed, 8));
    return { wall, intervals, row: intervals.map(({ min, max }) => ({ min: min === -wall ? -Infinity : min, max: max === wall ? Infinity : max })) };
  };
  let banded = false;
  for (let step = 0; step <= horizon && !banded; step++) {
    const { wall, intervals } = bandRow(kart.trackDistance + step, step);
    banded = intervals.length !== 1 || intervals[0]!.min !== -wall || intervals[0]!.max !== wall;
  }
  if (!banded) {
    const road = widthAt(track, kart.trackDistance + lookAhead).roadHalfWidth;
    return { center: 0, edgeDistance: Math.min(offset + road, road - offset), banded: false };
  }

  const required = Math.min(PATH_MARGIN, Math.max(bandClearance(bandRow(kart.trackDistance, 0).row, offset), 0));
  const wallNow = widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS - Math.abs(offset);
  const wallRequired = Math.min(PATH_MARGIN, Math.max(wallNow, 0));

  // The kart's own line: straight ahead in the world, projected onto the track metre by metre.
  const dx = Math.sin(kart.heading);
  const dz = Math.cos(kart.heading);
  const own: { y: number; x: number; z: number; nx: number; nz: number; row: Interval[]; limit: number }[] = [];
  let previous = kart.trackDistance;
  for (let step = 1; step <= horizon; step++) {
    const projection = projectToTrack(track, kart.x + dx * step, kart.z + dz * step, previous);
    previous = projection.distance;
    const point = sampleTrack(track, projection.distance);
    const { wall, row } = bandRow(projection.distance, step);
    own.push({ y: projection.offset, x: point.x, z: point.z, nx: point.nx, nz: point.nz, row, limit: wall - KART_RADIUS });
  }
  const acceleration = AUTHORITY / Math.max(kart.speed, 8);
  /** The own line's drift plus a constant added lateral acceleration, sliding on walls. */
  const trace = (c: number) => {
    const ys: number[] = [];
    let wallLeast = Infinity;
    let y = offset;
    let previousOwn = offset;
    let extra = 0;
    for (const { y: ownY, limit } of own) {
      const drift = ownY - previousOwn;
      previousOwn = ownY;
      extra += c;
      y += drift + extra;
      wallLeast = Math.min(wallLeast, limit - Math.abs(y));
      if (Math.abs(y) > limit) {
        y = Math.sign(y) * limit;
        // Sliding on the wall turns the kart along it: no further motion into the wall.
        extra = Math.sign(y) * Math.min(Math.sign(y) * extra, -Math.sign(y) * drift);
      }
      ys.push(y);
    }
    return { ys, wallLeast };
  };
  const paths = PATH_FAMILY.map(scale => {
    const c = scale * acceleration;
    const { ys, wallLeast } = trace(c);
    let least = Infinity;
    ys.forEach((y, index) => { least = Math.min(least, bandClearance(own[index]!.row, y)); });
    return { scale, c, ys, least, wallLeast };
  });
  const index = Math.max(0, Math.min(own.length, Math.round(lookAhead)) - 1);
  const at = own[index]!;
  const ownLine = paths[0]!;
  // 1. The own line clear of bands and walls needs no correction: aim straight ahead.
  if (ownLine.least >= required && ownLine.wallLeast >= wallRequired) {
    return { center: at.y, edgeDistance: ownLine.least, banded: true,
      aim: { x: kart.x + dx * lookAhead, z: kart.z + dz * lookAhead } };
  }
  // 2. An own line clear of bands that only meets a wall, while the kart is still off the wall:
  //    hold the current offset along the track if that is clear of bands and walls, i.e. the
  //    original tangent following (no aim; centre = offset, so no lateral pull). A kart already on
  //    the wall keeps sliding along it rather than being turned toward a band.
  let holdBand = Infinity;
  let holdWall = Infinity;
  for (let step = 1; step <= horizon; step++) {
    const { wall, row } = bandRow(kart.trackDistance + step, step);
    holdBand = Math.min(holdBand, bandClearance(row, offset));
    holdWall = Math.min(holdWall, wall - KART_RADIUS - Math.abs(offset));
  }
  // Holding must be within the assist's authority: the lateral acceleration it takes off the own line.
  const holdable = 2 * Math.abs(offset - at.y) / (lookAhead * lookAhead) <= HOLD_REACH * acceleration;
  if (ownLine.least >= required && wallNow >= PATH_MARGIN && holdable && holdBand >= required && holdWall >= wallRequired) {
    return { center: offset, edgeDistance: Infinity, banded: true };
  }
  // 3. Otherwise the band-safe path with the least |c| (steering side first). Walls are left to the
  //    sim here: preferring wall-clear paths while dodging a band made the fuzz worse than OFF.
  const passable = paths.filter(({ least }) => least >= required);
  // No band-safe path: the assist does not intervene at all, so it can never make things worse.
  if (!passable.length) return { center: at.y, edgeDistance: ownLine.least, banded: true, aim: null };
  const chosen = passable.find(({ scale }) => steer !== 0 && scale * steer > 0) ?? passable[0]!;
  if (chosen.scale === 0) {
    return { center: at.y, edgeDistance: chosen.least, banded: true,
      aim: { x: kart.x + dx * lookAhead, z: kart.z + dz * lookAhead } };
  }
  const ys = chosen.ys[index]!;
  const deviation = ys - ownLine.ys[index]!;
  // A path sliding on the wall there is where the kart's heading carries it anyway: aim along the
  // heading, moved by the doubled deviation from the sliding own line (no pull off the wall).
  if (Math.abs(ys) >= at.limit && ys * at.y > 0 && Math.abs(at.y) > Math.abs(ys)) {
    const shift = PURSUIT_GAIN * deviation;
    return { center: at.y + shift, edgeDistance: chosen.least, banded: true,
      aim: { x: kart.x + dx * lookAhead + at.nx * shift, z: kart.z + dz * lookAhead + at.nz * shift } };
  }
  // Otherwise aim at the chosen path's own point, its deviation from the sliding own line doubled:
  // pursuing the bare point under-steers the path.
  const center = ys + (PURSUIT_GAIN - 1) * deviation;
  return { center, edgeDistance: chosen.least, banded: true,
    aim: { x: at.x + at.nx * center, z: at.z + at.nz * center } };
}

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
  const { center, edgeDistance, aim } = assistPassage(state, kart, frame.steer, lookAhead);
  if (aim === null) return frame;
  const targetHeading = aim ? Math.atan2(aim.x - kart.x, aim.z - kart.z) :
    Math.atan2(ahead.tx, ahead.tz) - Math.atan2((kart.lateralOffset - center) * clamp(2 - edgeDistance, 0, 3), lookAhead);
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

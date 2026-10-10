import { projectToTrack, sampleTrack } from '../sim/track';
import { getTrack } from '../sim/tracks';
import { corridorAt, KART_RADIUS, widthAt, type Interval } from '../sim/corridor';
import type { InputFrame, KartState, RaceState, SplitSection, Track } from '../sim/types';

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
 * - Islands (split sections): the same rules, first with each split's lanes at full width from
 *   its first metre, so the kart is in a lane before the nose widens; without input the lane on
 *   the side where the own line meets the island comes first. When no path reaches a lane in
 *   time, the bands alone decide, as above.
 */
export function assistPassage(state: RaceState, kart: KartState, steer: number, lookAhead: number, throttle = 0): Passage {
  const track = getTrack(state.trackId);
  const offset = kart.lateralOffset;
  const horizon = Math.ceil(HORIZON * lookAhead);
  const timeAt = (ahead: number) => state.time + ahead / Math.max(kart.speed, 8);
  // Corridor rows along the track from the kart (step metres ahead), computed once on demand.
  const along: Row[] = [];
  const alongRow = (step: number): Row => {
    const distance = kart.trackDistance + step;
    return along[step] ??= { distance, wall: widthAt(track, distance).wallHalfWidth, intervals: corridorAt(track, distance, timeAt(step)) };
  };
  let banded = false;
  for (let step = 0; step <= horizon && !banded; step++) {
    const { wall, intervals } = alongRow(step);
    banded = intervals.length !== 1 || intervals[0]!.min !== -wall || intervals[0]!.max !== wall;
  }
  if (!banded) {
    const road = widthAt(track, kart.trackDistance + lookAhead).roadHalfWidth;
    return { center: 0, edgeDistance: Math.min(offset + road, road - offset), banded: false };
  }

  // The kart's own line: straight ahead in the world, projected onto the track metre by metre.
  const dx = Math.sin(kart.heading);
  const dz = Math.cos(kart.heading);
  // Splits the kart is in or reaches within the horizon.
  const splits = (track.def.splits ?? []).filter(({ from, to }) =>
    wrapLap(kart.trackDistance - from, track.length) <= wrapLap(to - from, track.length) ||
    wrapLap(from - kart.trackDistance, track.length) <= horizon);
  // Near an island the own line also turns with the steering input (the sim's turn rate), so a
  // player already steering into a lane is not turned back toward the nose.
  // The turn rate and the full-throttle speed (22 - 2.1 m/s², easing toward the 32 m/s cap at
  // rate 4) follow stepRace on plain road.
  const curving = splits.length > 0 && steer !== 0;
  const curvatureAt = (speed: number) => steer * Math.max(1.72, 2.1 - Math.max(0, speed - 15) * 0.025) *
    Math.min(1, speed / 6) / Math.max(speed, 1);
  const own: OwnPoint[] = [];
  let previous = kart.trackDistance;
  let wx = kart.x;
  let wz = kart.z;
  let heading = kart.heading;
  let speed = Math.max(kart.speed, 1);
  for (let step = 1; step <= horizon; step++) {
    if (curving) {
      const curvature = curvatureAt(speed);
      wx += Math.sin(heading + curvature / 2);
      wz += Math.cos(heading + curvature / 2);
      heading += curvature;
      speed = Math.max(1, speed + (22 * throttle - (throttle > 0 ? 2.1 : 5.5) - 4 * Math.max(0, speed - 32)) / speed);
    } else {
      wx = kart.x + dx * step;
      wz = kart.z + dz * step;
    }
    const projection = projectToTrack(track, wx, wz, previous);
    previous = projection.distance;
    const point = sampleTrack(track, projection.distance);
    const wall = widthAt(track, projection.distance).wallHalfWidth;
    own.push({ y: projection.offset, x: point.x, z: point.z, nx: point.nx, nz: point.nz, limit: wall - KART_RADIUS,
      distance: projection.distance, wall, intervals: corridorAt(track, projection.distance, timeAt(step)), wx, wz });
  }
  // The input already turns the kart along a curved own line: a path point is aimed at relative
  // to that line, not to the heading.
  const at = own[Math.max(0, Math.min(own.length, Math.round(lookAhead)) - 1)]!;
  const turn = curving ? Math.atan2(at.wx - kart.x, at.wz - kart.z) - kart.heading : 0;
  const plan = { track, kart, steer, lookAhead, horizon, alongRow, own, dx, dz, turn };
  if (!splits.length) return choosePassage(plan, [], false);
  const inLanes = choosePassage(plan, splits, true);
  return inLanes.aim !== null ? inLanes : choosePassage(plan, [], true);
}

type Passage = { center: number; edgeDistance: number; banded: boolean; aim?: { x: number; z: number } | null };
interface Row { readonly distance: number; readonly wall: number; readonly intervals: Interval[] }
interface OwnPoint extends Row {
  readonly y: number; readonly x: number; readonly z: number; readonly nx: number; readonly nz: number; readonly limit: number;
  readonly wx: number; readonly wz: number;
}

const wrapLap = (value: number, length: number): number => ((value % length) + length) % length;

/** A corridor row as band edges (walls only stop the kart), clipped to the lanes of a split covering it. */
function bandEdges(track: Track, { distance, wall, intervals }: Row, splits: readonly SplitSection[]): Interval[] {
  let free = intervals;
  const split = splits.find(({ from, to }) => wrapLap(distance - from, track.length) <= wrapLap(to - from, track.length));
  if (split) {
    free = [];
    for (const { min, max } of intervals) {
      for (const lane of split.lanes) {
        const low = Math.max(min, lane.offsetMin);
        const high = Math.min(max, lane.offsetMax);
        if (low < high) free.push({ min: low, max: high });
      }
    }
  }
  return free.map(({ min, max }) => ({ min: min === -wall ? -Infinity : min, max: max === wall ? Infinity : max }));
}

function choosePassage(plan: { track: Track; kart: KartState; steer: number; lookAhead: number; horizon: number;
  alongRow: (step: number) => Row; own: OwnPoint[]; dx: number; dz: number; turn: number }, splits: readonly SplitSection[],
  island: boolean): Passage {
  const { track, kart, steer, lookAhead, horizon, alongRow, own, dx, dz, turn } = plan;
  const offset = kart.lateralOffset;
  const required = Math.min(PATH_MARGIN, Math.max(bandClearance(bandEdges(track, alongRow(0), splits), offset), 0));
  const wallNow = widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS - Math.abs(offset);
  const wallRequired = Math.min(PATH_MARGIN, Math.max(wallNow, 0));
  const ownRows = own.map(point => bandEdges(track, point, splits));

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
    ys.forEach((y, index) => { least = Math.min(least, bandClearance(ownRows[index]!, y)); });
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
  // Holding must be within the assist's authority: the lateral acceleration it takes off the own line.
  const holdable = 2 * Math.abs(offset - at.y) / (lookAhead * lookAhead) <= HOLD_REACH * acceleration;
  if (ownLine.least >= required && wallNow >= PATH_MARGIN && holdable) {
    let holdBand = Infinity;
    let holdWall = Infinity;
    for (let step = 1; step <= horizon; step++) {
      const row = alongRow(step);
      holdBand = Math.min(holdBand, bandClearance(bandEdges(track, row, splits), offset));
      holdWall = Math.min(holdWall, row.wall - KART_RADIUS - Math.abs(offset));
    }
    if (holdBand >= required && holdWall >= wallRequired) return { center: offset, edgeDistance: Infinity, banded: true };
  }
  // 3. Otherwise the band-safe path with the least |c| (steering side first). Walls are left to the
  //    sim here: preferring wall-clear paths while dodging a band made the fuzz worse than OFF.
  const passable = paths.filter(({ least }) => least >= required);
  // No band-safe path: the assist does not intervene at all, so it can never make things worse.
  if (!passable.length) return { center: at.y, edgeDistance: ownLine.least, banded: true, aim: null };
  // Without input at a split, the lane on the side where the own line meets the island comes first.
  let side = steer;
  if (steer === 0 && island) {
    const blocked = ownRows.findIndex((row, step) => bandClearance(row, ownLine.ys[step]!) < required);
    side = blocked < 0 ? 0 : Math.sign(ownLine.ys[blocked]!) || Math.sign(offset);
  }
  const chosen = passable.find(({ scale }) => side !== 0 && scale * side > 0) ?? passable[0]!;
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
  const aim = { x: at.x + at.nx * center, z: at.z + at.nz * center };
  if (turn) {
    // Rotate the aim back by `turn` about the kart (heading angles run from +z toward +x).
    const ax = aim.x - kart.x;
    const az = aim.z - kart.z;
    aim.x = kart.x + ax * Math.cos(turn) - az * Math.sin(turn);
    aim.z = kart.z + ax * Math.sin(turn) + az * Math.cos(turn);
  }
  return { center, edgeDistance: chosen.least, banded: true, aim };
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
  const { center, edgeDistance, aim } = assistPassage(state, kart, frame.steer, lookAhead, frame.throttle);
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

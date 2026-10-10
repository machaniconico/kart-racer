import { KART_RADIUS } from '../corridor';
import type { Barrier, SplitSection, WidthKey } from '../types';

interface IslandSplitOptions {
  readonly from: number;
  readonly to: number;
  readonly islandHalf: number;
  readonly laneWidth: number;
  readonly taper: number;
  readonly scenery: 'rock' | 'building';
  readonly risky: 'inner' | 'outer';
  /** Signed bend in the track's heading convention; positive bends have positive inner offsets. */
  readonly bend: -1 | 1;
}

/**
 * A JSON-only fragment to spread into a TrackDef. from/to include the expanded
 * noses; the 35 m lane-selection approach ends just before from. laneWidth is
 * the free width beside the full island body; the tapered ends leave more room.
 */
export function islandSplit(options: IslandSplitOptions): {
  widthKeys: WidthKey[]; barriers: Barrier[]; splits: SplitSection[];
} {
  const { from, to, islandHalf, laneWidth, scenery, risky, bend } = options;
  for (const value of [from, to, islandHalf, laneWidth, options.taper]) {
    if (!Number.isFinite(value)) throw new RangeError('islandSplit dimensions must be finite');
  }
  if (from < 20 || islandHalf <= 0 || laneWidth < 2 * KART_RADIUS + 1.6) {
    throw new RangeError('islandSplit needs room for its entry ramp, a positive island, and lanes at least 3.5 m wide');
  }
  const taper = Math.max(8, 2 * islandHalf, options.taper);
  if (to - from < 2 * (KART_RADIUS + taper)) {
    throw new RangeError('islandSplit must fit both noses and tapers');
  }
  const innerEdge = islandHalf + KART_RADIUS;
  const wide = innerEdge + laneWidth;
  // A 20 m ramp can change half-width by at most 7 m. Wider islands simply
  // require a wider approach; no track-specific defaults enter this fragment.
  const approach = Math.max(3.6, wide - 7);
  const widthKey = (distance: number, half: number): WidthKey =>
    ({ distance, roadHalfWidth: half, wallHalfWidth: half });
  const riskySide = risky === 'inner' ? bend : -bend;
  return {
    widthKeys: [widthKey(from - 20, approach), widthKey(from, wide),
      widthKey(to, wide), widthKey(to + 20, approach)],
    barriers: [{ from: from + KART_RADIUS, to: to - KART_RADIUS,
      center: 0, halfWidth: islandHalf, taper, scenery }],
    splits: [{ from, to, lanes: [
      { offsetMin: -wide, offsetMax: -innerEdge, risk: riskySide === -1 ? 1 : 0 },
      { offsetMin: innerEdge, offsetMax: wide, risk: riskySide === 1 ? 1 : 0 },
    ] }],
  };
}

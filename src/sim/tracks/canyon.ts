import type { TrackDef } from '../types';
import { islandSplit } from './features';

// Clear the 0.69 item row by about 9 m (8 m required) and finish before the grid's 100 m buffer.
// The helper reserves the kart radius outside the island and normalizes its taper.
const island = islandSplit({ from: 468, to: 543, islandHalf: 6, laneWidth: 9,
  taper: 10, scenery: 'rock', risky: 'inner', bend: 1 });
const split = island.splits[0]!;
const inner = split.lanes.find(lane => lane.risk === 1)!;
const outer = split.lanes.find(lane => lane.risk === 0)!;
const innerOffsets = { offsetMin: inner.offsetMin, offsetMax: inner.offsetMax };
const safeOffset = (outer.offsetMin + outer.offsetMax) / 2;

export const canyon: TrackDef = {
  id: 'canyon',
  name: 'SUNSCAR CANYON',
  // Two long canyon shelves joined by broad mesa bends. The middle of each
  // shelf stays collinear through takeoff and the full 0.8-second flight.
  controlPoints: [
    [65, 6, 65], [65, 3, 21.667], [65, 0, -21.667], [65, 1, -65],
    [45.962, 4, -110.962], [0, 8, -130], [-45.962, 12, -110.962],
    [-65, 12, -65], [-65, 9, -21.667], [-65, 6, 21.667], [-65, 3, 65],
    [-45.962, 1, 110.962], [0, 1, 130], [45.962, 4, 110.962],
  ],
  scale: 1,
  samplesPerSegment: 32,
  roadHalfWidth: 7.2,
  wallHalfWidth: 10.5,
  layoutVersion: 3,
  // A narrow section midway through the right-hand bend, with 20 m entry and exit ramps.
  // Leave room after the first pillar to recover before the entry ramp.
  widthKeys: [
    { distance: 190, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
    { distance: 210, roadHalfWidth: 4.0, wallHalfWidth: 7.3 },
    { distance: 250, roadHalfWidth: 4.0, wallHalfWidth: 7.3 },
    { distance: 270, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
    { distance: split.from - 40, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
    // Keep the 10.5 m walls on the island's approach and exit ramps: the helper's ramp keys set the
    // wall to the road edge, which would pinch the wall in from 10.5 m to 8.95 m before the nose.
    ...island.widthKeys.map(key => ({ ...key, wallHalfWidth: Math.max(10.5, key.roadHalfWidth) })),
    { distance: split.to + 40, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
  ],
  // Centre pillars beyond the opening 100 m, clear of item rows, jump landings and gates.
  barriers: [
    { from: 136, to: 152, center: 0, halfWidth: 1.2, taper: 4, scenery: 'pillar' },
    { from: 361, to: 377, center: 0, halfWidth: 1.2, taper: 4, scenery: 'pillar' },
    ...island.barriers,
  ],
  splits: island.splits,
  checkpointCount: 12,
  boxRows: [0.19, 0.4, 0.69, 0.9],
  boxLanes: [-4.1, 0, 4.1],
  // Hold the left line through the first landing and pillar; move left early for pillar two.
  racingLine: [
    { distance: 0, offset: 0 }, { distance: 20, offset: -4.5 },
    { distance: 158, offset: -4.5 }, { distance: 178, offset: 0 },
    { distance: 320, offset: 0 }, { distance: 340, offset: -4.5 },
    { distance: 421, offset: -4.5 }, { distance: split.from - 35, offset: 0 },
    { distance: split.from, offset: safeOffset }, { distance: split.to, offset: safeOffset },
    { distance: split.to + 20, offset: 0 },
  ],
  surfaces: [
    { kind: 'jump', from: 60, to: 64 },
    { kind: 'jump', from: 393, to: 397 },
    // Dirt runs up to takeoff, so an unboosted kart leaves the ramp near its 20 m/s cap
    // (about 21.7 m/s) and a boost on the dirt lifts it to the boosted cap of about 26 m/s.
    // The jump sits late on the bend: the straight flight ends on the island's tail taper
    // instead of drifting into the island body.
    { kind: 'dirt', from: split.from + 32, to: split.from + 50, ...innerOffsets },
    { kind: 'boost', from: split.from + 42, to: split.from + 46, ...innerOffsets },
    { kind: 'jump', from: split.from + 50, to: split.from + 54, ...innerOffsets },
    // 20.8 m from takeoff / 0.8 s = 26 m/s on the centre line. The inner lane stretches the
    // centre-line arc about 1.14x, so an unboosted kart lands about 19.8 m past takeoff (in the
    // pit) and a boosted one about 23.7 m (clear).
    { kind: 'pit', from: split.from + 56, to: split.from + 70.8,
      offsetMin: inner.offsetMin + 0.05, offsetMax: inner.offsetMax },
  ],
  themeId: 'canyon',
};

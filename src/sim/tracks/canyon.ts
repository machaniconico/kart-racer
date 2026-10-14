import type { TrackDef } from '../types';
import { islandSplit } from './features';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

// The upper mesa bend carries the risky inside lane; neither taper crosses the grid.
const island = islandSplit({ from: 816, to: 911, islandHalf: 6.9, laneWidth: 11.7,
  taper: 13.8, scenery: 'rock', risky: 'inner', bend: 1 });
const split = island.splits[0]!;
const inner = split.lanes.find(lane => lane.risk === 1)!;
const outer = split.lanes.find(lane => lane.risk === 0)!;
const innerOffsets = { offsetMin: inner.offsetMin, offsetMax: inner.offsetMax };
const safeOffset = (outer.offsetMin + outer.offsetMax) / 2;

export const canyon: TrackDef = {
  id: 'canyon',
  name: 'SUNSCAR CANYON',
  layoutVersion: 5,
  // East shelf, tight eastern hairpin, mesa island, upper crossing, then the western S bends.
  controlPoints: [
    [-223.5, 12, 0],
    [-100, 9, 0],
    [0, 8, 0],
    [100, 5, 0],
    [200, 2, 0],
    [240, 2, 0],
    [260, 2, 0],
    [284.042, 2, -9.958],
    [294, 2, -34],
    [284.042, 2, -58.042],
    [260, 2, -68],
    [240, 3, -68],
    [220, 4, -68],
    [190, 6, -68],
    [150, 9, -85],
    [130, 17, -120],
    [130, 23, -160],
    [130, 24, -220],
    [110.962, 20, -265.962],
    [65, 30, -285],
    [19.038, 24, -265.962],
    [0, 24, -220],
    [0, 22, -150],
    [0, 28, -80],
    [0, 28, 0],
    [0, 28, 80],
    [0, 22, 160],
    [0, 14, 220],
    [-30, 8, 280],
    [-90, 5, 310],
    [-170, 5, 310],
    [-250, 7, 310],
    [-320, 9, 290],
    [-340, 11, 245],
    [-320, 13, 195],
    [-340, 14, 145],
    [-320, 14, 95],
    [-340, 14, 45],
    [-320, 14, 0],
    [-260, 13, 0],
  ],
  scale: 1,
  samplesPerSegment: 32,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH,
  wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 24,
  decks: [{ from: 1247.5, to: 1287.5 }],
  widthKeys: [
    { distance: split.from - 40, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    ...island.widthKeys.map(key => ({ ...key, wallHalfWidth: Math.max(BASE_WALL_HALF_WIDTH, key.roadHalfWidth) })),
    { distance: split.to + 40, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    { distance: 1636.5, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    { distance: 1656.5, roadHalfWidth: 5.148, wallHalfWidth: 7.5075 },
    { distance: 1696.5, roadHalfWidth: 5.148, wallHalfWidth: 7.5075 },
    { distance: 1716.5, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
  ],
  barriers: [
    { from: 136, to: 152, center: 0, halfWidth: 1.2, taper: 4, scenery: 'pillar' },
    ...island.barriers,
  ],
  splits: island.splits,
  boxRows: [0.04, 0.16, 0.29, 0.46, 0.62, 0.72, 0.82, 0.93],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [
    { distance: 0, offset: 0 },
    { distance: 80, offset: -5.85 },
    { distance: 158, offset: -5.85 },
    { distance: 178, offset: 0 },
    { distance: split.from - 35, offset: 0 },
    { distance: split.from, offset: safeOffset },
    { distance: split.to, offset: safeOffset },
    { distance: split.to + 20, offset: 0 },
    { distance: 2186.5, offset: 0 },
  ],
  surfaces: [
    { kind: 'jump', from: 306.5, to: 310.5 },
    { kind: 'jump', from: 1386.5, to: 1390.5 },
    // The downhill lip lands on the rising mesa; missing the pad costs recovery time.
    { kind: 'dirt', from: split.from + 45, to: split.from + 70, ...innerOffsets },
    { kind: 'boost', from: split.from + 54, to: split.from + 57, ...innerOffsets },
    { kind: 'jump', from: split.from + 70, to: split.from + 74, ...innerOffsets },
    { kind: 'pit', from: split.from + 76, to: split.from + 90.8,
      offsetMin: inner.offsetMin + 0.05, offsetMax: inner.offsetMax },
    // Loose gravel brakes the approach to the tight eastern hairpin.
    { kind: 'dirt', from: 451.5, to: 596.5 },
  ],
  themeId: 'canyon',
};

import type { TrackDef } from '../types';
import { buildTrack } from '../track';
import { islandSplit } from './features';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH, WIDTH_SCALE } from './widths';

// Two parallel pier straights lead into separate northern and southern promenades.
const layout: TrackDef = {
  id: 'harbor', name: 'TIDEWATER HARBOR', layoutVersion: 1, themeId: 'harbor',
  controlPoints: [
    [0, 1, 0], [48, 1, 0], [96, 4, 0], [144, 4, 0], [192, 4, 0], [218, 4, 0],
    [245, 4, 0], [264.092, 4, 7.908], [272, 4, 27],
    [264.092, 4, 46.092], [245, 4, 54], [218, 4, 54],
    [192, 4, 54], [144, 1, 54], [96, 1, 54], [48, 1, 54],
    [0, 1, 110], [-30, 1, 180], [-60, 1, 210], [-150, 1, 210],
    // North promenade: four alternating bends.
    [-200, 1, 190], [-250, 1, 210], [-300, 1, 190], [-350, 1, 210],
    [-410, 1, 190], [-440, 1, 130], [-440, 1, 50],
    // West pier rises onto a level landing, then descends gently to the beach.
    [-440, 4, -50], [-440, 4, -150], [-410, 1, -210], [-350, 1, -240],
    // South promenade, separated from the north S bends by the west pier.
    [-300, 1, -220], [-250, 1, -240], [-200, 1, -220], [-150, 1, -240],
    [-100, 1, -220], [-60, 1, -210], [20, 1, -180], [60, 1, -130],
    [30, 1, -80], [-13, 1, -80], [-40, 1, -80],
    [-68.284, 1, -68.284], [-80, 1, -40], [-68.284, 1, -11.716], [-40, 1, 0],
  ],
  scale: 1, samplesPerSegment: 32,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 24,
  boxRows: [0.025, 0.18, 0.29, 0.42, 0.54, 0.66, 0.79, 0.91],
  boxLanes: [-4.1 * WIDTH_SCALE, 0, 4.1 * WIDTH_SCALE],
  racingLine: [], surfaces: [],
};

// Feature distances follow the sampled centre line; the test pins the measured length.
const geometry = buildTrack(layout);
const at = (controlPoint: number) => geometry.samples[controlPoint * layout.samplesPerSegment]!.distance;
const island = islandSplit({ from: at(18) + 15, to: at(19) - 5,
  islandHalf: 4.5 * WIDTH_SCALE, laneWidth: 9 * WIDTH_SCALE,
  taper: 9 * WIDTH_SCALE, scenery: 'building', risky: 'inner', bend: 1 });
const split = island.splits[0]!;
const safeLane = split.lanes.find(lane => lane.risk === 0)!;
const safeOffset = (safeLane.offsetMin + safeLane.offsetMax) / 2;

export const harbor: TrackDef = {
  ...layout,
  widthKeys: [
    { distance: split.from - 40, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    ...island.widthKeys.map(key => ({ ...key, wallHalfWidth: Math.max(BASE_WALL_HALF_WIDTH, key.roadHalfWidth) })),
    { distance: split.to + 40, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
  ],
  splits: island.splits,
  barriers: [
    ...island.barriers,
    // A quay cargo belt retracts towards the sea; its gate always leaves the centre route free.
    { from: at(26) + 45, to: at(26) + 70, center: 8 * WIDTH_SCALE,
      halfWidth: 2 * WIDTH_SCALE, taper: 6, scenery: 'block',
      motion: { kind: 'gate', amplitude: 0, period: 8, phase: 0, minWidth: 0.6 * WIDTH_SCALE } },
  ],
  bankKeys: [
    { distance: 0, roll: 0 },
    { distance: at(36), roll: 0 }, { distance: at(37), roll: 0.18 },
    { distance: at(38), roll: 0.18 }, { distance: at(39), roll: 0 },
    { distance: geometry.length, roll: 0 },
  ],
  racingLine: [
    { distance: 0, offset: 0 },
    { distance: at(5), offset: 3 }, { distance: at(8), offset: -3 },
    { distance: at(11), offset: 3 }, { distance: at(12), offset: 0 },
    { distance: split.from - 35, offset: 0 }, { distance: split.from, offset: safeOffset },
    { distance: split.to, offset: safeOffset }, { distance: split.to + 25, offset: 0 },
    { distance: geometry.length, offset: 0 },
  ],
  surfaces: [
    { kind: 'jump', from: at(2) + 32, to: at(2) + 36 },
    { kind: 'jump', from: at(27) + 35, to: at(27) + 39 },
    { kind: 'dirt', from: at(20) - 12, to: at(21) + 12 },
    { kind: 'dirt', from: at(31) - 12, to: at(32) + 12 },
  ],
};

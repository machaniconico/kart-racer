import type { TrackDef } from '../types';
import { buildTrack } from '../track';
import { islandSplit } from './features';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH, WIDTH_SCALE } from './widths';

// The eastern teardrop leads to a raised cherry grove and a long pond promenade.
const layout: TrackDef = {
  id: 'garden', name: 'BLOSSOM GARDEN', layoutVersion: 1, themeId: 'garden',
  controlPoints: [
    [0, 1, 0], [80, 1, 0], [160, 1, 0], [203, 1, 0],
    [230, 1, 0], [254.395, 1, 10.105], [264.5, 1, 34.5],
    [254.395, 1, 58.895], [230, 1, 69], [203, 1, 69],
    [160, 1, 69], [80, 1, 69], [10, 1, 95], [-20, 1, 150],
    [-30, 4, 215], [-90, 6, 260], [-180, 6, 260], [-250, 5, 200],
    [-290, 3, 120], [-300, 1, 20], [-290, 1, -100], [-250, 1, -180],
    [-220, 1, -210],
    [-160, 1, -200], [-110, 1, -220], [-60, 1, -200], [-10, 1, -220],
    [50, 1, -210], [130, 1, -200], [190, 1, -150], [190, 1, -100],
    [130, 1, -60], [40, 1, -80], [-13, 1, -80], [-40, 1, -80],
    [-68.284, 1, -68.284], [-80, 1, -40], [-68.284, 1, -11.716],
    [-40, 1, 0], [-13, 1, 0],
  ],
  scale: 1, samplesPerSegment: 32,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 24,
  boxRows: [0.02, 0.12, 0.24, 0.36, 0.47, 0.58, 0.695, 0.81],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [], surfaces: [],
};

const geometry = buildTrack(layout);
export const GARDEN_LENGTH = geometry.length;
const islands = [
  islandSplit({ from: 690, to: 755, islandHalf: 2.5, laneWidth: 9,
    taper: 12, scenery: 'rock', risky: 'inner', bend: -1 }),
  islandSplit({ from: 1095, to: 1135, islandHalf: 2.5, laneWidth: 9,
    taper: 12, scenery: 'rock', risky: 'outer', bend: -1 }),
];

export const garden: TrackDef = {
  ...layout,
  widthKeys: islands.flatMap(island => {
    const split = island.splits[0]!;
    return [
      { distance: split.from - 40, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
      ...island.widthKeys.map(key => ({ ...key,
        roadHalfWidth: Math.max(BASE_ROAD_HALF_WIDTH, key.roadHalfWidth),
        wallHalfWidth: Math.max(BASE_WALL_HALF_WIDTH, key.wallHalfWidth) })),
      { distance: split.to + 40, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    ];
  }),
  splits: islands.flatMap(island => island.splits),
  barriers: [
    ...islands.flatMap(island => island.barriers),
    // A wooden garden door retracts along the verge, leaving the centre open.
    { from: 1290, to: 1310, center: 8 * WIDTH_SCALE, halfWidth: 2 * WIDTH_SCALE,
      taper: 6, scenery: 'block',
      motion: { kind: 'gate', amplitude: 0, period: 8, phase: 0, minWidth: 0.6 * WIDTH_SCALE } },
  ],
  racingLine: [
    { distance: 0, offset: 0 },
    ...islands.flatMap(island => {
      const split = island.splits[0]!, lane = split.lanes.find(lane => lane.risk === 0)!;
      const offset = (lane.offsetMin + lane.offsetMax) / 2;
      return [{ distance: split.from - 55, offset: 0 }, { distance: split.from, offset },
        { distance: split.to, offset }, { distance: split.to + 55, offset: 0 }];
    }),
    { distance: geometry.length, offset: 0 },
  ],
  surfaces: [
    // The pond occupies the left side; the continuous paved centre is the bypass.
    { kind: 'jump', from: 985, to: 989, offsetMin: -BASE_ROAD_HALF_WIDTH, offsetMax: -3.8 },
    { kind: 'pit', from: 993, to: 1003, offsetMin: -BASE_ROAD_HALF_WIDTH, offsetMax: -3.8 },
  ],
};

import { buildTrack } from '../track';
import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const layout: TrackDef = {
  id: 'snowpeak',
  name: 'FROSTBITE PEAK',
  layoutVersion: 4,
  controlPoints: [
    // Climb from the level grid to the summit hairpin, then follow the high ridge west.
    [0, 1, 0], [80, 1, 0], [160, 18, 0], [240, 37, 0], [283, 39, 0],
    [310, 39, 0], [329.092, 39, 7.908], [337, 39, 27],
    [329.092, 39, 46.092], [310, 39, 54], [283, 39, 54],
    [240, 39, 54], [160, 39, 110], [80, 39, 145], [-30, 39, 160], [-130, 39, 150],
    [-180, 39, 130], [-270, 28, 100], [-310, 9, 20], [-300, 1, -100],
    [-250, 1, -180], [-220, 1, -210],
    // The frozen valley alternates four bends before the southern compound corner.
    [-160, 1, -210], [-110, 1, -220], [-60, 1, -210], [-10, 1, -220],
    [50, 1, -210], [130, 1, -200], [190, 1, -150], [190, 1, -100],
    [130, 1, -60], [40, 1, -80], [-13, 1, -80], [-40, 1, -80],
    [-68.284, 1, -68.284], [-80, 1, -40], [-68.284, 1, -11.716],
    [-40, 1, 0], [-13, 1, 0],
  ],
  scale: 1,
  samplesPerSegment: 32,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH,
  wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 24,
  boxRows: [0.03, 0.16, 0.29, 0.42, 0.515, 0.61, 0.74, 0.87],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [],
  surfaces: [
    { kind: 'ice', from: 500, to: 640 },
    { kind: 'ice', from: 780, to: 900 },
    { kind: 'ice', from: 1410, to: 1615 },
    { kind: 'jump', from: 286, to: 289 },
    { kind: 'dirt', from: 1160, to: 1230 },
  ],
  // One exposed ridge passage; 30 m tapers keep both walls continuous.
  widthKeys: [
    { distance: 675, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    { distance: 705, roadHalfWidth: BASE_ROAD_HALF_WIDTH * 0.55, wallHalfWidth: BASE_WALL_HALF_WIDTH * 0.55 },
    { distance: 735, roadHalfWidth: BASE_ROAD_HALF_WIDTH * 0.55, wallHalfWidth: BASE_WALL_HALF_WIDTH * 0.55 },
    { distance: 765, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
  ],
  themeId: 'snowpeak',
};

// Derive seam keys from the sampled geometry, never a copied length measurement.
const { length } = buildTrack(layout);
export const snowpeak: TrackDef = {
  ...layout,
  racingLine: [
    { distance: 0, offset: 0 }, { distance: 260, offset: 0 },
    { distance: 295, offset: 3 }, { distance: 352, offset: -3 },
    { distance: 410, offset: 3 }, { distance: 470, offset: 0 },
    { distance: length, offset: 0 },
  ],
  // Two broad corners, each with 20 m transitions (0.015 rad/m).
  bankKeys: [
    { distance: 0, roll: 0 },
    { distance: 560, roll: 0 }, { distance: 580, roll: 0.3 },
    { distance: 620, roll: 0.3 }, { distance: 640, roll: 0 },
    { distance: 1740, roll: 0 }, { distance: 1760, roll: 0.3 },
    { distance: 1810, roll: 0.3 }, { distance: 1830, roll: 0 },
    { distance: length, roll: 0 },
  ],
};

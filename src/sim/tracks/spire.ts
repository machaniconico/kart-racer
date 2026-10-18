// M11 scaffold: MEADOW copy until the course story replaces this definition.
import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

export const spire: TrackDef = {
  id: 'spire',
  name: 'SKY SPIRE',
  layoutVersion: 3,
  controlPoints: [
    // Home straight and the east hairpin (27 m control-point radius).
    [0, 1, 0], [80, 1, 0], [160, 1, 0], [203, 1, 0],
    [230, 1, 0], [249.092, 1, 7.908], [257, 1, 27],
    [249.092, 1, 46.092], [230, 1, 54], [203, 1, 54],
    [160, 1, 54], [80, 1, 54], [10, 1, 85], [-20, 1, 140],
    // Meadow ridge: the crest levels out before the descent.
    [-30, 8, 215], [-90, 9, 250], [-180, 9, 250], [-250, 8, 200],
    [-290, 3, 120], [-300, 1, 20], [-290, 1, -100], [-250, 1, -180],
    [-220, 1, -210],
    // Four alternating bends, then a sweeping southern compound corner.
    [-160, 1, -200], [-110, 1, -220], [-60, 1, -200], [-10, 1, -220],
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
  boxRows: [0.02, 0.12, 0.24, 0.36, 0.47, 0.58, 0.695, 0.81],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [
    { distance: 0, offset: 0 },
    { distance: 180, offset: 0 },
    { distance: 215, offset: 3 },
    { distance: 272, offset: -3 },
    { distance: 330, offset: 3 },
    { distance: 390, offset: 0 },
    { distance: 600, offset: 0 },
    { distance: 780, offset: 0 },
    { distance: 1000, offset: 0 },
    { distance: 1240, offset: 0 },
    { distance: 1370, offset: 0 },
    { distance: 1660, offset: 0 },
    { distance: 1950, offset: 0 },
    { distance: 2120, offset: 0 },
    { distance: 2286.353556318704, offset: 0 },
  ],
  surfaces: [
    { kind: 'dirt', from: 440, to: 520 },
    { kind: 'jump', from: 733, to: 736 },
    { kind: 'dirt', from: 1670, to: 1750 },
  ],
  widthKeys: [
    { distance: 1145, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    { distance: 1165, roadHalfWidth: 5.15, wallHalfWidth: 7.5 },
    { distance: 1195, roadHalfWidth: 5.15, wallHalfWidth: 7.5 },
    { distance: 1215, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
  ],
  bankKeys: [
    { distance: 780, roll: 0 },
    { distance: 810, roll: 0.18 },
    { distance: 880, roll: 0.18 },
    { distance: 910, roll: 0 },
  ],
  themeId: 'spire',
};

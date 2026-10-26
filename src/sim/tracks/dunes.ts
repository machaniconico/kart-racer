import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

export const DUNES_LENGTH = 2239.8539616102685;

export const dunes: TrackDef = {
  id: 'dunes', name: 'SIROCCO DUNES', layoutVersion: 1, themeId: 'dunes',
  // Three sand ridges frame a broad basin; the western return snakes through a canyon.
  controlPoints: [
    [-230, 4, -240], [-130, 4, -240], [-30, 15, -240], [50, 13, -240],
    [130, 4, -240], [230, 4, -240], [300, 4, -210], [340, 4, -140],
    [340, 4, -40], [340, 14, 40], [340, 12, 120], [320, 4, 200],
    [260, 4, 250], [170, 4, 260], [80, 4, 260], [-10, 17, 260],
    [-90, 13, 260], [-170, 4, 260], [-260, 4, 260], [-330, 4, 220],
    [-360, 4, 150], [-340, 4, 80], [-300, 4, 10], [-320, 4, -60],
    [-360, 4, -130], [-350, 4, -200], [-300, 4, -240],
  ],
  scale: 1, samplesPerSegment: 32,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 24,
  boxRows: [0.04, 0.16, 0.29, 0.42, 0.55, 0.67, 0.79, 0.93],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [{ distance: 0, offset: 0 }, { distance: DUNES_LENGTH, offset: 0 }],
  surfaces: [
    { kind: 'jump', from: 230, to: 234 },
    { kind: 'jump', from: 830, to: 834 },
    { kind: 'jump', from: 1340, to: 1344 },
    // M12-22 (C2): every ridge lands on a full-width sand pad; past the pads the sand keeps only the
    // outside of the road (positive offsets), so the racing line runs on hard ground.
    { kind: 'dirt', from: 234, to: 300 },
    { kind: 'dirt', from: 300, to: 480, offsetMin: 2 },
    { kind: 'dirt', from: 834, to: 900 },
    { kind: 'dirt', from: 900, to: 1344, offsetMin: 2 },
    { kind: 'dirt', from: 1344, to: 1400 },
    { kind: 'dirt', from: 1400, to: 1500, offsetMin: 2 },
  ],
  widthKeys: [
    { distance: 1670, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    { distance: 1700, roadHalfWidth: BASE_ROAD_HALF_WIDTH * 0.55, wallHalfWidth: BASE_WALL_HALF_WIDTH * 0.55 },
    { distance: 1740, roadHalfWidth: BASE_ROAD_HALF_WIDTH * 0.55, wallHalfWidth: BASE_WALL_HALF_WIDTH * 0.55 },
    { distance: 1770, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
  ],
  bankKeys: [
    { distance: 0, roll: 0 },
    { distance: 1820, roll: 0 }, { distance: 1850, roll: -0.3 },
    { distance: 1930, roll: -0.3 }, { distance: 1970, roll: 0 },
    { distance: 2000, roll: 0.3 }, { distance: 2070, roll: 0.3 },
    { distance: 2110, roll: 0 }, { distance: DUNES_LENGTH, roll: 0 },
  ],
};

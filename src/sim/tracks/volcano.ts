import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

export const VOLCANO_LENGTH = 2265.6342550196605;

export const volcano: TrackDef = {
  id: 'volcano', name: 'EMBER CALDERA', layoutVersion: 1, themeId: 'volcano',
  // Lower lava shelf, two climbing switchbacks, basalt bridge, then the falling ridge.
  controlPoints: [
    [-183.5, 4, 0], [-100, 4, 0], [0, 4, 0], [100, 4, 0], [200, 4, 0],
    [240, 4, 0], [260, 5, 0], [284.395, 7, -10.105], [294.5, 9, -34.5],
    [284.395, 11, -58.895], [260, 13, -69], [240, 14, -69], [220, 15, -69],
    [190, 17, -69], [150, 21, -85], [130, 27, -120], [130, 30, -160],
    [130, 31, -220], [130, 32, -250], [119.895, 33, -274.395],
    [95.5, 34, -284.5], [71.105, 35, -274.395], [61, 36, -250],
    [61, 36, -220], [61, 35, -150], [61, 34, -80], [61, 34, 0],
    [61, 34, 80], [61, 17, 160], [30, 8, 220], [-30, 4, 280],
    [-90, 4, 310], [-170, 4, 310], [-250, 5, 310], [-320, 7, 290],
    [-340, 9, 245], [-320, 11, 195], [-340, 12, 145], [-320, 12, 95],
    [-340, 12, 45], [-320, 12, 0], [-260, 8, 0],
  ],
  scale: 1, samplesPerSegment: 32,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 24,
  boxRows: [0.04, 0.16, 0.29, 0.46, 0.62, 0.72, 0.82, 0.93],
  boxLanes: [-5.33, 0, 5.33],
  decks: [{ from: 1173.355828363949, to: 1213.355828363949 }],
  widthKeys: [
    { distance: 990, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    { distance: 1015, roadHalfWidth: BASE_ROAD_HALF_WIDTH * 0.55, wallHalfWidth: BASE_WALL_HALF_WIDTH * 0.55 },
    { distance: 1055, roadHalfWidth: BASE_ROAD_HALF_WIDTH * 0.55, wallHalfWidth: BASE_WALL_HALF_WIDTH * 0.55 },
    { distance: 1080, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
  ],
  bankKeys: [
    { distance: 0, roll: 0 },
    { distance: 1505, roll: 0 }, { distance: 1525, roll: 0.3 },
    { distance: 1555, roll: 0.3 }, { distance: 1575, roll: 0 },
    { distance: VOLCANO_LENGTH, roll: 0 },
  ],
  racingLine: [
    { distance: 0, offset: 0 }, { distance: 1260, offset: 0 },
    { distance: 1370, offset: 0 }, { distance: VOLCANO_LENGTH, offset: 0 },
  ],
  surfaces: [
    // A single downhill launch crosses two staggered fissures. The paved middle
    // stays open before, beside and after both holes for the safe racing line.
    { kind: 'jump', from: 1324, to: 1328 },
    { kind: 'pit', from: 1330, to: 1340, offsetMin: -BASE_ROAD_HALF_WIDTH, offsetMax: -3.8 },
    { kind: 'pit', from: 1334, to: 1344, offsetMin: 3.8, offsetMax: BASE_ROAD_HALF_WIDTH },
    { kind: 'dirt', from: 415, to: 575 },
  ],
};

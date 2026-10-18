import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

export const chasm: TrackDef = {
  id: 'chasm',
  name: 'CHASM LEAP',
  layoutVersion: 1,
  themeId: 'chasm',
  physics: {},
  // Three separated ravines on the level eastern shelf. Broad end turns leave
  // the full alignment window and landing runout on a straight for every leap.
  controlPoints: [
    [0, 24, 0], [100, 24, 0], [200, 24, 0], [300, 24, 0],
    [400, 24, 0], [500, 24, 0], [600, 24, 0], [700, 24, 0], [800, 24, 0],
    [870.711, 24, 29.289], [900, 24, 100], [870.711, 24, 170.711],
    [800, 24, 200], [700, 24, 200], [600, 24, 200], [500, 24, 200],
    [400, 24, 200], [300, 24, 200], [200, 24, 200], [100, 24, 200], [0, 24, 200],
    [-70.711, 24, 170.711], [-100, 24, 100], [-70.711, 24, 29.289],
  ],
  scale: 1,
  samplesPerSegment: 32,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH,
  wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 24,
  boxRows: [0.025, 0.15, 0.225, 0.36, 0.48, 0.62, 0.76, 0.9],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [{ distance: 0, offset: 0 }],
  surfaces: [
    { kind: 'boost', from: 175, to: 187 },
    { kind: 'jump', from: 200, to: 204, duration: 1.4, height: 4,
      offsetMin: -BASE_WALL_HALF_WIDTH, offsetMax: BASE_WALL_HALF_WIDTH },
    { kind: 'fall', from: 206, to: 232,
      offsetMin: -BASE_WALL_HALF_WIDTH, offsetMax: BASE_WALL_HALF_WIDTH, respawnAt: 240 },
    { kind: 'boost', from: 375, to: 387 },
    { kind: 'jump', from: 400, to: 404, duration: 1.6, height: 5,
      offsetMin: -BASE_WALL_HALF_WIDTH, offsetMax: BASE_WALL_HALF_WIDTH },
    { kind: 'fall', from: 406, to: 436,
      offsetMin: -BASE_WALL_HALF_WIDTH, offsetMax: BASE_WALL_HALF_WIDTH, respawnAt: 444 },
    { kind: 'boost', from: 565, to: 577 },
    { kind: 'jump', from: 590, to: 594, duration: 1.8, height: 6,
      offsetMin: -BASE_WALL_HALF_WIDTH, offsetMax: BASE_WALL_HALF_WIDTH },
    { kind: 'fall', from: 596, to: 630,
      offsetMin: -BASE_WALL_HALF_WIDTH, offsetMax: BASE_WALL_HALF_WIDTH, respawnAt: 638 },
  ],
};

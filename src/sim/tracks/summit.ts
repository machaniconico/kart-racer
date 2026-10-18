import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

export const SUMMIT_RIDGE = { from: 440, to: 680 } as const;
export const SUMMIT_DESCENT = { from: 760, to: 920 } as const;

export const summit: TrackDef = {
  id: 'summit', name: 'SUMMIT DROP', layoutVersion: 1, themeId: 'summit',
  physics: {},
  // A 96 m climb, an exposed level ridge, then a sustained 45% plunge.
  // Equal spacing keeps the steep sections straight and their pitch predictable.
  controlPoints: [
    [0, 4, 0], [40, 4, 0], [80, 4, 0], [120, 4, 0],
    [160, 12, 0], [200, 28, 0], [240, 44, 0], [280, 60, 0],
    [320, 76, 0], [360, 92, 0], [400, 100, 0], [440, 100, 0],
    [480, 100, 0], [520, 100, 0], [560, 100, 0], [600, 100, 0],
    [640, 100, 0], [680, 100, 0], [720, 100, 0], [760, 91, 0],
    [800, 73, 0], [840, 55, 0], [880, 37, 0], [920, 19, 0],
    [960, 4, 0], [1000, 4, 0], [1040, 4, 0],
    // Broad valley turns leave room to recover from the downhill speed.
    [1100, 4, 0], [1170.711, 4, 29.289], [1200, 4, 100],
    [1170.711, 4, 170.711], [1100, 4, 200], [1040, 4, 200],
    [920, 4, 200], [760, 4, 220], [600, 4, 260], [440, 4, 260],
    [280, 4, 220], [120, 4, 200], [0, 4, 200], [-40, 4, 200],
    [-110.711, 4, 170.711], [-140, 4, 100], [-110.711, 4, 29.289],
    [-40, 4, 0],
  ],
  scale: 1, samplesPerSegment: 24,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH,
  // Keep the entire ridge inside one checkpoint interval: a fall never skips a gate.
  checkpointCount: 8, checkpointPhase: 0.2,
  boxRows: [0.025, 0.12, 0.30, 0.40, 0.54, 0.67, 0.80, 0.92],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [{ distance: 0, offset: 0 }],
  widthKeys: [
    { distance: 380, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    { distance: SUMMIT_RIDGE.from, roadHalfWidth: 3.6, wallHalfWidth: 10 },
    { distance: SUMMIT_RIDGE.to, roadHalfWidth: 3.6, wallHalfWidth: 10 },
    { distance: 740, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
  ],
  surfaces: [-1, 1].map(side => ({
    kind: 'fall', ...SUMMIT_RIDGE,
    offsetMin: side < 0 ? -10 : 3.6,
    offsetMax: side < 0 ? -3.6 : 10,
    respawnAt: SUMMIT_RIDGE.from,
  })),
};

import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

export const snowpeak: TrackDef = {
  id: 'snowpeak',
  name: 'FROSTBITE PEAK',
  layoutVersion: 2,
  // A rolling alpine loop with two sheltered S-bends and broad icy sweepers.
  controlPoints: [
    [0, 0.8, 100], [48, 2, 90], [82, 4, 60], [88, 6, 15],
    // The bend approaching [70, 6, -71] has the minimum radius (17.22 m, limit 16.15 m); keep it open.
    [68, 7, -25], [70, 6, -71], [35, 4, -100],
    [-10, 2, -100], [-55, 1, -90], [-88, 2, -55], [-85, 3, -10], [-60, 3.5, 25],
    [-55, 2, 65], [-30, 1, 92],
  ],
  scale: 1,
  samplesPerSegment: 32,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH,
  wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 12,
  boxRows: [0.16, 0.42, 0.61, 0.87],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [],
  // Full road width only; keep the tighter S-bends and starting grid on snow.
  // 165m of ice across the 619m loop, with every icy radius above 33m.
  surfaces: [
    { kind: 'ice', from: 30, to: 85 },
    { kind: 'ice', from: 295, to: 350 },
    { kind: 'ice', from: 405, to: 460 },
  ],
  themeId: 'snowpeak',
};

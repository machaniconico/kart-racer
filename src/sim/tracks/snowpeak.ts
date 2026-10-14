import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

export const snowpeak: TrackDef = {
  id: 'snowpeak',
  name: 'FROSTBITE PEAK',
  layoutVersion: 3,
  // A 19m alpine climb and descent; the final approach stays level for the starting grid.
  controlPoints: [
    [0, 1, 100], [48, 2, 90], [82, 10, 60], [88, 18, 15],
    // The bend approaching [70, 19, -71] has the minimum radius (17.22 m, limit 16.15 m); keep it open.
    [68, 20, -25], [70, 19, -71], [35, 14, -100],
    [-10, 6, -100], [-55, 1, -90], [-88, 1, -55], [-85, 1, -10], [-60, 1, 25],
    [-55, 1, 65], [-30, 1, 92],
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
  // Bank only the first icy sweeper (30–85m, radius >= 57m): its broad turn gives
  // room to feel the bank while climbing. Negative roll lowers the inside edge;
  // 20m entry/exit ramps keep twist at 0.015 rad/m, below the 0.02 limit.
  bankKeys: [
    { distance: 0, roll: 0 },
    { distance: 30, roll: 0 },
    { distance: 50, roll: -0.3 },
    { distance: 65, roll: -0.3 },
    { distance: 85, roll: 0 },
    { distance: 619.022706055925, roll: 0 },
  ],
  themeId: 'snowpeak',
};

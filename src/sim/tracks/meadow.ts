import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

export const meadow: TrackDef = {
  id: 'meadow',
  name: 'MEADOW LOOP',
  layoutVersion: 2,
  controlPoints: [
    [0, 0.7, 82], [46, 2, 74], [87, 7.2, 47], [91, 8.5, 2],
    [76, 4.5, -27], [82, 1.5, -71], [32, 0.8, -105], [-26, 0.4, -86],
    [-75, 2.5, -62], [-91, 6.4, -10], [-68, 4, 38], [-31, 1.2, 58],
  ],
  scale: 1.1,
  samplesPerSegment: 32,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH,
  wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 12,
  boxRows: [0.12, 0.36, 0.58, 0.81],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [],
  surfaces: [],
  themeId: 'meadow',
};

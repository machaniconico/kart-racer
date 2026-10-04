import type { TrackDef } from '../types';

export const meadow: TrackDef = {
  id: 'meadow',
  name: 'MEADOW LOOP',
  controlPoints: [
    [0, 0.7, 82], [46, 2, 74], [87, 7.2, 47], [91, 8.5, 2],
    [75, 4.5, -27], [82, 1.5, -70], [32, 0.8, -105], [-26, 0.4, -86],
    [-75, 2.5, -62], [-91, 6.4, -10], [-68, 4, 38], [-31, 1.2, 58],
  ],
  scale: 1.1,
  samplesPerSegment: 32,
  roadHalfWidth: 7.2,
  wallHalfWidth: 10.5,
  checkpointCount: 12,
  boxRows: [0.12, 0.36, 0.58, 0.81],
  boxLanes: [-4.1, 0, 4.1],
  racingLine: [],
  surfaces: [],
  themeId: 'meadow',
};

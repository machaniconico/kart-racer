import type { TrackDef } from '../types';

/**
 * Test fixture only: the MEADOW TrackDef as of protocol v14 (layoutVersion 2, 651.39 m).
 * It has nothing to do with the real courses from M5 on, so shared tests that derive
 * synthetic courses from it keep their numbers when the real MEADOW is rebuilt.
 * Production code must not import this file.
 */
export const LEGACY_MEADOW: TrackDef = {
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
  roadHalfWidth: 9.36,
  wallHalfWidth: 13.65,
  checkpointCount: 12,
  boxRows: [0.02, 0.12, 0.24, 0.36, 0.47, 0.58, 0.695, 0.81],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [],
  surfaces: [],
  themeId: 'meadow',
};

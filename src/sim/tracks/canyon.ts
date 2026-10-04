import type { TrackDef } from '../types';

export const canyon: TrackDef = {
  id: 'canyon',
  name: 'SUNSCAR CANYON',
  // Two long canyon shelves joined by broad mesa bends. The middle of each
  // shelf stays collinear through takeoff and the full 0.8-second flight.
  controlPoints: [
    [65, 6, 65], [65, 3, 21.667], [65, 0, -21.667], [65, 1, -65],
    [45.962, 4, -110.962], [0, 8, -130], [-45.962, 12, -110.962],
    [-65, 12, -65], [-65, 9, -21.667], [-65, 6, 21.667], [-65, 3, 65],
    [-45.962, 1, 110.962], [0, 1, 130], [45.962, 4, 110.962],
  ],
  scale: 1,
  samplesPerSegment: 32,
  roadHalfWidth: 7.2,
  wallHalfWidth: 10.5,
  checkpointCount: 12,
  boxRows: [0.19, 0.4, 0.69, 0.9],
  boxLanes: [-4.1, 0, 4.1],
  racingLine: [],
  surfaces: [
    { kind: 'jump', from: 60, to: 64 },
    { kind: 'jump', from: 393, to: 397 },
  ],
  themeId: 'canyon',
};

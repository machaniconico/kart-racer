import type { TrackDef } from '../types';

export const snowpeak: TrackDef = {
  id: 'snowpeak',
  name: 'FROSTBITE PEAK',
  // A rolling alpine loop with two sheltered S-bends and broad icy sweepers.
  controlPoints: [
    [0, 0.8, 100], [48, 2, 90], [82, 4, 60], [88, 6, 15],
    [62, 7, -25], [70, 6, -70], [35, 4, -100],
    // The bend between these two points is the course minimum (about 13.5 m, limit 13.0 m); keep it open when editing.
    [-10, 2, -100], [-55, 1, -90], [-88, 2, -55], [-85, 3, -10], [-60, 3.5, 25],
    [-55, 2, 65], [-30, 1, 92],
  ],
  scale: 1,
  samplesPerSegment: 32,
  roadHalfWidth: 7.2,
  wallHalfWidth: 10.5,
  checkpointCount: 12,
  boxRows: [0.16, 0.42, 0.61, 0.87],
  boxLanes: [-4.1, 0, 4.1],
  racingLine: [],
  // Full road width only; keep the tighter S-bends and starting grid on snow.
  // 165m of ice across the 623m loop, with every icy radius above 33m.
  surfaces: [
    { kind: 'ice', from: 30, to: 85 },
    { kind: 'ice', from: 295, to: 350 },
    { kind: 'ice', from: 405, to: 460 },
  ],
  themeId: 'snowpeak',
};

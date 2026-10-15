import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH, WIDTH_SCALE } from './widths';

export const CAVERN_LENGTH = 2118.887715389262;
const full = { roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH };
const narrow = { roadHalfWidth: BASE_ROAD_HALF_WIDTH * 0.55, wallHalfWidth: BASE_WALL_HALF_WIDTH * 0.55 };

export const cavern: TrackDef = {
  id: 'cavern', name: 'CRYSTAL HOLLOW', layoutVersion: 1, themeId: 'cavern',
  // Two irregular chambers curl around a raised crystal bridge. Long, curved
  // transitions keep the silhouette organic and the crossing approaches level.
  controlPoints: [
    [-175, 3, 0], [-90, 3, 0], [10, 3, 0], [110, 3, 8],
    [210, 3, 40], [280, 5, 105], [300, 8, 190], [260, 12, 260],
    [170, 16, 290], [90, 20, 260], [50, 23, 190], [45, 23, 110],
    [45, 23, 50], [45, 23, 0], [45, 23, -60], [40, 22, -140],
    [0, 18, -220], [-70, 12, -280], [-170, 6, -300], [-270, 3, -270],
    [-350, 3, -200], [-380, 3, -110], [-350, 3, -30], [-280, 3, 0],
  ],
  scale: 1, samplesPerSegment: 32,
  ...full,
  checkpointCount: 24,
  boxRows: [0.03, 0.16, 0.26, 0.39, 0.53, 0.67, 0.8, 0.92],
  boxLanes: [-5.33, 0, 5.33],
  decks: [{ from: 1085, to: 1140 }],
  widthKeys: [
    { distance: 880, ...full }, { distance: 905, ...narrow },
    { distance: 950, ...narrow }, { distance: 975, ...full },
    { distance: 1580, ...full }, { distance: 1605, ...narrow },
    { distance: 1650, ...narrow }, { distance: 1675, ...full },
  ],
  racingLine: [{ distance: 0, offset: 0 }, { distance: CAVERN_LENGTH, offset: 0 }],
  surfaces: [
    { kind: 'ice', from: 300, to: 390 },
    { kind: 'ice', from: 1330, to: 1420 },
  ],
  barriers: [
    { from: 580, to: 605, center: -5.8, halfWidth: 2.2, taper: 8, scenery: 'pillar',
      motion: { kind: 'gate', amplitude: 0, period: 6, phase: 0, minWidth: 0.6 * WIDTH_SCALE } },
    { from: 1805, to: 1835, center: 5.8, halfWidth: 2.2, taper: 8, scenery: 'pillar',
      motion: { kind: 'gate', amplitude: 0, period: 7, phase: 1.5, minWidth: 0.6 * WIDTH_SCALE } },
  ],
};

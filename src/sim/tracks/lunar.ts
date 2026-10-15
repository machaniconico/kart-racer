import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

export const LUNAR_LENGTH = 2209.8782411911293;

export const lunar: TrackDef = {
  id: 'lunar', name: 'LUNAR BASIN', layoutVersion: 1, themeId: 'lunar',
  // Crater plain, two basin-rim hairpins, the habitat overpass, then the outer rim.
  controlPoints: [
    [0, 4, -151.5], [0, 4, -100], [0, 4, 0], [0, 4, 100], [0, 4, 200],
    [0, 4, 240], [0, 4.6, 260], [10.105, 5.8, 284.395], [34.5, 7, 294.5],
    [58.895, 8.2, 284.395], [69, 9.4, 260], [69, 10, 240], [69, 10.6, 220],
    [69, 11.8, 190], [85, 14.2, 150], [120, 17.8, 130], [160, 19.6, 130],
    [220, 20.2, 130], [250, 20.8, 130], [274.395, 21.4, 119.895],
    [284.5, 22, 95.5], [274.395, 22.6, 71.105], [250, 23.2, 61],
    [220, 23.2, 61], [150, 22.6, 61], [80, 22, 61], [0, 22, 61],
    [-80, 22, 61], [-160, 11.8, 61], [-225, 6.4, 25],
    [-290, 4, -40], [-320, 4, -120], [-315, 4, -210],
    [-280, 4.6, -290], [-220, 5.8, -340], [-140, 5.8, -355],
    [-65, 4.6, -340], [-15, 4, -305], [0, 4, -260],
  ],
  scale: 1, samplesPerSegment: 32,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 24,
  boxRows: [0.025, 0.16, 0.29, 0.42, 0.62, 0.73, 0.84, 0.94],
  boxLanes: [-5.33, 0, 5.33],
  decks: [{ from: 1136.355828363949, to: 1186.355828363949 }],
  racingLine: [{ distance: 0, offset: 0 }, { distance: LUNAR_LENGTH, offset: 0 }],
  surfaces: [
    // Each rim launches across a lane-sized crater; the paved centre is a continuous bypass.
    { kind: 'jump', from: 100, to: 104, offsetMin: 3.8, offsetMax: BASE_ROAD_HALF_WIDTH },
    { kind: 'pit', from: 110, to: 120, offsetMin: 3.8, offsetMax: BASE_ROAD_HALF_WIDTH },
    { kind: 'jump', from: 250, to: 254, offsetMin: -BASE_ROAD_HALF_WIDTH, offsetMax: -3.8 },
    { kind: 'pit', from: 260, to: 270, offsetMin: -BASE_ROAD_HALF_WIDTH, offsetMax: -3.8 },
    { kind: 'jump', from: 1020, to: 1024, offsetMin: 3.8, offsetMax: BASE_ROAD_HALF_WIDTH },
    { kind: 'pit', from: 1030, to: 1040, offsetMin: 3.8, offsetMax: BASE_ROAD_HALF_WIDTH },
    { kind: 'dirt', from: 1460, to: 1550 },
    { kind: 'boost', from: 1680, to: 1695 },
  ],
};

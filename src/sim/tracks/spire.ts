import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

export const spire: TrackDef = {
  id: 'spire', name: 'SKY SPIRE', layoutVersion: 1, themeId: 'spire',
  physics: {},
  // Three compact ascending terraces cross the ground return at right angles.
  // Level switchbacks and crossing approaches separate the climbs from the turns.
  // Start on the first terrace so all eight grid positions lie on a level straight.
  controlPoints: [
    [40, 19, 0], [80, 19, 0], [136, 19, 0],
    [156, 19, 5.358984], [170.641016, 19, 20], [176, 19, 40],
    [170.641016, 19, 60], [156, 19, 74.641016], [136, 19, 80],
    [100, 23, 80], [70, 32, 80], [40, 37, 80],
    [10, 37, 80], [-20, 37, 80], [-80, 37, 80],
    [-136, 37, 80], [-156, 37, 85.358984], [-170.641016, 37, 100],
    [-176, 37, 120], [-170.641016, 37, 140], [-156, 37, 154.641016],
    [-136, 37, 160], [-100, 41, 160], [-70, 50, 160],
    [-40, 55, 160], [-10, 55, 160], [20, 55, 160],
    [80, 55, 160], [136, 55, 160], [166, 55, 151.961524],
    [187.961524, 55, 130], [196, 55, 100], [196, 55, 60],
    [196, 47, 18], [196, 27, -24], [196, 7, -66],
    [196, 1, -106], [196, 1, -140], [196, 1, -160],
    [190.641016, 1, -180], [176, 1, -194.641016], [156, 1, -200],
    [100, 1, -200], [40, 1, -200], [20, 1, -194.641016],
    [5.358984, 1, -180], [0, 1, -160], [0, 1, -120],
    [0, 1, -60], [0, 1, 0], [0, 1, 80],
    [0, 1, 160], [0, 1, 210], [-5.358984, 1, 230],
    [-20, 1, 244.641016], [-40, 1, 250], [-100, 1, 250],
    [-156, 1, 250], [-176, 1, 244.641016], [-190.641016, 1, 230],
    [-196, 1, 210], [-196, 1, 140], [-196, 1, 80],
    [-196, 1, 40], [-190.641016, 1, 20], [-176, 1, 5.358984],
    [-156, 1, 0], [-136, 1, 0], [-130, 1, 0],
    [-100, 5, 0], [-70, 14, 0], [-40, 19, 0],
    [-10, 19, 0], [20, 19, 0],
  ],
  scale: 1, samplesPerSegment: 16, spline: 'centripetal',
  roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH,
  // Keep all six crossing approaches over 25 m from the regular checkpoint grid.
  checkpointCount: 24, checkpointPhase: -0.12,
  // Spread pickups along straights so packs can separate before the switchbacks.
  boxRows: [0.15, 0.30, 0.52, 0.61, 0.68, 0.77, 0.85, 0.935],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [{ distance: 0, offset: 0 }, { distance: 2526.4347509123468, offset: 0 }],
  decks: [{ from: 2446.4347509123477, to: 2526.4347509123468 }, { from: 317.4695200004162, to: 397.4695200004162 }, { from: 714.9394296867208, to: 794.9394296867208 }],
  // The plunge ends on a straight launch and landing before the compact return.
  surfaces: [{ kind: 'jump', from: 1202, to: 1206, duration: 0.9, height: 2 }],
};

import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

export const FOREST_LENGTH = 2237.3654195978625;

const base = { roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH };
const narrow = { roadHalfWidth: BASE_ROAD_HALF_WIDTH * 0.55, wallHalfWidth: BASE_WALL_HALF_WIDTH * 0.55 };

export const forest: TrackDef = {
  id: 'forest', name: 'MOSSWOOD TRAIL', layoutVersion: 1, themeId: 'forest',
  controlPoints: [
    // A broad, level log bridge clears the lower trail by 13.2 m. Its gentle
    // approaches keep the full spline (including overshoot) below 14 m of relief.
    [-243, 0, 0], [-195, 0, 0], [-155, 4.4, 0], [-115, 9.2, 0], [-75, 13.2, 0],
    [-35, 13.2, 0], [5, 13.2, 0], [45, 13.2, 0], [85, 13.2, 0], [125, 9.2, 0],
    [165, 4.4, 0], [205, 0, 0], [240, 0, 0],
    // Two woodland hairpins return into the canopy.
    [251.25, 0, 3.014428], [259.485572, 0, 11.25], [262.5, 0, 22.5],
    [259.485572, 0, 33.75], [251.25, 0, 41.985572], [240, 0, 45],
    // Lift the return shoulder clear of the neighbouring bridge approach's bank.
    [205, 0, 45], [170, 1, 45], [111, 2, 45],
    [81, 2, 53.038476], [59.038476, 1, 75], [51, 0, 105],
    [51, 0, 145], [51, 0, 190], [51, 0, 247.5],
    [47.583648, 0, 260.25], [38.25, 0, 269.583648], [25.5, 0, 273],
    [12.75, 0, 269.583648], [3.416352, 0, 260.25], [0, 0, 247.5],
    [0, 0, 190], [0, 0, 150], [0, 0, 110], [0, 0, 70], [0, 0, 30],
    [0, 0, -10], [0, 0, -50], [0, 0, -90], [0, 0, -130],
    // A 2 m terrace keeps both edges of the bank above the shared ground plane.
    [0, 2, -170], [0, 2, -210], [0, 2, -260],
    [-8.038476, 2, -290], [-30, 0, -311.961524], [-60, 0, -320],
    // Two separate S sections: fern slalom, then the western root bends.
    [-95, 0, -320], [-130, 0, -314], [-165, 0, -326], [-200, 0, -314],
    [-235, 0, -320], [-270, 0, -320],
    [-300, 0, -311.961524], [-321.961524, 0, -290], [-330, 0, -260],
    [-330, 0, -225], [-324, 0, -190], [-336, 0, -155], [-324, 0, -120],
    [-330, 0, -85], [-330, 0, -60],
    [-321.961524, 0, -30], [-300, 0, -8.038476], [-270, 0, 0],
  ],
  scale: 1, samplesPerSegment: 16, spline: 'centripetal', ...base,
  checkpointCount: 24,
  boxRows: [0.02, 0.16, 0.27, 0.39, 0.52, 0.66, 0.79, 0.91],
  boxLanes: [-5.33, 0, 5.33],
  decks: [{ from: 208, to: 278 }],
  widthKeys: [
    { distance: 100, ...base }, { distance: 130, ...narrow },
    { distance: 170, ...narrow }, { distance: 200, ...base },
    { distance: 1300, ...base }, { distance: 1330, ...narrow },
    { distance: 1370, ...narrow }, { distance: 1400, ...base },
  ],
  racingLine: [{ distance: 0, offset: 0 }, { distance: FOREST_LENGTH, offset: 0 }],
  surfaces: [
    { kind: 'dirt', from: 350, to: 440 },
    { kind: 'dirt', from: 760, to: 840 },
    { kind: 'dirt', from: 1600, to: 1710 },
    { kind: 'jump', from: 1260, to: 1263 },
  ],
  bankKeys: [
    { distance: 1430, roll: 0 }, { distance: 1460, roll: 0.2 },
    { distance: 1510, roll: 0.2 }, { distance: 1540, roll: 0 },
  ],
};

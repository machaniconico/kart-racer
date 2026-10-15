import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

export const SERPENTINE_LENGTH = 2328.5952422904697;

// Close-spaced controls form opposite turns with distinct minimum radii (11.04 / 11.94 m).
// Review correction: keep 50% asphalt, but move the rails inward. With KART_RADIUS
// 0.95, wall 5.60 limits the kart centre to 4.65 < road 4.68: the grass cannot
// act as a free brake. This supersedes the original 6.825 m wall specification.
// The curvature ramps soften turn-in without changing the shared simulation.
// Approaches fan apart before the road widens again, leaving room for the rails.
export const serpentine: TrackDef = {
  id: 'serpentine', name: 'SERPENT PASS', layoutVersion: 1, themeId: 'serpentine',
  controlPoints: [
    // Lower switchback: a level, 50%-width drift zone at 350–409 m.
    [0, 4, 0], [100, 4, 0], [200, 4, 0], [290, 4, 0], [330, 4, 0],
    [345, 4, 0], [350.000000, 4, 0.000000],
    [352.843943, 4, 0.024772],
    [355.682063, 4, 0.198021],
    [358.485346, 4, 0.666201],
    [361.179311, 4, 1.565706],
    [363.628389, 4, 2.999610],
    [365.684341, 4, 4.955655],
    [367.236627, 4, 7.331252],
    [368.202417, 4, 9.999641],
    [368.530176, 4, 12.818440],
    [368.202417, 4, 15.637239],
    [367.236627, 4, 18.305629],
    [365.684341, 4, 20.681226],
    [363.628389, 4, 22.637270],
    [361.179311, 4, 24.071173],
    [358.485346, 4, 24.970680],
    [355.682063, 4, 25.438859],
    [352.843943, 4, 25.612109],
    [350.000000, 4, 25.636881],
    [344.750000, 4, 25.636881], [329.000000, 4, 25.636881], [290, 4, 35], [220, 4, 75],
    // Climb to the second level switchback at 844–908 m.
    [120, 24, 110], [80, 29, 130], [40, 29, 130], [0, 29, 130], [-40, 29, 130], [-65, 29, 130], [-70.000000, 29, 130.000000],
    [-73.074167, 29, 130.026777],
    [-76.142040, 29, 130.214051],
    [-79.172255, 29, 130.720131],
    [-82.084303, 29, 131.692454],
    [-84.731639, 29, 133.242435],
    [-86.954026, 29, 135.356827],
    [-88.631973, 29, 137.924735],
    [-89.675946, 29, 140.809136],
    [-90.030238, 29, 143.856123],
    [-89.675946, 29, 146.903111],
    [-88.631973, 29, 149.787513],
    [-86.954026, 29, 152.355421],
    [-84.731639, 29, 154.469811],
    [-82.084303, 29, 156.019792],
    [-79.172255, 29, 156.992116],
    [-76.142040, 29, 157.498195],
    [-73.074167, 29, 157.685470],
    [-70.000000, 29, 157.712247],
    [-64.325000, 29, 157.712247], [-47.300000, 29, 157.712247], [-10, 29, 165], [60, 29, 205],
    // Full-width summit hairpin, then the banked descent back to the grid.
    [160, 29, 230], [260, 29, 230], [330, 29, 230],
    [354.395, 29, 240.105], [364.5, 29, 264.5], [354.395, 29, 288.895], [330, 29, 299],
    [295, 29, 299], [220, 29, 299], [100, 29, 299], [-40, 29, 299],
    [-140, 14, 260], [-180, 4, 180], [-180, 4, 80], [-160, 4, 20],
    [-120, 4, -10], [-60, 4, 0],
  ],
  spline: 'centripetal', scale: 1, samplesPerSegment: 24,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 24,
  boxRows: [0.03, 0.10, 0.26, 0.46, 0.55, 0.66, 0.78, 0.9],
  boxLanes: [-5.33, 0, 5.33],
  widthKeys: [
    { distance: 290, roadHalfWidth: 9.36, wallHalfWidth: 13.65 },
    { distance: 320, roadHalfWidth: 4.68, wallHalfWidth: 5.6 },
    { distance: 425, roadHalfWidth: 4.68, wallHalfWidth: 5.6 },
    { distance: 455, roadHalfWidth: 9.36, wallHalfWidth: 13.65 },
    { distance: 780, roadHalfWidth: 9.36, wallHalfWidth: 13.65 },
    { distance: 810, roadHalfWidth: 4.68, wallHalfWidth: 5.6 },
    { distance: 930, roadHalfWidth: 4.68, wallHalfWidth: 5.6 },
    { distance: 960, roadHalfWidth: 9.36, wallHalfWidth: 13.65 },
  ],
  bankKeys: [
    { distance: 0, roll: 0 }, { distance: 1770, roll: 0 },
    { distance: 1800, roll: 0.3 }, { distance: 1850, roll: 0.3 }, { distance: 1880, roll: 0 },
    { distance: SERPENTINE_LENGTH, roll: 0 },
  ],
  // Aim 1.5 m inside each turn so the existing curvature-braking AI can release
  // its exit turbo without washing out into the rail. Both approaches taper in.
  racingLine: [
    { distance: 0, offset: 0 }, { distance: 320, offset: 0 },
    { distance: 350, offset: -1.5 }, { distance: 395, offset: -1.5 }, { distance: 425, offset: 0 },
    { distance: 810, offset: 0 }, { distance: 844, offset: 1.5 },
    { distance: 895, offset: 1.5 }, { distance: 930, offset: 0 },
    { distance: SERPENTINE_LENGTH, offset: 0 },
  ],
  surfaces: [],
};

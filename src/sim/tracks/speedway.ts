import { buildTrack } from '../track';
import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const layout: TrackDef = {
  id: 'speedway', name: 'THUNDER OVAL', layoutVersion: 1, themeId: 'speedway',
  // Two 752 m straights joined by long, elliptical stadium turns.
  // Tighter entries and exits let CPUs build drift boosts before each straight.
  // Collinear approach points keep the long straights and start seam flat.
  // Both turns have positive curvature, so both +0.35-radian banks lower the inside.
  // Height 5 keeps their low edges above the infield.
  controlPoints: [
    [-300, 5, 0], [-200, 5, 0], [-100, 5, 0], [0, 5, 0],
    [100, 5, 0], [200, 5, 0], [300, 5, 0], [350, 5, 0], [400, 5, 0],
    [430, 5, 24.115], [451.962, 5, 90], [460, 5, 180],
    [451.962, 5, 270], [430, 5, 335.885], [400, 5, 360], [350, 5, 360],
    [300, 5, 360], [200, 5, 360], [100, 5, 360], [0, 5, 360],
    [-100, 5, 360], [-200, 5, 360], [-300, 5, 360], [-350, 5, 360], [-400, 5, 360],
    [-430, 5, 335.885], [-451.962, 5, 270], [-460, 5, 180],
    [-451.962, 5, 90], [-430, 5, 24.115], [-400, 5, 0], [-350, 5, 0],
  ],
  scale: 0.94, samplesPerSegment: 32,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 24,
  boxRows: [0.04, 0.18, 0.30, 0.43, 0.56, 0.69, 0.82, 0.94],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [], surfaces: [],
};

const geometry = buildTrack(layout);
const at = (point: number) => geometry.samples[point * layout.samplesPerSegment]!.distance;
export const SPEEDWAY_LENGTH = geometry.length;

export const speedway: TrackDef = {
  ...layout,
  // Hold the low, inside lane through both banks and return to centre on the straights.
  racingLine: [
    { distance: 0, offset: 0 },
    { distance: at(7), offset: 0 }, { distance: at(8), offset: -6.5 },
    { distance: at(14), offset: -6.5 }, { distance: at(15), offset: 0 },
    { distance: at(23), offset: 0 }, { distance: at(24), offset: -6.5 },
    { distance: at(30), offset: -6.5 }, { distance: at(31), offset: 0 },
    { distance: SPEEDWAY_LENGTH, offset: 0 },
  ],
  bankKeys: [
    { distance: 0, roll: 0 },
    { distance: at(7), roll: 0 }, { distance: at(8), roll: 0.35 },
    { distance: at(14), roll: 0.35 }, { distance: at(15), roll: 0 },
    { distance: at(23), roll: 0 }, { distance: at(24), roll: 0.35 },
    { distance: at(30), roll: 0.35 }, { distance: at(31), roll: 0 },
    { distance: SPEEDWAY_LENGTH, roll: 0 },
  ],
  surfaces: [
    { kind: 'boost', from: 210, to: 220 },
    { kind: 'boost', from: 245, to: 255 },
    { kind: 'boost', from: 280, to: 290 },
  ],
  // The pit wall sweeps along the outer half of the back straight. The centre
  // remains open throughout its cycle, including approaches and tapered noses.
  barriers: [{
    from: at(18) + 30, to: at(18) + 62, center: 6.5, halfWidth: 1.3, taper: 8,
    scenery: 'block', motion: { kind: 'sweep', amplitude: 1.5, period: 8, phase: 0 },
  }],
};

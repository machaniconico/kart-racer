import { buildTrack } from '../track';
import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

const layout: TrackDef = {
  id: 'speedway', name: 'THUNDER OVAL', layoutVersion: 1, themeId: 'speedway',
  // Two 752 m straights joined by broad, 112.8 m radius stadium turns.
  // Collinear approach points keep the long straights and start seam flat.
  // Height 5 keeps the low edge of both 0.35-radian banks above the infield.
  controlPoints: [
    [-300, 5, 0], [-200, 5, 0], [-100, 5, 0], [0, 5, 0],
    [100, 5, 0], [200, 5, 0], [300, 5, 0], [350, 5, 0], [400, 5, 0],
    [460, 5, 16.077], [503.923, 5, 60], [520, 5, 120],
    [503.923, 5, 180], [460, 5, 223.923], [400, 5, 240], [350, 5, 240],
    [300, 5, 240], [200, 5, 240], [100, 5, 240], [0, 5, 240],
    [-100, 5, 240], [-200, 5, 240], [-300, 5, 240], [-350, 5, 240], [-400, 5, 240],
    [-460, 5, 223.923], [-503.923, 5, 180], [-520, 5, 120],
    [-503.923, 5, 60], [-460, 5, 16.077], [-400, 5, 0], [-350, 5, 0],
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
  racingLine: [{ distance: 0, offset: 0 }, { distance: SPEEDWAY_LENGTH, offset: 0 }],
  bankKeys: [
    { distance: 0, roll: 0 },
    { distance: at(7), roll: 0 }, { distance: at(8), roll: 0.35 },
    { distance: at(14), roll: 0.35 }, { distance: at(15), roll: 0 },
    { distance: at(23), roll: 0 }, { distance: at(24), roll: -0.35 },
    { distance: at(30), roll: -0.35 }, { distance: at(31), roll: 0 },
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

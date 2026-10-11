import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

/** Shared arc-length bounds keep the tunnel shell aligned with its boost panel. */
export const NEON_TUNNEL = { from: 24, to: 86 } as const;

export const neon: TrackDef = {
  id: 'neon',
  name: 'NEON NIGHTLINE',
  layoutVersion: 2,
  // Four city blocks with 110m straights; sampled minimum corner radius is 18.56m.
  // Collinear points preserve a straight tunnel and a smooth seam.
  controlPoints: [
    [-55, 0, -90], [-33, 0, -90], [-11, 0, -90], [11, 0, -90], [33, 0, -90], [55, 0, -90],
    [79.748737, 0, -79.748737], [90, 0, -55],
    [90, 0, -33], [90, 0, -11], [90, 0, 11], [90, 0, 33], [90, 0, 55],
    [79.748737, 0, 79.748737], [55, 0, 90],
    [33, 0, 90], [11, 0, 90], [-11, 0, 90], [-33, 0, 90], [-55, 0, 90],
    [-79.748737, 0, 79.748737], [-90, 0, 55],
    [-90, 0, 33], [-90, 0, 11], [-90, 0, -11], [-90, 0, -33], [-90, 0, -55],
    [-79.748737, 0, -79.748737],
  ],
  scale: 1,
  samplesPerSegment: 32,
  spline: 'centripetal',
  roadHalfWidth: BASE_ROAD_HALF_WIDTH,
  wallHalfWidth: BASE_WALL_HALF_WIDTH,
  checkpointCount: 12,
  boxRows: [0.12, 0.36, 0.58, 0.81],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [
    { distance: 0, offset: 0 },
    { distance: 95, offset: 0 }, { distance: 137, offset: -3.25 }, { distance: 177, offset: 0 },
    { distance: 260, offset: 0 }, { distance: 302, offset: -3.25 }, { distance: 342, offset: 0 },
    { distance: 425, offset: 0 }, { distance: 467, offset: -3.25 }, { distance: 507, offset: 0 },
    { distance: 590, offset: 0 }, { distance: 632, offset: -3.25 },
  ],
  // A quarter-metre boundary survives float32 snapshots exactly (C-002).
  surfaces: [{ kind: 'boost', from: NEON_TUNNEL.from, to: NEON_TUNNEL.from + 6 }],
  themeId: 'neon',
};

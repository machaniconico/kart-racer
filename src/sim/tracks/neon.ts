import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

/** Shared arc-length bounds keep the tunnel shell aligned with its boost panel. */
export const NEON_TUNNEL = { from: 24, to: 86 } as const;

export const neon: TrackDef = {
  id: 'neon',
  name: 'NEON NIGHTLINE',
  layoutVersion: 3,
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
    { distance: 95, offset: 0 }, { distance: 137, offset: -3.25 },
    { distance: 176, offset: 6.8 }, { distance: 208, offset: 6.8 }, { distance: 240, offset: 0 },
    { distance: 260, offset: 0 }, { distance: 302, offset: -3.25 },
    { distance: 340, offset: 5.2 }, { distance: 370, offset: 5.2 }, { distance: 400, offset: 0 },
    { distance: 425, offset: 0 }, { distance: 467, offset: -3.25 }, { distance: 507, offset: 0 },
    { distance: 590, offset: 0 }, { distance: 632, offset: -3.25 },
  ],
  // Moving bands intentionally start at corner exits; only spin requires a straight.
  barriers: [
    {
      // M3-05: center 0 -> -2 m clears CPU approaches while retaining the 4 m sweep.
      from: 176, to: 208, center: -2, halfWidth: 1.2, taper: 4, scenery: 'pillar',
      motion: { kind: 'sweep', amplitude: 4.0, period: 6, phase: 0 },
    },
    {
      // M3-05: taper 4 -> 8 m keeps halfWidth / taper within the validator's 0.5 limit.
      from: 340, to: 370, center: 0, halfWidth: 3.6, taper: 8, scenery: 'block',
      motion: { kind: 'gate', amplitude: 0, period: 5, phase: 0, minWidth: 1.2 },
    },
  ],
  surfaces: [
    // A quarter-metre boundary survives float32 snapshots exactly (C-002).
    { kind: 'boost', from: NEON_TUNNEL.from, to: NEON_TUNNEL.from + 6 },
    { kind: 'spin', from: 558, to: 570, offsetMin: -6, offsetMax: 6, rate: 1.0 },
  ],
  themeId: 'neon',
};

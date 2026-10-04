import type { TrackDef } from '../types';

/** Shared arc-length bounds keep the tunnel shell aligned with its boost panel. */
export const NEON_TUNNEL = { from: 24, to: 86 } as const;

export const neon: TrackDef = {
  id: 'neon',
  name: 'NEON NIGHTLINE',
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
  roadHalfWidth: 7.2,
  wallHalfWidth: 10.5,
  checkpointCount: 12,
  boxRows: [0.12, 0.36, 0.58, 0.81],
  boxLanes: [-4.1, 0, 4.1],
  racingLine: [
    { distance: 0, offset: 0 },
    { distance: 95, offset: 0 }, { distance: 137, offset: -2.5 }, { distance: 177, offset: 0 },
    { distance: 260, offset: 0 }, { distance: 302, offset: -2.5 }, { distance: 342, offset: 0 },
    { distance: 425, offset: 0 }, { distance: 467, offset: -2.5 }, { distance: 507, offset: 0 },
    { distance: 590, offset: 0 }, { distance: 632, offset: -2.5 },
  ],
  // A quarter-metre boundary survives float32 snapshots exactly (C-002).
  surfaces: [{ kind: 'boost', from: NEON_TUNNEL.from, to: NEON_TUNNEL.from + 6 }],
  themeId: 'neon',
};

import { buildTrack } from '../track';
import type { TrackDef } from '../types';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

// Each 180-degree cap eases into/out of a 33 m circular bowl. Ramping
// curvature avoids the tight kink of a straight-to-circle Catmull join.
const radius = 33;
const ramp = 24;
const capLength = Math.PI * radius + ramp;
const capSegments = Math.ceil(capLength / 4);
const capStep = capLength / capSegments;
const headingAt = (s: number) => s < ramp ? s * s / (2 * radius * ramp)
  : s > capLength - ramp ? Math.PI - (capLength - s) ** 2 / (2 * radius * ramp)
  : (s - ramp / 2) / radius;
const cap: [number, number][] = [[0, 0]];
let x = 0, z = 0;
for (let i = 1; i <= capSegments; i++) {
  // Midpoint quadrature gives equally spaced control points on the eased arc.
  const step = capLength / capSegments / 16;
  for (let j = 0; j < 16; j++) {
    const heading = headingAt(((i - 1) * 16 + j + 0.5) * step);
    x += Math.cos(heading) * step;
    z += Math.sin(heading) * step;
  }
  cap.push([i === capSegments ? 0 : x, z]);
}
const separation = z;
const points: [number, number, number][] = [
  [-350, 12, 0], [-290, 12, 0], [-240, 12, 0], [-200, 12, 0],
  [-160, 12, -12], [-120, 12, -48], [-80, 12, -92], [-40, 12, -120],
  [0, 12, -120], [40, 12, -92], [80, 12, -48], [120, 12, -12],
  [160, 12, 0], [200, 12, 0], [300, 12, 0], [380, 12, 0], [430, 12, 0],
];
const firstEntry = points.length - 1;
points.push([450 - 2 * capStep, 12, 0], [450 - capStep, 12, 0]);
points.push(...cap.map(([dx, dz]): [number, number, number] => [450 + dx, 12, dz]));
points.push([450 - capStep, 12, separation], [450 - 2 * capStep, 12, separation], [430, 12, separation]);
const firstExit = points.length - 1;
points.push(...[380, 300, 200, 100, 0, -100, -200, -300, -380, -430]
  .map((x): [number, number, number] => [x, 12, separation]));
const secondEntry = points.length - 1;
points.push([-450 + 2 * capStep, 12, separation], [-450 + capStep, 12, separation]);
points.push(...cap.map(([dx, dz]): [number, number, number] => [-450 - dx, 12, separation - dz]));
points.push([-450 + capStep, 12, 0], [-450 + 2 * capStep, 12, 0], [-430, 12, 0]);
const secondExit = points.length - 1;
points.push([-390, 12, 0]);

const layout: TrackDef = {
  id: 'velodrome', name: 'WALL BOWL', layoutVersion: 1, themeId: 'velodrome',
  controlPoints: points, scale: 1, samplesPerSegment: 16,
  roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH,
  physics: { maxRoll: 0.85 }, checkpointCount: 24,
  boxRows: [0.04, 0.17, 0.30, 0.43, 0.56, 0.69, 0.82, 0.94],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [], surfaces: [],
};

const geometry = buildTrack(layout);
const at = (point: number) => geometry.samples[point * layout.samplesPerSegment]!.distance;
const bowls = [
  { from: at(firstEntry), to: at(firstExit) },
  { from: at(secondEntry), to: at(secondExit) },
];

export const velodrome: TrackDef = {
  ...layout,
  // The S rolls left/right/left. Reversals span > 60 m, and each bowl has
  // a 60 m approach/exit ramp: neither exceeds 0.02 rad/m, including the seam.
  bankKeys: [
    { distance: 0, roll: 0 },
    { distance: at(2) - 10, roll: 0 }, { distance: at(3), roll: -0.6 },
    { distance: at(4), roll: -0.6 }, { distance: at(6), roll: 0.6 },
    { distance: at(9), roll: 0.6 }, { distance: at(11), roll: -0.6 },
    { distance: at(12), roll: -0.6 }, { distance: at(13), roll: 0 },
    ...bowls.flatMap(({ from, to }) => [
      { distance: from - 60, roll: 0 }, { distance: from, roll: 0.85 },
      { distance: to, roll: 0.85 }, { distance: to + 60, roll: 0 },
    ]),
    { distance: geometry.length, roll: 0 },
  ],
  // The bowls keep a 14.4 m timber racing surface. The narrowed approach
  // makes holding the bank's inside line matter at turbo speed.
  widthKeys: [
    { distance: 0, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    ...bowls.flatMap(({ from, to }) => [
      { distance: from - 60, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
      { distance: from, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
      { distance: to, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
      { distance: to + 60, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    ]),
    { distance: geometry.length, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
  ],
  racingLine: [
    { distance: 0, offset: 0 },
    ...bowls.flatMap(({ from, to }) => [
      { distance: from - 60, offset: 0 }, { distance: from, offset: -6 },
      { distance: to, offset: -6 }, { distance: to + 60, offset: 0 },
    ]),
    { distance: geometry.length, offset: 0 },
  ],
};

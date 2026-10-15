import type { TrackDef } from '../types';
import { buildTrack } from '../track';
import { islandSplit } from './features';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH, WIDTH_SCALE } from './widths';

const base = { roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH };
const layout: TrackDef = {
  id: 'temple', name: 'SUNKEN TEMPLE', layoutVersion: 1, themeId: 'temple',
  // Enter the sunken courtyard, climb the eastern shrines, cross its raised
  // causeway, then weave through the jungle terraces back to the start.
  controlPoints: [
    [-170, 2, 0], [-100, 2, 0], [0, 2, 0], [100, 2, 0], [200, 2, 0],
    [240, 2, 0], [260, 3, 0], [284.395, 4, -10.105], [294.5, 5, -34.5],
    [284.395, 6, -58.895], [260, 7, -69], [240, 8, -69], [220, 9, -69],
    [190, 10, -69], [150, 12, -85], [130, 15, -120], [130, 18, -160],
    [130, 20, -220], [130, 20, -250], [119.895, 20, -274.395],
    [95.5, 20, -284.5], [71.105, 20, -274.395], [61, 20, -250],
    [61, 20, -220], [61, 20, -150], [61, 20, -80], [61, 20, 0],
    [61, 20, 80], [61, 11, 160], [30, 5, 220], [-30, 2, 280],
    [-90, 2, 310], [-170, 2, 310], [-250, 3, 310], [-320, 4, 290],
    [-340, 5, 245], [-328, 6, 195], [-340, 7, 145], [-328, 7, 95],
    [-340, 7, 45], [-320, 7, 0], [-260, 4, 0],
  ],
  scale: 1, samplesPerSegment: 32, ...base,
  checkpointCount: 24,
  boxRows: [0.04, 0.23, 0.32, 0.44, 0.60, 0.72, 0.82, 0.93],
  boxLanes: [-5.33, 0, 5.33],
  racingLine: [], surfaces: [],
};

const geometry = buildTrack(layout);
const at = (index: number) => geometry.samples[index * layout.samplesPerSegment]!.distance;
export const TEMPLE_LENGTH = geometry.length;
// The eastern hairpin turns toward positive offsets. Its inner lane is
// shorter and tighter; 10.5 m lanes keep the road clear of the entry's centre
// of curvature, and both island tips stay clear of the 469.6 m checkpoint.
const islandFrom = 445, islandTo = 495;
const island = islandSplit({ from: islandFrom, to: islandTo, islandHalf: 3,
  laneWidth: 10.5, taper: 10, scenery: 'building', risky: 'inner', bend: 1 });
const lane = island.splits[0]!.lanes.find(candidate => candidate.risk === 0)!;
const safeOffset = (lane.offsetMin + lane.offsetMax) / 2;

export const temple: TrackDef = {
  ...layout,
  decks: [{ from: at(26) - 28, to: at(26) + 28 }],
  widthKeys: [
    { distance: islandFrom - 40, ...base },
    ...island.widthKeys.map(key => ({ ...key, wallHalfWidth: Math.max(BASE_WALL_HALF_WIDTH, key.roadHalfWidth) })),
    { distance: islandTo + 40, ...base },
  ],
  splits: island.splits,
  barriers: [
    ...island.barriers,
    // Stone doors still cover 2.6 m of road when retracted; the central
    // passage remains open even when each door is fully extended.
    { from: 200, to: 222, center: 8, halfWidth: 3, taper: 7, scenery: 'pillar',
      motion: { kind: 'gate', amplitude: 0, period: 7, phase: 0, minWidth: WIDTH_SCALE } },
    { from: at(24) + 15, to: at(24) + 37, center: -8, halfWidth: 3, taper: 7, scenery: 'pillar',
      motion: { kind: 'gate', amplitude: 0, period: 9, phase: 1, minWidth: WIDTH_SCALE } },
  ],
  racingLine: [
    { distance: 0, offset: 0 },
    { distance: islandFrom - 40, offset: 0 }, { distance: islandFrom, offset: safeOffset },
    { distance: islandTo, offset: safeOffset }, { distance: islandTo + 40, offset: 0 },
    { distance: geometry.length, offset: 0 },
  ],
  surfaces: [
    { kind: 'spin', from: 130, to: 142, offsetMin: -6, offsetMax: 6, rate: 0.8 },
    { kind: 'spin', from: at(25) + 20, to: at(25) + 32, offsetMin: -6, offsetMax: 6, rate: -0.8 },
    { kind: 'boost', from: at(31) + 24, to: at(31) + 30 },
  ],
};

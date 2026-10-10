import { describe, expect, it } from 'vitest';
import { corridorAt, KART_RADIUS, validateTrackDef, widthAt } from '../corridor';
import { buildTrack } from '../track';
import { meadow } from './meadow';
import { islandSplit } from './features';

const options = { from: 140, to: 200, islandHalf: 6, laneWidth: 9,
  taper: 12, scenery: 'rock', risky: 'inner', bend: 1 } as const;

describe('islandSplit', () => {
  it('builds a valid JSON course with two full-width lanes, 20 m ramps and a clear approach', () => {
    const feature = islandSplit(options);
    const def = { ...meadow, checkpointCount: 1, boxRows: [0.4, 0.55, 0.7, 0.85], ...feature };
    const json = JSON.stringify(def);
    expect(() => validateTrackDef(def)).not.toThrow();
    expect(JSON.stringify(def)).toBe(json);
    expect(islandSplit(options)).toEqual(feature);
    expect(JSON.parse(JSON.stringify(feature))).toEqual(feature);
    const track = buildTrack(def);
    const barrier = feature.barriers[0]!;
    expect(barrier.taper).toBeGreaterThanOrEqual(8);
    expect(barrier.from).toBeGreaterThanOrEqual(options.from);
    expect(barrier.to).toBeLessThanOrEqual(options.to);
    for (let d = options.from; d <= options.to; d += 0.25) {
      const intervals = corridorAt(track, d, 0);
      expect(intervals).toHaveLength(2);
      for (let lane = 0; lane < 2; lane++) {
        expect(feature.splits[0]!.lanes[lane]!.offsetMin).toBeGreaterThanOrEqual(intervals[lane]!.min - 1e-10);
        expect(feature.splits[0]!.lanes[lane]!.offsetMax).toBeLessThanOrEqual(intervals[lane]!.max + 1e-10);
        if (d >= barrier.from + barrier.taper! && d <= barrier.to - barrier.taper!) {
          expect(intervals[lane]!.max - intervals[lane]!.min).toBeCloseTo(options.laneWidth, 8);
        }
      }
    }
    for (let d = options.from - 35; d < options.from; d += 0.25) expect(corridorAt(track, d, 0)).toHaveLength(1);
    expect(feature.widthKeys.map(key => key.distance)).toEqual([120, 140, 200, 220]);
    for (let d = 120; d < 220; d += 0.25) {
      const a = widthAt(track, d);
      const b = widthAt(track, d + 0.25);
      expect(Math.abs(b.wallHalfWidth - a.wallHalfWidth) / 0.25).toBeLessThanOrEqual(0.35 + 1e-10);
      expect(Math.abs(b.roadHalfWidth - a.roadHalfWidth) / 0.25).toBeLessThanOrEqual(0.35 + 1e-10);
    }
  });

  it.each([-1, 1] as const)('assigns risk on both bend directions (%i) and can be relocated', bend => {
    for (const risky of ['inner', 'outer'] as const) {
      const feature = islandSplit({ ...options, bend, risky, scenery: 'building' });
      const riskyLane = feature.splits[0]!.lanes.find(lane => lane.risk === 1)!;
      expect(Math.sign(riskyLane.offsetMin + riskyLane.offsetMax)).toBe(risky === 'inner' ? bend : -bend);
      expect(feature.splits[0]!.lanes.filter(lane => lane.risk === 0)).toHaveLength(1);
      const shifted = islandSplit({ ...options, from: options.from + 100, to: options.to + 100, bend, risky });
      expect(shifted.widthKeys.map(key => key.distance)).toEqual(feature.widthKeys.map(key => key.distance + 100));
      expect(shifted.splits[0]!.lanes).toEqual(feature.splits[0]!.lanes);
    }
  });

  it('raises short tapers to the island minimum and keeps wider islands within the ramp slope limit', () => {
    const feature = islandSplit({ ...options, islandHalf: 10, taper: 2 });
    expect(feature.barriers[0]!.taper).toBe(20);
    expect(feature.widthKeys[1]!.wallHalfWidth - feature.widthKeys[0]!.wallHalfWidth).toBeLessThanOrEqual(7);
    expect(feature.splits[0]!.lanes[1]!.offsetMin).toBe(10 + KART_RADIUS);
    expect(() => validateTrackDef({ ...meadow, checkpointCount: 1,
      boxRows: [0.4, 0.55, 0.7, 0.85], ...feature })).not.toThrow();
  });

  it('rejects dimensions that cannot produce the requested island', () => {
    for (const change of [{ from: 19 }, { to: 150 }, { islandHalf: 0 }, { laneWidth: 3.49 }, { taper: NaN }]) {
      expect(() => islandSplit({ ...options, ...change })).toThrow(RangeError);
    }
  });
});

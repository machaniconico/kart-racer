import { describe, expect, it } from 'vitest';
import { corridorAt, exclusionAt, freeIntervalFor, KART_RADIUS, validateTrackDef, widthAt } from './corridor';
import { KART_RADIUS as RACE_RADIUS } from './race';
import { buildTrack } from './track';
import { getTrack, TRACK_IDS, TRACKS } from './tracks';
import type { Barrier, TrackDef } from './types';

const base = TRACKS.meadow;
const length = getTrack('meadow').length;
const band: Barrier = { from: 25, to: 40, center: 0, halfWidth: 2, taper: 4 };
const fixture = (overrides: Partial<TrackDef> = {}): TrackDef => ({ ...base, ...overrides });

describe('widthAt', () => {
  it('interpolates continuously across the lap seam every 0.5 m', () => {
    const track = buildTrack(fixture({ widthKeys: [
      { distance: 10, roadHalfWidth: 5, wallHalfWidth: 8 },
      { distance: length - 10, roadHalfWidth: 9, wallHalfWidth: 12 },
    ] }));
    for (let d = -20; d < length + 20; d += 0.5) {
      const a = widthAt(track, d);
      const b = widthAt(track, d + 0.5);
      expect(Math.abs(b.roadHalfWidth - a.roadHalfWidth)).toBeLessThanOrEqual(0.5 * 0.5);
      expect(Math.abs(b.wallHalfWidth - a.wallHalfWidth)).toBeLessThanOrEqual(0.5 * 0.5);
    }
    expect(widthAt(track, 0)).toEqual({ roadHalfWidth: 7, wallHalfWidth: 10 });
    expect(widthAt(track, length)).toEqual(widthAt(track, 0));
    expect(widthAt(track, -0.5)).toEqual(widthAt(track, length - 0.5));
  });

  it.each([undefined, [], [0], [10, length - 10], [0, length]])(
    'preserves constant widths with exact equality (keys %j)', distances => {
      const track = buildTrack(fixture({ widthKeys: distances?.map(distance => ({
        distance, roadHalfWidth: base.roadHalfWidth, wallHalfWidth: base.wallHalfWidth,
      })) }));
      for (let d = -10; d <= length + 10; d += 0.5) {
        const width = widthAt(track, d);
        expect(width.roadHalfWidth).toBe(track.def.roadHalfWidth);
        expect(width.wallHalfWidth).toBe(track.def.wallHalfWidth);
      }
    },
  );

  it('interpolates internal segments and accepts matching zero/length endpoints', () => {
    const def = fixture({ widthKeys: [
      { distance: 0, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
      { distance: 20, roadHalfWidth: 4.2, wallHalfWidth: 7.5 },
      { distance: length, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
    ] });
    expect(widthAt(buildTrack(def), 10)).toEqual({ roadHalfWidth: 5.7, wallHalfWidth: 9 });
    expect(() => validateTrackDef(def)).not.toThrow();
  });
});

describe('exclusionAt', () => {
  const track = getTrack('meadow');

  it('uses the simulation kart radius', () => { expect(KART_RADIUS).toBe(RACE_RADIUS); });

  it('has continuous, monotone semicircle and taper widths at 0.1 m steps', () => {
    const at = (d: number) => exclusionAt(track, band, d, 0)!.halfWidth;
    expect(at(band.from - KART_RADIUS)).toBe(0);
    expect(at(band.from)).toBe(KART_RADIUS);
    expect(at(band.from + band.taper!)).toBe(band.halfWidth + KART_RADIUS);
    const points = Array.from({ length: 50 }, (_, i) => band.from - KART_RADIUS + i * 0.1);
    points.push(band.from + band.taper!);
    points.sort((a, b) => a - b);
    for (let i = 1; i < points.length; i++) {
      const delta = at(points[i]!) - at(points[i - 1]!);
      expect(delta).toBeGreaterThanOrEqual(-1e-12);
      expect(delta).toBeLessThanOrEqual(0.6);
    }
    expect(exclusionAt(track, band, band.from - KART_RADIUS - 0.01, 0)).toBeNull();
    expect(exclusionAt(track, band, band.to + KART_RADIUS + 0.01, 0)).toBeNull();
  });

  it('mirrors the rear cap and taper', () => {
    for (let i = 0; i <= 49; i++) {
      const delta = -KART_RADIUS + i * 0.1;
      const front = exclusionAt(track, band, band.from + delta, 0)!;
      const rear = exclusionAt(track, band, band.to - delta, 0)!;
      expect(front.halfWidth).toBeCloseTo(rear.halfWidth, 6);
    }
    expect(exclusionAt(track, band, band.to, 0)!.halfWidth).toBe(KART_RADIUS);
    expect(exclusionAt(track, band, band.to + KART_RADIUS, 0)!.halfWidth).toBe(0);
  });

  it('returns longitudinal normals for nose-on hits and lateral taper normals', () => {
    const front = exclusionAt(track, band, band.from - KART_RADIUS + 0.1, 0)!;
    const normal = front.normalAt(band.center);
    expect(normal.d).toBeLessThan(-0.9);
    expect(normal.offset).toBe(0);
    const rear = exclusionAt(track, band, band.to + KART_RADIUS - 0.1, 0)!;
    expect(rear.normalAt(band.center).d).toBeGreaterThan(0.9);
    for (const d of [band.from + 2, band.to - 2]) {
      const side = exclusionAt(track, band, d, 0)!;
      for (const offset of [side.min, side.max]) {
        const n = side.normalAt(offset);
        expect(Math.abs(n.offset)).toBeGreaterThan(0.85);
        expect(Math.hypot(n.d, n.offset)).toBeCloseTo(1, 14);
        expect(Math.sign(n.offset)).toBe(Math.sign(offset - band.center));
        expect(Math.sign(n.d)).toBe(d < (band.from + band.to) / 2 ? -1 : 1);
      }
    }
    for (const offset of [front.min, front.max]) {
      const n = front.normalAt(offset);
      expect(Math.hypot(n.d, n.offset)).toBeCloseTo(1, 14);
      expect(n.d).toBeCloseTo(-0.85 / KART_RADIUS, 12);
    }
    const body = exclusionAt(track, band, 32, 0)!;
    expect(body.normalAt(body.min)).toEqual({ d: -0, offset: -1 });
    expect(body.normalAt(body.max)).toEqual({ d: -0, offset: 1 });
  });

  it('handles negative distances, seam-crossing bands, and short symmetric tapers', () => {
    const wrapped = { ...band, from: length - 8, to: 8 };
    expect(exclusionAt(track, wrapped, 0, 0)!.halfWidth).toBe(2.95);
    expect(exclusionAt(track, wrapped, length, 0)!.halfWidth).toBe(2.95);
    expect(exclusionAt(track, wrapped, -1, 0)!.halfWidth)
      .toBe(exclusionAt(track, wrapped, length - 1, 0)!.halfWidth);
    expect(exclusionAt(track, wrapped, length / 2, 0)).toBeNull();
    const short = { ...band, to: band.from + 3 };
    expect(exclusionAt(track, short, band.from + 1.5, 0)!.halfWidth).toBe(0.75 + KART_RADIUS);
    expect(exclusionAt(track, short, short.from + 1, 0)!.halfWidth)
      .toBe(exclusionAt(track, short, short.to - 1, 0)!.halfWidth);
  });

  it.each(['sweep', 'gate'] as const)('keeps %s motion static at every supplied time', kind => {
    const moving: Barrier = { ...band, motion: { kind, amplitude: 2, period: 4, phase: 1, minWidth: 3 } };
    const trackWithMotion = buildTrack(fixture({ barriers: [moving] }));
    for (const time of [-5, 0, 1, 100]) {
      for (const d of [band.from - 0.5, band.from + 2, 32, band.to + 0.5]) {
        const actual = exclusionAt(track, moving, d, time)!;
        const expected = exclusionAt(track, band, d, 0)!;
        expect(actual.halfWidth).toBe(expected.halfWidth);
        expect(actual.min).toBe(expected.min);
        expect(actual.max).toBe(expected.max);
        expect(actual.normalAt(0)).toEqual(expected.normalAt(0));
        expect(corridorAt(trackWithMotion, d, time)).toEqual(corridorAt(trackWithMotion, d, 0));
      }
    }
  });
});

describe('corridorAt and freeIntervalFor', () => {
  it('uses the local wall width and returns the whole corridor without barriers', () => {
    const track = buildTrack(fixture({ widthKeys: [{ distance: 10, roadHalfWidth: 4, wallHalfWidth: 6 }] }));
    expect(corridorAt(track, 20, 0)).toEqual([{ min: -6, max: 6 }]);
  });

  it('subtracts overlapping barriers as a union, regardless of order', () => {
    const barriers = [band, { ...band, center: 3 }];
    const expected = [{ min: -10.5, max: -2.95 }, { min: 5.95, max: 10.5 }];
    expect(corridorAt(buildTrack(fixture({ barriers })), 32, 0)).toEqual(expected);
    expect(corridorAt(buildTrack(fixture({ barriers: [...barriers].reverse() })), 32, 0)).toEqual(expected);
  });

  it('clips to walls, drops covered intervals, and preserves disjoint intervals', () => {
    expect(corridorAt(buildTrack(fixture({ barriers: [{ ...band, center: -10 }] })), 32, 0))
      .toEqual([{ min: -7.05, max: 10.5 }]);
    expect(corridorAt(buildTrack(fixture({ barriers: [{ ...band, center: 30 }] })), 32, 0))
      .toEqual([{ min: -10.5, max: 10.5 }]);
    expect(corridorAt(buildTrack(fixture({ barriers: [{ ...band, halfWidth: 20, taper: 2 }] })), 32, 0))
      .toEqual([]);
    const split = corridorAt(buildTrack(fixture({ barriers: [{ ...band, center: -4 }, { ...band, center: 4 }] })), 32, 0);
    expect(split).toEqual([{ min: -10.5, max: -6.95 }, { min: -4 + 2.95, max: 4 - 2.95 },
      { min: 6.95, max: 10.5 }]);
  });

  it('chooses the containing or closest original interval, with deterministic ties', () => {
    const intervals = [{ min: -10, max: -3 }, { min: 3, max: 10 }];
    for (const offset of [-20, -10, -4, -3, -1, 0]) expect(freeIntervalFor(intervals, offset)).toBe(intervals[0]);
    for (const offset of [1, 3, 4, 10, 20]) expect(freeIntervalFor(intervals, offset)).toBe(intervals[1]);
    expect(freeIntervalFor([], 0)).toBeUndefined();
  });
});

describe('validateTrackDef', () => {
  it.each(TRACK_IDS)('accepts the existing %s definition without changing its JSON', id => {
    const def = TRACKS[id];
    const before = JSON.stringify(def);
    expect(() => validateTrackDef(def)).not.toThrow();
    expect(JSON.stringify(def)).toBe(before);
    // Only CANYON was re-laid out in M1 (narrow section, dirt, pillars); the rest stay on layout 1.
    expect(def.layoutVersion ?? 1).toBe(id === 'canyon' ? 2 : 1);
  });

  it('accepts a safe band and leaves mutable input unchanged', () => {
    const def = fixture({ barriers: [band] });
    const before = JSON.stringify(def);
    expect(() => validateTrackDef(def)).not.toThrow();
    expect(JSON.stringify(def)).toBe(before);
  });

  it('accepts a safe wrapped band when both noses clear the gates', () => {
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, from: length - 25, to: 25, center: 7 }] })))
      .not.toThrow();
  });

  it.each(['roadHalfWidth', 'wallHalfWidth'] as const)('rejects excessive %s key slope', field => {
    expect(() => validateTrackDef(fixture({ widthKeys: [
      { distance: 0, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
      { distance: 1, roadHalfWidth: 7.2, wallHalfWidth: 10.5, [field]: base[field] + 0.36 },
    ] }))).toThrow(/slope/);
  });

  it('checks key slope across the seam and rejects mismatching zero/length keys', () => {
    expect(() => validateTrackDef(fixture({ widthKeys: [
      { distance: 0.5, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
      { distance: length - 0.5, roadHalfWidth: 8, wallHalfWidth: 11.3 },
    ] }))).toThrow(/slope/);
    expect(() => validateTrackDef(fixture({ widthKeys: [
      { distance: 0, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
      { distance: length, roadHalfWidth: 7.3, wallHalfWidth: 10.6 },
    ] }))).toThrow(/widthKeys/);
  });

  it('rejects a road half-width below 3.6 m, in defaults and keys', () => {
    expect(() => validateTrackDef(fixture({ roadHalfWidth: 3.59 }))).toThrow(/roadHalfWidth/);
    expect(() => validateTrackDef(fixture({ widthKeys: [{ distance: 0, roadHalfWidth: 3.59, wallHalfWidth: 10.5 }] })))
      .toThrow(/roadHalfWidth/);
  });

  it('rejects a taper under 2 m and a barrier slope above 0.5', () => {
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, taper: 1.99 }] }))).toThrow(/taper/);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, halfWidth: 2.01 }] }))).toThrow(/halfWidth \/ taper/);
  });

  it('rejects a location with no passage of width 2R + 0.6', () => {
    const def = fixture({ roadHalfWidth: 3.6, wallHalfWidth: 5.4,
      barriers: [{ ...band, halfWidth: 2, taper: 4 }] });
    expect(corridorAt(buildTrack(def), 32, 0).every(interval => interval.max - interval.min < 2 * KART_RADIUS + 0.6))
      .toBe(true);
    expect(() => validateTrackDef(def)).toThrow(/free interval/);
  });

  it('accepts the exact passage threshold and a narrow gap when another lane is wide enough', () => {
    expect(() => validateTrackDef(fixture({ roadHalfWidth: 3.6, wallHalfWidth: 5.45, barriers: [band] }))).not.toThrow();
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, center: 7 }] }))).not.toThrow();
  });

  it('rejects a racing-line anchor in an exclusion and a crossing between safe anchors', () => {
    expect(() => validateTrackDef(fixture({ barriers: [band], racingLine: [{ distance: 32, offset: 0 }] })))
      .toThrow(/racingLine/);
    expect(() => validateTrackDef(fixture({ barriers: [band], racingLine: [
      { distance: 20, offset: 0 }, { distance: 45, offset: 0 },
    ] }))).toThrow(/racingLine/);
  });

  it('checks the effective racing line after the simulation clamps its offset', () => {
    expect(() => validateTrackDef(fixture({
      racingLine: [{ distance: 0, offset: 7.1 }],
      barriers: [{ from: 28, to: 43, center: 6, halfWidth: 0.1 }],
    }))).toThrow(/racingLine/);
  });

  it.each(Array.from({ length: 8 }, (_, slot) => slot))('rejects occupied start grid slot %i', slot => {
    const d = length - 8 - Math.floor(slot / 2) * 4.5;
    const barrier: Barrier = { from: d - 2, to: d + 2, center: slot % 2 === 0 ? -2 : 2, halfWidth: 0.5, taper: 2 };
    expect(() => validateTrackDef(fixture({ barriers: [barrier] }))).toThrow(new RegExp(`start grid slot ${slot}`));
  });

  it.each(Array.from({ length: 12 }, (_, box) => box))('rejects occupied item box %i', box => {
    const d = base.boxRows[Math.floor(box / 3)]! * length;
    const barrier: Barrier = { from: d - 2, to: d + 2, center: base.boxLanes[box % 3]!, halfWidth: 0.5, taper: 2 };
    expect(() => validateTrackDef(fixture({ barriers: [barrier] }))).toThrow(/item box/);
  });

  it('rejects a gate within ±10 m of either tip, also across the seam', () => {
    const gate = length / base.checkpointCount;
    for (const barrier of [
      { ...band, from: gate + 9, to: gate + 24, center: 7 },
      { ...band, from: gate - 24, to: gate - 9, center: 7 },
      { ...band, from: length - 20, to: length - 5, center: 7 },
      { ...band, from: 10, to: 25, center: 7 },
    ]) expect(() => validateTrackDef(fixture({ barriers: [barrier] }))).toThrow(/checkpoint gate/);
  });

  it('applies checkpointPhase only to non-start gates', () => {
    expect(() => validateTrackDef(fixture({ barriers: [band] }))).not.toThrow();
    expect(() => validateTrackDef(fixture({ barriers: [band], checkpointPhase: -0.3 }))).toThrow(/checkpoint gate/);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, from: 5, to: 20, center: 7 }], checkpointPhase: 0.4 })))
      .toThrow(/checkpoint gate/);
  });

  it('checks critical taper endpoints between the 0.5 m sampling locations', () => {
    const tinyPeak: Barrier = { from: 25.1, to: 29.4, halfWidth: 1.05, center: 0, taper: 2.1 };
    const def = fixture({ roadHalfWidth: 3.6, wallHalfWidth: 4.49, barriers: [tinyPeak] });
    expect(corridorAt(buildTrack(def), 27, 0)[0]!.max + 4.49).toBeGreaterThan(2.5);
    expect(() => validateTrackDef(def)).toThrow(/free interval/);
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite geometry (%s) before JSON cloning', value => {
    expect(() => validateTrackDef(fixture({ roadHalfWidth: value }))).toThrow(RangeError);
    expect(() => validateTrackDef(fixture({ widthKeys: [{ distance: value, roadHalfWidth: 7.2, wallHalfWidth: 10.5 }] })))
      .toThrow(RangeError);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, halfWidth: value }] }))).toThrow(RangeError);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, center: value }] }))).toThrow(RangeError);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, taper: value }] }))).toThrow(RangeError);
  });

  it('rejects duplicate keys, inverted widths, and zero-length bands', () => {
    expect(() => validateTrackDef(fixture({ widthKeys: [
      { distance: 10, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
      { distance: 10, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
    ] }))).toThrow(/strictly increasing/);
    expect(() => validateTrackDef(fixture({ wallHalfWidth: 7 }))).toThrow(/wallHalfWidth/);
    expect(() => validateTrackDef(fixture({ barriers: [{ ...band, to: band.from }] }))).toThrow(/endpoints/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBest, loadSensitivity, loadSteerAssist, saveBest, saveSensitivity, saveSteerAssist } from './storage';
import { TRACK_IDS } from './sim/tracks';

const V1 = 'pocket-circuit.best.v1';
const V2 = 'pocket-circuit.best.v2';
const V3 = 'pocket-circuit.best.v3';

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('storage steer assist', () => {
  it('preserves an unset preference and round-trips both explicit choices', () => {
    expect(loadSteerAssist()).toBeNull();
    for (const value of [true, false]) {
      saveSteerAssist(value);
      expect(loadSteerAssist()).toBe(value);
    }
  });

  it('treats corrupt values as unset', () => {
    for (const value of ['', '0', '1', 'null', 'TRUE']) {
      store.set('pocket-circuit.steer-assist.v1', value);
      expect(loadSteerAssist()).toBeNull();
    }
  });

  it('remains usable when storage is denied', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(loadSteerAssist()).toBeNull();
    expect(() => saveSteerAssist(true)).not.toThrow();
  });
});

describe('storage best times', () => {
  it('round-trips per track in v3', () => {
    saveBest('meadow', 41.5);
    saveBest('canyon', 50);
    expect(loadBest('meadow')).toBe(41.5);
    expect(loadBest('canyon')).toBe(50);
    expect(loadBest('other')).toBeNull();
    expect(JSON.parse(store.get(V3)!)).toEqual({ meadow: { time: 41.5, layout: 1 }, canyon: { time: 50, layout: 1 } });
  });

  it('migrates v1 into meadow on first load and keeps v1', () => {
    store.set(V1, '37.25');
    expect(loadBest('canyon')).toBeNull();
    expect(JSON.parse(store.get(V2)!)).toEqual({ meadow: 37.25 });
    expect(store.get(V1)).toBe('37.25');
    expect(loadBest('meadow')).toBe(37.25);
    expect(JSON.parse(store.get(V3)!)).toEqual({ meadow: { time: 37.25, layout: 1 } });
  });

  it('migrates v2 records into v3 with layout 1', () => {
    store.set(V2, JSON.stringify({ meadow: 30, canyon: 55 }));
    expect(loadBest('canyon')).toBe(55);
    expect(JSON.parse(store.get(V3)!)).toEqual({ meadow: { time: 30, layout: 1 }, canyon: { time: 55, layout: 1 } });
    expect(store.get(V2)).toBe(JSON.stringify({ meadow: 30, canyon: 55 }));
  });

  it('returns only records that match the course layoutVersion', () => {
    store.set(V2, JSON.stringify({ canyon: 55 }));
    expect(loadBest('canyon', 1)).toBe(55);
    expect(loadBest('canyon', 2)).toBeNull();
    saveBest('canyon', 60, 2);
    expect(loadBest('canyon', 2)).toBe(60);
    expect(loadBest('canyon', 1)).toBeNull();
  });

  it('chains v1 -> v2 -> v3', () => {
    store.set(V1, '37.25');
    expect(loadBest('meadow', 1)).toBe(37.25);
    expect(JSON.parse(store.get(V2)!)).toEqual({ meadow: 37.25 });
    expect(JSON.parse(store.get(V3)!)).toEqual({ meadow: { time: 37.25, layout: 1 } });
    expect(loadBest('meadow', 2)).toBeNull();
  });

  it('prefers v2 over v1', () => {
    store.set(V1, '99');
    store.set(V2, JSON.stringify({ meadow: 30 }));
    expect(loadBest('meadow')).toBe(30);
  });

  it('ignores corrupt JSON, bad values and prototype keys', () => {
    store.set(V2, '{not json');
    expect(loadBest('meadow')).toBeNull();
    store.set(V2, JSON.stringify({ meadow: 0, canyon: -1, snowpeak: 'x', neon: null, d: 12, toString: 13 }));
    expect(loadBest('meadow')).toBeNull();
    expect(loadBest('canyon')).toBeNull();
    expect(loadBest('snowpeak')).toBeNull();
    expect(loadBest('neon')).toBeNull();
    expect(loadBest('d')).toBeNull();
    expect(loadBest('toString')).toBeNull();
    store.set(V2, '[1,2]');
    expect(loadBest('0')).toBeNull();
  });

  it('ignores invalid v1 values', () => {
    for (const v of ['abc', '0', '-3', 'Infinity']) {
      store.clear();
      store.set(V1, v);
      expect(loadBest('meadow')).toBeNull();
      expect(store.has(V2)).toBe(false);
    }
  });

  it('refuses to save invalid times and recovers from corrupt v2', () => {
    saveBest('meadow', 0);
    saveBest('meadow', NaN);
    saveBest('meadow', Infinity);
    expect(store.has(V3)).toBe(false);
    store.set(V3, '{bad');
    saveBest('meadow', 20);
    expect(loadBest('meadow')).toBe(20);
  });

  it('ignores unknown track ids on save and drops them from stored data', () => {
    store.set(V3, JSON.stringify({ meadow: { time: 40, layout: 1 }, ghost: { time: 5, layout: 1 } }));
    saveBest('ghost', 9);
    saveBest('canyon', 50);
    expect(JSON.parse(store.get(V3)!)).toEqual({ meadow: { time: 40, layout: 1 }, canyon: { time: 50, layout: 1 } });
  });

  it('migrates v1 even when another course is saved before the first load', () => {
    store.set(V1, '37.25');
    saveBest('canyon', 50);
    expect(loadBest('meadow')).toBe(37.25);
    expect(loadBest('canyon')).toBe(50);
    expect(store.get(V1)).toBe('37.25');
  });

  it('swallows a setItem failure after a successful read', () => {
    store.set(V2, JSON.stringify({ meadow: 40 }));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: () => { throw new Error('quota'); },
    });
    expect(() => saveBest('meadow', 30)).not.toThrow();
    expect(loadBest('meadow')).toBe(40);
  });

  it('never throws when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(loadBest('meadow')).toBeNull();
    expect(() => saveBest('meadow', 10)).not.toThrow();
  });

  it('requires a track ID: the no-arg API is gone and a bare time is not saved', () => {
    // @ts-expect-error saveBest(time) was removed; a number is not a track ID.
    saveBest(33);
    // @ts-expect-error loadBest() was removed.
    expect(loadBest()).toBeNull();
    expect(loadBest('meadow')).toBeNull();
    expect(store.has(V2)).toBe(false);
  });
  it('saves and loads every registered course', () => {
    TRACK_IDS.forEach((id, index) => saveBest(id, 40 + index));
    TRACK_IDS.forEach((id, index) => expect(loadBest(id)).toBe(40 + index));
  });
});

describe('storage steer sensitivity', () => {
  it('defaults to 3, round-trips, and rejects invalid values', () => {
    expect(loadSensitivity()).toBe(3);
    saveSensitivity(5);
    expect(loadSensitivity()).toBe(5);
    for (const bad of ['0', '6', '2.5', 'abc']) {
      store.set('pocket-circuit.steer-sensitivity.v1', bad);
      expect(loadSensitivity()).toBe(3);
    }
  });

  it('survives throwing storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(loadSensitivity()).toBe(3);
    expect(() => saveSensitivity(2)).not.toThrow();
  });
});

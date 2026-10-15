import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAIInput } from '../sim/ai';
import { createRace, NEUTRAL_INPUT, stepRace } from '../sim/race';
import { TRACK_IDS, TRACKS } from '../sim/tracks';
import type { InputFrame, RaceState } from '../sim/types';
import { decodeFrames, encodeFrames, quantizeInput } from './codec';
import { GhostPlayer } from './player';
import { CHECKPOINT_INTERVAL, GHOST_FORMAT, GhostRecorder, MAX_GHOST_TICKS } from './record';
import type { GhostRecord } from './record';
import { loadBestLap, loadGhost, saveBestLap, saveGhost } from './storage';

const options = { trackId: 'meadow' as const, layout: TRACKS.meadow.layoutVersion ?? 1, laps: 1, seed: 42 };
const GHOST_KEY = 'pocket-circuit.timeattack.v1';
const BEST_LAP_KEY = 'pocket-circuit.bestlap.v1';

function randomFrames(ticks: number): InputFrame[] {
  let seed = 42;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  return Array.from({ length: ticks }, () => ({
    steer: random() * 2 - 1, throttle: random(),
    brake: random() > 0.5, drift: random() > 0.5, useItem: random() > 0.5,
  }));
}

function fixture(): GhostRecord {
  return {
    format: GHOST_FORMAT, ...options, time: 30, lapTimes: [30], ticks: 1,
    frames: encodeFrames([{ ...NEUTRAL_INPUT, throttle: 1 }]), checkpoints: [],
  };
}

describe('ghost input codec', () => {
  it('quantizes without mutation, preserves flags, and is idempotent including signed zero', () => {
    const frames = [
      ...randomFrames(1000),
      ...[-1, -0.5 / 127, -0.001, -0, 0, 0.5 / 127, 1].map(steer => ({ ...NEUTRAL_INPUT, steer })),
    ];
    for (const frame of frames) {
      const original = { ...frame };
      const q = quantizeInput(frame);
      expect(q.steer).toBe(Math.round(frame.steer * 127) / 127 || 0);
      expect(q.throttle).toBe(Math.round(frame.throttle * 255) / 255 || 0);
      expect([q.brake, q.drift, q.useItem]).toEqual([frame.brake, frame.drift, frame.useItem]);
      expect(quantizeInput(q)).toStrictEqual(q);
      expect(frame).toStrictEqual(original);
    }
    const quantized = frames.map(quantizeInput);
    expect(decodeFrames(encodeFrames(quantized), quantized.length)).toStrictEqual(quantized);
  });

  it('clamps out-of-range and NaN inputs so finish() can still encode them', () => {
    const wild = [
      { ...NEUTRAL_INPUT, steer: 5, throttle: 9 },
      { ...NEUTRAL_INPUT, steer: -5, throttle: -3 },
      { ...NEUTRAL_INPUT, steer: NaN, throttle: NaN },
    ];
    expect(wild.map(quantizeInput).map(({ steer, throttle }) => [steer, throttle])).toEqual([[1, 1], [-1, 0], [0, 0]]);
    wild.map(quantizeInput).forEach(q => expect(quantizeInput(q)).toStrictEqual(q));
    const recorder = new GhostRecorder(options);
    const state = createRace(options.seed, { trackId: options.trackId, laps: 1, karts: 1, itemBoxes: false });
    wild.forEach(frame => recorder.push(frame));
    state.karts[0]!.finishTime = 1;
    const result = recorder.finish(state);
    expect(result).not.toBeNull();
    expect(decodeFrames(result!.frames, 3)).toHaveLength(3);
  });

  it('round-trips every steer byte, throttle byte, and flag combination', () => {
    const frames = Array.from({ length: 256 * 8 }, (_, i) => ({
      steer: ((i % 255) - 127) / 127, throttle: (i % 256) / 255,
      brake: (i & 1) !== 0, drift: (i & 2) !== 0, useItem: (i & 4) !== 0,
    }));
    expect(decodeFrames(encodeFrames(frames), frames.length)).toStrictEqual(frames);
    expect(decodeFrames(encodeFrames([]), 0)).toEqual([]);
  });

  it.each([1, 127, 128, 16383, 16384, MAX_GHOST_TICKS])('round-trips a %i-tick varint run', ticks => {
    const frames = Array.from({ length: ticks }, () => ({ ...NEUTRAL_INPUT, steer: -1, throttle: 1 }));
    const decoded = decodeFrames(encodeFrames(frames), ticks);
    expect(decoded).toStrictEqual(frames);
    if (ticks > 1) {
      decoded[0]!.throttle = 0;
      expect(decoded[1]!.throttle).toBe(1);
    }
  });

  it('keeps 12,600 keyboard ticks below 2 KB and random analog ticks below 80 KB', () => {
    const constant = Array.from({ length: 12600 }, () => ({ ...NEUTRAL_INPUT, throttle: 1 }));
    const keyboard = constant.map((frame, i) => ({ ...frame, steer: [-1, 0, 1][Math.floor(i / 120) % 3]! }));
    const analog = randomFrames(12600).map(quantizeInput);
    expect(encodeFrames(constant).length).toBeLessThan(2000);
    expect(encodeFrames(keyboard).length).toBeLessThan(2000);
    expect(encodeFrames(analog).length).toBeLessThan(80000);
    expect(decodeFrames(encodeFrames(analog), analog.length)).toStrictEqual(analog);
  });

  it('rejects corrupt base64, truncated tuples/varints, invalid flags and run lengths', () => {
    const base64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
    for (const bytes of [[0], [0, 255, 0], [0, 255, 0, 128], [0, 255, 0, 0],
      [0, 255, 0, 2], [128, 255, 0, 1], [0, 255, 8, 1], [0, 255, 0, 128, 128, 128, 128, 128, 0]]) {
      expect(() => decodeFrames(base64(bytes), 1)).toThrow();
    }
    expect(() => decodeFrames('!bad!', 1)).toThrow();
    expect(() => decodeFrames('', 1)).toThrow();
    for (const ticks of [-1, 0.5, NaN, Infinity]) expect(() => decodeFrames('', ticks)).toThrow();
    expect(() => decodeFrames(encodeFrames([NEUTRAL_INPUT]), 2)).toThrow();
    expect(() => decodeFrames(encodeFrames([NEUTRAL_INPUT]), 0)).toThrow();
    expect(() => encodeFrames([{ ...NEUTRAL_INPUT, steer: 2 }])).toThrow();
    expect(() => encodeFrames([{ ...NEUTRAL_INPUT, throttle: Infinity }])).toThrow();
  });
});

describe('ghost recorder and deterministic playback', () => {
  let source: RaceState;
  let record: GhostRecord;

  beforeAll(() => {
    source = createRace(options.seed, { trackId: options.trackId, laps: options.laps, karts: 1, itemBoxes: false });
    const recorder = new GhostRecorder(options);
    recorder.checkpoint(0, source);
    while (source.phase !== 'finished' && source.tick < MAX_GHOST_TICKS) {
      const frame = recorder.push(getAIInput(source, 0));
      stepRace(source, [frame]);
      recorder.checkpoint(source.tick, source);
    }
    expect(source.phase).toBe('finished');
    const result = recorder.finish(source);
    expect(result).not.toBeNull();
    record = result!;
  });

  it('ignores a checkpoint repeated at the same tick', () => {
    const recorder = new GhostRecorder(options);
    const state = createRace(options.seed, { trackId: options.trackId, laps: 1, karts: 1, itemBoxes: false });
    recorder.checkpoint(0, state);
    recorder.checkpoint(0, state);
    state.karts[0]!.finishTime = 1;
    expect(recorder.finish(state)!.checkpoints).toHaveLength(1);
  });

  it('replays a one-kart meadow lap with exactly equal finishTime and lapTimes', () => {
    expect(record.seed).toBe(options.seed);
    expect(record.ticks).toBe(source.tick);
    expect(record.time).toBe(source.karts[0]!.finishTime);
    expect(record.checkpoints.length).toBeGreaterThan(1);
    expect(record.checkpoints.map(({ tick }) => tick)).toEqual(
      Array.from({ length: Math.floor(record.ticks / CHECKPOINT_INTERVAL) + 1 }, (_, i) => i * CHECKPOINT_INTERVAL),
    );
    const player = new GhostPlayer(record);
    expect(player.state).not.toBe(source);
    expect(player.state.karts).toHaveLength(1);
    expect(player.state.boxes).toEqual([]);
    expect(player.finished).toBe(false);
    expect(player.finishTime).toBeNull();
    for (let tick = 0; tick < record.ticks; tick++) player.step();
    expect(player.finished).toBe(true);
    expect(player.diverged).toBe(false);
    expect(player.finishTime).toBe(source.karts[0]!.finishTime);
    expect(player.finishTime).toBe(record.time);
    expect(player.state.karts[0]!.lapTimes).toStrictEqual(record.lapTimes);
    for (const [i, time] of source.karts[0]!.lapTimes.entries()) expect(player.state.karts[0]!.lapTimes[i]).toBe(time);
    expect(player.state).toStrictEqual(source);
    const finishedState = structuredClone(player.state);
    player.step();
    expect(player.state).toStrictEqual(finishedState);
  });

  it('detects a single changed input tick at the next checkpoint and keeps diverged set', () => {
    const original = decodeFrames(record.frames, record.ticks);
    const frames = decodeFrames(record.frames, record.ticks);
    // Change tick 599, after countdown, immediately before the tick-600 checkpoint.
    frames[CHECKPOINT_INTERVAL - 2]!.throttle = 0;
    frames[CHECKPOINT_INTERVAL - 2]!.brake = true;
    const tampered = { ...record, frames: encodeFrames(frames) };
    expect(decodeFrames(tampered.frames, record.ticks).filter((frame, i) =>
      JSON.stringify(frame) !== JSON.stringify(original[i]))).toHaveLength(1);
    const player = new GhostPlayer(tampered);
    for (let tick = 0; tick < CHECKPOINT_INTERVAL - 1; tick++) player.step();
    expect(player.diverged).toBe(false);
    player.step();
    expect(player.state.tick).toBe(CHECKPOINT_INTERVAL);
    expect(player.diverged).toBe(true);
    for (let tick = 0; tick < CHECKPOINT_INTERVAL; tick++) player.step();
    expect(player.diverged).toBe(true);
  });

  it('compares checkpoint distances exactly and checks tick zero', () => {
    const player = new GhostPlayer({
      ...record, checkpoints: [{ tick: 0, distance: record.checkpoints[0]!.distance + 1e-10 }],
    });
    expect(player.diverged).toBe(true);
  });

  it('uses neutral input when recorded frames run out', () => {
    const short = { ...record, ticks: 181, frames: encodeFrames(Array.from({ length: 181 }, () => ({
      ...NEUTRAL_INPUT, throttle: 1,
    }))), checkpoints: [] };
    const player = new GhostPlayer(short);
    const expected = createRace(short.seed, { trackId: short.trackId, laps: short.laps, karts: 1, itemBoxes: false });
    for (let tick = 0; tick < 200; tick++) {
      player.step();
      stepRace(expected, [tick < short.ticks ? { ...NEUTRAL_INPUT, throttle: 1 } : NEUTRAL_INPUT]);
    }
    expect(player.state).toStrictEqual(expected);
    expect(player.finished).toBe(false);
  });

  it('copies inputs and result arrays and excludes unfinished and over-limit recordings', () => {
    const mutableOptions = { ...options };
    const recorder = new GhostRecorder(mutableOptions);
    mutableOptions.seed = 17;
    const original = { ...NEUTRAL_INPUT, steer: 0.234, throttle: 0.567 };
    const quantized = recorder.push(original);
    expect(quantized).toStrictEqual(quantizeInput(original));
    const savedFrame = { ...quantized };
    original.steer = 1;
    quantized.steer = -1;
    const unfinished = createRace(options.seed, { karts: 1, itemBoxes: false });
    expect(recorder.finish(unfinished)).toBeNull();
    const saved = recorder.finish(source)!;
    expect(saved.seed).toBe(options.seed);
    expect(decodeFrames(saved.frames, saved.ticks)).toStrictEqual([savedFrame]);
    saved.lapTimes[0] = -1;
    expect(recorder.finish(source)!.lapTimes).toStrictEqual(source.karts[0]!.lapTimes);
    const long = new GhostRecorder(options);
    for (let tick = 0; tick < MAX_GHOST_TICKS; tick++) long.push(NEUTRAL_INPUT);
    expect(long.finish(source)!.ticks).toBe(MAX_GHOST_TICKS);
    long.push(NEUTRAL_INPUT);
    expect(long.finish(source)).toBeNull();
  });
});

describe('ghost and best-lap persistence', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('round-trips each track and lap count without losing other records', () => {
    expect(loadGhost(options.trackId, options.layout, 1)).toBeNull();
    expect(loadBestLap(options.trackId, options.layout)).toBeNull();
    for (const trackId of TRACK_IDS) {
      for (const laps of [1, 2, 3]) {
        const record = { ...fixture(), trackId, laps, lapTimes: Array.from({ length: laps }, () => 30) };
        saveGhost(record);
        expect(loadGhost(trackId, options.layout, laps)).toStrictEqual(record);
      }
      saveBestLap(trackId, options.layout, 20);
    }
    expect(Object.keys(JSON.parse(store.get(GHOST_KEY)!))).toEqual(TRACK_IDS);
    expect(Object.keys(JSON.parse(store.get(GHOST_KEY)!).meadow)).toEqual(['1', '2', '3']);
    for (const trackId of TRACK_IDS) expect(loadBestLap(trackId, options.layout)).toBe(20);
    expect(JSON.parse(store.get(BEST_LAP_KEY)!).meadow).toEqual({ time: 20, layout: options.layout });
    saveGhost({ ...fixture(), time: 29 });
    expect(loadGhost('meadow', options.layout, 1)!.time).toBe(29);
    expect(loadGhost('meadow', options.layout, 2)!.time).toBe(30);
  });

  it.each([
    { format: 2 }, { trackId: 'canyon' }, { layout: options.layout + 1 }, { laps: 2 },
    { ticks: MAX_GHOST_TICKS + 1 }, { ticks: -1 }, { ticks: 0.5 }, { ticks: 2 },
    { frames: '!bad!' }, { seed: null }, { time: -1 }, { lapTimes: [] },
    { checkpoints: [{ tick: 1, distance: 20 }] }, { checkpoints: [{ tick: 600, distance: 20 }] },
    { checkpoints: [{ tick: 0, distance: null }] },
  ])('rejects incompatible or damaged ghost metadata: %j', change => {
    store.set(GHOST_KEY, JSON.stringify({ meadow: { '1': { ...fixture(), ...change } } }));
    expect(loadGhost('meadow', options.layout, 1)).toBeNull();
  });

  it('rejects unknown tracks and mismatching requested layout/lap count', () => {
    saveGhost(fixture());
    saveBestLap('meadow', options.layout, 20);
    expect(loadGhost('meadow', options.layout + 1, 1)).toBeNull();
    expect(loadGhost('meadow', options.layout, 2)).toBeNull();
    expect(loadGhost('canyon', options.layout, 1)).toBeNull();
    expect(loadBestLap('meadow', options.layout + 1)).toBeNull();
    expect(loadBestLap('canyon', options.layout)).toBeNull();
    for (const id of ['unknown', '__proto__', 'constructor']) {
      expect(loadGhost(id, options.layout, 1)).toBeNull();
      expect(loadBestLap(id, options.layout)).toBeNull();
      expect(() => saveBestLap(id, options.layout, 20)).not.toThrow();
    }
    expect(loadGhost('meadow', options.layout, 4)).toBeNull();
  });

  it.each(['{bad', 'null', '[]', '42', '"bad"', '{"meadow":null}', '{"meadow":[]}'])('handles corrupt storage: %s', raw => {
    store.set(GHOST_KEY, raw);
    store.set(BEST_LAP_KEY, raw);
    expect(loadGhost('meadow', options.layout, 1)).toBeNull();
    expect(loadBestLap('meadow', options.layout)).toBeNull();
    saveGhost(fixture());
    saveBestLap('meadow', options.layout, 20);
    expect(loadGhost('meadow', options.layout, 1)).toStrictEqual(fixture());
    expect(loadBestLap('meadow', options.layout)).toBe(20);
  });

  it('does not save invalid or over-limit records or invalid lap times', () => {
    const invalid = [{ ...fixture(), ticks: MAX_GHOST_TICKS + 1 }, { ...fixture(), format: 2 },
      { ...fixture(), layout: 0 }, { ...fixture(), laps: 4 }, { ...fixture(), frames: 'bad' }];
    for (const record of invalid) saveGhost(record);
    for (const time of [0, -1, NaN, Infinity]) saveBestLap('meadow', options.layout, time);
    saveBestLap('meadow', 0, 20);
    expect(store.size).toBe(0);
    for (const time of [null, '20', 0, -1]) {
      store.set(BEST_LAP_KEY, JSON.stringify({ meadow: { time, layout: options.layout } }));
      expect(loadBestLap('meadow', options.layout)).toBeNull();
    }
  });

  it.each(['getItem', 'setItem'] as const)('contains storage %s errors including QuotaExceededError', method => {
    vi.spyOn(localStorage, method).mockImplementation(() => { throw new DOMException('denied', 'QuotaExceededError'); });
    expect(() => saveGhost(fixture())).not.toThrow();
    expect(() => saveBestLap('meadow', options.layout, 20)).not.toThrow();
    expect(loadGhost('meadow', options.layout, 1)).toBeNull();
    expect(loadBestLap('meadow', options.layout)).toBeNull();
  });

  it('contains storage access errors and works without browser globals', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadGhost('meadow', options.layout, 1)).toBeNull();
    expect(loadBestLap('meadow', options.layout)).toBeNull();
    expect(() => saveGhost(fixture())).not.toThrow();
    expect(() => saveBestLap('meadow', options.layout, 20)).not.toThrow();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, get: () => { throw new Error('storage denied'); },
    });
    expect(loadGhost('meadow', options.layout, 1)).toBeNull();
    expect(loadBestLap('meadow', options.layout)).toBeNull();
    expect(() => saveGhost(fixture())).not.toThrow();
    expect(() => saveBestLap('meadow', options.layout, 20)).not.toThrow();
  });
});

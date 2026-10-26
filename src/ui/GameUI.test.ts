import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../sim/types';

const tracks = vi.hoisted(() => ({
  current: { def: { name: 'Init' } } as unknown,
  // While GameUI is imported, getTrack answers per course so the title's course options see 21 distinct names.
  names: null as Record<string, string> | null,
}));
vi.mock('../sim/tracks', async importOriginal => {
  const actual = await importOriginal<typeof import('../sim/tracks')>();
  tracks.names = Object.fromEntries(actual.TRACK_IDS.map(id => [id, actual.getTrack(id).def.name]));
  return {
    TRACK_IDS: actual.TRACK_IDS,
    getTrack: (id: string) => tracks.names ? { def: { name: tracks.names[id] } } : tracks.current,
  };
});

const confetti = vi.hoisted(() => ({ start: vi.fn(() => vi.fn()) }));
vi.mock('./confetti', () => ({ startConfetti: confetti.start }));

import { COUNTDOWN_POP_MS, FINISH_SLIDE_MS, GO_FLASH_MS, RESULT_ROW_STAGGER_MS, courseNumber, courseOptions, cpuOptions, cupOptions, formatPreciseTime, GameUI, modeOptions } from './GameUI';
import { CUPS } from '../gp/grandPrix';
import { sampleTrack } from '../sim/track';
import { createRouletteView } from './itemIcons';
import { createRace } from '../sim/race';
import type { ItemType } from '../sim/types';

const courseNames = tracks.names!;
tracks.names = null;
afterEach(() => vi.unstubAllGlobals());

const SAMPLES = 8;
const RADIUS = 100;

function loopTrack(decks?: Track['def']['decks']): Track {
  const samples = Array.from({ length: SAMPLES }, (_, i) => {
    const a = i / SAMPLES * Math.PI * 2;
    return { x: Math.cos(a) * RADIUS, y: 0, z: Math.sin(a) * RADIUS, tx: -Math.sin(a), tz: Math.cos(a),
      nx: Math.cos(a), nz: Math.sin(a), distance: i * 100 };
  });
  return { def: { name: 'Loop', ...(decks ? { decks } : {}) }, samples, length: SAMPLES * 100,
    checkpointDistances: [], boxPoses: [] } as unknown as Track;
}

let log: string[];
class FakePath2D {
  readonly ops: string[] = [];
  moveTo(x: number, y: number): void { this.ops.push(`M${x.toFixed(3)},${y.toFixed(3)}`); }
  lineTo(x: number, y: number): void { this.ops.push(`L${x.toFixed(3)},${y.toFixed(3)}`); }
  closePath(): void { this.ops.push('Z'); }
}

function fakeContext(): CanvasRenderingContext2D {
  const record = (name: string) => (...args: unknown[]) => {
    log.push(`${name}(${args.map(a => a instanceof FakePath2D ? `[${a.ops.join(' ')}]` : typeof a === 'number' ? a.toFixed(3) : String(a)).join(',')})`);
  };
  const target: Record<string, unknown> = {};
  for (const name of ['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'arc', 'save',
    'restore', 'translate', 'rotate', 'fill', 'stroke']) target[name] = record(name);
  for (const name of ['strokeStyle', 'lineWidth', 'lineJoin', 'lineCap', 'fillStyle']) {
    Object.defineProperty(target, name, { set: (value: unknown) => log.push(`${name}=${String(value)}`) });
  }
  return target as unknown as CanvasRenderingContext2D;
}

function drawMap(track: Track): string[] {
  tracks.current = track;
  log = [];
  const ui = Object.create(GameUI.prototype) as Record<string, unknown>;
  ui.mapContext = fakeContext();
  ui.mapTrack = null;
  ui.localKartId = 0;
  (ui as unknown as { drawMap(state: unknown): void }).drawMap({ trackId: 'meadow', karts: [] });
  return log;
}

/** Expected deck path ops, built from the track samples inside each span (a span across the seam is two). */
function deckOps(track: Track, spans: [number, number][]): string {
  const scale = Math.min(144 / (2 * RADIUS), 99 / (2 * RADIUS));
  const op = (distance: number, first: boolean): string => {
    const p = sampleTrack(track, distance);
    return `${first ? 'M' : 'L'}${(p.x * scale + 90).toFixed(3)},${(p.z * scale + 64).toFixed(3)}`;
  };
  return '[' + spans.map(([from, to]) => [op(from, true), ...track.samples.filter(p => p.distance > from && p.distance < to)
    .map(p => op(p.distance, false)), op(to, false)].join(' ')).join(' ') + ']';
}

function upperPaths(decks: Track['def']['decks']): string[] {
  const log = drawMap(loopTrack(decks));
  const flat = drawMap(loopTrack()).indexOf('beginPath()');
  return log.slice(flat, flat + 6).filter(entry => entry.startsWith('stroke('));
}

describe('GameUI title course options', () => {
  it('renders all 21 courses labelled 01 to 21 with their definition names', () => {
    const ids = Object.keys(courseNames);
    expect(ids).toHaveLength(21);
    const labels = [...courseOptions.matchAll(/aria-label="([^"]*)"/g)].map(match => match[1]);
    expect(labels).toEqual(ids.map((id, index) => `${String(index + 1).padStart(2, '0')} ${courseNames[id]}`));
    expect(labels[7]).toBe('08 STRATOS CITY');
    expect(labels[15]).toBe('16 LUNAR BASIN');
    expect(labels[19]).toBe('20 SKY SPIRE');
    expect(labels[20]).toBe('21 AQUEDUCT');
    expect(ids.map(courseNumber)).toEqual([
      '01', '02', '03', '04', '05', '06', '07', '08',
      '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21',
    ]);
  });
});

describe('GameUI title background resolution', () => {
  // M6-09 ?perf=1, darwin Chromium headless, 1280x720 DPR 1, MEADOW:
  // after frame > 20 then another 10 seconds, average 198.1 -> 142.3 ms
  // (about 5.05 -> 7.03 fps), maximum 2983.2 -> 3149.9 ms including startup.
  // Drawing buffer 1280x720 -> 640x360, displayed bounds stay 1280x720;
  // start-race restores 1280x720 and clears the inline transform, with no page errors.
  it('uses one quarter of the pixels only on the title and restores every other screen', () => {
    const resize = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: resize });
    const style = { width: '', height: '', transform: '', transformOrigin: '' };
    const ui = Object.create(GameUI.prototype) as { canvas: unknown; setBackgroundResolution(screen: string): void };
    ui.canvas = { style };
    for (const next of ['race', 'lobby', 'results']) {
      ui.setBackgroundResolution('title');
      expect(style).toEqual({ width: '50%', height: '50%', transform: 'scale(2)', transformOrigin: 'top left' });
      const calls = resize.mock.calls.length;
      ui.setBackgroundResolution('title');
      expect(resize).toHaveBeenCalledTimes(calls);
      ui.setBackgroundResolution(next);
      expect(style).toEqual({ width: '', height: '', transform: '', transformOrigin: '' });
      expect(resize).toHaveBeenCalledTimes(calls + 1);
      expect(resize.mock.lastCall![0].type).toBe('resize');
    }
  });
});

describe('GameUI minimap', () => {
  it('closes the lap with identical first and last points and a joined stroke', () => {
    vi.stubGlobal('Path2D', FakePath2D);
    const path = drawMap(loopTrack()).find(entry => entry.startsWith('stroke(['))!;
    const points = [...path.matchAll(/[ML](-?[\d.]+,-?[\d.]+)/g)].map(match => match[1]);
    expect(points.at(-1)).toBe(points[0]);
    expect(path).toContain(' Z]');
  });

  it.each(['harbor', 'skyline', 'canyon', 'neon'] as const)(
    '%s draws each split lane as its own path, joined to both road endpoints', async id => {
      vi.stubGlobal('Path2D', FakePath2D);
      const { getTrack } = await vi.importActual<typeof import('../sim/tracks')>('../sim/tracks');
      const track = getTrack(id);
      const paths = drawMap(track).filter(entry => entry.startsWith('stroke(['));
      // Base road outline/fill, then two outlines and two fills per split.
      const lanes = paths.slice(2, 2 + 2 * track.def.splits!.length);
      expect(lanes).toHaveLength(2 * track.def.splits!.length);
      const unique = new Set(lanes);
      expect(unique.size).toBe(lanes.length);
      const roadPoints = [...paths[0].matchAll(/[ML](-?[\d.]+,-?[\d.]+)/g)].map(match => match[1]);
      // These real courses have one split: the road runs continuously across
      // distance length/0, and either lane completes exactly the same closed lap.
      expect(paths[0].match(/M/g)).toHaveLength(1);
      for (let i = 0; i < lanes.length; i += 2) {
        const points = lanes.slice(i, i + 2).map(path => [...path.matchAll(/[ML](-?[\d.]+,-?[\d.]+)/g)]
          .map(match => match[1]));
        expect(lanes[i].match(/M/g)).toHaveLength(1);
        expect(lanes[i + 1].match(/M/g)).toHaveLength(1);
        expect(points[0][0]).toBe(points[1][0]);
        expect(points[0].at(-1)).toBe(points[1].at(-1));
        expect(points[0]).not.toEqual(points[1]);
        expect(roadPoints.at(-1)).toBe(points[0][0]);
        expect(points[0].at(-1)).toBe(roadPoints[0]);
        // The approach/exit are explicit points of the road, not lateral gaps.
        for (const endpoint of [points[0][0], points[0].at(-1)]) expect(paths[0]).toContain(endpoint);
      }
    });

  it('fits a wide 600 x 200 m boundary inside the 144 x 99 frame', () => {
    const scale = Math.min(144 / 600, 99 / 200);
    expect(600 * scale).toBeLessThanOrEqual(144);
    expect(200 * scale).toBeLessThanOrEqual(99);
    const track = loopTrack();
    const ui = Object.create(GameUI.prototype) as unknown as { prepareMap(t: Track): void; mapScale: number };
    const wide = { ...track, samples: [{ ...track.samples[0], x: -300, z: -100 }, { ...track.samples[0], x: 300, z: 100 }] } as Track;
    ui.prepareMap(wide);
    expect(ui.mapScale).toBeCloseTo(scale);
  });

  beforeEach(() => { vi.stubGlobal('Path2D', FakePath2D); });

  it('draws a closed road without decks or empty lane strokes', () => {
    expect(drawMap(loopTrack())).toMatchInlineSnapshot(`
      [
        "setTransform(2.000,0.000,0.000,2.000,0.000,0.000)",
        "clearRect(0.000,0.000,180.000,128.000)",
        "lineJoin=round",
        "lineCap=round",
        "strokeStyle=rgba(9, 39, 31, .9)",
        "lineWidth=11",
        "stroke([M139.500,64.000 L125.002,99.002 L90.000,113.500 L54.998,99.002 L40.500,64.000 L54.998,28.998 L90.000,14.500 L125.002,28.998 L139.500,64.000 Z])",
        "strokeStyle=rgba(255, 255, 255, .7)",
        "lineWidth=5",
        "stroke([M139.500,64.000 L125.002,99.002 L90.000,113.500 L54.998,99.002 L40.500,64.000 L54.998,28.998 L90.000,14.500 L125.002,28.998 L139.500,64.000 Z])",
        "strokeStyle=rgba(9, 39, 31, .9)",
        "lineWidth=8",
        "strokeStyle=rgba(255, 255, 255, .7)",
        "lineWidth=5",
        "beginPath()",
        "moveTo(134.500,64.000)",
        "lineTo(144.500,64.000)",
        "strokeStyle=#d8ff75",
        "lineWidth=2",
        "stroke()",
      ]
    `);
  });

  it('draws deck spans as a later, distinct upper pass', () => {
    const base = drawMap(loopTrack());
    const withDeck = drawMap(loopTrack([{ from: 150, to: 450 }]));
    const flat = base.indexOf('beginPath()');
    // The flat pass is untouched; the deck pass is inserted just before the start marker.
    expect(withDeck.slice(0, flat)).toEqual(base.slice(0, flat));
    expect(withDeck.slice(flat + 6)).toEqual(base.slice(flat));
    const upper = withDeck.slice(flat, flat + 6);
    expect(upper.filter(entry => entry.startsWith('stroke([')))
      .toHaveLength(2);
    // Only the deck span (ends plus samples 200, 300, 400) is in the upper path, wider and brighter than the road.
    for (const entry of upper.filter(e => e.startsWith('stroke('))) expect(entry.match(/[ML]/g)).toHaveLength(5);
    expect(upper.filter(e => e.startsWith('lineWidth=')))
      .toEqual(['lineWidth=13', 'lineWidth=7']);
    expect(upper[2]).not.toBe('strokeStyle=rgba(255, 255, 255, .7)');
  });

  it('draws exactly the deck-span samples, by coordinate', () => {
    const track = loopTrack();
    const expected = deckOps(track, [[150, 450]]);
    expect(upperPaths([{ from: 150, to: 450 }])).toEqual([`stroke(${expected})`, `stroke(${expected})`]);
  });

  it('splits a deck across the lap seam into two spans', () => {
    const track = loopTrack();
    const expected = deckOps(track, [[650, 800], [0, 100]]);
    expect(upperPaths([{ from: 650, to: 100 }])).toEqual([`stroke(${expected})`, `stroke(${expected})`]);
  });

  it('detects a deck span that is off by one metre', () => {
    const expected = `stroke(${deckOps(loopTrack(), [[150, 450]])})`;
    expect(upperPaths([{ from: 149, to: 450 }])).not.toContain(expected);
    expect(upperPaths([{ from: 150, to: 451 }])).not.toContain(expected);
  });
});

const labelsOf = (html: string): string[] => [...html.matchAll(/aria-label="([^"]*)"/g)].map(match => match[1]);
const valuesOf = (html: string): string[] => [...html.matchAll(/value="([^"]*)"/g)].map(match => match[1]);

describe('GameUI title mode / cup / cpu options', () => {
  it('renders 3 modes, 5 cups and 3 cpu levels with labels and defaults', () => {
    expect(valuesOf(modeOptions)).toEqual(['race', 'gp', 'timeattack']);
    expect(labelsOf(modeOptions)).toEqual(['レース', 'グランプリ', 'タイムアタック']);
    expect(valuesOf(cupOptions)).toEqual(CUPS.map(cup => cup.id));
    expect(labelsOf(cupOptions)).toEqual([
      'SUNRISE CUP 01–04', 'HORIZON CUP 05–08', 'ZENITH CUP 09–12', 'ECLIPSE CUP 13–16', 'EXTREME CUP 17–21',
    ]);
    expect(valuesOf(cpuOptions)).toEqual(['easy', 'normal', 'hard']);
    expect(labelsOf(cpuOptions)).toEqual(['やさしい', 'ふつう', 'つよい']);
    expect(modeOptions.match(/ checked/g)).toHaveLength(1);
    expect(modeOptions).toMatch(/value="race"[^>]* checked/);
    expect(cpuOptions).toMatch(/value="normal"[^>]* checked/);
    expect(modeOptions).toContain('class="mode-option"');
    expect(cupOptions).toContain('class="cup-option"');
    expect(cpuOptions).toContain('class="cpu-option"');
  });
});

interface FakeEl { hidden: boolean; textContent: string; innerHTML: string; dataset: Record<string, string>; inputs: { value: string; checked: boolean }[];
  querySelectorAll(): unknown[]; querySelector(): unknown; replaceChildren(): void; append(...nodes: unknown[]): void; className: string;
  style: Record<string, string> }
function fakeEl(values: string[] = []): FakeEl {
  const el: FakeEl = { hidden: false, textContent: '', innerHTML: '', dataset: {}, inputs: values.map(value => ({ value, checked: false })),
    querySelectorAll: () => el.inputs, querySelector: () => el.inputs.find(input => input.checked) ?? null,
    replaceChildren: () => undefined, append: () => undefined, className: '', style: {} };
  return el;
}
const IDS = ['cup-select', 'course-select', 'cpu-select', 'position-group', 'retry-label', 'course-index', 'course-name', 'title-best',
  'result-position', 'leaderboard', 'best-lap-record', 'results-heading', 'results-course', 'finish-time', 'finish-best', 'new-record', 'result-laps',
  'back-title', 'retry-race', 'item-display'];
function fakeUi() {
  const refs: Record<string, FakeEl> = Object.fromEntries(IDS.map(id => [id, fakeEl()]));
  refs['cup-select'] = fakeEl(CUPS.map(cup => cup.id));
  refs['cpu-select'] = fakeEl(['easy', 'normal', 'hard']);
  const root = fakeEl();
  const ui = Object.create(GameUI.prototype) as Record<string, unknown> & {
    setPlayMode(m: string): void; setCpuLevel(l: string): void; setCup(c: string): void; setTimeAttackBest(t: number | null, b: number | null): void;
    setCourse(id: string, best: number | null): void; showResults(...args: unknown[]): void; show(s: string): void };
  Object.assign(ui, { refs, root, playMode: 'race', courseId: 'meadow', localKartId: 0, screen: 'title', paused: false, itemsEnabled: true,
    setBackgroundResolution: () => undefined, setPaused: () => undefined, setCourseLabels: () => undefined, canvas: {} });
  return { ui, refs, root };
}

describe('GameUI play modes', () => {
  it('swaps course and cup selection for gp and hides cpu / position for time attack', () => {
    const { ui, refs, root } = fakeUi();
    ui.setCourse('meadow', null);
    ui.setPlayMode('gp');
    expect(root.dataset.playMode).toBe('gp');
    expect([refs['cup-select'].hidden, refs['course-select'].hidden, refs['cpu-select'].hidden, refs['position-group'].hidden])
      .toEqual([false, true, false, false]);
    expect(refs['retry-label'].textContent).toBe('順位表へ');
    expect(refs['course-name'].textContent).toBe('SUNRISE CUP · 4 RACES');
    ui.setCup('horizon');
    expect(refs['cup-select'].inputs.map(input => input.checked)).toEqual([false, true, false, false, false]);
    expect(refs['course-name'].textContent).toBe('HORIZON CUP · 4 RACES');
    ui.setCup('zenith');
    expect(refs['cup-select'].inputs.map(input => input.checked)).toEqual([false, false, true, false, false]);
    expect(refs['course-name'].textContent).toBe('ZENITH CUP · 4 RACES');
    ui.setCup('eclipse');
    expect(refs['cup-select'].inputs.map(input => input.checked)).toEqual([false, false, false, true, false]);
    expect(refs['course-name'].textContent).toBe('ECLIPSE CUP · 4 RACES');
    ui.setCup('extreme');
    expect(refs['cup-select'].inputs.map(input => input.checked)).toEqual([false, false, false, false, true]);
    expect(refs['course-name'].textContent).toBe('EXTREME CUP · 5 RACES');
    ui.setPlayMode('timeattack');
    expect([refs['cup-select'].hidden, refs['course-select'].hidden, refs['cpu-select'].hidden, refs['position-group'].hidden])
      .toEqual([true, false, true, true]);
    expect(refs['item-display'].hidden).toBe(true);
    expect(refs['retry-label'].textContent).toBe('もう一度走る');
    expect(refs['course-index'].textContent).toBe('01');
    ui.setPlayMode('race');
    expect([refs['cpu-select'].hidden, refs['position-group'].hidden, refs['item-display'].hidden]).toEqual([false, false, false]);
    ui.setPlayMode('timeattack');
    ui.setPlayMode('gp');
    expect(refs['item-display'].hidden).toBe(false);
  });

  it('keeps the touch item button in sync through update() after a race with a held item', () => {
    const { ui, refs } = fakeUi();
    const make = () => ({ ...fakeEl(), disabled: false, attrs: {} as Record<string, string>,
      classList: { toggle: () => undefined, remove: () => undefined },
      setAttribute(name: string, value: string) { this.attrs[name] = value; }, dispatchEvent: () => true });
    const any = new Proxy(refs as Record<string, unknown>, { get: (target, key: string) => (target[key] ??= make()) });
    Object.assign(ui, { refs: any, roulette: createRouletteView(), lastItem: undefined, reducedMotion: null, onRoulette: null,
      inkMounted: true, lastMapTick: 0, drawMap: () => undefined });
    const state = createRace(1, { karts: 2, itemBoxes: false });
    const button = make();
    refs['use-item'] = button;
    const run = (item: ItemType | null) => { state.karts[0]!.item = item; state.karts[0]!.effects.rouletteTime = 0; (ui as unknown as { update(s: unknown): void }).update(state); };
    run('dash');
    expect(refs['item-button-name'].textContent).not.toBe('ITEM');
    expect(button.disabled).toBe(false);
    ui.setPlayMode('timeattack');
    run(null);
    expect(refs['item-button-name'].textContent).toBe('ITEM');
    expect(button.disabled).toBe(true);
    expect(button.attrs['aria-label']).toBe('アイテムを持っていません');
    expect(refs['item-name'].textContent).not.toBe('ボックスを取ろう');
  });

  const rocketUi = () => {
    const { ui, refs } = fakeUi();
    const make = () => ({ ...fakeEl(), disabled: false, attrs: {} as Record<string, string>,
      classList: { toggle: () => undefined, remove: () => undefined },
      setAttribute(name: string, value: string) { this.attrs[name] = value; }, dispatchEvent: () => true });
    const any = new Proxy(refs as Record<string, unknown>, { get: (target, key: string) => (target[key] ??= make()) });
    Object.assign(ui, { refs: any, roulette: createRouletteView(), lastItem: undefined, reducedMotion: null, onRoulette: null,
      inkMounted: true, lastMapTick: 0, drawMap: () => undefined });
    const state = createRace(1, { karts: 2, itemBoxes: false });
    const update = () => (ui as unknown as { update(s: unknown): void }).update(state);
    return { ui: ui as unknown as GameUI, refs, state, kart: state.karts[0]!, update };
  };
  const rocketEvent = (kartId: number) => [{ type: 'go' as const, kartId: 0 }, { type: 'boost' as const, kartId, value: 2 }];

  it('hides the countdown start-dash hold and shows ROCKET START from the local GO boost event', () => {
    const { ui, refs, state, kart, update } = rocketUi();
    // Countdown: boostTime is the hold accumulator (0.3 s held so far), not a boost.
    Object.assign(state, { tick: 160 });
    kart.boostTime = 0.3;
    update();
    expect(refs['race-status'].hidden).toBe(true);
    ui.noteEvents(rocketEvent(0));
    Object.assign(state, { phase: 'racing', tick: 183, racingTicks: 3, time: 3 / 60 });
    kart.boostTime = 1 - 3 / 60;
    update();
    expect(refs['race-status'].hidden).toBe(false);
    expect(refs['race-status'].textContent).toBe('ROCKET START!');
    // An item dash after the start-dash second keeps its own label.
    Object.assign(state, { racingTicks: 120, time: 2 });
    kart.boostTime = 0.5;
    update();
    expect(refs['race-status'].textContent).toBe('DASH!');
  });

  it('guest view: shows ROCKET START although predicted boost + host time do not sum to the grant', () => {
    const { ui, refs, state, kart, update } = rocketUi();
    // Predicted local kart at 120 ms RTT: timers from prediction, time from a quantized host snapshot.
    Object.assign(state, { phase: 'racing', tick: 191, racingTicks: 11, time: 0.18 });
    kart.boostTime = 0.94;
    ui.noteEvents(rocketEvent(0));
    update();
    expect(refs['race-status'].textContent).toBe('ROCKET START!');
  });

  it('an early item/drift boost without the local GO event, or another kart\'s start dash, stays DASH!', () => {
    const { ui, refs, state, kart, update } = rocketUi();
    Object.assign(state, { phase: 'racing', tick: 210, racingTicks: 30, time: 0.5 });
    kart.boostTime = 0.5;
    ui.noteEvents(rocketEvent(1));
    update();
    expect(refs['race-status'].textContent).toBe('DASH!');
  });

  it('cancels the running 120 ms settle animation when reduced motion turns on mid-settle', () => {
    const { ui } = fakeUi();
    const cancel = vi.fn();
    const make = () => ({ ...fakeEl(), disabled: false, attrs: {} as Record<string, string>, firstElementChild: { animate: () => ({ cancel }) },
      classList: { toggle: () => undefined, remove: () => undefined },
      setAttribute(name: string, value: string) { this.attrs[name] = value; }, dispatchEvent: () => true });
    const any = new Proxy({} as Record<string, unknown>, { get: (target, key: string) => (target[key] ??= make()) });
    const media = { matches: false };
    Object.assign(ui, { refs: any, roulette: createRouletteView(), lastItem: undefined, reducedMotion: media, onRoulette: null,
      inkMounted: true, lastMapTick: 0, drawMap: () => undefined });
    const state = createRace(1, { karts: 2, itemBoxes: false });
    const update = () => (ui as unknown as { update(s: unknown): void }).update(state);
    state.karts[0]!.item = 'dash';
    state.karts[0]!.effects.rouletteTime = 0.5;
    update();
    state.karts[0]!.effects.rouletteTime = 0;
    update(); // stop: starts the settle animations
    expect(cancel).not.toHaveBeenCalled();
    media.matches = true;
    update();
    expect(cancel).toHaveBeenCalledTimes(2);
    update();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('checks the cpu level radio and formats the time attack best', () => {
    const { ui, refs } = fakeUi();
    ui.setCpuLevel('hard');
    expect(refs['cpu-select'].inputs.map(input => input.checked)).toEqual([false, false, true]);
    ui.setTimeAttackBest(62.345, 20.111);
    expect(refs['title-best'].textContent).toBe('BEST 1:02.345 · LAP 0:20.111');
    ui.setTimeAttackBest(null, null);
    expect(refs['title-best'].textContent).toBe('まだ記録はありません');
    expect(formatPreciseTime(62.345)).toBe('1:02.345');
  });

  it('hides all four screens for standings', () => {
    const screens = Object.fromEntries(['title', 'lobby', 'race', 'results'].map(name => [name, fakeEl()]));
    const { ui } = fakeUi();
    Object.assign(ui, screens, { reset: undefined });
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.stubGlobal('document', { activeElement: null });
    ui.show('standings');
    expect(Object.values(screens).map(el => el.hidden)).toEqual([true, true, true, true]);
  });

  it('time attack results hide position and leaderboard and show the lap record', () => {
    const { ui, refs } = fakeUi();
    Object.assign(ui, { results: fakeEl(), title: fakeEl(), lobby: fakeEl(), race: fakeEl() });
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.stubGlobal('document', { createElement: () => fakeEl() });
    const kart = { id: 0, name: 'YOU', color: 0xff0000, finishTime: 70, lapTimes: [23, 22, 25], lap: 3 };
    const state = { karts: [kart], trackId: 'meadow', laps: 3, phase: 'finished', time: 70 };
    const track = { def: { name: 'MEADOW' } };
    tracks.current = track;
    ui.setPlayMode('timeattack');
    (ui as unknown as { show(s: string): void }).show = () => undefined;
    ui.showResults(state, 70, true, { bestLap: 22, isLapRecord: true });
    expect(refs['results-heading'].textContent).toBe('TIME ATTACK');
    expect([refs['result-position'].hidden, refs['leaderboard'].hidden, refs['best-lap-record'].hidden]).toEqual([true, true, false]);
    expect(refs['finish-best'].textContent).toBe('1:10.000');
  });
});

describe('GameUI B5 presentation', () => {
  const animated = () => { const animate = vi.fn(); return { ...fakeEl(), animate, classList: { toggle: () => undefined, remove: () => undefined }, setAttribute: () => undefined, disabled: false, dispatchEvent: () => true }; };

  function raceUi(reduced: boolean) {
    tracks.current = loopTrack();
    const { ui, refs } = fakeUi();
    const make = () => animated();
    const any = new Proxy(refs as Record<string, unknown>, { get: (target, key: string) => (target[key] ??= make()) });
    Object.assign(ui, { refs: any, roulette: createRouletteView(), lastItem: undefined, reducedMotion: { matches: reduced }, onRoulette: null, settleAnims: [],
      inkMounted: true, lastMapTick: 0, drawMap: () => undefined });
    const update = (s: unknown) => (ui as unknown as { update(s: unknown): void }).update(s);
    return { ui, refs, any: any as Record<string, ReturnType<typeof animated>>, update };
  }

  it('tags the countdown 3/2/1/go and animates 280 ms pops and a 160 ms GO flash once per change', () => {
    const { any, update } = raceUi(false);
    const state = createRace(1, { karts: 2, itemBoxes: false });
    const seen: string[] = [];
    for (const countdown of [2.5, 2.2, 1.5, 0.5]) {
      state.phase = 'countdown'; state.countdown = countdown;
      update(state); update(state);
      seen.push(any['countdown-display'].dataset.count!);
    }
    state.phase = 'racing'; state.time = 0.1;
    update(state);
    seen.push(any['countdown-display'].dataset.count!);
    expect(seen).toEqual(['3', '3', '2', '1', 'go']);
    const calls = any['countdown-display'].animate.mock.calls as unknown as [unknown, { duration: number }][];
    expect(calls.map(call => call[1].duration)).toEqual([COUNTDOWN_POP_MS, COUNTDOWN_POP_MS, COUNTDOWN_POP_MS, GO_FLASH_MS]);
    expect([COUNTDOWN_POP_MS, GO_FLASH_MS]).toEqual([280, 160]);
    expect(JSON.stringify(calls[0]![0])).toContain('scale(1.8)');
  });

  it('does not animate the countdown under reduced motion but still tags it', () => {
    const { any, update } = raceUi(true);
    const state = createRace(1, { karts: 2, itemBoxes: false });
    state.phase = 'countdown'; state.countdown = 2.5;
    update(state);
    expect(any['countdown-display'].dataset.count).toBe('3');
    expect(any['countdown-display'].animate).not.toHaveBeenCalled();
  });

  function finish(reduced: boolean, rank: number) {
    confetti.start.mockClear();
    const { ui, refs } = fakeUi();
    const rows: ReturnType<typeof animated>[] = [];
    Object.assign(ui, { results: fakeEl(), title: fakeEl(), lobby: fakeEl(), race: fakeEl(), reducedMotion: { matches: reduced } });
    refs['result-position'] = animated() as unknown as FakeEl;
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.stubGlobal('document', { createElement: () => { const row = animated(); rows.push(row); return row; } });
    tracks.current = loopTrack();
    (ui as unknown as { show(s: string): void }).show = () => undefined;
    const state = createRace(1, { karts: 4, itemBoxes: false });
    state.karts.forEach(kart => { kart.lapTimes = [20]; });
    const order = state.karts.filter(kart => kart.id !== 0);
    order.splice(rank - 1, 0, state.karts[0]!);
    order.forEach((kart, index) => { kart.finishTime = 60 + index; });
    ui.showResults(state, 60, false);
    return { refs, rows, position: refs['result-position'] as unknown as ReturnType<typeof animated> };
  }

  it('shows the local rank, slides it in over 320 ms and staggers rows by 70 ms', () => {
    const { refs, rows, position } = finish(false, 2);
    expect(refs['result-position'].dataset.rank).toBe('2');
    expect(refs['result-position'].dataset.ordinal).toBe('2nd');
    expect(refs['result-position'].innerHTML).toBe('2<span>位</span>');
    expect((position.animate.mock.calls[0] as unknown as [unknown, { duration: number }])[1].duration).toBe(FINISH_SLIDE_MS);
    const delays = rows.filter(row => row.animate.mock.calls.length).map(row => (row.animate.mock.calls[0] as unknown as [unknown, { delay: number }])[1].delay);
    expect(delays.slice(0, 3)).toEqual([0, RESULT_ROW_STAGGER_MS, 2 * RESULT_ROW_STAGGER_MS]);
    expect(confetti.start).toHaveBeenCalledTimes(1);
  });

  it('launches confetti only for the top three and never under reduced motion', () => {
    finish(false, 4);
    expect(confetti.start).not.toHaveBeenCalled();
    finish(true, 1);
    expect(confetti.start).not.toHaveBeenCalled();
    const { position } = finish(true, 1);
    expect(position.animate).not.toHaveBeenCalled();
  });

  it('cancels running B5 animations and confetti when reduced motion turns on mid-run', () => {
    const { ui } = fakeUi();
    const cancel = vi.fn();
    const stopConfetti = vi.fn();
    const media = { matches: false };
    Object.assign(ui, { reducedMotion: media, motionAnims: [{ cancel }, { cancel }], settleAnims: [{ cancel }], cancelConfetti: stopConfetti });
    (ui as unknown as { stopMotion(): void }).stopMotion();
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(stopConfetti).toHaveBeenCalledTimes(1);
    expect((ui as Record<string, unknown>).motionAnims).toEqual([]);
    expect((ui as Record<string, unknown>).cancelConfetti).toBeNull();
  });
});

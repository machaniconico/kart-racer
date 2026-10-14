import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../sim/types';

const tracks = vi.hoisted(() => ({ current: { def: { name: 'Init' } } as unknown }));
vi.mock('../sim/tracks', () => ({
  TRACK_IDS: ['meadow'],
  getTrack: () => tracks.current,
}));

import { GameUI } from './GameUI';
import { sampleTrack } from '../sim/track';

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
}

function fakeContext(): CanvasRenderingContext2D {
  const record = (name: string) => (...args: unknown[]) => {
    log.push(`${name}(${args.map(a => a instanceof FakePath2D ? `[${a.ops.join(' ')}]` : typeof a === 'number' ? a.toFixed(3) : String(a)).join(',')})`);
  };
  const target: Record<string, unknown> = {};
  for (const name of ['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'arc', 'save',
    'restore', 'translate', 'rotate', 'fill', 'stroke']) target[name] = record(name);
  for (const name of ['strokeStyle', 'lineWidth', 'lineJoin', 'fillStyle']) {
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

describe('GameUI minimap', () => {
  beforeEach(() => { vi.stubGlobal('Path2D', FakePath2D); });

  it('draws a course without decks exactly as before', () => {
    expect(drawMap(loopTrack())).toMatchInlineSnapshot(`
      [
        "setTransform(2.000,0.000,0.000,2.000,0.000,0.000)",
        "clearRect(0.000,0.000,180.000,128.000)",
        "lineJoin=round",
        "strokeStyle=rgba(9, 39, 31, .9)",
        "lineWidth=11",
        "stroke([M139.500,64.000 L125.002,99.002 L90.000,113.500 L54.998,99.002 L40.500,64.000 L54.998,28.998 L90.000,14.500 L125.002,28.998 L139.500,64.000])",
        "strokeStyle=rgba(255, 255, 255, .7)",
        "lineWidth=5",
        "stroke([M139.500,64.000 L125.002,99.002 L90.000,113.500 L54.998,99.002 L40.500,64.000 L54.998,28.998 L90.000,14.500 L125.002,28.998 L139.500,64.000])",
        "strokeStyle=rgba(9, 39, 31, .9)",
        "lineWidth=8",
        "stroke([])",
        "strokeStyle=rgba(255, 255, 255, .7)",
        "lineWidth=5",
        "stroke([])",
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

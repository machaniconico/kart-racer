import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as THREE from 'three';
import { createRace, getTrack, sampleTrack } from '../sim';
import type { KartState, RaceState } from '../sim';
import { GameRenderer, respawnedKarts } from './GameRenderer';
import { captureRenderSnapshot } from './snapshot';

// A real GameRenderer (scene, course, karts, camera) over a stand-in WebGLRenderer that draws nothing.
const fakeWebGL = () => ({
  shadowMap: {}, outputColorSpace: '', info: { render: { calls: 0 }, programs: [] },
  setClearColor() {}, setPixelRatio() {}, setSize() {}, render() {}, dispose() {},
}) as unknown as THREE.WebGLRenderer;
const canvas = { clientWidth: 640, clientHeight: 360 } as HTMLCanvasElement;

beforeAll(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), devicePixelRatio: 1 });
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillText() {} }) }),
  });
});
afterAll(() => vi.unstubAllGlobals());

const renderers: GameRenderer[] = [];
function renderer(state: RaceState): GameRenderer {
  const created = new GameRenderer(canvas, state, 0, { webgl: fakeWebGL() });
  renderers.push(created);
  return created;
}
afterEach(() => { renderers.splice(0).forEach(r => r.dispose()); });

const track = getTrack('chasm');
const ravine = track.def.surfaces.find(zone => zone.kind === 'fall')!;

function placeAt(kart: KartState, distance: number): void {
  const p = sampleTrack(track, distance);
  Object.assign(kart, { x: p.x, y: p.y, z: p.z, heading: Math.atan2(p.tx, p.tz), trackDistance: distance,
    lateralOffset: 0, speed: 30 });
}

/** Kart 0 drives up to the lip at 30 m/s, then the tick that respawns it lands in `state`. */
function approachAndFall(r: GameRenderer, state: RaceState): RaceState['karts'][number] {
  const kart = state.karts[0]!;
  for (let d = ravine.from - 60; d <= ravine.from + 4; d += 0.5) {
    placeAt(kart, d);
    r.update(state, captureRenderSnapshot(state), 1, 1 / 60, 'race');
  }
  return kart;
}

function kartPosition(r: GameRenderer): THREE.Vector3 {
  return (r as unknown as { kartVisuals: { root: THREE.Group }[] }).kartVisuals[0]!.root.position;
}

describe('fall respawn cuts interpolation and the camera', () => {
  it('reads the fall events of this tick', () => {
    expect([...respawnedKarts([{ type: 'fall', kartId: 3 }, { type: 'hit', kartId: 1 }, { type: 'fall', kartId: 5 }])])
      .toEqual([3, 5]);
  });

  it('snaps the kart and camera to the respawn point on the fall tick', () => {
    const state = createRace(127, { trackId: 'chasm' });
    const r = renderer(state);
    const kart = approachAndFall(r, state);
    const before = captureRenderSnapshot(state); // Pose at the lip, before the respawn tick.
    placeAt(kart, ravine.respawnAt!);
    kart.speed = 0;
    state.events = [{ type: 'fall', kartId: 0 }];
    r.update(state, before, 0.4, 1 / 60, 'race');
    expect(kartPosition(r).toArray()).toEqual([kart.x, kart.y, kart.z]);
    // A fresh renderer has no camera history: an exact match means no smoothing from the lip.
    const fresh = renderer(state);
    fresh.update(state, before, 0.4, 1 / 60, 'race');
    expect(r.getCameraPosition()).toEqual(fresh.getCameraPosition());

    // Control: the same frame without the event interpolates across the ravine and lags the camera.
    const control = renderer(state);
    approachAndFall(control, state);
    placeAt(kart, ravine.respawnAt!);
    kart.speed = 0;
    state.events = [];
    control.update(state, before, 0.4, 1 / 60, 'race');
    expect(kartPosition(control).distanceTo({ x: kart.x, y: kart.y, z: kart.z } as THREE.Vector3)).toBeGreaterThan(10);
    expect(control.getCameraPosition()).not.toEqual(r.getCameraPosition());
  });

  it('still cuts the camera when the fall happened on an earlier tick of the frame (event lost)', () => {
    const state = createRace(127, { trackId: 'chasm' });
    const r = renderer(state);
    const kart = approachAndFall(r, state);
    placeAt(kart, ravine.respawnAt! + 0.5);
    kart.speed = 0;
    state.events = [];
    // The snapshot was taken after the respawn tick, so the kart is not interpolated across the ravine.
    const after = captureRenderSnapshot(state);
    r.update(state, after, 0.5, 1 / 30, 'race');
    const fresh = renderer(state);
    fresh.update(state, after, 0.5, 1 / 30, 'race');
    expect(r.getCameraPosition()).toEqual(fresh.getCameraPosition());
  });

  it('keeps smoothing an ordinary frame', () => {
    const state = createRace(127, { trackId: 'chasm' });
    const r = renderer(state);
    approachAndFall(r, state);
    placeAt(state.karts[0]!, ravine.from + 5);
    const fresh = renderer(state);
    r.update(state, captureRenderSnapshot(state), 1, 1 / 60, 'race');
    fresh.update(state, captureRenderSnapshot(state), 1, 1 / 60, 'race');
    expect(r.getCameraPosition()).not.toEqual(fresh.getCameraPosition());
  });

  it('cuts a short (5 m, backwards) summit respawn from an earlier tick when the frame passes its falls', () => {
    const summit = getTrack('summit');
    const band = summit.def.surfaces.find(zone => zone.kind === 'fall')!;
    const at = (kart: KartState, distance: number, offset = 0) => {
      const p = sampleTrack(summit, distance);
      Object.assign(kart, { x: p.x + p.nx * offset, y: p.y, z: p.z + p.nz * offset, heading: Math.atan2(p.tx, p.tz),
        trackDistance: distance, lateralOffset: offset, speed: 30 });
    };
    const run = (respawned: ReadonlySet<number>) => {
      const state = createRace(127, { trackId: 'summit' });
      const r = renderer(state);
      const kart = state.karts[0]!;
      for (let d = band.respawnAt! - 40; d <= band.respawnAt! + 5; d += 0.5) {
        at(kart, d, Math.min(3.4, Math.max(0, d - band.respawnAt! + 1.6)));
        r.update(state, captureRenderSnapshot(state), 1, 1 / 60, 'race', new Set());
      }
      // The fall ran on the first of two ticks this frame: the snapshot already holds the respawn,
      // and state.events (the second tick) no longer has it.
      at(kart, band.respawnAt! + 0.5);
      kart.speed = 0;
      state.events = [];
      const after = captureRenderSnapshot(state);
      r.update(state, after, 0.5, 1 / 30, 'race', respawned);
      const fresh = renderer(state);
      fresh.update(state, after, 0.5, 1 / 30, 'race', new Set());
      return { cut: r.getCameraPosition(), fresh: fresh.getCameraPosition() };
    };
    const passed = run(new Set([0]));
    for (const axis of ['x', 'y', 'z'] as const) expect(passed.cut[axis]).toBeCloseTo(passed.fresh[axis], 9);
    // Without the frame's falls, the 15 m backstop cannot see a 5 m jump: the camera would sweep.
    const lost = run(new Set());
    expect(Math.hypot(lost.cut.x - lost.fresh.x, lost.cut.y - lost.fresh.y, lost.cut.z - lost.fresh.z)).toBeGreaterThan(0.5);
  });

  it('draws the ghost at its respawn when the ghost replay reports a fall this frame', () => {
    const state = createRace(127, { trackId: 'chasm' });
    const r = renderer(state);
    r.setGhost(true);
    const ghost = () => (r as unknown as { ghost: { root: THREE.Group } }).ghost.root.position;
    const kart = structuredClone(state.karts[0]!);
    placeAt(kart, ravine.respawnAt!);
    const lip = structuredClone(kart);
    placeAt(lip, ravine.respawnAt! - 8); // A short respawn: inside the 15 m backstop.
    r.updateGhost(kart, lip, 0.5, 1 / 60, true);
    expect(ghost().toArray()).toEqual([kart.x, kart.y, kart.z]);
    r.updateGhost(kart, lip, 0.5, 1 / 60, false);
    expect(ghost().distanceTo({ x: kart.x, y: kart.y, z: kart.z } as THREE.Vector3)).toBeGreaterThan(3);
  });
});

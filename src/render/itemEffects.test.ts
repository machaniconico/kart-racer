import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as THREE from 'three';
import { createRace } from '../sim';
import { GameRenderer } from './GameRenderer';
import { captureRenderSnapshot } from './snapshot';

// Same stand-in WebGLRenderer as respawnCut.test.ts: a real scene graph, nothing drawn.
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
afterEach(() => { renderers.splice(0).forEach(r => r.dispose()); vi.restoreAllMocks(); });

describe('item effect rendering', () => {
  it('adds warm-up meshes only on the first frame (no console errors afterwards) and trails bolts', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = createRace(7);
    const r = new GameRenderer(canvas, state, 0, { webgl: fakeWebGL() });
    renderers.push(r);
    const trail = (r as unknown as { boltTrail: THREE.InstancedMesh }).boltTrail;
    const frame = () => r.update(state, captureRenderSnapshot(state), 1, 1 / 60, 'race');
    frame();
    expect(trail.count).toBe(0);
    state.projectiles.push({ kind: 'bolt', id: 900, ownerId: 1, life: 3, bounces: 0, x: 0, y: 0, z: 0, heading: 0 });
    frame();
    frame();
    expect(trail.count).toBeGreaterThan(0);
    state.projectiles.length = 0;
    frame();
    expect(trail.count).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('draws the item warm-up meshes once per WebGLRenderer, not again after a course rebuild', () => {
    const warmups: number[] = [];
    const webgl = fakeWebGL();
    webgl.render = ((scene: THREE.Scene) => {
      warmups.push(scene.children.filter(child => child.userData.pose && child.scale.x === 0).length);
    }) as THREE.WebGLRenderer['render'];
    const state = createRace(7);
    for (let build = 0; build < 2; build++) {
      const r = new GameRenderer(canvas, state, 0, { webgl });
      renderers.push(r);
      r.update(state, captureRenderSnapshot(state), 1, 1 / 60, 'lobby');
      r.update(state, captureRenderSnapshot(state), 1, 1 / 60, 'lobby');
    }
    expect(warmups).toEqual([6, 0, 0, 0]);
    const other = new GameRenderer(canvas, state, 0, { webgl: fakeWebGL() });
    renderers.push(other);
    const otherWarmups: number[] = [];
    (other.renderer as { render: unknown }).render = (scene: THREE.Scene) => {
      otherWarmups.push(scene.children.filter(child => child.userData.pose && child.scale.x === 0).length);
    };
    other.update(state, captureRenderSnapshot(state), 1, 1 / 60, 'lobby');
    expect(otherWarmups).toEqual([6]);
  });
});

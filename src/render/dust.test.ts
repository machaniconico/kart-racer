import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRace, FIXED_DT } from '../sim';
import { createDustState, DUST_LIFETIME, dustScale, updateDust, type DustEmitter } from './dust';
import { GameRenderer } from './GameRenderer';
import { captureRenderSnapshot } from './snapshot';

const emitter = (overrides: Partial<DustEmitter> = {}): DustEmitter => ({
  id: 0, x: 10, y: 2, z: 20, heading: 0, speed: 20, airTime: 0, driftTime: 0,
  grass: false, dirt: false, pitch: 0, roll: 0, ...overrides,
});

describe('pure dust pools', () => {
  it('emits every 3 local / 6 remote ticks, independent of render frequency or human flag', () => {
    const karts = [emitter({ id: 0, grass: true }), emitter({ id: 1, dirt: true })];
    let state = createDustState();
    for (let tick = 1; tick <= 30; tick++) {
      state = updateDust(state, tick, karts, 1);
      expect(updateDust(state, tick, karts, 1)).toBe(state);
    }
    expect(state.surface.slots.filter(p => p?.kartId === 0)).toHaveLength(5);
    expect(state.surface.slots.filter(p => p?.kartId === 1)).toHaveLength(10);
    expect(state).toEqual(updateDust(createDustState(), 30, karts, 1));
    expect(state.drift.slots.filter(Boolean)).toHaveLength(0);
  });

  it.each([
    [{ grass: true }, 4, 0, 0],
    [{ dirt: true }, 4, 0, 0],
    [{ driftTime: 1 }, 0, 4, 6],
    [{ grass: true, driftTime: 1 }, 4, 0, 6],
    [{ dirt: true, driftTime: 1 }, 4, 0, 6],
    [{ grass: true, dirt: true, driftTime: 1, airTime: 0.01 }, 0, 0, 0],
    [{}, 0, 0, 0],
  ] as const)('gates and selects pools for %j', (conditions, surface, drift, marks) => {
    const state = updateDust(createDustState(), 12, [emitter(conditions)], 0);
    expect(state.surface.slots.filter(Boolean)).toHaveLength(surface);
    expect(state.drift.slots.filter(Boolean)).toHaveLength(drift);
    expect(state.marks.slots.filter(Boolean)).toHaveLength(marks);
  });

  it('is deterministic and never mutates frozen inputs, including an occupied pool', () => {
    const karts = Object.freeze([Object.freeze(emitter({ grass: true, driftTime: 1 }))]);
    const previous = updateDust(createDustState(), 6, karts, 0);
    for (const pool of [previous.surface, previous.drift, previous.marks]) {
      pool.slots.forEach(p => p && Object.freeze(p));
      Object.freeze(pool.slots);
      Object.freeze(pool);
    }
    Object.freeze(previous);
    const saved = JSON.stringify(previous);
    expect(updateDust(previous, 12, karts, 0)).toEqual(updateDust(previous, 12, karts, 0));
    expect(JSON.stringify(previous)).toBe(saved);
  });

  it('reuses the oldest slots without throwing on more than 128 simultaneous requests', () => {
    const karts = Array.from({ length: 140 }, (_, id) => emitter({ id, dirt: true }));
    const state = updateDust(createDustState(5), 6, karts, 0);
    expect(state.surface.slots).toHaveLength(128);
    expect(state.surface.next).toBe(12);
    expect(state.surface.slots.filter(Boolean).map(p => p!.kartId).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 128 }, (_, i) => i + 12));
    const drift = updateDust(createDustState(5), 6, karts.map(k => ({ ...k, dirt: false, driftTime: 1 })), 0);
    expect(drift.drift.slots.filter(Boolean)).toHaveLength(64);
    expect(drift.drift.slots.filter(Boolean).map(p => p!.kartId).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 64 }, (_, i) => i + 76));
  });

  it('places two marks at the rear wheels every four ticks and retains only the latest 240', () => {
    const kart = emitter({ driftTime: 1 });
    let state = updateDust(createDustState(), 4, [kart], 0);
    expect(state.marks.slots.slice(0, 2)).toEqual([
      { x: 8.98, y: 2.02, z: 19.05, heading: 0, born: 4, pitch: 0, roll: 0 },
      { x: 11.02, y: 2.02, z: 19.05, heading: 0, born: 4, pitch: 0, roll: 0 },
    ]);
    state = updateDust(state, 484, [kart], 0);
    expect(state.marks.slots.filter(Boolean)).toHaveLength(240);
    expect(Math.min(...state.marks.slots.map(p => p!.born))).toBe(8);
    expect(Math.max(...state.marks.slots.map(p => p!.born))).toBe(484);
    const stopped = updateDust(state, 10_000, [], 0);
    expect(stopped.marks.slots).toEqual(state.marks.slots);
    expect(stopped.surface.slots.filter(Boolean)).toHaveLength(0);
    expect(stopped.drift.slots.filter(Boolean)).toHaveLength(0);
    expect(updateDust(stopped, 0, [kart], 0)).toEqual(createDustState());
  });

  it('expires smoke at exactly 0.55 seconds and implements the full scale curve', () => {
    const state = updateDust(createDustState(), 3, [emitter({ dirt: true, heading: Math.PI / 2 })], 0);
    const particle = state.surface.slots[0]!;
    expect(particle.vx).toBeCloseTo(-3);
    expect(particle.vz).toBeCloseTo(0);
    expect(updateDust(state, 35, [], 0).surface.slots.filter(Boolean)).toHaveLength(1);
    expect(updateDust(state, 36, [], 0).surface.slots.filter(Boolean)).toHaveLength(0);
    expect(dustScale(0)).toBe(0.35);
    expect(dustScale(DUST_LIFETIME * 0.35)).toBeCloseTo(0.875);
    expect(dustScale(DUST_LIFETIME * 0.7)).toBeCloseTo(1.4);
    expect(dustScale(DUST_LIFETIME * 0.85)).toBeCloseTo(0.7);
    expect(dustScale(DUST_LIFETIME)).toBe(0);
    expect(dustScale(DUST_LIFETIME + 1)).toBe(0);
  });
});

describe('GameRenderer dust integration', () => {
  let renderer: GameRenderer | undefined;
  afterEach(() => { renderer?.dispose(); renderer = undefined; vi.unstubAllGlobals(); });

  it('warms exactly once, renders fixed materials under reduced motion, and disposes all pool resources', () => {
    vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: query.includes('reduced-motion') }), devicePixelRatio: 1 });
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ fillRect() {}, fillText() {} }) }) });
    const frames: { counts: number[]; scales: number[] }[] = [];
    const drivingFrames: { visible: boolean; scale: number; culled: boolean }[][] = [];
    let drivingMeshes: THREE.Mesh[] = [];
    let meshes: THREE.InstancedMesh[] = [];
    const webgl = {
      shadowMap: {}, setClearColor() {}, setPixelRatio() {}, setSize() {}, dispose() {},
      render(scene: THREE.Scene) {
        drivingFrames.push(drivingMeshes.map(mesh => ({ visible: mesh.visible, scale: mesh.scale.length(), culled: mesh.frustumCulled })));
        meshes = ['surface-dust', 'drift-smoke', 'tire-marks'].map(name => scene.getObjectByName(name) as THREE.InstancedMesh);
        frames.push({ counts: meshes.map(mesh => mesh.count), scales: meshes.map(mesh => {
          const matrix = new THREE.Matrix4();
          mesh.getMatrixAt(0, matrix);
          return new THREE.Vector3().setFromMatrixScale(matrix).length();
        }) });
      },
    } as unknown as THREE.WebGLRenderer;
    const state = createRace(127);
    renderer = new GameRenderer({ clientWidth: 640, clientHeight: 360 } as HTMLCanvasElement, state, 0, { webgl });
    const visual = (renderer as unknown as { kartVisuals: { sparks: THREE.Mesh; effects: { flame: THREE.Mesh } }[] }).kartVisuals[0];
    drivingMeshes = [visual.sparks, visual.effects.flame];
    const render = () => renderer!.update(state, captureRenderSnapshot(state), 1, FIXED_DT, 'race');
    render();
    expect(frames).toEqual([{ counts: [1, 1, 1], scales: [0, 0, 0] }]);
    expect(drivingFrames[0]).toEqual([
      { visible: true, scale: 0, culled: false }, { visible: true, scale: 0, culled: false },
    ]);
    for (const mesh of drivingMeshes) {
      expect(mesh.visible).toBe(false);
      expect(mesh.frustumCulled).toBe(true);
      expect(mesh.scale.length()).toBeGreaterThan(0);
    }
    expect(meshes.map(mesh => mesh.count)).toEqual([0, 0, 0]);
    render();
    expect(frames[1].counts).toEqual([0, 0, 0]);
    expect(meshes.map(mesh => mesh.instanceMatrix.count)).toEqual([128, 64, 240]);
    expect(meshes.map(mesh => (mesh.material as THREE.MeshBasicMaterial).color.getHex())).toEqual([0xd8caa8, 0xf0f0f0, 0x1a1410]);
    for (const mesh of meshes) {
      expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
      expect(mesh.material).toMatchObject({ transparent: true, depthWrite: false, vertexColors: false });
      expect(mesh.instanceColor).toBeNull();
      expect(mesh.geometry.hasAttribute('color')).toBe(false);
      expect(mesh.castShadow).toBe(false);
    }
    expect(meshes.map(mesh => (mesh.material as THREE.MeshBasicMaterial).opacity)).toEqual([0.28, 0.28, 0.32]);
    expect(meshes[2].material).toMatchObject({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    expect((meshes[2].geometry as THREE.PlaneGeometry).parameters).toMatchObject({ width: 0.26, height: 0.7 });
    state.phase = 'racing';
    state.tick = 12;
    state.karts[0].driftTime = 1;
    state.karts[1].lateralOffset = 100;
    const unchanged = JSON.stringify(state);
    render();
    expect(meshes.map(mesh => mesh.count)).toEqual([2, 4, 6]);
    expect(JSON.stringify(state)).toBe(unchanged);
    render();
    expect(meshes.map(mesh => mesh.count)).toEqual([2, 4, 6]);
    const before = new THREE.Matrix4();
    meshes[0].getMatrixAt(0, before);
    state.tick += 6;
    state.karts.forEach(kart => { kart.airTime = 0.5; });
    render();
    const after = new THREE.Matrix4();
    meshes[0].getMatrixAt(0, after);
    expect(after.elements[13] - before.elements[13]).toBeCloseTo(0.9 * 6 * FIXED_DT, 5);
    expect(meshes.map(mesh => mesh.count)).toEqual([2, 4, 6]);
    const resources = new Set<{ addEventListener(type: 'dispose', listener: () => void): void }>(
      meshes.flatMap(mesh => [mesh, mesh.geometry, mesh.material as THREE.Material]));
    const dispose = [...resources].map(resource => {
      const listener = vi.fn(); resource.addEventListener('dispose', listener); return listener;
    });
    renderer.dispose(); renderer = undefined;
    dispose.forEach(listener => expect(listener).toHaveBeenCalledOnce());
  });
});

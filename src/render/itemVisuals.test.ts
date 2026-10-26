import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createRace } from '../sim/race';
import { attachKartEffects, boxCoreRadius, createBoxAnim, createEntityMesh, createWarmupMeshes, entityPose, boltTrailSpark, createHitTracker, hitElapsed, hitSquash, stepBoxAnim, updateKartEffects } from './itemVisuals';

function kartVisual() {
  const root = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ color: 0x55bb77, emissive: 0x102030, emissiveIntensity: 0.2 });
  root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 3), material));
  return { root, material, effects: attachKartEffects(root), kart: createRace(42).karts[0] };
}

describe('item meshes', () => {
  for (const kind of ['bolt', 'trap', 'seeker', 'skycomet', 'bomb', 'decoy', 'orbit'] as const) {
    it(`${kind} shares a single draw mesh without a shadow pass`, () => {
      const mesh = createEntityMesh(kind);
      const other = createEntityMesh(kind);
      expect(mesh).not.toBe(other);
      expect(mesh.geometry).toBe(other.geometry);
      expect(mesh.material).toBe(other.material);
      expect(mesh.children).toHaveLength(0);
      expect(Array.isArray(mesh.material)).toBe(false);
      expect(mesh.castShadow).toBe(false);
      expect((mesh.material as THREE.Material).transparent).toBe(false);
      mesh.geometry.computeBoundingSphere();
      expect(mesh.geometry.boundingSphere!.radius).toBeGreaterThan(0);
      expect(Number.isFinite(mesh.geometry.boundingSphere!.radius)).toBe(true);
      expect(entityPose(mesh).lift).toBeGreaterThan(0);
    });
  }

  it('gives new entities distinct silhouettes and heading-following homing projectiles', () => {
    const meshes = (['seeker', 'skycomet', 'bomb', 'decoy'] as const).map(createEntityMesh);
    expect(new Set(meshes.map((mesh) => mesh.geometry)).size).toBe(4);
    for (const mesh of meshes) {
      expect(mesh.geometry.getAttribute('color').count).toBe(mesh.geometry.getAttribute('position').count);
      expect(mesh.geometry.groups).toHaveLength(0);
    }
    expect(entityPose(meshes[0]).spin).toBe(false);
    expect(entityPose(meshes[1]).spin).toBe(false);
  });
});

describe('kart item effects', () => {
  it('starts hidden and restores size, original emissive material, and boost flame after effects expire', () => {
    const { root, material, effects, kart } = kartVisual();
    expect([effects.flame, ...effects.orbit, effects.held].every((mesh) => !mesh.visible)).toBe(true);
    const children = root.children.length;
    const originalEmissive = material.emissive.clone();
    const originalColor = material.color.clone();
    kart.effects.shrinkTime = 5;
    kart.effects.auraTime = 7;
    kart.effects.autoTime = 4;
    updateKartEffects(effects, kart, 1);
    expect(root.scale.toArray()).toEqual([0.6, 0.6, 0.6]);
    expect(material.emissiveIntensity).toBeGreaterThan(0.4);
    expect(material.emissive.equals(originalEmissive)).toBe(false);
    expect(material.color.equals(originalColor)).toBe(true);
    expect(effects.flame.visible).toBe(true);
    expect(effects.flame.material.color.getHex()).toBe(0x65e5ff);
    expect(root.children).toHaveLength(children);

    kart.effects.shrinkTime = kart.effects.auraTime = kart.effects.autoTime = 0;
    updateKartEffects(effects, kart, 2);
    expect(root.scale.toArray()).toEqual([1, 1, 1]);
    expect(material.emissive.equals(originalEmissive)).toBe(true);
    expect(material.emissiveIntensity).toBe(0.2);
    expect(effects.flame.visible).toBe(false);
    kart.boostTime = 1;
    updateKartEffects(effects, kart, 3);
    expect(effects.flame.visible).toBe(true);
    expect(effects.flame.material.color.getHex()).toBe(0xffd863);
  });

  it('keeps per-kart flame colors and aura state independent', () => {
    const a = kartVisual();
    const b = kartVisual();
    a.kart.effects.auraTime = a.kart.effects.autoTime = 2;
    b.kart.boostTime = 2;
    updateKartEffects(a.effects, a.kart, 1);
    updateKartEffects(b.effects, b.kart, 1);
    expect(b.material.emissiveIntensity).toBe(0.2);
    expect(a.effects.flame.material.color.getHex()).toBe(0x65e5ff);
    expect(b.effects.flame.material.color.getHex()).toBe(0xffd863);
    expect(a.effects.flame.geometry).toBe(b.effects.flame.geometry);
  });

  it('renders orbit counts/kinds and synchronizes world positions from race time despite shrink/heading', () => {
    const { effects, kart, root } = kartVisual();
    kart.effects.orbitCount = 3;
    kart.effects.orbitKind = 1;
    kart.effects.shrinkTime = 5;
    root.rotation.y = 1.4;
    updateKartEffects(effects, kart, 5, 2);
    root.updateMatrixWorld(true);
    const positions = effects.orbit.map((mesh) => mesh.getWorldPosition(new THREE.Vector3()));
    effects.orbit.forEach((mesh, index) => {
      expect(mesh.visible).toBe(true);
      expect(mesh.geometry).toBe(createEntityMesh('trap').geometry);
      expect(Math.hypot(positions[index].x, positions[index].z)).toBeCloseTo(2.2);
      expect(positions[index].y).toBeCloseTo(0.7);
      expect(mesh.getWorldScale(new THREE.Vector3()).x).toBeCloseTo(1);
    });
    updateKartEffects(effects, kart, 20, 2);
    root.updateMatrixWorld(true);
    effects.orbit.forEach((mesh, index) => expect(mesh.getWorldPosition(new THREE.Vector3()).distanceTo(positions[index])).toBeCloseTo(0));
    kart.effects.orbitKind = 2;
    kart.effects.orbitCount = 1;
    updateKartEffects(effects, kart, 20, 2);
    expect(effects.orbit.map((mesh) => mesh.visible)).toEqual([true, false, false]);
    expect(effects.orbit[0].geometry).toBe(createEntityMesh('bolt').geometry);
    kart.effects.orbitCount = 0;
    updateKartEffects(effects, kart, 20, 2);
    expect(effects.orbit.every((mesh) => !mesh.visible)).toBe(true);
  });

  it('reuses one held item mesh behind the kart and hides it on release', () => {
    const { effects, kart, root } = kartVisual();
    kart.effects.holding = 1;
    kart.effects.shrinkTime = 5;
    for (const item of ['trap', 'bolt', 'decoy', 'bomb'] as const) {
      kart.item = item;
      updateKartEffects(effects, kart, 1);
      root.updateMatrixWorld(true);
      expect(effects.held.visible).toBe(true);
      expect(effects.held.geometry).toBe(createEntityMesh(item).geometry);
      expect(effects.held.getWorldPosition(new THREE.Vector3()).z).toBeCloseTo(-2.2);
    }
    kart.effects.holding = 0;
    updateKartEffects(effects, kart, 2);
    expect(effects.held.visible).toBe(false);
  });
});

describe('item box and hit animation', () => {
  it('shrinks within 0.15 s after pickup and grows back in 0.4 s with ease-out', () => {
    const anim = createBoxAnim();
    expect(stepBoxAnim(anim, true, 1 / 60)).toBe(1);
    expect(stepBoxAnim(anim, false, 0.15)).toBe(0);
    const early = stepBoxAnim(anim, true, 0.1);
    expect(early).toBeGreaterThan(0.1 / 0.4);
    expect(stepBoxAnim(anim, true, 0.3)).toBe(1);
  });

  it('pulses the core 0.55-0.75 at 2 Hz and holds still under reduced motion', () => {
    expect(boxCoreRadius(0.125, false)).toBeCloseTo(0.75);
    expect(boxCoreRadius(0.375, false)).toBeCloseTo(0.55);
    expect(boxCoreRadius(0.125, true)).toBeCloseTo(0.65);
  });

  it('squashes y to 0.7 for 0.2 s after the hit origin', () => {
    expect(hitSquash(Infinity)).toBe(1);
    expect(hitSquash(0)).toBeCloseTo(1);
    expect(hitSquash(0.1)).toBeCloseTo(0.7);
    expect(hitSquash(0.2)).toBeCloseTo(1);
    const { effects, kart } = kartVisual();
    updateKartEffects(effects, kart, 0, 0, false, 0.1);
    expect(effects.root.scale.y).toBeCloseTo(0.7);
  });

  it('times the squash from the rising spinTime edge for any start value, and ignores falls', () => {
    for (const start of [1.05, 1.0, 1.5]) {
      const tracker = createHitTracker();
      expect(hitElapsed(tracker, 0, false, 1)).toBe(Infinity);
      expect(hitElapsed(tracker, start, false, 2)).toBe(0);
      expect(hitElapsed(tracker, start - 0.1, false, 2.1)).toBeCloseTo(0.1);
      expect(hitElapsed(tracker, start - 0.3, false, 2.3)).toBeCloseTo(0.3);
    }
    const fall = createHitTracker();
    expect(hitElapsed(fall, 1.5, true, 5)).toBe(Infinity);
    expect(hitElapsed(fall, 1.4, false, 5.1)).toBe(Infinity);
  });

  it('shows the aura ring only while aura is active, sharing an existing lambert material', () => {
    const { effects, kart } = kartVisual();
    updateKartEffects(effects, kart, 0, 0, false);
    expect(effects.ring.visible).toBe(false);
    kart.effects.auraTime = 3;
    updateKartEffects(effects, kart, 0.2, 0.2, false);
    expect(effects.ring.visible).toBe(true);
    expect(effects.ring.scale.x).not.toBeCloseTo(1);
    updateKartEffects(effects, kart, 0.2, 0.2, true);
    expect(effects.ring.scale.x).toBeCloseTo(1);
    expect(effects.ring.material).toBe(createEntityMesh('bolt').material);
  });

  it('lays bolt trail sparks behind the heading, shrinking', () => {
    const first = boltTrailSpark(0, 0);
    const last = boltTrailSpark(0, 3);
    expect(first.z).toBeLessThan(0);
    expect(last.z).toBeLessThan(first.z);
    expect(last.scale).toBeLessThan(first.scale);
    expect(boltTrailSpark(Math.PI / 2, 0).x).toBeLessThan(0);
  });

  it('warm-up meshes cover every entity look at zero scale', () => {
    const meshes = createWarmupMeshes();
    expect(meshes).toHaveLength(6);
    expect(meshes.every((mesh) => mesh.scale.x === 0 && !mesh.frustumCulled)).toBe(true);
  });
});

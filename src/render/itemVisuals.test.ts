import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createRace } from '../sim/race';
import { attachKartEffects, createEntityMesh, entityPose, updateKartEffects } from './itemVisuals';

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

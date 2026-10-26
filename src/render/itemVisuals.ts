import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { KartState } from '../sim/types';
import type { ProjectileKind, TrapKind } from '../sim/itemTypes';
import { orbitPosition } from '../sim/items';

const motionPreference = typeof window === 'undefined' ? null : window.matchMedia('(prefers-reduced-motion: reduce)');

/** Lift above the track and whether the mesh spins instead of following its heading. */
export interface EntityPose { lift: number; spin: boolean }

interface EntityLook { geometry: THREE.BufferGeometry; material: THREE.Material; pose: EntityPose }
type EntityKind = ProjectileKind | TrapKind | 'orbit';

const lambert = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true });
const looks = new Map<EntityKind, EntityLook>();

/** Vertex colors keep multi-part silhouettes in one mesh/material and one draw. */
function coloredParts(parts: [THREE.BufferGeometry, number][]): THREE.BufferGeometry {
  const geometries = parts.map(([source, hex]) => {
    // Polyhedra have no index, while boxes/cones do; normalize before merging.
    const geometry = source.index ? source.toNonIndexed() : source;
    if (geometry !== source) source.dispose();
    const color = new THREE.Color(hex);
    const colors = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  });
  const merged = mergeGeometries(geometries, false)!;
  geometries.forEach((geometry) => geometry.dispose());
  return merged;
}

function multicolor(geometry: THREE.BufferGeometry, lift: number, spin: boolean): EntityLook {
  return { geometry, material: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), pose: { lift, spin } };
}

function look(kind: EntityKind): EntityLook {
  let entry = looks.get(kind);
  if (!entry) {
    switch (kind) {
      case 'bolt':
        entry = { geometry: new THREE.IcosahedronGeometry(0.55, 0), material: lambert(0xffdc41), pose: { lift: 0.7, spin: true } };
        break;
      case 'trap':
        entry = { geometry: new THREE.ConeGeometry(0.8, 0.45, 5), material: lambert(0xff648b), pose: { lift: 0.22, spin: false } };
        break;
      case 'seeker':
        entry = multicolor(coloredParts([
          [new THREE.ConeGeometry(0.47, 1.5, 6).rotateX(Math.PI / 2), 0xff6170],
          [new THREE.BoxGeometry(1.4, 0.12, 0.5).translate(0, 0, -0.35), 0xffe9af],
          [new THREE.BoxGeometry(0.12, 0.9, 0.45).translate(0, 0.15, -0.38), 0xffe9af],
        ]), 0.8, false);
        break;
      case 'skycomet':
        entry = multicolor(coloredParts([
          [new THREE.IcosahedronGeometry(0.68, 0), 0x64e5ff],
          [new THREE.ConeGeometry(0.5, 1.65, 5).rotateX(-Math.PI / 2).translate(0, 0, -0.85), 0xfff2af],
        ]), 1.9, false);
        break;
      case 'bomb':
        entry = multicolor(coloredParts([
          [new THREE.SphereGeometry(0.62, 10, 8), 0x343c51],
          [new THREE.CylinderGeometry(0.10, 0.10, 0.4, 5).translate(0, 0.69, 0), 0xffd86b],
          [new THREE.OctahedronGeometry(0.18).translate(0, 0.94, 0), 0xff704d],
        ]), 0.63, true);
        break;
      case 'decoy':
        entry = multicolor(coloredParts([
          [new THREE.BoxGeometry(1.3, 1.3, 1.3).applyMatrix4(new THREE.Matrix4()
            .makeRotationFromEuler(new THREE.Euler(Math.PI / 5, 0, Math.PI / 4))), 0x9ce9d2],
          [new THREE.OctahedronGeometry(0.62).translate(0, 0.2, 0), 0xffe1a3],
        ]), 1.5, true);
        break;
      case 'orbit':
        entry = look('bolt');
        break;
    }
    looks.set(kind, entry);
  }
  return entry;
}

/** Meshes share geometry and material per kind; the pose is kept in userData. */
export function createEntityMesh(kind: EntityKind): THREE.Mesh {
  const entry = look(kind);
  const mesh = new THREE.Mesh(entry.geometry, entry.material);
  // A shadow pass would double the draw cost of each small projectile.
  mesh.castShadow = false;
  mesh.userData.pose = entry.pose;
  return mesh;
}

export const entityPose = (mesh: THREE.Mesh): EntityPose => mesh.userData.pose as EntityPose;

/** Item box timings: shrink after a pickup, then grow back with an ease-out once it respawns. */
export const BOX_SHRINK_TIME = 0.15;
export const BOX_GROW_TIME = 0.4;
export interface BoxAnim { scale: number; grow: number }
export const createBoxAnim = (): BoxAnim => ({ scale: 1, grow: 1 });

/** Advances one box's presence scale by dt seconds; `active` is respawnTime <= 0. */
export function stepBoxAnim(anim: BoxAnim, active: boolean, dt: number): number {
  if (active) {
    if (anim.grow < 1) {
      anim.grow = Math.min(1, anim.grow + dt / BOX_GROW_TIME);
      anim.scale = 1 - (1 - anim.grow) ** 3;
    } else anim.scale = 1;
  } else {
    anim.grow = 0;
    anim.scale = Math.max(0, anim.scale - dt / BOX_SHRINK_TIME);
  }
  return anim.scale;
}

/** Core pulse radius: 2 Hz between 0.55 and 0.75. Reduced motion holds the midpoint. */
export const boxCoreRadius = (elapsed: number, reducedMotion: boolean): number =>
  0.65 + (reducedMotion ? 0 : Math.sin(elapsed * Math.PI * 4) * 0.1);

/** Hit squash: scale y dips to 0.7 and returns within 0.2 s of the hit, whatever spinTime it started at. */
export const HIT_SQUASH_TIME = 0.2;
export const hitSquash = (age: number): number =>
  age >= 0 && age < HIT_SQUASH_TIME ? 1 - 0.3 * Math.sin(Math.PI * age / HIT_SQUASH_TIME) : 1;

/** Per-kart hit origin: a rising spinTime marks a hit; a fall respawn (also sets spinTime) is not one. */
export interface HitTracker { spin: number; at: number }
export const createHitTracker = (): HitTracker => ({ spin: 0, at: -Infinity });

/** Seconds since the last hit (Infinity if none), advancing the tracker with this frame's spinTime. */
export function hitElapsed(tracker: HitTracker, spinTime: number, fell: boolean, now: number): number {
  if (spinTime > tracker.spin + 1e-9) tracker.at = fell ? -Infinity : now;
  tracker.spin = spinTime;
  return now - tracker.at;
}

export const BOLT_TRAIL_COUNT = 4;

/** Spark `index` of a bolt's trail: offset behind the heading, shrinking with distance. */
export function boltTrailSpark(heading: number, index: number): { x: number; z: number; scale: number } {
  const back = 0.8 + index * 0.65;
  return { x: -Math.sin(heading) * back, z: -Math.cos(heading) * back, scale: 1 - index * 0.2 };
}

/** One mesh per entity look, for a zero-scale first render that compiles every effect program. */
export function createWarmupMeshes(): THREE.Mesh[] {
  return (['bolt', 'trap', 'seeker', 'skycomet', 'bomb', 'decoy'] as const).map((kind) => {
    const mesh = createEntityMesh(kind);
    mesh.frustumCulled = false;
    mesh.scale.setScalar(0);
    return mesh;
  });
}

interface AuraMaterial { material: THREE.MeshLambertMaterial; emissive: THREE.Color; intensity: number }

export interface KartEffectVisuals {
  root: THREE.Group;
  ring: THREE.Mesh;
  flame: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  orbit: THREE.Mesh[];
  held: THREE.Mesh;
  auraMaterials: AuraMaterial[];
}

const flameGeometry = new THREE.ConeGeometry(0.38, 1.7, 6);
const ringGeometry = new THREE.TorusGeometry(1.6, 0.07, 6, 24);

/** Attach once; all per-frame changes reuse meshes and existing kart materials. */
export function attachKartEffects(root: THREE.Group): KartEffectVisuals {
  const materials = new Set<THREE.MeshLambertMaterial>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material instanceof THREE.MeshLambertMaterial) materials.add(material);
    }
  });
  const auraMaterials = [...materials].map((material) => ({ material, emissive: material.emissive.clone(), intensity: material.emissiveIntensity }));
  const flame = new THREE.Mesh(flameGeometry, new THREE.MeshBasicMaterial({ color: 0xffd863 }));
  flame.rotation.x = -Math.PI / 2;
  flame.position.set(0, 0.58, -2.05);
  // Shares the bolt look's lambert material, so the aura ring adds no shader program; userData.pose
  // marks it shared so GameRenderer.disposeScene detaches it without disposing that material.
  const ring = new THREE.Mesh(ringGeometry, look('bolt').material);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.6;
  ring.castShadow = false;
  ring.userData.pose = look('bolt').pose;
  const orbit = Array.from({ length: 3 }, () => createEntityMesh('orbit'));
  const held = createEntityMesh('trap');
  for (const mesh of [flame, ring, ...orbit, held]) {
    mesh.visible = false;
    root.add(mesh);
  }
  return { root, ring, flame, orbit, held, auraMaterials };
}

/** Pass state.time to synchronize orbit phase online, independently of decorative motion. */
export function updateKartEffects(effects: KartEffectVisuals, kart: KartState, elapsed: number,
  raceTime = elapsed, reducedMotion = motionPreference?.matches ?? false, sinceHit = Infinity): void {
  const animationTime = reducedMotion ? 0 : elapsed;
  const scale = kart.effects.shrinkTime > 0 ? 0.6 : 1;
  effects.root.scale.set(scale, scale * hitSquash(sinceHit), scale);
  const auto = kart.effects.autoTime > 0;
  effects.flame.visible = kart.boostTime > 0 || auto;
  effects.flame.material.color.setHex(auto ? 0x65e5ff : 0xffd863);
  effects.flame.scale.set(auto ? 1.5 : 1, (auto ? 1.8 : 1) * (1 + Math.sin(animationTime * 45) * 0.25), auto ? 1.5 : 1);
  effects.flame.position.z = auto ? -2.65 : -2.05;

  const aura = kart.effects.auraTime > 0;
  effects.ring.visible = aura;
  effects.ring.scale.setScalar(1 + Math.sin(animationTime * 6) * 0.12);
  for (const { material, emissive, intensity } of effects.auraMaterials) {
    if (aura) {
      material.emissive.setHex(0xffd65c);
      material.emissiveIntensity = 0.6 + Math.sin(animationTime * 6) * 0.25;
    } else {
      material.emissive.copy(emissive);
      material.emissiveIntensity = intensity;
    }
  }

  const orbitLook = look(kart.effects.orbitKind === 1 ? 'trap' : 'bolt');
  effects.orbit.forEach((mesh, index) => {
    // The sim gives the guard no hitbox while its roulette is still spinning.
    mesh.visible = kart.effects.orbitKind > 0 && index < kart.effects.orbitCount && kart.effects.rouletteTime <= 0;
    if (!mesh.visible) return;
    mesh.geometry = orbitLook.geometry;
    mesh.material = orbitLook.material;
    // Compensate the parent transform so the defensive radius stays 2.2m.
    const offset = orbitPosition(raceTime, index);
    const sin = Math.sin(effects.root.rotation.y);
    const cos = Math.cos(effects.root.rotation.y);
    mesh.position.set((offset.x * cos - offset.z * sin) / scale, 0.7 / scale,
      (offset.x * sin + offset.z * cos) / scale);
    mesh.scale.setScalar(1 / scale);
    mesh.rotation.y = animationTime * 9;
  });

  const heldItem = kart.item;
  const hold = kart.effects.holding > 0 && (heldItem === 'trap' || heldItem === 'bolt' || heldItem === 'decoy' || heldItem === 'bomb');
  effects.held.visible = hold;
  if (hold) {
    const heldLook = look(heldItem);
    effects.held.geometry = heldLook.geometry;
    effects.held.material = heldLook.material;
    effects.held.position.set(0, heldLook.pose.lift / scale, -2.2 / scale);
    effects.held.scale.setScalar(1 / scale);
    effects.held.rotation.y = heldLook.pose.spin ? animationTime * 9 : 0;
  }
}

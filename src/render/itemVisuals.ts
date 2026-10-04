import * as THREE from 'three';
import type { KartState } from '../sim/types';

/** Lift above the track and whether the mesh spins instead of following its heading. */
export interface EntityPose { lift: number; spin: boolean }

interface EntityLook { geometry: THREE.BufferGeometry; material: THREE.Material; pose: EntityPose }

const lambert = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true });
const looks = new Map<string, EntityLook>();

function look(kind: string): EntityLook {
  let entry = looks.get(kind);
  if (!entry) {
    switch (kind) {
      case 'bolt':
        entry = { geometry: new THREE.IcosahedronGeometry(0.55, 0), material: lambert(0xffdc41), pose: { lift: 0.7, spin: true } };
        break;
      case 'trap':
        entry = { geometry: new THREE.ConeGeometry(0.8, 0.45, 5), material: lambert(0xff648b), pose: { lift: 0.22, spin: false } };
        break;
      default:
        // Entity kinds without artwork yet stay visible as a neutral marker.
        entry = { geometry: new THREE.OctahedronGeometry(0.5, 0), material: lambert(0xd9e4e0), pose: { lift: 0.5, spin: true } };
    }
    looks.set(kind, entry);
  }
  return entry;
}

/** Meshes share geometry and material per kind; the pose is kept in userData. */
export function createEntityMesh(kind: string): THREE.Mesh {
  const entry = look(kind);
  const mesh = new THREE.Mesh(entry.geometry, entry.material);
  mesh.castShadow = true;
  mesh.userData.pose = entry.pose;
  return mesh;
}

export const entityPose = (mesh: THREE.Mesh): EntityPose => mesh.userData.pose as EntityPose;

export interface KartEffectVisuals { flame: THREE.Mesh }

/** Item-driven effects attached to a kart root (the dash boost flame for now). */
export function attachKartEffects(root: THREE.Group): KartEffectVisuals {
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.38, 1.7, 6), new THREE.MeshBasicMaterial({ color: 0xffd863 }));
  flame.rotation.x = -Math.PI / 2;
  flame.position.set(0, 0.58, -2.05);
  root.add(flame);
  return { flame };
}

export function updateKartEffects(effects: KartEffectVisuals, kart: KartState, elapsed: number): void {
  effects.flame.visible = kart.boostTime > 0;
  effects.flame.scale.y = 1 + Math.sin(elapsed * 45) * 0.25;
}

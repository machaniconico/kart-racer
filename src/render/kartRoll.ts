import * as THREE from 'three';
import { rollAt } from '../sim';
import type { Track } from '../sim';

export function kartRotationZ(track: Track, trackDistance: number): number {
  const roll = rollAt(track, trackDistance);
  return roll === 0 ? 0 : roll;
}

/** YXZ applies bank in the kart's local frame before its world heading. */
export function rolledLocalPointY(heading: number, rotationZ: number, localX: number): number {
  const object = new THREE.Object3D();
  object.rotation.set(0, heading, rotationZ, 'YXZ');
  return object.localToWorld(new THREE.Vector3(localX, 0, 0)).y;
}

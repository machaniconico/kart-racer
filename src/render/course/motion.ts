import * as THREE from 'three';
import { sampleTrack } from '../../sim';
import type { Track } from '../../sim';
import { barrierCenterAt, barrierHalfWidthAt } from '../../sim/corridor';
import { disposeObjectTree, type CourseTheme } from './buildCourse';

export interface MotionUpdater {
  update(time: number): void;
  dispose(): void;
}

/** One draw per moving band or floor; the course owns all of their resources. */
export function buildMotion(track: Track, theme: CourseTheme, parent: THREE.Group): MotionUpdater {
  const motionGroup = new THREE.Group();
  motionGroup.name = 'motion';
  parent.add(motionGroup);
  const bands = (track.def.barriers ?? []).flatMap((barrier, index) => {
    if (!barrier.motion) return [];
    const span = (barrier.to - barrier.from + track.length) % track.length;
    const point = sampleTrack(track, barrier.from + span / 2);
    const taper = Math.min(barrier.taper ?? 4, span / 2);
    const geometry = new THREE.BoxGeometry(2, 1.2, 1, 1, 1, 4);
    const vertices = geometry.getAttribute('position');
    for (let i = 0; i < vertices.count; i++) {
      // Four sections put vertices at both taper joins; local X is lateral
      // and local Z follows the track at the band's midpoint.
      const unit = vertices.getZ(i) + 0.5;
      const along = unit < 0.25 ? unit * 4 * taper : unit > 0.75
        ? span - (1 - unit) * 4 * taper : taper + (unit - 0.25) * 2 * (span - 2 * taper);
      const half = Math.min(1, along / (barrier.taper ?? 4), (span - along) / (barrier.taper ?? 4));
      vertices.setXYZ(i, vertices.getX(i) * half, vertices.getY(i), along - span / 2);
    }
    geometry.computeVertexNormals();
    const color = theme.colors.motionBarrier ?? theme.colors.barrier ?? theme.colors.post;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({
      color, emissive: color, emissiveIntensity: 0.6, flatShading: true,
    }));
    mesh.name = `motion:barrier:${index}`;
    mesh.rotation.y = Math.atan2(point.tx, point.tz);
    mesh.receiveShadow = true;
    // No extra shadow draw: two bands plus one disc cost at most three calls.
    motionGroup.add(mesh);
    return [{ barrier, mesh, point }];
  });
  const discs = track.def.surfaces.flatMap((zone, index) => {
    if (zone.kind !== 'spin') return [];
    const point = sampleTrack(track, (zone.from + zone.to) / 2);
    const offset = ((zone.offsetMin ?? 0) + (zone.offsetMax ?? 0)) / 2;
    const geometry = new THREE.CircleGeometry((zone.to - zone.from) / 2, 48);
    // Bake the horizontal plane into geometry so positive rotation.y follows
    // the same +Z toward +X heading convention as the simulation and karts.
    geometry.rotateX(-Math.PI / 2);
    const stripes = new Uint8Array([
      255, 255, 255, 255, 255, 255, 255, 255,
      32, 32, 32, 255, 32, 32, 32, 255,
    ]);
    const texture = new THREE.DataTexture(stripes, 4, 1);
    texture.wrapS = THREE.RepeatWrapping;
    texture.repeat.x = 6;
    texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    const color = theme.colors.motionSpin ?? theme.colors.surfaces.spin ?? 0xb77ee0;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({
      color, emissive: color, emissiveIntensity: 0.6, map: texture, emissiveMap: texture,
    }));
    mesh.name = `motion:spin:${index}`;
    mesh.position.set(point.x + point.nx * offset, point.y + 0.12, point.z + point.nz * offset);
    mesh.receiveShadow = true;
    motionGroup.add(mesh);
    return [{ mesh, rate: zone.rate ?? 0 }];
  });
  const updater: MotionUpdater = {
    update(time) {
      for (const { barrier, mesh, point } of bands) {
        const center = barrierCenterAt(barrier, time);
        mesh.position.set(point.x + point.nx * center, point.y + 0.66, point.z + point.nz * center);
        mesh.scale.x = barrierHalfWidthAt(barrier, time);
      }
      for (const { mesh, rate } of discs) mesh.rotation.y = rate * time;
    },
    dispose() {
      disposeObjectTree(motionGroup);
      motionGroup.removeFromParent();
    },
  };
  updater.update(0);
  return updater;
}

import * as THREE from 'three';
import { sampleTrack } from '../../../sim/track';
import type { Track } from '../../../sim/types';
import { widthAt } from '../../../sim/corridor';
import type { SceneryBudget } from '../CourseTheme';
import type { CourseTheme } from '../buildCourse';
import { material, terrainHeight } from '../buildCourse';

export const volcanoPalette = {
  basalt: 0x2b2224, lava: 0xff4d1a, sky: 0x5a2b24, fog: 0x7a3a2a, accent: 0xffb347,
} as const;

export const volcano: CourseTheme = {
  colors: {
    sky: volcanoPalette.sky, skyTop: 0x241b25, skyBottom: 0xa65032,
    ground: volcanoPalette.basalt, road: 0x514346, shoulder: 0x78605b,
    deck: 0x332e35, pillar: 0x39323a, line: 0xffd498,
    curb: [volcanoPalette.accent, 0x4c3434], rail: 0xb5917f, post: 0x463339,
    dash: 0xbba392, gate: 0x50323a, bannerBackground: '#38252b', bannerText: '#ffd498',
    checker: [0xffd498, 0x2b2224], signBackground: '#ffb347', signText: '#2b2224',
    surfaces: { ice: 0xbdefff, boost: 0xffb347, jump: 0xffb347, dirt: 0x655c60, pit: volcanoPalette.lava },
  },
  fog: { color: volcanoPalette.fog, near: 170, far: 460 },
  lighting: {
    hemisphere: { sky: 0xffbb99, ground: 0x47333e, intensity: 1.9 },
    sun: { color: 0xffbc88, intensity: 2.1, position: [70, 100, 40], offset: [55, 85, 35] },
  },
  // Before the two switchbacks, ridge, downhill fissures, bank and western S bends.
  signFractions: [0.175, 0.35, 0.43, 0.565, 0.65, 0.78, 0.88],
  budget: { trees: 120, rocks: 72, flowers: 120 },
  buildProps,
  buildLandmarks(_track, scene) {
    // buildCourse owns the decal and its material; keep its actual pit cutouts emissive.
    const pit = scene.getObjectByName('surface:pit') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    if (pit) {
      pit.material.emissive.setHex(volcanoPalette.lava);
      pit.material.emissiveIntensity = 1.2;
    }
  },
};

/** Reserve the entire footprint against every branch, including the bridge below. */
function clearsRoads(track: Track, x: number, z: number, radius: number): boolean {
  return track.samples.every((a, i) => {
    const b = track.samples[(i + 1) % track.samples.length]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    const half = Math.max(widthAt(track, a.distance).wallHalfWidth, widthAt(track, b.distance).wallHalfWidth);
    return Math.hypot(x - a.x - t * dx, z - a.z - t * dz) > half + radius + 3;
  });
}

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  const transform = new THREE.Object3D();
  let seed = 683;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const char = material(0x382c30);
  const glow = new THREE.MeshLambertMaterial({ color: volcanoPalette.lava,
    emissive: volcanoPalette.lava, emissiveIntensity: 1.15, flatShading: true });
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.42, 4, 5), char, budget.trees);
  const branches = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.16, 2, 4), char, budget.trees);
  const columns = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 1, 5, 6),
    new THREE.MeshLambertMaterial({ color: volcanoPalette.basalt, emissive: 0x8c2009,
      emissiveIntensity: 0.65, flatShading: true }), Math.ceil(budget.trees / 2));
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), material(0x403943), budget.rocks);
  const reflections = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.04, 0.9), glow, budget.flowers);
  trunks.name = 'trunks'; branches.name = 'volcano:dead-branches'; columns.name = 'volcano:lava-columns';
  rocks.name = 'rocks'; reflections.name = 'flowers';
  trunks.castShadow = true; branches.castShadow = true; columns.castShadow = true;
  const batches = [trunks, columns, rocks, reflections];
  for (const mesh of batches) {
    const count = mesh.count;
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const distance = (i + random()) / count * track.length;
      const point = sampleTrack(track, distance);
      const side = i % 2 ? -1 : 1;
      const scale = 0.8 + random() * 0.65;
      const radius = mesh === trunks ? 1.6 * scale : mesh === rocks ? 2 * scale : scale;
      for (let attempt = 0; attempt < 24; attempt++) {
        const offset = side * (widthAt(track, distance).wallHalfWidth + 12 + attempt * 6 + random() * 8);
        const x = point.x + point.nx * offset, z = point.z + point.nz * offset;
        if (!clearsRoads(track, x, z, radius)) continue;
        // No raised terrain or mountains beside the exposed ridge and descent.
        const ground = terrainHeight(track, { distance, offset, height: point.y, heading: Math.atan2(point.tx, point.tz) });
        const halfHeight = mesh === trunks ? 2 : mesh === columns ? 2.5 : mesh === rocks ? 0.6 : 0.02;
        transform.position.set(x, ground + halfHeight * scale, z);
        transform.rotation.set(0, random() * Math.PI * 2, 0);
        transform.scale.set(scale, scale, scale);
        if (mesh === rocks) transform.scale.set(2 * scale, 0.6 * scale, 1.4 * scale);
        transform.updateMatrix();
        mesh.setMatrixAt(placed, transform.matrix);
        if (mesh === trunks) {
          transform.position.x += Math.cos(transform.rotation.y) * 0.5 * scale;
          transform.position.y += 0.7 * scale;
          transform.position.z -= Math.sin(transform.rotation.y) * 0.5 * scale;
          transform.rotation.z = -0.7;
          transform.updateMatrix();
          branches.setMatrixAt(placed, transform.matrix);
        }
        placed++;
        break;
      }
    }
    mesh.count = placed;
  }
  branches.count = trunks.count;
  scene.add(trunks, branches, columns, rocks, reflections);
}

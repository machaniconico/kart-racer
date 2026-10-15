import * as THREE from 'three';
import { sampleTrack } from '../../../sim/track';
import type { Track } from '../../../sim/types';
import { widthAt } from '../../../sim/corridor';
import type { SceneryBudget } from '../CourseTheme';
import { material, terrainHeight, type CourseTheme } from '../buildCourse';

export const templePalette = {
  gold: 0xd8b65a, moss: 0x536d39, stone: 0x85877a,
  jungle: 0x244a32, sky: 0x9bb59a, fog: 0x738d72,
} as const;

export const temple: CourseTheme = {
  colors: {
    sky: templePalette.sky, skyTop: 0x426d63, skyBottom: 0xc5cdb0,
    ground: templePalette.moss, road: templePalette.stone, shoulder: 0x64704b,
    deck: 0x797f6d, pillar: 0x676e5c, line: 0xe9dfb5,
    curb: [templePalette.gold, 0x3d5136], rail: 0xa5a588, post: 0x676e5c,
    dash: 0xddd1a1, gate: 0x656e59, barrier: templePalette.stone,
    motionBarrier: templePalette.stone, motionSpin: templePalette.gold,
    bannerBackground: '#244a32', bannerText: '#efdaa0',
    checker: [0xefdaa0, 0x344c36], signBackground: '#d8b65a', signText: '#243a2b',
    surfaces: { ice: 0xb5dcd1, boost: templePalette.gold, jump: templePalette.gold,
      dirt: 0x536d39, pit: 0x253d34, spin: templePalette.gold },
  },
  fog: { color: templePalette.fog, near: 150, far: 430 },
  lighting: {
    hemisphere: { sky: 0xe2edcc, ground: 0x354b35, intensity: 2.0 },
    sun: { color: 0xffe3a4, intensity: 2.0, position: [70, 100, 40], offset: [55, 85, 35] },
  },
  signFractions: [0.06, 0.115, 0.19, 0.36, 0.46, 0.55, 0.75, 0.88],
  budget: { trees: 120, rocks: 64, flowers: 72 },
  buildProps,
  buildLandmarks(_track, scene) {
    // Keep the shared island footprint and instance transforms, replacing its
    // city blocks with stepped stone columns entirely inside that footprint.
    const columns = scene.getObjectByName('island-scenery:building') as THREE.InstancedMesh | undefined;
    if (!columns) return;
    const profile = [
      new THREE.Vector2(0.5, -0.5), new THREE.Vector2(0.5, -0.38),
      new THREE.Vector2(0.29, -0.34), new THREE.Vector2(0.29, 0.32),
      new THREE.Vector2(0.5, 0.38), new THREE.Vector2(0.5, 0.5),
    ];
    columns.geometry.dispose();
    columns.geometry = new THREE.LatheGeometry(profile, 8);
    (columns.material as THREE.MeshLambertMaterial).color.setHex(templePalette.stone);
  },
};

/** Clear every branch, including the lower road underneath the causeway. */
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
  let seed = 1406;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.65, 7, 5),
    material(0x514e36), budget.trees);
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0),
    material(templePalette.jungle), budget.trees);
  const stones = new THREE.InstancedMesh(new THREE.BoxGeometry(2.8, 2, 2.2),
    material(templePalette.stone), budget.rocks);
  const ferns = new THREE.InstancedMesh(new THREE.ConeGeometry(1.2, 1.4, 5),
    material(templePalette.moss), budget.flowers);
  const relics = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.8, 1.1, 3, 6),
    material(templePalette.gold), 24);
  trunks.name = 'temple:trunks'; crowns.name = 'temple:canopies';
  stones.name = 'temple:ruins'; ferns.name = 'temple:ferns'; relics.name = 'temple:relics';
  trunks.castShadow = true; stones.castShadow = true;
  for (const mesh of [trunks, stones, ferns, relics]) {
    const count = mesh.count;
    let placed = 0;
    mesh.geometry.computeBoundingSphere();
    for (let i = 0; i < count; i++) {
      const distance = (i + random()) / count * track.length;
      const point = sampleTrack(track, distance), side = i % 2 ? -1 : 1;
      const scale = 0.8 + random() * 0.65;
      // The canopy is wider than its trunk; reserve both with the same check.
      const radius = (mesh === trunks ? 5 : mesh.geometry.boundingSphere!.radius) * scale;
      for (let attempt = 0; attempt < 24; attempt++) {
        const offset = side * (widthAt(track, distance).wallHalfWidth + 14 + attempt * 6 + random() * 8);
        const x = point.x + point.nx * offset, z = point.z + point.nz * offset;
        if (!clearsRoads(track, x, z, radius)) continue;
        const ground = terrainHeight(track, { distance, offset, height: point.y, heading: Math.atan2(point.tx, point.tz) });
        const halfHeight = mesh === trunks ? 3.5 : mesh === stones ? 1 : mesh === ferns ? 0.7 : 1.5;
        transform.position.set(x, ground + halfHeight * scale, z);
        transform.rotation.set(0, random() * Math.PI * 2, 0);
        transform.scale.setScalar(scale);
        transform.updateMatrix();
        mesh.setMatrixAt(placed, transform.matrix);
        if (mesh === trunks) {
          transform.position.y = ground + 7.5 * scale;
          transform.scale.set(5 * scale, 2.8 * scale, 4 * scale);
          transform.updateMatrix();
          crowns.setMatrixAt(placed, transform.matrix);
        }
        placed++;
        break;
      }
    }
    mesh.count = placed;
  }
  crowns.count = trunks.count;
  scene.add(trunks, crowns, stones, ferns, relics);
}

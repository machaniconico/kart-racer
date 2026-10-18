import * as THREE from 'three';
import { projectToTrack, sampleTrack } from '../../../sim';
import type { Track } from '../../../sim';
import { widthAt } from '../../../sim/corridor';
import { SUMMIT_RIDGE } from '../../../sim/tracks/summit';
import type { SceneryBudget } from '../CourseTheme';
import { material, terrainHeight } from '../buildCourse';
import type { CourseTheme } from '../buildCourse';

export const summit: CourseTheme = {
  colors: {
    sky: 0xd8e9e8, skyTop: 0x6baebf, skyBottom: 0xf2e5d5,
    ground: 0x7d9390, road: 0x485761, shoulder: 0x99a8ac, line: 0xfff5de,
    curb: [0xe28b46, 0xf4f0e5], rail: 0xdbe4e3, post: 0x495e66, dash: 0xb3c3c8,
    gate: 0xa64f27, bannerBackground: '#a64f27', bannerText: '#ffffff',
    checker: [0xfff5de, 0x283b43], signBackground: '#ffe4a5', signText: '#42352b',
    surfaces: { ice: 0xb9e5ee, boost: 0x75dfb4, jump: 0xf4b35d },
  },
  fog: { color: 0xd8e9e8, near: 230, far: 820 },
  lighting: {
    hemisphere: { sky: 0xe5f4fa, ground: 0x697b79, intensity: 1.9 },
    sun: { color: 0xffddb5, intensity: 2.1, position: [80, 140, -90], offset: [65, 110, -55] },
  },
  signFractions: [0.035, 0.13, 0.25, 0.365, 0.43, 0.68, 0.92],
  budget: { trees: 96, rocks: 80, flowers: 0 },
  buildProps,
  buildLandmarks,
};

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  let seed = 1104;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const transform = new THREE.Object3D();
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.38, 2, 5), material(0x65706c), budget.trees);
  const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(2.3, 6, 5), material(0x376b67), budget.trees);
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), material(0x9daaad), budget.rocks);
  const minX = Math.min(...track.samples.map(p => p.x)) - 65;
  const maxX = Math.max(...track.samples.map(p => p.x)) + 65;
  const minZ = Math.min(...track.samples.map(p => p.z)) - 100;
  const maxZ = Math.max(...track.samples.map(p => p.z)) + 100;
  function location() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const x = minX + random() * (maxX - minX), z = minZ + random() * (maxZ - minZ);
      const projection = projectToTrack(track, x, z);
      // No foliage or boulders suspended beside the exposed spine.
      if (projection.distance >= SUMMIT_RIDGE.from - 40 && projection.distance <= SUMMIT_RIDGE.to + 40) continue;
      if (Math.abs(projection.offset) <= widthAt(track, projection.distance).wallHalfWidth + 9) continue;
      return { x, y: terrainHeight(track, projection), z };
    }
    return null;
  }
  let trees = 0, stones = 0;
  for (let i = 0; i < budget.trees; i++) {
    const p = location();
    if (!p) continue;
    const scale = 0.8 + random() * 0.6;
    transform.rotation.set(0, random() * Math.PI * 2, 0);
    transform.scale.setScalar(scale);
    transform.position.set(p.x, p.y + scale, p.z);
    transform.updateMatrix();
    trunks.setMatrixAt(trees, transform.matrix);
    transform.position.y = p.y + 4 * scale;
    transform.updateMatrix();
    crowns.setMatrixAt(trees++, transform.matrix);
  }
  for (let i = 0; i < budget.rocks; i++) {
    const p = location();
    if (!p) continue;
    const scale = 1.2 + random() * 1.5;
    transform.position.set(p.x, p.y + scale * 0.4, p.z);
    transform.rotation.set(0, random() * Math.PI * 2, 0);
    transform.scale.set(scale * 1.3, scale * 0.8, scale);
    transform.updateMatrix();
    rocks.setMatrixAt(stones++, transform.matrix);
  }
  trunks.count = crowns.count = trees;
  rocks.count = stones;
  trunks.name = 'summit:trunks'; crowns.name = 'summit:conifers'; rocks.name = 'summit:rocks';
  crowns.castShadow = true;
  scene.add(trunks, crowns, rocks);
}

/** Theme-local cutouts keep the ridge exposed without changing legacy course meshes. */
function exposeRidge(track: Track, scene: THREE.Group): void {
  const onRidge = (x: number, z: number, margin = 0): boolean => {
    const { distance } = projectToTrack(track, x, z);
    return distance > SUMMIT_RIDGE.from - margin && distance < SUMMIT_RIDGE.to + margin;
  };
  for (const name of ['shoulder:-1', 'shoulder:1', 'ground:-1', 'ground:1']) {
    const mesh = scene.getObjectByName(name) as THREE.Mesh;
    const geometry = mesh.geometry, positions = geometry.getAttribute('position'), index = geometry.index!;
    const kept: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      if (!onRidge((positions.getX(a) + positions.getX(b) + positions.getX(c)) / 3,
        (positions.getZ(a) + positions.getZ(b) + positions.getZ(c)) / 3)) kept.push(a, b, c);
    }
    geometry.setIndex(kept);
  }
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), color = new THREE.Color();
  for (const name of ['curbs', 'rails', 'posts']) {
    const mesh = scene.getObjectByName(name) as THREE.InstancedMesh;
    let kept = 0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      position.setFromMatrixPosition(matrix);
      // Include the complete rail/curb footprint at either lip.
      if (onRidge(position.x, position.z, 2)) continue;
      mesh.setMatrixAt(kept, matrix);
      if (mesh.instanceColor) { mesh.getColorAt(i, color); mesh.setColorAt(kept, color); }
      kept++;
    }
    mesh.count = kept;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

function buildLandmarks(track: Track, scene: THREE.Group): void {
  // buildScenery also supports a standalone scenery group without road meshes.
  if (scene.getObjectByName('road')) exposeRidge(track, scene);
  // Sheer rock faces carry the asphalt 100 m above the valley. The fall bands stay open.
  const positions: number[] = [], indices: number[] = [];
  for (const side of [-1, 1]) for (const d of [SUMMIT_RIDGE.from, SUMMIT_RIDGE.to]) {
    const p = sampleTrack(track, d);
    for (const [offset, height] of [[3.55, p.y - 0.02], [3.55, 62], [25, -1.35]]) {
      positions.push(p.x + p.nx * offset * side, height, p.z + p.nz * offset * side);
    }
  }
  for (const base of [0, 6]) for (let tier = 0; tier < 2; tier++) {
    const a = base + tier;
    indices.push(a, a + 3, a + 1, a + 1, a + 3, a + 4);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const cliffMaterial = material(0x748184); cliffMaterial.side = THREE.DoubleSide;
  const cliff = new THREE.Mesh(geometry, cliffMaterial);
  cliff.name = 'summit:ridge-cliffs'; cliff.receiveShadow = true;
  scene.add(cliff);

  const peaks = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 5), material(0x819397), 18);
  const caps = new THREE.InstancedMesh(new THREE.ConeGeometry(0.34, 0.34, 5), material(0xf0f2eb), peaks.count);
  const minX = Math.min(...track.samples.map(p => p.x)), maxX = Math.max(...track.samples.map(p => p.x));
  const minZ = Math.min(...track.samples.map(p => p.z)), maxZ = Math.max(...track.samples.map(p => p.z));
  const transform = new THREE.Object3D();
  for (let i = 0; i < peaks.count; i++) {
    const angle = i / peaks.count * Math.PI * 2, height = 160 + i * 37 % 100;
    transform.position.set((minX + maxX) / 2 + Math.cos(angle) * ((maxX - minX) / 2 + 180),
      height / 2 - 3, (minZ + maxZ) / 2 + Math.sin(angle) * ((maxZ - minZ) / 2 + 240));
    transform.rotation.set(0, i * 0.73, 0);
    transform.scale.set(65 + i * 11 % 30, height, 60 + i * 17 % 35);
    transform.updateMatrix(); peaks.setMatrixAt(i, transform.matrix);
    transform.position.y = height * (1 - 0.34 / 2) - 3 + 0.03;
    transform.updateMatrix(); caps.setMatrixAt(i, transform.matrix);
  }
  peaks.name = 'summit:peaks'; caps.name = 'summit:snowcaps';
  scene.add(peaks, caps);
}

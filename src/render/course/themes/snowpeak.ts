import * as THREE from 'three';
import { projectToTrack } from '../../../sim';
import type { Track } from '../../../sim';
import { widthAt } from '../../../sim/corridor';
import type { SceneryBudget } from '../CourseTheme';
import type { CourseTheme } from '../buildCourse';
import { material, terrainHeight } from '../buildCourse';

export const snowpeak: CourseTheme = {
  colors: {
    sky: 0xdce8ed, skyTop: 0x8bafc4, skyBottom: 0xdce8ed,
    ground: 0xdce5eb, road: 0x788e9e, shoulder: 0xe9f0f3, line: 0xf8fcff,
    curb: [0x48748d, 0xf4f8fa], rail: 0xc5d6e0, post: 0x496778, dash: 0xc3d4de,
    gate: 0x315c75, bannerBackground: '#315c75', bannerText: '#ffffff',
    checker: [0xf8fcff, 0x294659], signBackground: '#edf6fa', signText: '#315c75',
    surfaces: { ice: 0x9fdfed, boost: 0x64e3a8, jump: 0xffbe62, dirt: 0x887059, pit: 0x302724, spin: 0xb77ee0 },
    barrier: 0x728a9a,
  },
  // The horizon matches the fog so distant peaks fade without a hard silhouette.
  fog: { color: 0xdce8ed, near: 65, far: 330 },
  lighting: {
    hemisphere: { sky: 0xeaf5ff, ground: 0x889eae, intensity: 1.65 },
    sun: { color: 0xf6faff, intensity: 1.75, position: [65, 100, 35], offset: [55, 85, 35] },
  },
  // Between the 24 gates: summit approach, ridge, descent, ice S and southern bank.
  signFractions: [2.25 / 24, 5.25 / 24, 7.25 / 24, 10.25 / 24, 14.25 / 24, 18.25 / 24, 21.25 / 24],
  // M5-00's 2042.8 m dry run: 84,914 GPU triangles, cap 152,566.
  // This layout: 106,084 course triangles + 5,784 shadow triangles, cap 165,738.
  // Moderate instanced growth leaves room for karts/items; M5-05 measures the GPU total.
  budget: { trees: 240, rocks: 90, flowers: 0 },
  buildProps,
  buildLandmarks,
};

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  let seed = 808;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const transform = new THREE.Object3D();
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.24, 0.38, 2, 5), material(0x60717a), budget.trees);
  const needles = new THREE.InstancedMesh(new THREE.ConeGeometry(2.4, 4.2, 6), material(0x366267), budget.trees * 2);
  const snow = new THREE.InstancedMesh(new THREE.ConeGeometry(1.85, 3.25, 6), material(0xf0f6fa), budget.trees * 2);
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1.6, 0), material(0xc0d0dc), budget.rocks);
  const rockSnow = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1.6, 0), material(0xf2f7fa), budget.rocks);

  const minX = Math.min(...track.samples.map(point => point.x)) - 65;
  const maxX = Math.max(...track.samples.map(point => point.x)) + 65;
  const minZ = Math.min(...track.samples.map(point => point.z)) - 65;
  const maxZ = Math.max(...track.samples.map(point => point.z)) + 65;
  // Eight metres clears even the largest branch/rock and both walls of the narrow ridge.
  // Projection checks the nearest road, including the opposite S-bend.
  const location = () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const x = minX + random() * (maxX - minX);
      const z = minZ + random() * (maxZ - minZ);
      const projection = projectToTrack(track, x, z);
      if (Math.abs(projection.offset) > widthAt(track, projection.distance).wallHalfWidth + 8) {
        return { x, y: terrainHeight(track, projection), z };
      }
    }
    return null;
  };
  let treeCount = 0;
  for (let i = 0; i < budget.trees; i++) {
    const p = location();
    if (!p) continue;
    const scale = 0.8 + random() * 0.75;
    transform.rotation.set(0, random() * Math.PI * 2, 0);
    transform.scale.setScalar(scale);
    transform.position.set(p.x, p.y + scale, p.z);
    transform.updateMatrix();
    trunks.setMatrixAt(treeCount, transform.matrix);
    for (let tier = 0; tier < 2; tier++) {
      const taper = tier === 0 ? 1 : 0.72;
      const y = p.y + (3.4 + tier * 2.1) * scale;
      transform.scale.setScalar(scale * taper);
      transform.position.y = y;
      transform.updateMatrix();
      needles.setMatrixAt(treeCount * 2 + tier, transform.matrix);
      // Match the apex, leaving a dark lower rim on each snowy branch tier.
      transform.position.y = y + (4.2 - 3.25) / 2 * scale * taper + 0.06;
      transform.updateMatrix();
      snow.setMatrixAt(treeCount * 2 + tier, transform.matrix);
    }
    treeCount++;
  }
  trunks.count = treeCount;
  needles.count = snow.count = treeCount * 2;
  let rockCount = 0;
  for (let i = 0; i < budget.rocks; i++) {
    const p = location();
    if (!p) continue;
    const scale = 0.65 + random() * 0.8;
    transform.rotation.set(0, random() * Math.PI * 2, 0);
    transform.scale.set(scale * 1.3, scale * 0.75, scale);
    transform.position.set(p.x, p.y + 0.45 * scale, p.z);
    transform.updateMatrix();
    rocks.setMatrixAt(rockCount, transform.matrix);
    transform.scale.set(scale * 1.12, scale * 0.3, scale * 0.86);
    transform.position.y = p.y + 1.25 * scale;
    transform.updateMatrix();
    rockSnow.setMatrixAt(rockCount, transform.matrix);
    rockCount++;
  }
  rocks.count = rockSnow.count = rockCount;
  trunks.name = 'snowpeak:trunks';
  needles.name = 'snowpeak:needles';
  snow.name = 'snowpeak:branch-snow';
  rocks.name = 'snowpeak:rocks';
  rockSnow.name = 'snowpeak:rock-snow';
  needles.castShadow = true;
  snow.receiveShadow = true;
  scene.add(trunks, needles, snow, rocks, rockSnow);
}

function buildLandmarks(track: Track, scene: THREE.Group): void {
  const peaks = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 5), material(0x8da4b6), 14);
  const caps = new THREE.InstancedMesh(new THREE.ConeGeometry(0.43, 0.43, 5), material(0xe3edf4), peaks.count);
  const transform = new THREE.Object3D();
  // Both layers use fog-aware materials, with bases buried below the terrain.
  const radius = Math.max(...track.samples.map(p => Math.hypot(p.x, p.z))) + 145;
  for (let i = 0; i < peaks.count; i++) {
    const angle = i / peaks.count * Math.PI * 2;
    const height = 66 + (i * 23 % 51);
    const width = 43 + (i * 17 % 24);
    transform.position.set(Math.cos(angle) * radius, -2 + height / 2, Math.sin(angle) * radius);
    transform.rotation.set(0, i * 0.73, 0);
    transform.scale.set(width, height, width * (0.85 + i % 3 * 0.1));
    transform.updateMatrix();
    peaks.setMatrixAt(i, transform.matrix);
    transform.position.y = -2 + height * (1 - 0.43 / 2) + 0.02;
    transform.updateMatrix();
    caps.setMatrixAt(i, transform.matrix);
  }
  peaks.name = 'snowpeak:mountains';
  caps.name = 'snowpeak:summit-snow';
  scene.add(peaks, caps);
}

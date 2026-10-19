import * as THREE from 'three';
import { projectToTrack, sampleTrack } from '../../../sim/track';
import type { Track } from '../../../sim/types';
import { material, type CourseTheme } from '../buildCourse';

export const spire: CourseTheme = {
  colors: {
    sky: 0xc4eced, skyTop: 0x78cbd4, skyBottom: 0xf0f8f3,
    ground: 0x7aa8a0, road: 0x455b60, deck: 0xd8e8e5, pillar: 0xf1f7ee,
    shoulder: 0xb8cfcb, line: 0xf5fff8, curb: [0xf1f7ee, 0x168f91],
    rail: 0x23c9be, post: 0xd8e8e5, dash: 0xd2ebe4, gate: 0x168f91,
    bannerBackground: '#163f45', bannerText: '#f5fff8', checker: [0xf5fff8, 0x168f91],
    signBackground: '#f5fff8', signText: '#163f45',
    surfaces: { ice: 0xc5f6f3, boost: 0x23c9be, jump: 0xffd25c },
  },
  fog: { color: 0xc4ded9, near: 320, far: 1100 },
  lighting: {
    hemisphere: { sky: 0xf4fffc, ground: 0x698f88, intensity: 2.0 },
    sun: { color: 0xfff2d2, intensity: 2.2, position: [70, 100, 40], offset: [55, 85, 35] },
  },
  signFractions: [0.12, 0.28, 0.46, 0.50, 0.55, 0.72],
  budget: { trees: 32, rocks: 24, flowers: 48 },
  buildProps,
  buildLandmarks,
};

function buildProps(track: Track, scene: THREE.Group, budget: CourseTheme['budget']): void {
  const transform = new THREE.Object3D();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const columns = new THREE.InstancedMesh(geometry, material(0xd8e8e5), budget.trees);
  const bases = new THREE.InstancedMesh(geometry, material(0x547d78), budget.rocks);
  const lights = new THREE.InstancedMesh(geometry, material(0x23c9be), budget.flowers);
  columns.name = 'spire:columns'; bases.name = 'spire:foundations'; lights.name = 'spire:beacons';
  for (const mesh of [columns, bases, lights]) {
    const count = mesh.count;
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const p = sampleTrack(track, (i + 0.5) / count * track.length);
      const offset = (track.def.wallHalfWidth + 40 + i % 4 * 10) * (i % 2 ? -1 : 1);
      const x = p.x + p.nx * offset, z = p.z + p.nz * offset;
      // Projection without a height hint also clears the other crossing levels.
      if (Math.abs(projectToTrack(track, x, z).offset) < track.def.wallHalfWidth + 12) continue;
      const height = mesh === columns ? 18 + i % 5 * 8 : mesh === bases ? 3 : 8;
      const width = mesh === columns ? 4 : mesh === bases ? 12 : 1;
      transform.position.set(x, -1.35 + height / 2, z);
      transform.scale.set(width, height, width);
      transform.updateMatrix();
      mesh.setMatrixAt(placed++, transform.matrix);
    }
    mesh.count = placed;
  }
  scene.add(columns, bases, lights);
}

function buildLandmarks(_track: Track, scene: THREE.Group): void {
  // The tower is built above a flat plaza, with open air beneath its terraces.
  for (const name of ['ground:-1', 'ground:1']) {
    const ground = scene.getObjectByName(name) as THREE.Mesh | undefined;
    if (!ground) continue;
    ground.removeFromParent();
    ground.geometry.dispose();
    for (const mat of Array.isArray(ground.material) ? ground.material : [ground.material]) mat.dispose();
  }
  const tower = new THREE.Group();
  tower.name = 'spire:switchback-tower';
  const frame = material(0xf1f7ee), accent = material(0x168f91);
  const addBeam = (x: number, y: number, z: number, w: number, h: number, d: number,
    mat: THREE.Material): void => {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    beam.position.set(x, y, z);
    tower.add(beam);
  };
  for (const x of [-90, 90]) for (const z of [40, 120]) addBeam(x, 39, z, 4, 80, 4, frame);
  for (const height of [19, 37, 55]) {
    // Frames sit between the switchbacks, well above the low return spine.
    for (const z of [40, 120]) addBeam(0, height - 2, z, 184, 3, 4, frame);
    // The +90 m middle cross-beam spans the terrace-1 climb (road ≈ 26 m there): at 35 m the chase
    // camera (kart + 5.1 m, ≈ 33.7 m) passed through it, so it sits 14 m over that road instead.
    for (const x of [-90, 90]) addBeam(x, x > 0 && height === 37 ? 41 : height - 2, 80, 6, 2, 84, accent);
  }
  addBeam(0, 80, 80, 184, 3, 84, frame);
  const beacon = new THREE.Mesh(new THREE.ConeGeometry(13, 24, 4), accent);
  beacon.position.set(0, 94, 80);
  tower.add(beacon);
  scene.add(tower);
}

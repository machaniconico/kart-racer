import * as THREE from 'three';
import { projectToTrack, sampleTrack } from '../../../sim';
import type { Track } from '../../../sim';
import type { SceneryBudget } from '../CourseTheme';
import type { CourseTheme } from '../buildCourse';
import { material, place, terrainHeight } from '../buildCourse';

export const meadow: CourseTheme = {
  colors: {
    sky: 0xa3dce6, skyTop: 0x51b8ed, skyBottom: 0xdff4ee,
    ground: 0x82c767, road: 0x596d73, shoulder: 0x98cf64, line: 0xf8f6d8,
    curb: [0xeb695f, 0xfff1d1], rail: 0xe9eee0, post: 0x547e6d, dash: 0xaab8b4,
    gate: 0x175c50, bannerBackground: '#175c50', bannerText: '#ffffff',
    checker: [0xffffee, 0x203a3d], signBackground: '#fff0aa', signText: '#184f43',
    surfaces: { ice: 0xbdefff, boost: 0x64e3a8, jump: 0xffbe62, dirt: 0x99683f, pit: 0x302724, spin: 0xb77ee0 },
    barrier: 0x927050,
  },
  fog: { color: 0xb4e1df, near: 170, far: 460 },
  lighting: {
    hemisphere: { sky: 0xe5faff, ground: 0x6d965b, intensity: 2.25 },
    sun: { color: 0xfff1d4, intensity: 2.25, position: [70, 100, 40], offset: [55, 85, 35] },
  },
  signFractions: [0.18, 0.37, 0.61, 0.82],
  budget: { trees: 150, rocks: 54, flowers: 120 },
  buildProps,
  // MEADOW has no course-specific landmarks.
  buildLandmarks() {},
};

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  const transform = new THREE.Object3D();
  transform.rotation.order = 'YXZ';
  // Scenery uses a local deterministic sequence and never consumes simulation RNG.
  let seed = 127;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const trees = budget.trees;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.27, 0.4, 2, 5), material(0x927050), trees);
  const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(2.4, 5.7, 6), material(0x34a67b), trees);
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1.6, 0), material(0xa3b7a6), budget.rocks);
  const flowers = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.22, 0), material(0xffe97e), budget.flowers);
  for (let i = 0; i < trees; i++) {
    let x = 0, z = 0, projection = projectToTrack(track, 0, 0);
    for (let tries = 0; tries < 100; tries++) {
      x = (random() - 0.5) * 365;
      z = (random() - 0.5) * 365;
      projection = projectToTrack(track, x, z);
      if (Math.abs(projection.offset) > track.def.wallHalfWidth + 6) break;
    }
    const y = terrainHeight(track, projection);
    const scale = 0.75 + random() * 0.7;
    transform.position.set(x, y + scale, z);
    transform.rotation.set(0, random() * 6.28, 0);
    transform.scale.setScalar(scale);
    transform.updateMatrix();
    trunks.setMatrixAt(i, transform.matrix);
    transform.position.y = y + 4.5 * scale;
    transform.updateMatrix();
    crowns.setMatrixAt(i, transform.matrix);
    crowns.setColorAt(i, new THREE.Color().setHSL(0.37 + random() * 0.07, 0.45, 0.37 + random() * 0.12));
    if (i < rocks.count) {
      transform.position.set(x + 3.5, y + 0.25, z + 2);
      transform.scale.set(scale * 1.5, scale * 0.8, scale);
      transform.updateMatrix();
      rocks.setMatrixAt(i, transform.matrix);
    }
  }
  for (let i = 0; i < flowers.count; i++) {
    const p = sampleTrack(track, random() * track.length);
    const offset = (track.def.roadHalfWidth + 1.2 + random() * 1.2) * (i % 2 ? -1 : 1);
    place(track, transform, p, offset, 0.28);
    flowers.setMatrixAt(i, transform.matrix);
  }
  trunks.name = 'trunks';
  crowns.name = 'crowns';
  rocks.name = 'rocks';
  flowers.name = 'flowers';
  crowns.castShadow = true;
  trunks.castShadow = true;
  scene.add(trunks, crowns, rocks, flowers);
  const peaks = new THREE.InstancedMesh(new THREE.ConeGeometry(45, 65, 5), material(0x75b99d), 16);
  for (let i = 0; i < peaks.count; i++) {
    const angle = i / peaks.count * Math.PI * 2;
    transform.position.set(Math.cos(angle) * 290, 13 + random() * 12, Math.sin(angle) * 290);
    transform.rotation.set(0, random() * 3, 0);
    transform.scale.set(1 + random(), 0.7 + random() * 0.8, 1 + random());
    transform.updateMatrix();
    peaks.setMatrixAt(i, transform.matrix);
    peaks.setColorAt(i, new THREE.Color().setHSL(0.4, 0.26, 0.58 + random() * 0.08));
  }
  peaks.name = 'peaks';
  scene.add(peaks);
  const clouds = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xf7fff0 }), 36);
  for (let i = 0; i < clouds.count; i++) {
    const angle = i / clouds.count * Math.PI * 2;
    transform.position.set(Math.cos(angle) * 220, 48 + random() * 24, Math.sin(angle) * 220);
    transform.scale.set(8 + random() * 13, 3 + random() * 4, 5 + random() * 6);
    transform.rotation.set(0, 0, 0);
    transform.updateMatrix();
    clouds.setMatrixAt(i, transform.matrix);
  }
  clouds.name = 'clouds';
  scene.add(clouds);
}

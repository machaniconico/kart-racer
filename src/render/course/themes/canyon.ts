import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { projectToTrack, sampleTrack } from '../../../sim';
import type { Track } from '../../../sim';
import { widthAt } from '../../../sim/corridor';
import type { SceneryBudget } from '../CourseTheme';
import type { CourseTheme } from '../buildCourse';
import { material, place, terrainHeight } from '../buildCourse';

export const canyon: CourseTheme = {
  colors: {
    sky: 0xf4ce98, skyTop: 0x71becf, skyBottom: 0xffdfae,
    ground: 0xdba95e, road: 0x805c47, shoulder: 0xc68a48, line: 0xffeac0,
    curb: [0xb44b2e, 0xffdda0], rail: 0xefcf99, post: 0x73402d, dash: 0xc9a37a,
    gate: 0x783e2d, bannerBackground: '#783e2d', bannerText: '#fff0ca',
    checker: [0xffe8b5, 0x442c25], signBackground: '#ffda79', signText: '#623525',
    surfaces: { ice: 0xbdefff, boost: 0x64e3a8, jump: 0xfbc45a, dirt: 0xb47a3e, pit: 0x302724, spin: 0xb77ee0 },
    barrier: 0xa85c39,
  },
  fog: { color: 0xeac797, near: 155, far: 490 },
  lighting: {
    hemisphere: { sky: 0xfff0d6, ground: 0xa66538, intensity: 2.1 },
    sun: { color: 0xffd8a0, intensity: 2.3, position: [70, 100, 40], offset: [55, 85, 35] },
  },
  signFractions: [0.18, 0.35, 0.70, 0.84],
  // M5: double the props on the three-times-longer course; keep the remaining
  // 60 triangles/metre + 30k allowance for ribbons, the deck and kart shadows.
  budget: { trees: 192, rocks: 88, flowers: 120 },
  buildProps,
  buildLandmarks,
};

function cactusGeometry(): THREE.BufferGeometry {
  const stem = () => new THREE.CylinderGeometry(0.34, 0.43, 1, 6);
  const parts = [
    stem().scale(1.25, 5, 1.25).translate(0, 2.5, 0),
    stem().scale(0.9, 1.5, 0.9).rotateZ(Math.PI / 2).translate(-0.85, 2.1, 0),
    stem().scale(0.9, 2.4, 0.9).translate(-1.6, 3.1, 0),
    stem().scale(0.8, 1.3, 0.8).rotateZ(Math.PI / 2).translate(0.8, 2.9, 0),
    stem().scale(0.8, 1.7, 0.8).translate(1.45, 3.6, 0),
  ];
  const geometry = mergeGeometries(parts)!;
  parts.forEach(part => part.dispose());
  return geometry;
}

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  let seed = 713;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const transform = new THREE.Object3D();
  const cacti = new THREE.InstancedMesh(cactusGeometry(), material(0x42745a), budget.trees);
  const pillars = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.72, 1, 1, 7), material(0xb75f37), budget.rocks);
  const pillarCaps = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.85, 0.78, 1, 7), material(0xe8b46d), budget.rocks);
  const stones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), material(0xb87d4e), budget.flowers);
  const mesas = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.72, 1, 1, 6), material(0xb4744e), 16);
  const mesaCaps = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.72, 0.82, 1, 6), material(0xdba271), 16);

  // Check every branch in XZ: the nearest projection alone can hide an upper
  // deck behind a narrower lower road. Clearance includes each prop's radius.
  const clearOfRoad = (x: number, z: number, clearance: number): boolean =>
    track.samples.every((a, i) => {
      const b = track.samples[(i + 1) % track.samples.length]!;
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
      const distance = a.distance + t * ((i + 1 === track.samples.length ? track.length : b.distance) - a.distance);
      return Math.hypot(x - a.x - t * dx, z - a.z - t * dz) > widthAt(track, distance).wallHalfWidth + clearance;
    });

  const roadside = (clearance: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const point = sampleTrack(track, random() * track.length);
      const offset = (widthAt(track, point.distance).wallHalfWidth + clearance + random() * 65) * (random() < 0.5 ? -1 : 1);
      const x = point.x + point.nx * offset;
      const z = point.z + point.nz * offset;
      const projection = projectToTrack(track, x, z);
      if (clearOfRoad(x, z, clearance)) {
        return { x, y: terrainHeight(track, projection), z };
      }
    }
    return null;
  };
  for (const [mesh, clearance] of [[cacti, 8], [pillars, 13], [stones, 5]] as const) {
    let count = 0;
    for (let i = 0; i < mesh.count; i++) {
      const point = roadside(clearance);
      if (!point) continue;
      transform.rotation.set(0, random() * Math.PI * 2, 0);
      if (mesh === cacti) {
        const scale = 0.65 + random() * 0.8;
        transform.position.set(point.x, point.y - 0.1, point.z);
        transform.scale.setScalar(scale);
      } else if (mesh === pillars) {
        const width = 2.1 + random() * 3.1;
        const height = 9 + random() * 15;
        transform.position.set(point.x, point.y + height / 2 - 0.3, point.z);
        transform.scale.set(width, height, width * (0.8 + random() * 0.3));
      } else {
        const scale = 0.5 + random() * 1.6;
        transform.position.set(point.x, point.y + scale * 0.25, point.z);
        transform.scale.set(scale * 1.4, scale * 0.7, scale);
      }
      transform.updateMatrix();
      mesh.setMatrixAt(count, transform.matrix);
      mesh.setColorAt(count, new THREE.Color().setScalar(0.8 + random() * 0.35));
      if (mesh === pillars) {
        const height = transform.scale.y;
        transform.position.y += height * 0.41;
        transform.scale.y = height * 0.16;
        transform.updateMatrix();
        pillarCaps.setMatrixAt(count, transform.matrix);
      }
      count++;
    }
    mesh.count = count;
  }
  pillarCaps.count = pillars.count;
  const xs = track.samples.map(point => point.x), zs = track.samples.map(point => point.z);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerZ = (Math.min(...zs) + Math.max(...zs)) / 2;
  const extent = Math.max(...track.samples.map(point => Math.hypot(point.x - centerX, point.z - centerZ)));
  for (let i = 0; i < mesas.count; i++) {
    const angle = (i + 0.3) / mesas.count * Math.PI * 2;
    // The entire mesa (at most 52 m radius) stays beyond the course envelope,
    // including the deck and island, as the layout grows in either direction.
    const radius = extent + 90 + random() * 35;
    const width = 27 + random() * 25;
    const height = 35 + random() * 30;
    transform.position.set(centerX + Math.cos(angle) * radius, height / 2 - 2, centerZ + Math.sin(angle) * radius);
    transform.rotation.set(0, angle + random() * 0.4, 0);
    transform.scale.set(width, height, width * 0.7);
    transform.updateMatrix();
    mesas.setMatrixAt(i, transform.matrix);
    transform.position.y += height * 0.44;
    transform.scale.y = height * 0.12;
    transform.updateMatrix();
    mesaCaps.setMatrixAt(i, transform.matrix);
  }
  cacti.name = 'canyon:cacti';
  pillars.name = 'canyon:pillars';
  pillarCaps.name = 'canyon:pillar-caps';
  stones.name = 'canyon:stones';
  mesas.name = 'canyon:mesas';
  mesaCaps.name = 'canyon:mesa-caps';
  cacti.castShadow = true;
  pillars.castShadow = true;
  scene.add(cacti, pillars, pillarCaps, stones, mesas, mesaCaps);
}

function buildLandmarks(track: Track, scene: THREE.Group): void {
  const jumps = track.def.surfaces.filter(zone => zone.kind === 'jump');
  if (jumps.length === 0) return;
  // The leading edge is exactly zone.from, where the simulation launches.
  // The approach wedge is visual only: the sampled road remains continuous. It stays low (0.18 m)
  // because karts follow the road surface until they cross zone.from, so a tall lip would swallow the wheels.
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    const z = positions.getZ(i);
    positions.setXYZ(i, positions.getX(i), positions.getY(i) > 0 ? 0.06 + (z + 0.5) * 0.12 : 0.04, z - 0.5);
  }
  geometry.computeVertexNormals();
  const lips = new THREE.InstancedMesh(geometry, material(canyon.colors.surfaces.jump), jumps.length);
  const stripes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.03, 0.2), material(0x613827), jumps.length * 8);
  const transform = new THREE.Object3D();
  for (const [i, jump] of jumps.entries()) {
    const point = sampleTrack(track, jump.from);
    const half = widthAt(track, jump.from).roadHalfWidth;
    const left = jump.offsetMin ?? -half;
    const right = jump.offsetMax ?? half;
    place(track, transform, point, (left + right) / 2, 0);
    transform.scale.set(right - left, 1, 4);
    transform.updateMatrix();
    lips.setMatrixAt(i, transform.matrix);
    for (let stripe = 0; stripe < 8; stripe++) {
      place(track, transform, point, left + (stripe + 0.5) / 8 * (right - left), 0);
      transform.translateY(0.18);
      transform.translateZ(-0.12);
      transform.scale.set((right - left) / 16, 1, 1);
      transform.updateMatrix();
      stripes.setMatrixAt(i * 8 + stripe, transform.matrix);
    }
  }
  lips.name = 'canyon:jump-lips';
  stripes.name = 'canyon:jump-stripes';
  lips.receiveShadow = true;
  scene.add(lips, stripes);
}

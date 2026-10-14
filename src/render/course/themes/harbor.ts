import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildTrack, projectToTrack, sampleTrack } from '../../../sim';
import type { Track } from '../../../sim';
import { widthAt } from '../../../sim/corridor';
import { harbor as harborLayout } from '../../../sim/tracks/harbor';
import type { SceneryBudget } from '../CourseTheme';
import type { CourseTheme } from '../buildCourse';
import { material, place, terrainHeight } from '../buildCourse';
import { meadow } from './meadow';

export const harborPalette = {
  sky: 0x9ad8ff, fog: 0xcfe9f5, road: 0x6f7f86, sand: 0xe6d3a3, sea: 0x2b8fc9, accent: 0xff7a3d,
} as const;

const signTrack = buildTrack(harborLayout);
export const harbor: CourseTheme = {
  colors: {
    ...meadow.colors, sky: harborPalette.sky, skyTop: harborPalette.sky, skyBottom: harborPalette.fog,
    ground: harborPalette.sea, road: harborPalette.road, shoulder: harborPalette.sand,
    curb: [harborPalette.accent, 0xf5f4e9], rail: 0xe7eff0, post: 0x536c79,
    gate: 0x285b72, bannerBackground: '#285b72', signBackground: '#f5f4e9', signText: '#285b72',
    surfaces: { ...meadow.colors.surfaces, dirt: harborPalette.sand, jump: harborPalette.accent },
    barrier: 0x82969d, motionBarrier: harborPalette.accent,
  },
  fog: { color: harborPalette.fog, near: 180, far: 520 },
  lighting: { ...meadow.lighting, hemisphere: { sky: 0xe8f7ff, ground: 0x6e9ead, intensity: 2.25 } },
  // 25 m ahead of the pier hairpin, lighthouse, promenades, west pier and final bends.
  signFractions: [5, 18, 20, 26, 30, 37, 41].map(index =>
    (signTrack.samples[index * harborLayout.samplesPerSegment]!.distance - 25) / signTrack.length),
  // Leave the GPU baseline null until M6-05; use low-poly instancing for harbour furniture.
  budget: { trees: 120, rocks: 72, flowers: 72 },
  buildProps,
  buildLandmarks,
};

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts)!;
  parts.forEach(part => part.dispose());
  return geometry;
}

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  let seed = 127;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const palms = Math.ceil(budget.trees / 2);
  const foliage = merge(Array.from({ length: 5 }, (_, i) =>
    new THREE.BoxGeometry(0.7, 0.12, 3.2).rotateX(0.22).translate(0, 5.5, 1.25).rotateY(i * Math.PI * 2 / 5)));
  const lamp = merge([
    new THREE.CylinderGeometry(0.12, 0.18, 5, 6).translate(0, 2.5, 0),
    new THREE.BoxGeometry(1.8, 0.15, 0.18).translate(0.8, 5, 0),
    new THREE.BoxGeometry(0.65, 0.22, 0.45).translate(1.5, 4.9, 0),
  ]);
  const breakwater = merge([
    new THREE.BoxGeometry(3.6, 0.9, 0.9).rotateZ(0.65).translate(0, 1.2, 0),
    new THREE.BoxGeometry(0.9, 0.9, 3.6).rotateX(-0.65).translate(0, 1.2, 0),
  ]);
  const batches = [
    ['trunks', new THREE.CylinderGeometry(0.23, 0.4, 5.4, 6).translate(0, 2.7, 0), 0x9a7956, palms, 4],
    ['harbor:lamps', lamp, 0x536c79, budget.trees - palms, 2],
    ['rocks', breakwater, 0x99aab0, Math.ceil(budget.rocks / 3), 3],
    ['harbor:buoys', merge([
      new THREE.CylinderGeometry(0.6, 1.1, 1.4, 8).translate(0, 0.7, 0),
      new THREE.CylinderGeometry(0.1, 0.1, 1.8, 5).translate(0, 2, 0),
    ]), harborPalette.accent, Math.floor(budget.rocks / 3), 1.2],
    ['harbor:crates', new THREE.BoxGeometry(1.8, 1.8, 1.8).translate(0, 0.9, 0), 0xa97e4e,
      budget.rocks - Math.ceil(budget.rocks / 3) - Math.floor(budget.rocks / 3), 1.4],
    ['flowers', new THREE.TorusGeometry(0.65, 0.09, 4, 10).rotateX(-Math.PI / 2).translate(0, 0.12, 0),
      0xd4bb88, budget.flowers, 0.8],
  ] as const;
  const crowns = new THREE.InstancedMesh(foliage, material(0x3b9977), palms);
  crowns.name = 'crowns';
  const transform = new THREE.Object3D();
  // Test every branch, including the parallel piers, with the entire prop footprint.
  const segments = track.samples.map((a, i) => {
    const b = track.samples[(i + 1) % track.samples.length]!;
    return { a, dx: b.x - a.x, dz: b.z - a.z,
      wall: Math.max(widthAt(track, a.distance).wallHalfWidth, widthAt(track, b.distance).wallHalfWidth) };
  });
  for (const [name, geometry, color, count, radius] of batches) {
    const mesh = new THREE.InstancedMesh(geometry, material(color), count);
    mesh.name = name;
    let placed = 0;
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const point = sampleTrack(track, random() * track.length);
        const scale = 0.85 + random() * 0.3;
        const clearance = radius * scale + 2;
        const offset = (widthAt(track, point.distance).wallHalfWidth + clearance + random() * 18)
          * (random() < 0.5 ? -1 : 1);
        const x = point.x + point.nx * offset, z = point.z + point.nz * offset;
        if (!segments.every(({ a, dx, dz, wall }) => {
          const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
          return Math.hypot(x - a.x - t * dx, z - a.z - t * dz) > wall + clearance;
        })) continue;
        transform.position.set(x, terrainHeight(track, projectToTrack(track, x, z)), z);
        transform.rotation.set(0, random() * Math.PI * 2, 0);
        transform.scale.setScalar(scale);
        transform.updateMatrix();
        mesh.setMatrixAt(placed, transform.matrix);
        if (name === 'trunks') crowns.setMatrixAt(placed, transform.matrix);
        placed++;
        break;
      }
    }
    mesh.count = placed;
    if (name === 'trunks') { crowns.count = placed; mesh.castShadow = true; }
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  scene.add(crowns);
}

function buildLandmarks(track: Track, scene: THREE.Group): void {
  const split = track.def.splits![0]!;
  const point = sampleTrack(track, (split.from + split.to) / 2);
  const lighthouse = new THREE.Group();
  lighthouse.name = 'harbor:lighthouse';
  lighthouse.position.set(point.x, point.y + 0.21, point.z);
  for (const [geometry, color] of [
    [new THREE.CylinderGeometry(1.5, 2.3, 15, 12).translate(0, 7.5, 0), 0xf5f4e9],
    [new THREE.CylinderGeometry(1.85, 2, 2, 12).translate(0, 6.5, 0), harborPalette.accent],
    [new THREE.CylinderGeometry(2.6, 2.6, 0.4, 12).translate(0, 15, 0), 0x536c79],
    [new THREE.CylinderGeometry(1.4, 1.4, 2, 8).translate(0, 16, 0), 0xffe4a2],
    [new THREE.ConeGeometry(2.2, 1.6, 12).translate(0, 17.8, 0), harborPalette.accent],
  ] as const) lighthouse.add(new THREE.Mesh(geometry, material(color)));
  scene.add(lighthouse);

  // Timber on either side of each 4 m cut makes the mandatory pier jumps legible.
  const jumps = track.def.surfaces.filter(zone => zone.kind === 'jump');
  const planks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.08, 2.6), material(0xb49870), jumps.length * 20);
  planks.name = 'harbor:pier-planks';
  const gaps = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.04, 1), material(harborPalette.sea), jumps.length);
  gaps.name = 'harbor:pier-gaps';
  const transform = new THREE.Object3D();
  jumps.forEach((jump, index) => {
    for (let i = 0; i < 20; i++) {
      const d = i < 10 ? jump.from - (10 - i) * 3 + 1.5 : jump.to + (i - 10) * 3 + 1.5;
      place(track, transform, sampleTrack(track, d), 0, 0.09);
      transform.scale.set(widthAt(track, d).roadHalfWidth * 2, 1, 1);
      transform.updateMatrix();
      planks.setMatrixAt(index * 20 + i, transform.matrix);
    }
    const d = (jump.from + jump.to) / 2;
    place(track, transform, sampleTrack(track, d), 0, 0.10);
    transform.scale.set(widthAt(track, d).roadHalfWidth * 2, 1, jump.to - jump.from);
    transform.updateMatrix();
    gaps.setMatrixAt(index, transform.matrix);
  });
  scene.add(planks, gaps);
}

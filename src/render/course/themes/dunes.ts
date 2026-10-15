import * as THREE from 'three';
import { widthAt } from '../../../sim/corridor';
import { sampleTrack } from '../../../sim/track';
import type { Track } from '../../../sim/types';
import type { SceneryBudget } from '../CourseTheme';
import { material, terrainHeight, type CourseTheme } from '../buildCourse';

export const dunesPalette = {
  sand: 0xc49a51, sandstone: 0x9c633e, sky: 0x745676, dust: 0xc39b7c, cactus: 0x596b4b,
} as const;

export const dunes: CourseTheme = {
  colors: {
    sky: dunesPalette.sky, skyTop: 0x483b69, skyBottom: 0x9d7699,
    ground: dunesPalette.sand, road: 0x80654b, shoulder: 0xdbb96f,
    deck: 0xa47b50, pillar: dunesPalette.sandstone, line: 0xffedb9,
    curb: [0xf3cf7b, 0x76516b], rail: 0xd9ad72, post: 0x76503e,
    dash: 0xffe3a0, gate: 0x62435c, bannerBackground: '#62435c', bannerText: '#ffedb9',
    checker: [0xffedb9, 0x62435c], signBackground: '#f3cf7b', signText: '#483b69',
    surfaces: { ice: 0xd6e8eb, boost: 0xffce79, jump: 0xffce79, dirt: 0xb58a49, pit: 0x664633 },
  },
  fog: { color: dunesPalette.dust, near: 115, far: 390 },
  lighting: {
    hemisphere: { sky: 0xe1bad5, ground: 0x8e6845, intensity: 1.8 },
    sun: { color: 0xffcb8f, intensity: 2.0, position: [-100, 65, 60], offset: [-85, 55, 45] },
  },
  signFractions: [0.085, 0.35, 0.58, 0.73, 0.80, 0.87],
  budget: { trees: 72, rocks: 64, flowers: 96 },
  buildProps,
  buildLandmarks(_track, scene) {
    // The third launch sits inside the long sand basin: keep its paint above the dirt decal.
    const jumps = scene.getObjectByName('surface:jump');
    if (jumps) jumps.position.y = 0.015;
  },
};

/** Check the full prop footprint against every road segment, including the far side of a bend. */
function clearsRoad(track: Track, x: number, z: number, radius: number): boolean {
  return track.samples.every((a, i) => {
    const b = track.samples[(i + 1) % track.samples.length]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    const half = Math.max(widthAt(track, a.distance).wallHalfWidth, widthAt(track, b.distance).wallHalfWidth);
    return Math.hypot(x - a.x - t * dx, z - a.z - t * dz) > half + radius + 3;
  });
}

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  const cactus = material(dunesPalette.cactus);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.4, 0.5, 4.5, 6), cactus, budget.trees);
  const arms = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.24, 0.3, 2, 5), cactus, budget.trees);
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), material(dunesPalette.sandstone), budget.rocks);
  const dunes = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 4), material(0xd7ad64), Math.ceil(budget.rocks / 2));
  const scrub = new THREE.InstancedMesh(new THREE.ConeGeometry(0.5, 0.8, 5), material(0x927c4c), budget.flowers);
  trunks.name = 'trunks'; arms.name = 'dunes:cactus-arms'; rocks.name = 'rocks';
  dunes.name = 'dunes:sand-ridges'; scrub.name = 'flowers';
  trunks.castShadow = true; arms.castShadow = true; rocks.castShadow = true;
  const transform = new THREE.Object3D();
  let seed = 1001;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (const mesh of [trunks, rocks, dunes, scrub]) {
    const count = mesh.count;
    let placed = 0;
    mesh.geometry.computeBoundingSphere();
    for (let i = 0; i < count; i++) {
      const distance = (i + random()) / count * track.length;
      const point = sampleTrack(track, distance);
      const side = i % 2 ? -1 : 1;
      const size = 0.8 + random() * 0.7;
      const scale = mesh === dunes ? [7 * size, 1.8 * size, 4 * size] :
        mesh === rocks ? [2 * size, 2.8 * size, 1.7 * size] : [size, size, size];
      const radius = Math.max(mesh.geometry.boundingSphere!.radius * Math.max(...scale), mesh === trunks ? 4 * size : 0);
      for (let attempt = 0; attempt < 24; attempt++) {
        const offset = side * (widthAt(track, distance).wallHalfWidth + radius + 10 + attempt * 6 + random() * 8);
        const x = point.x + point.nx * offset, z = point.z + point.nz * offset;
        if (!clearsRoad(track, x, z, radius)) continue;
        const ground = terrainHeight(track, { distance, offset, height: point.y, heading: Math.atan2(point.tx, point.tz) });
        const halfHeight = mesh === trunks ? 2.25 : mesh === rocks ? 2.2 : mesh === dunes ? -0.1 : 0.4;
        transform.position.set(x, ground + halfHeight * size, z);
        transform.rotation.set(0, random() * Math.PI * 2, 0);
        transform.scale.set(scale[0]!, scale[1]!, scale[2]!);
        transform.updateMatrix();
        mesh.setMatrixAt(placed, transform.matrix);
        if (mesh === trunks) {
          transform.position.x += Math.cos(transform.rotation.y) * 0.8 * size;
          transform.position.z -= Math.sin(transform.rotation.y) * 0.8 * size;
          transform.position.y += 0.5 * size;
          transform.rotation.z = -0.8;
          transform.updateMatrix();
          arms.setMatrixAt(placed, transform.matrix);
        }
        placed++;
        break;
      }
    }
    mesh.count = placed;
  }
  arms.count = trunks.count;
  scene.add(trunks, arms, rocks, dunes, scrub);
}

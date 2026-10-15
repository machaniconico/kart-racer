import * as THREE from 'three';
import { widthAt } from '../../../sim/corridor';
import { sampleTrack } from '../../../sim/track';
import type { Track } from '../../../sim/types';
import type { CourseTheme, SceneryBudget } from '../CourseTheme';
import { material, terrainHeight } from '../buildCourse';

export const serpentinePalette = {
  orange: 0xe88932, red: 0xb83d36, rock: 0x777b80, sky: 0xb8cad5, ground: 0x806e4d,
} as const;

export const serpentine: CourseTheme = {
  colors: {
    sky: serpentinePalette.sky, skyTop: 0x728caa, skyBottom: 0xe8d8ba,
    ground: serpentinePalette.ground, road: 0x62616a, shoulder: 0x9e8462,
    deck: 0x656a70, pillar: serpentinePalette.rock, line: 0xffe7b0,
    curb: [serpentinePalette.orange, 0xede0c2], rail: 0xa7acb0, post: 0x64584d,
    dash: 0xd5c7aa, gate: 0x60442f, bannerBackground: '#493a30', bannerText: '#ffe7b0',
    checker: [0xffe7b0, 0x493a30], signBackground: '#e88932', signText: '#392f2c',
    surfaces: { ice: 0xc6dfec, boost: 0xf1c861, jump: 0xe88932 },
  },
  fog: { color: 0xc4b9a6, near: 180, far: 500 },
  lighting: {
    hemisphere: { sky: 0xffe4be, ground: 0x594b3d, intensity: 2.0 },
    sun: { color: 0xffd5a1, intensity: 2.1, position: [70, 100, -30], offset: [55, 85, -25] },
  },
  // Both narrow switchbacks, the wider summit hairpin and the banked descent.
  signFractions: [0.135, 0.345, 0.54, 0.75, 0.9],
  budget: { trees: 140, rocks: 64, flowers: 80 },
  buildProps,
  buildLandmarks() {},
};

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  // Reserve whole prop bounds against every branch. Cache static segment widths
  // once, since the placement search may revisit a segment many times.
  const segments = track.samples.map((a, i) => {
    const b = track.samples[(i + 1) % track.samples.length]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    return { x: a.x, z: a.z, dx, dz, squared: dx * dx + dz * dz,
      half: Math.max(widthAt(track, a.distance).wallHalfWidth, widthAt(track, b.distance).wallHalfWidth) };
  });
  const clearsRoads = (x: number, z: number, radius: number): boolean => segments.every(segment => {
    const { dx, dz } = segment;
    const t = Math.max(0, Math.min(1, ((x - segment.x) * dx + (z - segment.z) * dz) / segment.squared));
    return Math.hypot(x - segment.x - t * dx, z - segment.z - t * dz) > segment.half + radius + 2;
  });
  let seed = 7107;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const transform = new THREE.Object3D();
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.4, 4, 5), material(0x66503e), budget.trees);
  const crowns = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(2.8, 0), material(0xffffff), budget.trees);
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), material(serpentinePalette.rock), budget.rocks);
  const leaves = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 0.04, 5), material(0xffffff), budget.flowers);
  trunks.name = 'serpentine:trunks'; crowns.name = 'serpentine:foliage';
  rocks.name = 'serpentine:rocks'; leaves.name = 'serpentine:fallen-leaves';
  trunks.castShadow = true; crowns.castShadow = true; rocks.castShadow = true;
  const color = new THREE.Color();
  for (const mesh of [trunks, rocks, leaves]) {
    const count = mesh.count;
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const distance = (i + random()) / count * track.length;
      const p = sampleTrack(track, distance), side = i % 2 ? -1 : 1;
      const size = 0.8 + random() * 0.6;
      // This also reserves the crown, whose centre shares the trunk's XZ position.
      const radius = (mesh === trunks ? 3.5 : mesh === rocks ? 2.2 : 1) * size;
      for (let attempt = 0; attempt < 24; attempt++) {
        const offset = side * (widthAt(track, distance).wallHalfWidth + 10 + attempt * 6 + random() * 8);
        const x = p.x + p.nx * offset, z = p.z + p.nz * offset;
        if (!clearsRoads(x, z, radius)) continue;
        const ground = terrainHeight(track, { distance, offset, height: p.y, heading: Math.atan2(p.tx, p.tz) });
        transform.position.set(x, ground + (mesh === trunks ? 2 : mesh === rocks ? 0.7 : 0.04) * size, z);
        transform.rotation.set(0, random() * Math.PI * 2, 0);
        transform.scale.set(size, size, size);
        if (mesh === rocks) transform.scale.set(2.2 * size, 0.9 * size, 1.6 * size);
        transform.updateMatrix();
        mesh.setMatrixAt(placed, transform.matrix);
        color.setHex(i % 2 ? serpentinePalette.red : serpentinePalette.orange);
        if (mesh === leaves) mesh.setColorAt(placed, color);
        if (mesh === trunks) {
          transform.position.y = ground + 5 * size;
          transform.scale.set(size, 1.2 * size, size);
          transform.updateMatrix();
          crowns.setMatrixAt(placed, transform.matrix);
          crowns.setColorAt(placed, color);
        }
        placed++;
        break;
      }
    }
    mesh.count = placed;
  }
  crowns.count = trunks.count;
  scene.add(trunks, crowns, rocks, leaves);
}

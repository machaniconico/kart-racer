import * as THREE from 'three';
import { sampleTrack } from '../../../sim/track';
import type { Track } from '../../../sim/types';
import { widthAt } from '../../../sim/corridor';
import type { SceneryBudget } from '../CourseTheme';
import type { CourseTheme } from '../buildCourse';
import { material, terrainHeight } from '../buildCourse';

export const cavernPalette = {
  rock: 0x101018, sky: 0x05060c, fog: 0x090d18, cyan: 0x49efff, magenta: 0xf15bc8,
} as const;

const atriums = [{ from: 140, to: 330 }, { from: 1020, to: 1230 }];

export const cavern: CourseTheme = {
  colors: {
    sky: cavernPalette.sky, skyTop: 0x020308, skyBottom: 0x101322,
    ground: cavernPalette.rock, road: 0x353b4c, shoulder: 0x53556b,
    deck: 0x262c3e, pillar: 0x333247, line: 0xb4f6ff,
    curb: [cavernPalette.cyan, 0x292636], rail: 0x84a8ba, post: 0x48445e,
    dash: 0xa3cfdf, gate: 0x343047, barrier: 0x595069, motionBarrier: 0x78648b,
    bannerBackground: '#101018', bannerText: '#49efff',
    checker: [0xb4f6ff, 0x101018], signBackground: '#49efff', signText: '#101018',
    surfaces: { ice: 0x92f4ff, boost: cavernPalette.cyan, jump: cavernPalette.magenta },
  },
  fog: { color: cavernPalette.fog, near: 45, far: 200 },
  lighting: {
    hemisphere: { sky: 0xa0c5ed, ground: 0x332139, intensity: 1.7 },
    sun: { color: 0xc4edff, intensity: 1.5, position: [30, 90, 45], offset: [25, 75, 35] },
  },
  signFractions: [0.12, 0.25, 0.4, 0.6, 0.73, 0.84],
  budget: { trees: 112, rocks: 64, flowers: 96 },
  buildProps,
  buildLandmarks(track, scene) {
    // A faceted ceiling follows each chamber. Leave the crossing atrium open
    // so its lower roof cannot cut through the raised bridge.
    const vertices: number[] = [];
    const segments = 384, facets = 8;
    const roofPoint = (d: number, j: number): number[] => {
      const point = sampleTrack(track, d), angle = j / facets * Math.PI;
      const offset = Math.cos(angle) * 38;
      const height = point.y + 9 + Math.sin(angle) * 21;
      return [point.x + point.nx * offset, height, point.z + point.nz * offset];
    };
    for (let i = 0; i < segments; i++) {
      const from = i / segments * track.length, to = (i + 1) / segments * track.length;
      if (atriums.some(atrium => from < atrium.to && to > atrium.from)) continue;
      for (let j = 0; j < facets; j++) {
        const a = roofPoint(from, j), b = roofPoint(to, j);
        const c = roofPoint(to, j + 1), d = roofPoint(from, j + 1);
        vertices.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.computeVertexNormals();
    const stone = material(0x171824);
    stone.side = THREE.DoubleSide;
    const roof = new THREE.Mesh(geometry, stone);
    roof.name = 'cavern:ceiling';
    scene.add(roof);
  },
};

/** Include the whole prop radius, and every branch of the crossing, in clearance. */
function clearsRoads(track: Track, x: number, z: number, radius: number): boolean {
  return track.samples.every((a, i) => {
    const b = track.samples[(i + 1) % track.samples.length]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    const half = Math.max(widthAt(track, a.distance).wallHalfWidth, widthAt(track, b.distance).wallHalfWidth);
    return Math.hypot(x - a.x - t * dx, z - a.z - t * dz) > half + radius + 2;
  });
}

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  let seed = 1305;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const transform = new THREE.Object3D();
  const crystal = (color: number) => new THREE.MeshLambertMaterial({
    color, emissive: color, emissiveIntensity: 0.85, flatShading: true,
  });
  const batches = [
    new THREE.InstancedMesh(new THREE.ConeGeometry(1.1, 6, 5), crystal(cavernPalette.cyan), Math.ceil(budget.trees / 2)),
    new THREE.InstancedMesh(new THREE.ConeGeometry(1, 4.5, 5), crystal(cavernPalette.magenta), Math.floor(budget.trees / 2)),
    new THREE.InstancedMesh(new THREE.ConeGeometry(1.4, 7, 6), material(0x464051), budget.rocks),
    new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1.8, 0), material(0x272633), budget.rocks),
    new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.5, 0), crystal(cavernPalette.cyan), budget.flowers),
  ];
  const names = ['cavern:cyan-crystals', 'cavern:magenta-crystals', 'cavern:stalactites', 'rocks', 'flowers'];
  for (const [batch, mesh] of batches.entries()) {
    mesh.name = names[batch]!;
    mesh.geometry.computeBoundingSphere();
    const count = mesh.count;
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const distance = (i + random()) / count * track.length, point = sampleTrack(track, distance);
      if (batch === 2 && atriums.some(atrium => distance >= atrium.from && distance <= atrium.to)) continue;
      const scale = 0.8 + random() * 0.7;
      const radius = mesh.geometry.boundingSphere!.radius * scale;
      for (let attempt = 0; attempt < 20; attempt++) {
        const offset = (i % 2 ? -1 : 1) * (widthAt(track, distance).wallHalfWidth + 9 + attempt * 5 + random() * 7);
        if (batch === 2 && Math.abs(offset) > 34) break;
        const x = point.x + point.nx * offset, z = point.z + point.nz * offset;
        if (!clearsRoads(track, x, z, radius)) continue;
        const ground = terrainHeight(track, { distance, offset, height: point.y, heading: Math.atan2(point.tx, point.tz) });
        const halfHeight = [3, 2.25, 3.5, 1.4, 0.35][batch]!;
        // Embed each hanging base in the ceiling; its point faces the floor.
        const height = batch === 2
          ? point.y + 9.5 + Math.sqrt(1 - (offset / 38) ** 2) * 21 - halfHeight * scale
          : ground + halfHeight * scale;
        transform.position.set(x, height, z);
        transform.rotation.set(0, random() * Math.PI * 2, batch === 2 ? Math.PI : 0);
        transform.scale.setScalar(scale);
        transform.updateMatrix();
        mesh.setMatrixAt(placed++, transform.matrix);
        break;
      }
    }
    mesh.count = placed;
    scene.add(mesh);
  }
}

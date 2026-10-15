import * as THREE from 'three';
import { widthAt } from '../../../sim/corridor';
import { sampleTrack } from '../../../sim/track';
import type { Track } from '../../../sim/types';
import type { SceneryBudget } from '../CourseTheme';
import { material, terrainHeight } from '../buildCourse';
import type { CourseTheme } from '../buildCourse';

export const lunarPalette = {
  regolith: 0x777780, road: 0x4c4e57, rock: 0x9999a0, crater: 0x22232b,
  sky: 0x000000, habitat: 0xe4e9ef, accent: 0x8fe8ff, earth: 0x287bd6,
} as const;

export const lunar: CourseTheme = {
  colors: {
    sky: lunarPalette.sky, skyTop: lunarPalette.sky, skyBottom: lunarPalette.sky,
    ground: lunarPalette.regolith, road: lunarPalette.road, shoulder: 0xa0a0a8,
    deck: 0xb0bac4, pillar: 0x8b96a2, line: 0xeaf4ff,
    curb: [0xf6d879, 0x4c4e57], rail: 0xb7c3ce, post: 0x66727d,
    dash: 0xdde3eb, gate: 0xabb7c2, bannerBackground: '#182029', bannerText: '#eaf4ff',
    checker: [0xeaf4ff, 0x30333c], signBackground: '#8fe8ff', signText: '#182029',
    surfaces: { ice: 0xcceeff, boost: lunarPalette.accent, jump: 0xf6d879,
      dirt: 0x89878d, pit: lunarPalette.crater },
  },
  fog: { color: lunarPalette.sky, near: 1800, far: 6000 },
  lighting: {
    hemisphere: { sky: 0xddeaff, ground: 0x55515f, intensity: 1.7 },
    sun: { color: 0xffffff, intensity: 2.5, position: [90, 120, -50], offset: [70, 100, -40] },
  },
  signFractions: [0.03, 0.09, 0.17, 0.34, 0.44, 0.60, 0.71, 0.84],
  budget: { trees: 36, rocks: 96, flowers: 48 },
  buildProps,
  buildLandmarks,
};

/** Check full footprints against all road branches, including the lower crossing. */
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
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1), material(lunarPalette.rock), budget.rocks);
  const rims = new THREE.InstancedMesh(new THREE.TorusGeometry(3, 0.65, 4, 12), material(0x92929b), budget.trees);
  const beacons = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.3, 1.8, 6),
    new THREE.MeshLambertMaterial({ color: lunarPalette.habitat, emissive: lunarPalette.accent,
      emissiveIntensity: 0.35 }), budget.flowers);
  rocks.name = 'lunar:rocks'; rims.name = 'lunar:crater-rims'; beacons.name = 'lunar:beacons';
  rocks.castShadow = true;
  const transform = new THREE.Object3D();
  let seed = 1969;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (const mesh of [rocks, rims, beacons]) {
    mesh.geometry.computeBoundingSphere();
    const count = mesh.count;
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const distance = (i + random()) / count * track.length;
      const point = sampleTrack(track, distance), size = 0.8 + random() * 0.9;
      const scale = mesh === rocks ? [2 * size, 0.8 * size, 1.3 * size] : [size, size, size];
      const radius = mesh.geometry.boundingSphere!.radius * Math.max(...scale);
      for (let attempt = 0; attempt < 24; attempt++) {
        const offset = (i % 2 ? -1 : 1) * (widthAt(track, distance).wallHalfWidth + 12 + attempt * 6 + random() * 8);
        const x = point.x + point.nx * offset, z = point.z + point.nz * offset;
        if (!clearsRoads(track, x, z, radius)) continue;
        const ground = terrainHeight(track, { distance, offset, height: point.y, heading: Math.atan2(point.tx, point.tz) });
        const halfHeight = mesh === rocks ? 0.55 : mesh === rims ? 0.15 : 0.9;
        transform.position.set(x, ground + halfHeight * size, z);
        transform.rotation.set(mesh === rims ? -Math.PI / 2 : 0, mesh === rims ? 0 : random() * Math.PI * 2, 0);
        transform.scale.set(scale[0]!, scale[1]!, scale[2]!);
        transform.updateMatrix();
        mesh.setMatrixAt(placed++, transform.matrix);
        break;
      }
    }
    mesh.count = placed;
    scene.add(mesh);
  }
}

function buildLandmarks(track: Track, scene: THREE.Group): void {
  // A camera-following globe stays fixed in the black sky, with no particle stars or external textures.
  const earthGeometry = new THREE.SphereGeometry(42, 32, 20);
  const vertices = earthGeometry.getAttribute('position');
  const colors: number[] = [];
  const color = new THREE.Color();
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i) / 42, y = vertices.getY(i) / 42, z = vertices.getZ(i) / 42;
    const longitude = Math.atan2(z, x), latitude = Math.asin(Math.max(-1, Math.min(1, y)));
    const land = Math.sin(longitude * 3 + latitude * 2) + 0.6 * Math.cos(latitude * 7 - longitude * 2);
    const cloud = Math.sin(longitude * 9 + latitude * 13) * Math.cos(latitude * 11);
    color.setHex(Math.abs(y) > 0.9 || cloud > 0.78 ? 0xeaf5ff : land > 0.8 ? 0x6c9c84 : lunarPalette.earth);
    color.multiplyScalar(0.48 + 0.52 * Math.max(0, (x - z + y) / Math.sqrt(3)));
    colors.push(color.r, color.g, color.b);
  }
  earthGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const earth = new THREE.Mesh(earthGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
  earth.name = 'lunar:earth';
  earth.position.set(170, 70, 350);
  const sky = scene.children.find(object => object instanceof THREE.Mesh && object.material instanceof THREE.ShaderMaterial);
  (sky ?? scene).add(earth);

  for (const deck of track.def.decks ?? []) {
    const centre = (deck.from + deck.to) / 2, point = sampleTrack(track, centre);
    const radius = widthAt(track, centre).wallHalfWidth + 1.8;
    const tube = new THREE.Group();
    tube.name = 'lunar:habitat-tube';
    tube.position.set(point.x, point.y + 0.15, point.z);
    tube.rotation.y = Math.atan2(point.tx, point.tz);
    // The arch's feet sit outside the rails; the lowest roof over the road is above kart headroom.
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, deck.to - deck.from,
      16, 1, true, Math.PI / 2, Math.PI),
    new THREE.MeshLambertMaterial({ color: lunarPalette.accent, transparent: true, opacity: 0.2,
      side: THREE.DoubleSide, depthWrite: false }));
    shell.name = 'lunar:habitat-glass';
    shell.rotation.x = Math.PI / 2;
    tube.add(shell);
    const ribGeometry = new THREE.TorusGeometry(radius, 0.28, 4, 16, Math.PI);
    const ribMaterial = material(lunarPalette.habitat);
    for (let z = -(deck.to - deck.from) / 2; z <= (deck.to - deck.from) / 2; z += 10) {
      const rib = new THREE.Mesh(ribGeometry, ribMaterial);
      rib.name = 'lunar:habitat-rib';
      rib.position.z = z;
      tube.add(rib);
    }
    scene.add(tube);
  }
}

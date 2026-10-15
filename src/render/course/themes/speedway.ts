import * as THREE from 'three';
import { widthAt } from '../../../sim/corridor';
import { sampleTrack } from '../../../sim/track';
import type { Track } from '../../../sim/types';
import type { SceneryBudget } from '../CourseTheme';
import { material, type CourseTheme } from '../buildCourse';

export const speedwayPalette = {
  asphalt: 0x48494d, red: 0xd83b36, white: 0xf4f0e8,
  sky: 0xb57477, sunset: 0xf1b087, steel: 0x767b85, lamp: 0xfff0bd,
} as const;

export const speedway: CourseTheme = {
  colors: {
    sky: speedwayPalette.sky, skyTop: 0x4b435f, skyBottom: speedwayPalette.sunset,
    ground: 0x526151, road: speedwayPalette.asphalt, shoulder: 0x68696b,
    deck: 0x555960, pillar: speedwayPalette.steel, line: speedwayPalette.white,
    curb: [speedwayPalette.red, speedwayPalette.white], rail: 0xb9bec5, post: 0x535963,
    dash: speedwayPalette.white, gate: speedwayPalette.red,
    bannerBackground: '#35363c', bannerText: '#fff0bd',
    checker: [speedwayPalette.white, 0x292a30], signBackground: '#d83b36', signText: '#fff4e8',
    surfaces: { ice: 0xbdefff, boost: 0xffce55, jump: 0xffce55, dirt: 0x7d7668, pit: 0x292a30 },
    barrier: 0xb5b7bc, motionBarrier: speedwayPalette.red,
  },
  fog: { color: speedwayPalette.sky, near: 240, far: 950 },
  lighting: {
    hemisphere: { sky: 0xffd5ba, ground: 0x586354, intensity: 1.8 },
    sun: { color: 0xffba83, intensity: 2.1, position: [-100, 55, 80], offset: [-85, 45, 65] },
  },
  signFractions: [0.25, 0.29, 0.74, 0.79],
  // Reuse the shared scenery budget slots for towers, grandstands and roof panels.
  budget: { trees: 24, rocks: 64, flowers: 16 },
  buildProps,
  buildLandmarks() {},
};

/** Reserve the whole prop, including its roof, against every part of the oval. */
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
  const mast = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.3, 0.65, 18, 6),
    material(speedwayPalette.steel), budget.trees);
  const lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(9, 2, 1.2),
    new THREE.MeshLambertMaterial({ color: speedwayPalette.lamp, emissive: speedwayPalette.lamp,
      emissiveIntensity: 1.3, flatShading: true }), budget.trees);
  const stands = new THREE.InstancedMesh(new THREE.BoxGeometry(5, 2, 50), material(0xffffff), budget.rocks);
  const roofs = new THREE.InstancedMesh(new THREE.BoxGeometry(28, 0.8, 52),
    material(0xc0c2c8), budget.flowers);
  const supports = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 12, 0.5),
    material(speedwayPalette.steel), budget.flowers * 2);
  mast.name = 'speedway:light-towers'; lamps.name = 'speedway:floodlights';
  stands.name = 'speedway:grandstands'; roofs.name = 'speedway:canopies';
  supports.name = 'speedway:canopy-supports';
  mast.castShadow = true; stands.castShadow = true; roofs.castShadow = true;
  stands.receiveShadow = true;
  const transform = new THREE.Object3D();
  const color = new THREE.Color();
  for (const mesh of [mast, lamps, stands, roofs, supports]) mesh.geometry.computeBoundingSphere();
  const place = (mesh: THREE.InstancedMesh, index: number, distance: number, offset: number, height: number, along = 0) => {
    const point = sampleTrack(track, distance);
    const x = point.x + point.nx * offset + point.tx * along;
    const z = point.z + point.nz * offset + point.tz * along;
    if (!clearsRoad(track, x, z, mesh.geometry.boundingSphere!.radius)) return false;
    // Outside the terrain ribbon, the stadium concourse is at y = -1.35.
    transform.position.set(x, height - 1.35, z);
    transform.rotation.set(0, Math.atan2(point.tx, point.tz), 0);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
    return true;
  };
  let lights = 0;
  for (let i = 0; i < budget.trees; i++) {
    const distance = (i + 0.5) / budget.trees * track.length;
    if (!place(mast, lights, distance, 40, 9)) continue;
    place(lamps, lights, distance, 40, 18);
    lights++;
  }
  mast.count = lights; lamps.count = lights;
  let seats = 0, covers = 0, pillars = 0;
  for (let i = 0; i < budget.flowers; i++) {
    const distance = (i + 0.5) / budget.flowers * track.length;
    for (let row = 0; row < 4 && seats < budget.rocks; row++) {
      if (!place(stands, seats, distance, 53 + row * 6, 1 + row * 2)) continue;
      stands.setColorAt(seats++, color.setHex(row % 2 ? speedwayPalette.white : speedwayPalette.red));
    }
    if (place(roofs, covers, distance, 62, 12)) {
      covers++;
      for (const delta of [-23, 23]) {
        if (place(supports, pillars, distance, 73, 6, delta)) pillars++;
      }
    }
  }
  stands.count = seats; roofs.count = covers; supports.count = pillars;
  scene.add(mast, lamps, stands, roofs, supports);
}

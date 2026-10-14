import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { projectToTrack, sampleTrack } from '../../../sim';
import type { Track } from '../../../sim';
import { SKYLINE_TUBE } from '../../../sim/tracks/skyline';
import type { CourseTheme } from '../buildCourse';
import { material } from '../buildCourse';

export const skylinePalette = {
  sky: 0xdbe7ff, deck: 0x8d9bb5, glass: 0x62c6ff, fog: 0xc7d6f0, accent: 0xff4fa3,
} as const;

export const skyline: CourseTheme = {
  colors: {
    sky: skylinePalette.sky, skyTop: 0x72b5ed, skyBottom: 0xf0f6ff,
    ground: skylinePalette.fog, road: 0x53667d, deck: skylinePalette.deck,
    shoulder: 0xb6c8db, line: 0xf6fbff, curb: [0xffffff, skylinePalette.accent],
    rail: skylinePalette.glass, post: 0x687e99, dash: 0xb6cee3,
    gate: 0x526781, bannerBackground: '#384f6b', bannerText: '#ffffff',
    checker: [0xffffff, 0x31445b], signBackground: '#ffffff', signText: '#324c70',
    surfaces: { ice: 0xbdefff, boost: skylinePalette.glass, jump: 0xffd774,
      pit: skylinePalette.fog, spin: skylinePalette.accent },
    barrier: 0x849eb7, motionBarrier: skylinePalette.glass, motionSpin: skylinePalette.accent,
  },
  fog: { color: skylinePalette.fog, near: 300, far: 1000 },
  lighting: {
    hemisphere: { sky: 0xf1f8ff, ground: 0x8daacb, intensity: 2.1 },
    sun: { color: 0xfff7e7, intensity: 2.3, position: [70, 100, 40], offset: [55, 85, 35] },
  },
  // Advance signs for the chicane, first gap, hairpin, island, second gap and wind gate.
  signFractions: [0.065, 0.15, 0.20, 0.44, 0.62, 0.79],
  budget: { trees: 64, rocks: 48, flowers: 72 },
  buildProps,
  buildLandmarks,
};

function buildProps(track: Track, scene: THREE.Group, budget: CourseTheme['budget']): void {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const towers = new THREE.InstancedMesh(geometry, material(0xb7cce2), budget.trees);
  const antennae = new THREE.InstancedMesh(geometry, material(skylinePalette.accent), budget.trees);
  const platforms = new THREE.InstancedMesh(geometry, material(skylinePalette.deck), budget.rocks);
  const units = new THREE.InstancedMesh(geometry, material(0xe5f2ff), budget.rocks);
  const clouds = new THREE.InstancedMesh(geometry, material(0xf4f8ff), budget.flowers);
  const transform = new THREE.Object3D();
  const widest = Math.max(track.def.wallHalfWidth, ...(track.def.widthKeys ?? []).map(key => key.wallHalfWidth));
  // Height-free projection keeps the complete prop footprint clear of both crossing levels.
  const locations: { x: number; z: number; y: number }[] = [];
  for (let i = 0; i < 256; i++) {
    const point = sampleTrack(track, i / 256 * track.length);
    const offset = (widest + 35 + i % 5 * 9) * (i % 2 ? -1 : 1);
    const x = point.x + point.nx * offset, z = point.z + point.nz * offset;
    if (Math.abs(projectToTrack(track, x, z).offset) <= widest + 18) continue;
    locations.push({ x, z, y: point.y });
  }
  const set = (mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number,
    width: number, height: number, depth: number): void => {
    transform.position.set(x, y, z);
    transform.scale.set(width, height, depth);
    transform.updateMatrix();
    mesh.setMatrixAt(i, transform.matrix);
  };
  for (let i = 0; i < towers.count; i++) {
    const p = locations[Math.floor(i * locations.length / towers.count)]!;
    const height = 28 + i % 7 * 6;
    set(towers, i, p.x, p.y - 18 + height / 2, p.z, 7 + i % 3 * 2, height, 9);
    set(antennae, i, p.x, p.y - 18 + height + 4, p.z, 0.45, 8, 0.45);
  }
  for (let i = 0; i < platforms.count; i++) {
    const p = locations[Math.floor((i + 0.5) * locations.length / platforms.count)]!;
    set(platforms, i, p.x, p.y - 8, p.z, 20, 1.2, 16);
    set(units, i, p.x + 4, p.y - 5.5, p.z, 4, 3.8, 4);
  }
  for (let i = 0; i < clouds.count; i++) {
    const p = locations[Math.floor(i * locations.length / clouds.count)]!;
    set(clouds, i, p.x, -24 - i % 5 * 5, p.z, 35 + i % 4 * 7, 1.5, 22 + i % 3 * 6);
  }
  towers.name = 'trunks';
  antennae.name = 'skyline:antennae';
  platforms.name = 'rocks';
  units.name = 'skyline:air-conditioning';
  clouds.name = 'flowers';
  scene.add(towers, antennae, platforms, units, clouds);
}

function buildLandmarks(track: Track, scene: THREE.Group): void {
  // The shared renderer builds terrain before invoking the theme. Remove its
  // owned ground and pit-floor meshes so these suspended roads overlook open air.
  for (const child of [...scene.children]) {
    if (!(child instanceof THREE.Mesh)) continue;
    const groundPlane = child.geometry instanceof THREE.PlaneGeometry
      && child.geometry.parameters.width === 1800 && child.geometry.parameters.height === 1800;
    if (!groundPlane && !['ground:-1', 'ground:1', 'surface:pit'].includes(child.name)) continue;
    child.removeFromParent();
    child.geometry.dispose();
    for (const mat of Array.isArray(child.material) ? child.material : [child.material]) mat.dispose();
  }
  // Edge paint must stop before a missing platform. Remove the complete
  // touching triangle, including triangles straddling either lip of the gap.
  for (const side of [-1, 1]) {
    const line = scene.getObjectByName(`line:${side}`) as THREE.Mesh | undefined;
    if (!line) continue;
    const positions = line.geometry.getAttribute('position');
    const index = line.geometry.getIndex()!;
    const kept: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const vertices = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      const distances = vertices.map(v => projectToTrack(track,
        positions.getX(v), positions.getZ(v), undefined, positions.getY(v)).distance);
      const touchesPit = track.def.surfaces.some(zone => zone.kind === 'pit'
        && (side > 0 ? zone.offsetMax! >= track.def.roadHalfWidth : zone.offsetMin! <= -track.def.roadHalfWidth)
        && Math.min(...distances) <= zone.to && Math.max(...distances) >= zone.from
        && Math.max(...distances) - Math.min(...distances) < track.length / 2);
      if (!touchesPit) kept.push(...vertices);
    }
    line.geometry.setIndex(kept);
  }
  // Sparse open hoops form an air-current tube; daylight and the next platform
  // remain visible through it. The first hoop coincides with the boost entrance.
  const parts: THREE.BufferGeometry[] = [];
  const transform = new THREE.Object3D();
  for (let i = 0; i < 7; i++) {
    const p = sampleTrack(track, SKYLINE_TUBE.from + i / 6 * (SKYLINE_TUBE.to - SKYLINE_TUBE.from));
    transform.position.set(p.x, p.y + 2, p.z);
    transform.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(p.tx, 0, p.tz));
    transform.updateMatrix();
    parts.push(new THREE.TorusGeometry(track.def.wallHalfWidth + 1, 0.22, 4, 24).applyMatrix4(transform.matrix));
  }
  const tube = new THREE.Mesh(mergeGeometries(parts)!, material(skylinePalette.glass));
  parts.forEach(part => part.dispose());
  tube.name = 'skyline:boost-tube';
  scene.add(tube);
}

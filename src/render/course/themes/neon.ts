import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { projectToTrack, sampleTrack } from '../../../sim';
import type { Track } from '../../../sim';
import { NEON_TUNNEL } from '../../../sim/tracks/neon';
import type { CourseTheme } from '../buildCourse';
import { material } from '../buildCourse';

const cyan = 0x56efff;
const pink = 0xff58b9;

export const neon: CourseTheme = {
  colors: {
    sky: 0x090d20, skyTop: 0x040717, skyBottom: 0x392b50,
    ground: 0x111724, road: 0x303b50, shoulder: 0x192337, line: 0xb8e9f2,
    curb: [cyan, pink], rail: 0x4096aa, post: 0x253d59, dash: 0x89a6bc,
    gate: 0x18283d, bannerBackground: '#142035', bannerText: '#56efff',
    checker: [0xd6fcff, 0x132333], signBackground: '#172337', signText: '#ff78c8',
    surfaces: { ice: 0x9deaff, boost: cyan, jump: 0xffc76b, dirt: 0x80543d, pit: 0x302724, spin: 0xb77ee0 },
    barrier: 0x725dc2,
    motionBarrier: pink, motionSpin: cyan,
  },
  fog: { color: 0x27243e, near: 160, far: 450 },
  lighting: {
    hemisphere: { sky: 0x98b9ff, ground: 0x433256, intensity: 1.45 },
    sun: { color: 0xc3d7ff, intensity: 0.85, position: [70, 100, 40], offset: [55, 85, 35] },
  },
  // Advance notices for the rooftop hairpin, narrow street, island and chicane.
  signFractions: [0.19, 0.46, 0.59, 0.72],
  budget: { trees: 0, rocks: 0, flowers: 0 },
  buildProps,
  buildLandmarks,
};

function buildProps(track: Track, scene: THREE.Group): void {
  const candidates: { x: number; z: number; width: number; depth: number; height: number }[] = [];
  const xs = track.samples.map(point => point.x);
  const zs = track.samples.map(point => point.z);
  const minX = Math.min(...xs) - 50, maxX = Math.max(...xs) + 50;
  const minZ = Math.min(...zs) - 50, maxZ = Math.max(...zs) + 50;
  // Use the widest island lane for clearance, and project without a height hint
  // so buildings stay outside both branches of the overpass.
  const wallHalfWidth = Math.max(track.def.wallHalfWidth,
    ...(track.def.widthKeys ?? []).map(key => key.wallHalfWidth));
  for (let row = 0; row < 12; row++) {
    for (let column = 0; column < 12; column++) {
      const x = minX + column / 11 * (maxX - minX);
      const z = minZ + row / 11 * (maxZ - minZ);
      const width = 16 + (row * 7 + column * 3) % 9;
      const depth = 16 + (row * 3 + column * 7) % 9;
      const clearance = wallHalfWidth + Math.hypot(width, depth) / 2 + 5;
      if (Math.abs(projectToTrack(track, x, z).offset) < clearance) continue;
      candidates.push({ x, z, width, depth, height: 20 + (row * 17 + column * 11) % 49 });
    }
  }
  // 60 buildings × (body + 32 windows + 2 signs) × 12 = 25,200 triangles.
  // Distribute this fixed scenery allowance over the whole expanded city.
  const count = Math.min(60, candidates.length);
  const blocks = Array.from({ length: count }, (_, i) => candidates[Math.floor(i * candidates.length / count)]!);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const buildings = new THREE.InstancedMesh(geometry, material(0xffffff), blocks.length);
  const glow = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const windows = new THREE.InstancedMesh(geometry, glow, blocks.length * 4 * 8);
  const signs = new THREE.InstancedMesh(geometry, glow, blocks.length * 2);
  const transform = new THREE.Object3D();
  let windowIndex = 0;
  for (const [index, block] of blocks.entries()) {
    const { x, z, width, depth, height } = block;
    transform.position.set(x, height / 2 - 1.35, z);
    transform.scale.set(width, height, depth);
    transform.rotation.set(0, 0, 0);
    transform.updateMatrix();
    buildings.setMatrixAt(index, transform.matrix);
    buildings.setColorAt(index, new THREE.Color(index % 2 ? 0x25344e : 0x34314c));
    const color = new THREE.Color(index % 3 ? cyan : pink);
    for (let face = 0; face < 4; face++) {
      const angle = face * Math.PI / 2;
      for (let floor = 0; floor < 8; floor++) {
        transform.position.set(x + Math.sin(angle) * (width / 2 + 0.06),
          3 + floor * (height - 7) / 8, z + Math.cos(angle) * (depth / 2 + 0.06));
        transform.rotation.set(0, angle, 0);
        transform.scale.set((face % 2 ? depth : width) * (floor % 3 ? 0.7 : 0.4), 0.4, 0.12);
        transform.updateMatrix();
        windows.setMatrixAt(windowIndex, transform.matrix);
        windows.setColorAt(windowIndex++, color.clone().multiplyScalar(0.55));
      }
    }
    // Oversized luminous panels and rooftop strips read as signs at race speed.
    transform.rotation.set(0, 0, 0);
    transform.position.set(x, height * 0.65, z + depth / 2 + 0.18);
    transform.scale.set(width * 0.48, 3.2, 0.3);
    transform.updateMatrix();
    signs.setMatrixAt(index * 2, transform.matrix);
    signs.setColorAt(index * 2, color);
    transform.position.set(x, height - 1.2, z);
    transform.scale.set(width + 0.3, 0.25, depth + 0.3);
    transform.updateMatrix();
    signs.setMatrixAt(index * 2 + 1, transform.matrix);
    signs.setColorAt(index * 2 + 1, color);
  }
  buildings.name = 'neon:buildings';
  windows.name = 'neon:windows';
  signs.name = 'neon:signs';
  // Scenery does not cast shadows: the karts retain their existing shadow pass.
  scene.add(buildings, windows, signs);
}

function buildLandmarks(track: Track, scene: THREE.Group): void {
  const entrance = sampleTrack(track, NEON_TUNNEL.from);
  const exit = sampleTrack(track, NEON_TUNNEL.to);
  const direction = new THREE.Vector3(exit.x - entrance.x, 0, exit.z - entrance.z).normalize();
  const length = NEON_TUNNEL.to - NEON_TUNNEL.from;
  const radius = track.def.wallHalfWidth + 1.3;
  // The Y-to-X rotation puts the upper arch at pi..2pi. Cull its exterior
  // so a chase camera outside the shell can still see the kart and road.
  const tunnel = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 32, 1, true, Math.PI, Math.PI),
    new THREE.MeshLambertMaterial({ color: 0x24314c, emissive: 0x10172c, side: THREE.BackSide }));
  tunnel.position.set((entrance.x + exit.x) / 2, entrance.y, (entrance.z + exit.z) / 2);
  tunnel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  tunnel.name = 'neon:tunnel';
  // These lights belong to the tunnel below the deck. Batch them as static
  // geometry so the generic scenery-instance clearance pass preserves them.
  const parts: THREE.BufferGeometry[] = [];
  const addLight = (geometry: THREE.BufferGeometry, color: number): void => {
    const rgb = new THREE.Color(color);
    const colors = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) rgb.toArray(colors, i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(geometry);
  };
  const transform = new THREE.Object3D();
  transform.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
  for (let i = 0; i < 9; i++) {
    const point = sampleTrack(track, NEON_TUNNEL.from + i / 8 * length);
    transform.position.set(point.x, point.y, point.z);
    transform.updateMatrix();
    addLight(new THREE.TorusGeometry(radius - 0.08, 0.12, 5, 32).applyMatrix4(transform.matrix), i % 2 ? pink : cyan);
  }
  for (let i = 0; i < 2; i++) {
    const offset = (i * 2 - 1) * (track.def.wallHalfWidth - 0.35);
    transform.position.set(tunnel.position.x + entrance.nx * offset, entrance.y + 1.2,
      tunnel.position.z + entrance.nz * offset);
    transform.rotation.set(0, Math.atan2(entrance.tx, entrance.tz), 0);
    transform.updateMatrix();
    addLight(new THREE.BoxGeometry(0.16, 0.16, length).applyMatrix4(transform.matrix), cyan);
  }
  const lights = new THREE.Mesh(mergeGeometries(parts)!,
    new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  parts.forEach(part => part.dispose());
  lights.name = 'neon:tunnel-lights';
  scene.add(tunnel, lights);
}

import * as THREE from 'three';
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
  },
  fog: { color: 0x27243e, near: 160, far: 450 },
  lighting: {
    hemisphere: { sky: 0x98b9ff, ground: 0x433256, intensity: 1.45 },
    sun: { color: 0xc3d7ff, intensity: 0.85, position: [70, 100, 40], offset: [55, 85, 35] },
  },
  signFractions: [0.19, 0.44, 0.69, 0.94],
  budget: { trees: 0, rocks: 0, flowers: 0 },
  buildProps,
  buildLandmarks,
};

function buildProps(track: Track, scene: THREE.Group): void {
  const blocks: { x: number; z: number; width: number; depth: number; height: number }[] = [];
  // A fixed city grid leaves the entire drivable corridor clear, including bends.
  for (let row = 0; row < 10; row++) {
    for (let column = 0; column < 10; column++) {
      const x = (column - 4.5) * 38;
      const z = (row - 4.5) * 38;
      const width = 16 + (row * 7 + column * 3) % 9;
      const depth = 16 + (row * 3 + column * 7) % 9;
      const clearance = track.def.wallHalfWidth + Math.hypot(width, depth) / 2 + 5;
      if (Math.abs(projectToTrack(track, x, z).offset) < clearance) continue;
      blocks.push({ x, z, width, depth, height: 20 + (row * 17 + column * 11) % 49 });
    }
  }
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
  const glow = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const ribs = new THREE.InstancedMesh(new THREE.TorusGeometry(radius - 0.08, 0.12, 5, 32), glow, 9);
  const transform = new THREE.Object3D();
  transform.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
  for (let i = 0; i < ribs.count; i++) {
    const point = sampleTrack(track, NEON_TUNNEL.from + i / (ribs.count - 1) * length);
    transform.position.set(point.x, point.y, point.z);
    transform.updateMatrix();
    ribs.setMatrixAt(i, transform.matrix);
    ribs.setColorAt(i, new THREE.Color(i % 2 ? pink : cyan));
  }
  ribs.name = 'neon:tunnel-ribs';
  const guides = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.16, length), glow, 2);
  for (let i = 0; i < guides.count; i++) {
    const offset = (i * 2 - 1) * (track.def.wallHalfWidth - 0.35);
    transform.position.set(tunnel.position.x + entrance.nx * offset, entrance.y + 1.2,
      tunnel.position.z + entrance.nz * offset);
    transform.rotation.set(0, Math.atan2(entrance.tx, entrance.tz), 0);
    transform.updateMatrix();
    guides.setMatrixAt(i, transform.matrix);
    guides.setColorAt(i, new THREE.Color(cyan));
  }
  guides.name = 'neon:tunnel-guides';
  scene.add(tunnel, ribs, guides);
}

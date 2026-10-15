import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sampleTrack } from '../../../sim/track';
import type { Track } from '../../../sim/types';
import { widthAt } from '../../../sim/corridor';
import type { SceneryBudget } from '../CourseTheme';
import { material, terrainHeight, type CourseTheme } from '../buildCourse';

export const bayouPalette = {
  teal: 0x103d40, water: 0x164b57, violet: 0xb281ff, wood: 0x80634f,
  mud: 0x554b43, sky: 0x101c32, fog: 0x193b48,
} as const;

export const bayou: CourseTheme = {
  colors: {
    sky: bayouPalette.sky, skyTop: 0x090f24, skyBottom: 0x345363,
    ground: bayouPalette.teal, road: 0x61716b, shoulder: 0x354d49,
    deck: bayouPalette.wood, pillar: 0x514735, line: 0xc0dfd3,
    curb: [bayouPalette.violet, 0x294a50], rail: 0x8da99a, post: 0x564c42,
    dash: 0x9db8ad, gate: 0x455d59, barrier: bayouPalette.wood, motionBarrier: bayouPalette.wood,
    bannerBackground: '#193b48', bannerText: '#e4d2ff',
    checker: [0xe4d2ff, 0x23383d], signBackground: '#b281ff', signText: '#182c35',
    surfaces: { ice: 0x86c7d1, boost: 0xb281ff, jump: 0xc6a3ff, dirt: bayouPalette.mud, pit: bayouPalette.water },
  },
  fog: { color: bayouPalette.fog, near: 75, far: 280 },
  lighting: {
    hemisphere: { sky: 0xb5c9ed, ground: 0x30524e, intensity: 1.8 },
    sun: { color: 0xc4d4ff, intensity: 1.55, position: [-80, 110, 45], offset: [-60, 85, 35] },
  },
  signFractions: [0.07, 0.25, 0.38, 0.55, 0.72, 0.88],
  budget: { trees: 100, rocks: 48, flowers: 160 },
  buildProps,
  buildLandmarks(track, scene) {
    const water = scene.getObjectByName('surface:pit') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    water.material.emissive.setHex(bayouPalette.water);
    water.material.emissiveIntensity = 0.45;

    // Crosswise timber under the road keeps the bridge top smooth for the karts.
    const timber = new THREE.CylinderGeometry(0.3, 0.3, 2 * track.def.wallHalfWidth + 0.8, 8);
    timber.rotateZ(Math.PI / 2);
    const timbers: THREE.BufferGeometry[] = [];
    for (const deck of track.def.decks ?? []) for (let d = deck.from + 1; d < deck.to; d += 2) {
      const p = sampleTrack(track, d);
      timbers.push(timber.clone().rotateY(Math.atan2(p.tx, p.tz)).translate(p.x, p.y - 0.65, p.z));
    }
    const bridge = new THREE.Mesh(mergeGeometries(timbers), material(bayouPalette.wood));
    bridge.name = 'bayou:bridge-logs';
    scene.add(bridge);
    timber.dispose();
    timbers.forEach(geometry => geometry.dispose());

    // Motion is built after landmarks. Restyle its owned meshes once they are
    // attached; the existing updater still owns every position and sweep phase.
    const onMotion = (event: THREE.Object3DEventMap['childadded']) => {
      if (event.child.name !== 'motion') return;
      scene.removeEventListener('childadded', onMotion);
      let remaining = track.def.barriers!.length;
      const onLog = (added: THREE.Object3DEventMap['childadded']) => {
        const mesh = added.child;
        if (!(mesh instanceof THREE.Mesh) || !mesh.name.startsWith('motion:barrier:')) return;
        const barrier = track.def.barriers![Number(mesh.name.split(':').at(-1))]!;
        const span = barrier.to - barrier.from;
        const geometry = new THREE.CylinderGeometry(1, 1, span, 8, 4);
        geometry.rotateX(Math.PI / 2);
        const vertices = geometry.getAttribute('position');
        for (let i = 0; i < vertices.count; i++) {
          const along = vertices.getZ(i) + span / 2;
          const taper = Math.max(0, Math.min(1, along / barrier.taper!, (span - along) / barrier.taper!));
          vertices.setXYZ(i, vertices.getX(i) * taper, vertices.getY(i) * 0.6 * taper, vertices.getZ(i));
        }
        geometry.computeVertexNormals();
        mesh.geometry.dispose();
        mesh.geometry = geometry;
        mesh.material.emissiveIntensity = 0.15;
        if (--remaining === 0) event.child.removeEventListener('childadded', onLog);
      };
      event.child.addEventListener('childadded', onLog);
    };
    scene.addEventListener('childadded', onMotion);
  },
};

/** Keep full scenery bounds outside both branches, including the lower crossing. */
function clearsRoads(track: Track, x: number, z: number, radius: number): boolean {
  return track.samples.every((a, i) => {
    const b = track.samples[(i + 1) % track.samples.length]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    const wall = Math.max(widthAt(track, a.distance).wallHalfWidth, widthAt(track, b.distance).wallHalfWidth);
    return Math.hypot(x - a.x - t * dx, z - a.z - t * dz) > wall + radius + 1;
  });
}

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  let seed = 1204;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const glow = new THREE.MeshLambertMaterial({ color: bayouPalette.violet,
    emissive: bayouPalette.violet, emissiveIntensity: 1.25, flatShading: true });
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.4, 1, 6, 6), material(0x4c5550), budget.trees);
  const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(3.2, 5, 7), material(0x24625a), budget.trees);
  const knees = new THREE.InstancedMesh(new THREE.ConeGeometry(0.85, 2, 5), material(0x58614f), budget.rocks);
  const reeds = new THREE.InstancedMesh(new THREE.ConeGeometry(0.35, 2.8, 4), material(0x579380), budget.flowers);
  const fungi = new THREE.InstancedMesh(new THREE.SphereGeometry(0.65, 6, 3), glow, budget.flowers);
  trunks.name = 'trunks'; crowns.name = 'bayou:cypress-crowns'; knees.name = 'rocks';
  reeds.name = 'bayou:reeds'; fungi.name = 'flowers';
  trunks.castShadow = true; crowns.castShadow = true;
  const transform = new THREE.Object3D();
  for (const mesh of [trunks, knees, reeds, fungi]) {
    const count = mesh.count;
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const d = (i + random()) / count * track.length, p = sampleTrack(track, d);
      const scale = 0.8 + random() * 0.5;
      const radius = (mesh === trunks ? 4.5 : mesh === reeds ? 1.5 : 1.4) * scale;
      for (let attempt = 0; attempt < 20; attempt++) {
        const offset = (i % 2 ? -1 : 1) * (widthAt(track, d).wallHalfWidth + 10 + attempt * 6 + random() * 9);
        const x = p.x + p.nx * offset, z = p.z + p.nz * offset;
        if (!clearsRoads(track, x, z, radius)) continue;
        const ground = terrainHeight(track, { distance: d, offset, height: p.y, heading: Math.atan2(p.tx, p.tz) });
        const lift = mesh === trunks ? 3 : mesh === knees ? 1 : mesh === reeds ? 1.4 : 0.3;
        transform.position.set(x, ground + lift * scale, z);
        transform.rotation.set(0, random() * Math.PI * 2, 0);
        transform.scale.set(scale, mesh === fungi ? scale * 0.45 : scale, scale);
        transform.updateMatrix();
        mesh.setMatrixAt(placed, transform.matrix);
        if (mesh === trunks) {
          transform.position.y = ground + 7 * scale;
          transform.updateMatrix();
          crowns.setMatrixAt(placed, transform.matrix);
        }
        placed++;
        break;
      }
    }
    mesh.count = placed;
  }
  crowns.count = trunks.count;
  scene.add(trunks, crowns, knees, reeds, fungi);
}

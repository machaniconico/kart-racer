import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { projectToTrack, sampleTrack } from '../../../sim';
import type { Track } from '../../../sim';
import { widthAt } from '../../../sim/corridor';
import { FOREST_LENGTH } from '../../../sim/tracks/forest';
import type { SceneryBudget } from '../CourseTheme';
import type { CourseTheme } from '../buildCourse';
import { material, terrainHeight } from '../buildCourse';

export const forestPalette = {
  canopy: 0x1e4a2a, moss: 0x5c8a3a, trunk: 0x4a3426, fog: 0x3b5a3f, accent: 0xe0583f,
} as const;

export const forest: CourseTheme = {
  colors: {
    sky: 0x87a78b, skyTop: 0x526f59, skyBottom: 0xb2c7a3,
    ground: forestPalette.moss, road: 0x536451, shoulder: 0x688449, line: 0xf2ecc4,
    curb: [forestPalette.accent, 0xeee5b8], rail: 0xb2bb85, post: forestPalette.trunk,
    deck: 0x72513a, pillar: forestPalette.trunk, dash: 0xc1c69c,
    gate: 0xeee5b8, bannerBackground: '#243c2b', bannerText: '#fff4ca',
    checker: [0xfff4ca, 0x243c2b], signBackground: '#fff4ca', signText: '#243c2b',
    surfaces: { dirt: 0x795535, jump: forestPalette.accent, ice: 0xbdefff, boost: 0x64e3a8 },
  },
  fog: { color: forestPalette.fog, near: 120, far: 320 },
  lighting: {
    hemisphere: { sky: 0xd7ebce, ground: 0x415736, intensity: 1.9 },
    sun: { color: 0xffedbb, intensity: 1.6, position: [70, 100, 40], offset: [55, 85, 35] },
  },
  // Notices precede the two narrows, two hairpins and both S sections by 20–80 m.
  signFractions: [80, 410, 840, 1280, 1570, 1870].map(distance => distance / FOREST_LENGTH),
  budget: { trees: 240, rocks: 72, flowers: 192 },
  buildProps,
  buildLandmarks,
};

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  let seed = 3167;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const transform = new THREE.Object3D();
  const widest = Math.max(track.def.wallHalfWidth, ...(track.def.widthKeys ?? []).map(key => key.wallHalfWidth));
  // Reserve the full footprint against every branch, including the lower crossing.
  const position = (radius: number): THREE.Vector3 | undefined => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const p = sampleTrack(track, random() * track.length);
      const offset = (widest + radius + 2 + random() * 48) * (random() < 0.5 ? -1 : 1);
      const x = p.x + p.nx * offset, z = p.z + p.nz * offset;
      const projection = projectToTrack(track, x, z);
      if (Math.abs(projection.offset) < widest + radius + 2) continue;
      return new THREE.Vector3(x, terrainHeight(track, projection), z);
    }
    return undefined;
  };
  const batch = (name: string, geometry: THREE.BufferGeometry, color: number, count: number) => {
    const mesh = new THREE.InstancedMesh(geometry, material(color), count);
    mesh.name = `forest:${name}`;
    scene.add(mesh);
    return mesh;
  };
  // Forked trunks and broad rounded crowns replace MEADOW's conifers.
  const parts = [new THREE.CylinderGeometry(0.35, 0.65, 7, 7).translate(0, 3.5, 0)];
  for (const side of [-1, 1]) {
    parts.push(new THREE.CylinderGeometry(0.15, 0.3, 3.6, 5)
      .rotateZ(side * 0.6).translate(side * -0.9, 6.3, 0));
  }
  const trunkGeometry = mergeGeometries(parts)!;
  parts.forEach(part => part.dispose());
  const trunks = batch('trunks', trunkGeometry, forestPalette.trunk, budget.trees);
  const crowns = batch('crowns', new THREE.IcosahedronGeometry(3.4, 1), forestPalette.canopy, budget.trees);
  let trees = 0;
  for (let i = 0; i < budget.trees; i++) {
    const scale = 0.85 + random() * 0.55;
    const p = position(3.4 * Math.hypot(1.4, 1.15) * scale);
    if (!p) continue;
    transform.position.copy(p);
    transform.rotation.set(0, random() * Math.PI * 2, 0);
    transform.scale.setScalar(scale);
    transform.updateMatrix();
    trunks.setMatrixAt(trees, transform.matrix);
    transform.position.y += 8 * scale;
    transform.scale.set(scale * 1.4, scale * 0.9, scale * 1.15);
    transform.updateMatrix();
    crowns.setMatrixAt(trees, transform.matrix);
    crowns.setColorAt(trees++, new THREE.Color().setHSL(0.28 + random() * 0.08, 0.38, 0.22 + random() * 0.12));
  }
  trunks.count = crowns.count = trees;

  const rocks = batch('moss-rocks', new THREE.DodecahedronGeometry(1, 0), forestPalette.moss, Math.ceil(budget.rocks / 2));
  const stumps = batch('stumps', new THREE.CylinderGeometry(0.8, 1, 1.1, 9), 0x735238, Math.floor(budget.rocks / 2));
  for (const mesh of [rocks, stumps]) {
    let kept = 0;
    for (let i = 0; i < mesh.count; i++) {
      const scale = 0.8 + random() * 0.8;
      const p = position(scale * 1.4);
      if (!p) continue;
      transform.position.copy(p).add(new THREE.Vector3(0, scale * 0.4, 0));
      transform.rotation.set(0, random() * Math.PI * 2, 0);
      transform.scale.set(scale * 1.3, scale * 0.8, scale);
      transform.updateMatrix();
      mesh.setMatrixAt(kept++, transform.matrix);
    }
    mesh.count = kept;
  }

  const mushroomCount = Math.ceil(budget.flowers / 2);
  const stems = batch('mushroom-stems', new THREE.CylinderGeometry(0.09, 0.14, 0.5, 5), 0xf1e8cb, mushroomCount);
  const caps = batch('mushrooms', new THREE.SphereGeometry(0.45, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2), forestPalette.accent, mushroomCount);
  // Six pairs of pointed leaflets make each low-poly fern readable from the chase camera.
  const leaves: number[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3;
    const x = Math.cos(angle), z = Math.sin(angle);
    leaves.push(0, 0, 0, x * 0.55 - z * 0.18, 0.38, z * 0.55 + x * 0.18, x, 0.2, z,
      0, 0, 0, x, 0.2, z, x * 0.55 + z * 0.18, 0.38, z * 0.55 - x * 0.18);
  }
  const fernGeometry = new THREE.BufferGeometry();
  fernGeometry.setAttribute('position', new THREE.Float32BufferAttribute(leaves, 3));
  fernGeometry.computeVertexNormals();
  const ferns = batch('ferns', fernGeometry, 0x82aa4f, Math.floor(budget.flowers / 2));
  (ferns.material as THREE.Material).side = THREE.DoubleSide;
  let mushrooms = 0;
  for (let i = 0; i < mushroomCount; i++) {
    const p = position(0.6);
    if (!p) continue;
    transform.position.copy(p).add(new THREE.Vector3(0, 0.25, 0));
    transform.rotation.set(0, random() * Math.PI * 2, 0);
    transform.scale.setScalar(1);
    transform.updateMatrix();
    stems.setMatrixAt(mushrooms, transform.matrix);
    transform.position.y += 0.25;
    transform.updateMatrix();
    caps.setMatrixAt(mushrooms++, transform.matrix);
  }
  stems.count = caps.count = mushrooms;
  let fernCount = 0;
  for (let i = 0; i < ferns.count; i++) {
    const p = position(1.4);
    if (!p) continue;
    transform.position.copy(p);
    transform.rotation.set(0, random() * Math.PI * 2, 0);
    transform.scale.setScalar(0.8 + random() * 0.6);
    transform.updateMatrix();
    ferns.setMatrixAt(fernCount++, transform.matrix);
  }
  ferns.count = fernCount;
}

function buildLandmarks(track: Track, scene: THREE.Group): void {
  for (const span of track.def.decks ?? []) {
    // Transverse logs sit inside the existing slab, with their crowns flush to its surface.
    const count = Math.ceil((span.to - span.from) / 0.8);
    const log = new THREE.CylinderGeometry(0.4, 0.4, 1, 6);
    const transform = new THREE.Object3D();
    const parts = Array.from({ length: count }, (_, i) => {
      const p = sampleTrack(track, span.from + (i + 0.5) * (span.to - span.from) / count);
      transform.position.set(p.x, p.y - 0.32, p.z);
      transform.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(p.nx, 0, p.nz));
      transform.scale.set(1, widthAt(track, p.distance).wallHalfWidth * 2, 1);
      transform.updateMatrix();
      return log.clone().applyMatrix4(transform.matrix);
    });
    // Static deck geometry survives the lower-lane scenery-instance clearance pass.
    const geometry = mergeGeometries(parts)!;
    parts.forEach(part => part.dispose());
    log.dispose();
    const bridge = new THREE.Mesh(geometry, material(0x805c3c));
    bridge.name = 'forest:log-bridge';
    scene.add(bridge);
  }
  for (const jump of track.def.surfaces.filter(zone => zone.kind === 'jump')) {
    const p = sampleTrack(track, jump.to + 5);
    // A shallow creek continues beside both shoulders; the jump keeps the main racing corridor.
    const creek = new THREE.Mesh(new THREE.BoxGeometry(70, 0.12, 4), material(0x679e99));
    creek.position.set(p.x, p.y - 0.65, p.z);
    creek.rotation.y = Math.atan2(p.tx, p.tz);
    creek.name = 'forest:creek';
    scene.add(creek);
  }
}

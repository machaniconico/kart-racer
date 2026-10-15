import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sampleTrack } from '../../../sim/track';
import type { Track } from '../../../sim/types';
import { widthAt } from '../../../sim/corridor';
import type { SceneryBudget } from '../CourseTheme';
import type { CourseTheme } from '../buildCourse';
import { material, terrainHeight } from '../buildCourse';

export const gardenPalette = {
  blossom: 0xf2a7bd, white: 0xfff8fa, limestone: 0xb9bdb1,
  moss: 0x8ca884, wood: 0x79523d, pond: 0x72b9bd,
} as const;

export const garden: CourseTheme = {
  colors: {
    sky: 0xeaf1ed, skyTop: 0xc6dfe8, skyBottom: gardenPalette.white,
    ground: gardenPalette.moss, road: 0x81877e, shoulder: gardenPalette.limestone,
    line: gardenPalette.white, curb: [gardenPalette.blossom, gardenPalette.white],
    rail: gardenPalette.limestone, post: gardenPalette.wood, dash: 0xdce1d5,
    gate: gardenPalette.wood, barrier: gardenPalette.limestone, motionBarrier: gardenPalette.wood,
    bannerBackground: '#fff8fa', bannerText: '#714154',
    checker: [gardenPalette.blossom, gardenPalette.white], signBackground: '#fff8fa', signText: '#714154',
    surfaces: { ice: 0xd9edf0, boost: 0xe6c571, jump: gardenPalette.blossom,
      dirt: 0xa4a291, pit: gardenPalette.pond },
  },
  fog: { color: 0xf3e8eb, near: 190, far: 510 },
  lighting: {
    hemisphere: { sky: gardenPalette.white, ground: 0x809174, intensity: 2.1 },
    sun: { color: 0xfff3e2, intensity: 2, position: [70, 110, 40], offset: [55, 90, 35] },
  },
  signFractions: [0.085, 0.26, 0.40, 0.45, 0.54, 0.63, 0.77, 0.91],
  budget: { trees: 100, rocks: 48, flowers: 140 },
  buildProps,
  buildLandmarks(_track, scene) {
    const island = scene.getObjectByName('islands') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    island.material.color.setHex(gardenPalette.limestone);
    // Keep the shared island placement and collision footprint, replacing the
    // boulder silhouette with stone bases, lantern chambers and pagoda caps.
    const stones = scene.getObjectByName('island-scenery:rock') as THREE.InstancedMesh;
    const lantern = lanternGeometry();
    lantern.scale(0.5, 1 / 3, 0.5);
    lantern.translate(0, -0.5, 0);
    const matrix = new THREE.Matrix4();
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < stones.count; i++) {
      stones.getMatrixAt(i, matrix);
      parts.push(lantern.clone().applyMatrix4(matrix));
    }
    const lanterns = new THREE.Mesh(mergeGeometries(parts)!, stones.material);
    lanterns.name = 'garden:island-lanterns';
    lanterns.castShadow = true;
    lanterns.receiveShadow = true;
    scene.add(lanterns);
    scene.remove(stones);
    stones.geometry.dispose();
    stones.dispose();
    lantern.dispose();
    parts.forEach(part => part.dispose());
  },
};

/** A three-metre stone lantern with a two-metre square footprint. */
function lanternGeometry(): THREE.BufferGeometry {
  const parts = [
    new THREE.BoxGeometry(1.6, 0.35, 1.6).translate(0, 0.175, 0),
    new THREE.BoxGeometry(0.55, 1.3, 0.55).translate(0, 1, 0),
    new THREE.BoxGeometry(1.15, 0.7, 1.15).translate(0, 2, 0),
    new THREE.ConeGeometry(Math.SQRT2, 0.65, 4).rotateY(Math.PI / 4).translate(0, 2.675, 0),
  ];
  const geometry = mergeGeometries(parts)!;
  parts.forEach(part => part.dispose());
  return geometry;
}

/** Reserve the full bounding sphere against every road segment, including nearby bends. */
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
  const transform = new THREE.Object3D();
  let seed = 1042;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.45, 4, 5),
    material(gardenPalette.wood), budget.trees);
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(3.4, 1),
    material(0xffffff), budget.trees);
  const stones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0),
    material(gardenPalette.limestone), budget.rocks);
  const lanterns = new THREE.InstancedMesh(lanternGeometry(), material(gardenPalette.limestone),
    Math.ceil(budget.rocks / 2));
  const petals = new THREE.InstancedMesh(new THREE.BoxGeometry(0.45, 0.04, 0.65),
    material(gardenPalette.white), budget.flowers);
  trunks.name = 'trunks'; crowns.name = 'crowns'; stones.name = 'rocks';
  lanterns.name = 'garden:lanterns'; petals.name = 'flowers';
  trunks.castShadow = true; crowns.castShadow = true; lanterns.castShadow = true;
  for (const mesh of [trunks, stones, lanterns, petals]) {
    const count = mesh.count;
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const distance = (i + random()) / count * track.length;
      const point = sampleTrack(track, distance), side = i % 2 ? -1 : 1;
      const scale = 0.85 + random() * 0.4;
      // The tree reserve covers its wider, flattened blossom canopy as well.
      const radius = (mesh === trunks ? 4.5 : mesh === lanterns ? 3.4 : mesh === stones ? 1.7 : 0.5) * scale;
      for (let attempt = 0; attempt < 24; attempt++) {
        const offset = side * (widthAt(track, distance).wallHalfWidth + 12 + attempt * 6 + random() * 9);
        const x = point.x + point.nx * offset, z = point.z + point.nz * offset;
        if (!clearsRoads(track, x, z, radius)) continue;
        const ground = terrainHeight(track, { distance, offset, height: point.y, heading: Math.atan2(point.tx, point.tz) });
        const lift = mesh === trunks ? 2 : mesh === stones ? 0.55 : mesh === petals ? 0.04 : 0;
        transform.position.set(x, ground + lift * scale, z);
        transform.rotation.set(0, random() * Math.PI * 2, 0);
        transform.scale.setScalar(scale);
        if (mesh === stones) transform.scale.set(1.7 * scale, 0.6 * scale, 1.2 * scale);
        transform.updateMatrix();
        mesh.setMatrixAt(placed, transform.matrix);
        if (mesh === trunks) {
          transform.position.y = ground + 4.6 * scale;
          transform.scale.set(1.3 * scale, 0.8 * scale, 1.15 * scale);
          transform.updateMatrix();
          crowns.setMatrixAt(placed, transform.matrix);
          crowns.setColorAt(placed, new THREE.Color(i % 3 === 0 ? gardenPalette.white : gardenPalette.blossom));
        }
        placed++;
        break;
      }
    }
    mesh.count = placed;
  }
  crowns.count = trunks.count;
  scene.add(trunks, crowns, stones, lanterns, petals);
}

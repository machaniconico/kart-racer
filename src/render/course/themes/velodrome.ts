import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sampleTrack } from '../../../sim/track';
import type { Track } from '../../../sim/types';
import type { SceneryBudget } from '../CourseTheme';
import { material, type CourseTheme } from '../buildCourse';

export const velodromePalette = {
  timber: 0x9e7141, apron: 0xb6ec36, plum: 0x341b37,
  white: 0xfff4d9, amber: 0xffaf32, steel: 0x302633, lamp: 0xffe3a1,
} as const;

export const velodrome: CourseTheme = {
  colors: {
    sky: 0x110c13, skyTop: 0x08060b, skyBottom: 0x281724,
    ground: 0x211d21, road: velodromePalette.timber, shoulder: velodromePalette.apron,
    deck: 0xbb874e, pillar: velodromePalette.steel, line: velodromePalette.white,
    curb: [velodromePalette.amber, velodromePalette.white], rail: velodromePalette.apron,
    post: velodromePalette.steel, dash: velodromePalette.plum, gate: velodromePalette.plum,
    bannerBackground: '#341b37', bannerText: '#b6ec36',
    checker: [velodromePalette.white, velodromePalette.plum],
    signBackground: '#341b37', signText: '#ffaf32',
    surfaces: { ice: 0xc8f4f6, boost: 0xffd166, jump: 0xffd166, dirt: 0x9b8061, pit: 0x183c46 },
  },
  fog: { color: 0x281724, near: 160, far: 700 },
  lighting: {
    hemisphere: { sky: 0xffd9a8, ground: 0x4a3236, intensity: 1.05 },
    sun: { color: 0xffe3a1, intensity: 0.9, position: [-130, 170, -100], offset: [-100, 140, -80] },
  },
  signFractions: [0.20, 0.39, 0.69, 0.89],
  // Existing budget slots count lighting towers, seating tiers and canopies.
  budget: { trees: 20, rocks: 60, flowers: 20 },
  buildProps,
  buildLandmarks(_track, scene) {
    // Floodlit timber without scene lights: buildCourse owns the road material, and an emissive
    // tint is a uniform, so the course keeps the shared shader programs (no light-count variant).
    const road = scene.getObjectByName('road') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    if (road) {
      road.material.emissive.setHex(velodromePalette.amber);
      road.material.emissiveIntensity = 0.12;
    }
  },
};

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  const masts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.45, 0.8, 60, 6),
    material(velodromePalette.steel), budget.trees);
  const lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(8, 1.5, 2),
    new THREE.MeshLambertMaterial({ color: velodromePalette.lamp,
      emissive: velodromePalette.lamp, emissiveIntensity: 2, flatShading: true }), budget.trees);
  const seats = new THREE.InstancedMesh(new THREE.BoxGeometry(6, 1, 38),
    material(0xffffff), budget.rocks);
  const roofs = new THREE.InstancedMesh(new THREE.BoxGeometry(21, 0.8, 42),
    material(velodromePalette.white), budget.flowers);
  const neon = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.6, 42),
    new THREE.MeshBasicMaterial({ color: velodromePalette.apron, toneMapped: false }), budget.flowers);
  neon.name = 'velodrome:neon-ribbons';
  masts.name = 'velodrome:light-towers'; lamps.name = 'velodrome:floodlights';
  seats.name = 'velodrome:seating'; roofs.name = 'velodrome:canopies';
  const transform = new THREE.Object3D();
  const color = new THREE.Color();
  const place = (mesh: THREE.InstancedMesh, index: number, distance: number,
    offset: number, height: number, scaleY = 1) => {
    const point = sampleTrack(track, distance);
    transform.position.set(point.x + point.nx * offset, height - 1.35, point.z + point.nz * offset);
    transform.rotation.set(0, Math.atan2(point.tx, point.tz), 0);
    transform.scale.set(1, scaleY, 1);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
  };
  // Positive offset is outside both bowls. All footprints start beyond the
  // wall + 22 m terrain ribbon, on the level stadium concourse at y = -1.35.
  // Unlit additive beams from every floodlight to the track centre. Scene lights would change
  // the light count and so the shader variant of every lit material (karts included).
  const beam = new THREE.ConeGeometry(9, 1, 10, 1, true).translate(0, -0.5, 0);
  const beams: THREE.BufferGeometry[] = [];
  const down = new THREE.Vector3(0, -1, 0), target = new THREE.Vector3(), direction = new THREE.Vector3();
  for (let i = 0; i < budget.trees; i++) {
    const d = (i + 0.5) / budget.trees * track.length;
    place(masts, i, d, 43, 30);
    place(lamps, i, d, 43, 60);
    const point = sampleTrack(track, d);
    target.set(point.x, point.y, point.z);
    direction.subVectors(target, transform.position);
    const length = direction.length();
    beams.push(beam.clone().applyMatrix4(new THREE.Matrix4().compose(transform.position,
      new THREE.Quaternion().setFromUnitVectors(down, direction.normalize()),
      new THREE.Vector3(1, length, 1))));
  }
  beam.dispose();
  const light = new THREE.Mesh(mergeGeometries(beams)!, new THREE.MeshBasicMaterial({
    color: velodromePalette.lamp, transparent: true, opacity: 0.09, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, fog: false }));
  for (const part of beams) part.dispose();
  light.name = 'velodrome:light-beams';
  scene.add(light);
  for (let i = 0; i < budget.rocks; i++) {
    const row = i % 3;
    const d = (Math.floor(i / 3) + 0.5) / Math.ceil(budget.rocks / 3) * track.length;
    const height = 14 + row * 3;
    place(seats, i, d, 54 + row * 6, height / 2, height);
    seats.setColorAt(i, color.setHex(row === 1 ? velodromePalette.apron : velodromePalette.plum));
  }
  for (let i = 0; i < budget.flowers; i++) {
    const d = (i + 0.5) / budget.flowers * track.length;
    // The canopy rests on the tallest outer seating tier.
    place(roofs, i, d, 60, 20.4);
    place(neon, i, d, 49.5, 20.4);
  }
  for (const mesh of [masts, lamps, seats, roofs]) {
    mesh.castShadow = mesh !== lamps;
    mesh.receiveShadow = mesh === seats;
    scene.add(mesh);
  }
  scene.add(neon);
}

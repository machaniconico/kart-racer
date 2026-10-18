import * as THREE from 'three';
import { projectToTrack, sampleTrack } from '../../../sim/track';
import { widthAt } from '../../../sim/corridor';
import type { Track } from '../../../sim/types';
import type { SceneryBudget } from '../CourseTheme';
import { material, place, terrainHeight } from '../buildCourse';
import type { CourseTheme } from '../buildCourse';

export const chasm: CourseTheme = {
  colors: {
    sky: 0xdfbcc2, skyTop: 0x899fba, skyBottom: 0xf2c9bb,
    ground: 0x69454f, road: 0x575861, shoulder: 0xb18b86, line: 0xffefce,
    curb: [0xf3d582, 0x793b49], rail: 0xe3c7b9, post: 0x683a49, dash: 0xc9b8b1,
    gate: 0x873c51, bannerBackground: '#532b3a', bannerText: '#fff1cb',
    checker: [0xffefce, 0x532b3a], signBackground: '#f3d582', signText: '#532b3a',
    surfaces: { ice: 0xc7e3e5, boost: 0x75dfc1, jump: 0xf3d582 },
  },
  fog: { color: 0xdfbcc2, near: 210, far: 950 },
  lighting: {
    hemisphere: { sky: 0xffe2da, ground: 0x684254, intensity: 1.8 },
    sun: { color: 0xffdfb9, intensity: 2.2, position: [80, 130, -65], offset: [60, 100, -40] },
  },
  signFractions: [0.035, 0.15, 0.225, 0.36, 0.55, 0.72, 0.9],
  budget: { trees: 56, rocks: 80, flowers: 0 },
  buildProps,
  buildLandmarks,
};

/** Shared ribbons already include exact surface boundaries; remove their gap
 * triangles here so the other nineteen themes retain their existing geometry. */
function openRavines(track: Track, scene: THREE.Group): void {
  const gaps = track.def.surfaces.filter(zone => zone.kind === 'fall');
  const inGap = (distance: number, margin = 0): boolean =>
    gaps.some(gap => distance > gap.from - margin && distance < gap.to + margin);
  for (const name of ['road', 'shoulder:-1', 'shoulder:1', 'ground:-1', 'ground:1', 'line:-1', 'line:1']) {
    const mesh = scene.getObjectByName(name) as THREE.Mesh;
    const positions = mesh.geometry.getAttribute('position'), indices = mesh.geometry.index!;
    const kept: number[] = [];
    for (let i = 0; i < indices.count; i += 3) {
      const a = indices.getX(i), b = indices.getX(i + 1), c = indices.getX(i + 2);
      const x = (positions.getX(a) + positions.getX(b) + positions.getX(c)) / 3;
      const z = (positions.getZ(a) + positions.getZ(b) + positions.getZ(c)) / 3;
      if (!inGap(projectToTrack(track, x, z).distance)) kept.push(a, b, c);
    }
    mesh.geometry.setIndex(kept);
  }
  const matrix = new THREE.Matrix4(), point = new THREE.Vector3(), color = new THREE.Color();
  // At this point the direct instances are the road's curbs, rails, posts and
  // centre dashes (which have no name). Include each instance's full footprint.
  for (const mesh of scene.children) {
    if (!(mesh instanceof THREE.InstancedMesh)) continue;
    const vertices = mesh.geometry.getAttribute('position');
    let kept = 0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      point.setFromMatrixPosition(matrix);
      const distance = projectToTrack(track, point.x, point.z).distance;
      let halfLength = 0;
      const tangent = sampleTrack(track, distance);
      for (let v = 0; v < vertices.count; v++) {
        point.fromBufferAttribute(vertices, v).applyMatrix4(matrix);
        halfLength = Math.max(halfLength, Math.abs((point.x - matrix.elements[12]!) * tangent.tx +
          (point.z - matrix.elements[14]!) * tangent.tz));
      }
      if (inGap(distance, halfLength)) continue;
      mesh.setMatrixAt(kept, matrix);
      if (mesh.instanceColor) { mesh.getColorAt(i, color); mesh.setColorAt(kept, color); }
      kept++;
    }
    mesh.count = kept;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

function buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void {
  openRavines(track, scene);
  const pillars = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 1, 1, 5), material(0x8f5263), budget.trees);
  const caps = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.75, 0.78, 1, 5), material(0xd5a59b), budget.trees);
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1), material(0xaa777b), budget.rocks);
  const transform = new THREE.Object3D();
  let seed = 1105;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (const mesh of [pillars, rocks]) {
    let count = 0;
    for (let i = 0; i < mesh.count; i++) {
      const distance = (i + random()) / mesh.count * track.length;
      const point = sampleTrack(track, distance);
      const size = mesh === pillars ? 3 + random() * 4 : 1 + random() * 1.8;
      const height = mesh === pillars ? 15 + random() * 25 : size;
      const offset = (i % 2 ? -1 : 1) * (widthAt(track, distance).wallHalfWidth + 35 + random() * 30);
      const x = point.x + point.nx * offset, z = point.z + point.nz * offset;
      const projection = projectToTrack(track, x, z);
      if (Math.abs(projection.offset) < widthAt(track, projection.distance).wallHalfWidth + size + 5) continue;
      transform.position.set(x, terrainHeight(track, projection) + height / 2, z);
      transform.rotation.set(0, random() * Math.PI * 2, 0);
      transform.scale.set(size, height, size);
      transform.updateMatrix();
      mesh.setMatrixAt(count, transform.matrix);
      if (mesh === pillars) {
        transform.position.y += height * 0.41;
        transform.scale.y = height * 0.12;
        transform.updateMatrix();
        caps.setMatrixAt(count, transform.matrix);
      }
      count++;
    }
    mesh.count = count;
  }
  caps.count = pillars.count;
  pillars.name = 'chasm:buttes'; caps.name = 'chasm:butte-caps'; rocks.name = 'chasm:rocks';
  pillars.castShadow = true;
  scene.add(pillars, caps, rocks);
}

function buildLandmarks(track: Track, scene: THREE.Group): void {
  const gaps = track.def.surfaces.filter(zone => zone.kind === 'fall');
  const faces: number[] = [], indices: number[] = [];
  const markers = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.035, 0.5), material(0xf3d582), gaps.length * 2);
  const beacons = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.3, 0.5, 3.5, 6), material(0x75dfc1), gaps.length * 4);
  const transform = new THREE.Object3D();
  for (const [i, gap] of gaps.entries()) for (const [end, distance] of [gap.from, gap.to].entries()) {
    const point = sampleTrack(track, distance), wall = widthAt(track, distance).wallHalfWidth;
    const edges = [-wall - 22, -wall, wall, wall + 22];
    for (let e = 0; e < edges.length - 1; e++) {
      const n = faces.length / 3;
      for (const offset of [edges[e]!, edges[e + 1]!]) {
        const y = Math.abs(offset) <= wall ? point.y : -1.35;
        faces.push(point.x + point.nx * offset, -1.35, point.z + point.nz * offset,
          point.x + point.nx * offset, y, point.z + point.nz * offset);
      }
      indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
    }
    const lip = sampleTrack(track, distance + (end === 0 ? -0.3 : 0.3));
    place(track, transform, lip, 0, 0.095);
    transform.scale.x = 2 * wall;
    transform.updateMatrix();
    markers.setMatrixAt(i * 2 + end, transform.matrix);
    markers.setColorAt(i * 2 + end, new THREE.Color(end === 0 ? 0xffffff : 0x75dfc1));
    for (const [sideIndex, side] of [-1, 1].entries()) {
      place(track, transform, sampleTrack(track, distance + (end === 0 ? -2 : 2)), side * (wall + 1), 1);
      transform.updateMatrix();
      beacons.setMatrixAt(i * 4 + end * 2 + sideIndex, transform.matrix);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(faces, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const stone = material(0x8f5263);
  stone.side = THREE.DoubleSide;
  const cliffs = new THREE.Mesh(geometry, stone);
  cliffs.name = 'chasm:ravine-faces'; markers.name = 'chasm:lip-markers'; beacons.name = 'chasm:landing-beacons';
  cliffs.receiveShadow = true;
  scene.add(cliffs, markers, beacons);
}

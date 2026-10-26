import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { projectToTrack, sampleTrack, surfaceHeightAt, wrapDistance } from '../../../sim';
import type { SurfaceZone, Track } from '../../../sim';
import { widthAt } from '../../../sim/corridor';
import { material, place, terrainHeight, type CourseTheme } from '../buildCourse';
import { RoadIndex } from '../roadIndex';
import { meadow } from './meadow';

export const aqueduct: CourseTheme = {
  ...meadow,
  colors: {
    ...meadow.colors,
    sky: 0xb9dde4, skyTop: 0x77b8d2, skyBottom: 0xe8e0bf,
    ground: 0x96996b, road: 0x9a805a, shoulder: 0xb49b70,
    deck: 0xd8b878, pillar: 0xb18a4f, line: 0xffedbd,
    curb: [0xe2c48a, 0x9c7747], rail: 0xd3b47c, post: 0x9c7747,
    dash: 0xe8d4a5, gate: 0xb18a4f, barrier: 0xb18a4f,
    bannerBackground: '#756040', bannerText: '#fff1cd',
    checker: [0xffedbd, 0x756040], signBackground: '#e2c48a', signText: '#51432d',
    surfaces: { ...meadow.colors.surfaces, dirt: 0xb49b70, fall: 0x328e9b },
  },
  fog: { color: 0xd8dfce, near: 200, far: 600 },
  lighting: {
    hemisphere: { sky: 0xf2f5e3, ground: 0x807650, intensity: 2.25 },
    sun: { ...meadow.lighting.sun, color: 0xffe5b5 },
  },
  budget: { trees: 0, rocks: 24, flowers: 0 },
  buildProps(track, scene, budget) {
    // Box-built voussoirs, piers and trough share one existing Lambert program.
    const parts: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      parts.push(new THREE.BoxGeometry(3, 4, 1.4).translate(0, 2, side * 6));
      parts.push(new THREE.BoxGeometry(0.6, 0.8, 14).translate(side * 1.9, 11.2, 0));
    }
    for (let i = 0; i < 9; i++) {
      const angle = (i + 0.5) / 9 * Math.PI;
      parts.push(new THREE.BoxGeometry(3, 1.1, 2.15).rotateX(Math.PI / 2 - angle)
        .translate(0, 4 + Math.sin(angle) * 6, Math.cos(angle) * 6));
    }
    parts.push(new THREE.BoxGeometry(4.4, 0.5, 14).translate(0, 10.8, 0));
    const arches = new THREE.InstancedMesh(mergeGeometries(parts)!, material(0xc49b5d), budget.rocks);
    parts.forEach(part => part.dispose());
    const water = new THREE.InstancedMesh(new THREE.BoxGeometry(3.2, 0.04, 14).translate(0, 11.08, 0),
      material(0x328e9b), budget.rocks);
    arches.name = 'aqueduct:arches';
    water.name = 'aqueduct:water';
    arches.receiveShadow = true;
    const index = new RoadIndex(track), transform = new THREE.Object3D();
    let count = 0;
    for (let i = 0; i < budget.rocks; i++) {
      const point = sampleTrack(track, (i + 0.5) / budget.rocks * track.length);
      for (let attempt = 0; attempt < 48; attempt++) {
        const offset = ((i + attempt) % 2 ? -1 : 1)
          // Keep the arch feet beyond the 22 m banks, including removed upper banks.
          * (widthAt(track, point.distance).wallHalfWidth + 26 + Math.floor(attempt / 2) * 8);
        const x = point.x + point.nx * offset, z = point.z + point.nz * offset;
        // Reserve the whole arch footprint against both crossing branches.
        if (index.heightAt(x, z, false, 10) !== undefined || index.heightAt(x, z, true, 10) !== undefined) continue;
        transform.position.set(x, terrainHeight(track, {
          distance: point.distance, offset, height: point.y, heading: Math.atan2(point.tx, point.tz),
        }), z);
        transform.rotation.set(0, Math.atan2(point.tx, point.tz), 0);
        transform.updateMatrix();
        arches.setMatrixAt(count, transform.matrix);
        water.setMatrixAt(count++, transform.matrix);
        break;
      }
    }
    arches.count = water.count = count;
    scene.add(arches, water);
  },
  buildLandmarks: buildOpenDeckEdges,
};

/** Keep the upper ledge visible below the tires, without suggesting a safety rail. */
function buildOpenDeckEdges(track: Track, scene: THREE.Group): void {
  if (!track.def.decks?.length) return;
  const falls = track.def.surfaces.filter(zone => zone.kind === 'fall');
  const spansFor = (side: number) => falls.filter(zone => side < 0
    ? (zone.offsetMax ?? 0) < 0 : (zone.offsetMin ?? 0) > 0);
  const within = (distance: number, span: { from: number; to: number }, margin = 0): boolean => {
    const relative = wrapDistance(track, distance - span.from);
    return relative <= wrapDistance(track, span.to - span.from) + margin || relative >= track.length - margin;
  };
  const edgeAt = (distance: number, side: number): number => {
    const fall = spansFor(side).find(span => within(distance, span));
    return fall ? Math.abs(side < 0 ? fall.offsetMax! : fall.offsetMin!) : widthAt(track, distance).wallHalfWidth;
  };
  const index = new RoadIndex(track), transform = new THREE.Object3D();
  const matrix = new THREE.Matrix4(), point = new THREE.Vector3();
  for (const name of ['rails', 'posts', ...(falls.length ? ['curbs'] : [])]) {
    const mesh = scene.getObjectByName(name) as THREE.InstancedMesh;
    const color = new THREE.Color();
    let kept = 0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      point.setFromMatrixPosition(matrix);
      const upper = index.heightAt(point.x, point.z, true, 0.5);
      const projection = projectToTrack(track, point.x, point.z, undefined, point.y);
      const side = Math.sign(projection.offset);
      const onFall = spansFor(side).some(span => within(projection.distance, span,
        name === 'posts' ? 0.2 : Math.hypot(matrix.elements[8], matrix.elements[10]) / 2));
      // XZ alone would also remove the safe lower road's rail at the crossing.
      if (onFall || (upper !== undefined && Math.abs(point.y - upper) < 1.5)) continue;
      mesh.setMatrixAt(kept, matrix);
      if (mesh.instanceColor) { mesh.getColorAt(i, color); mesh.setColorAt(kept, color); }
      kept++;
    }
    mesh.count = kept;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  // The shared builder treats fall as simulation data. Remove the upper banks
  // and shoulders so their geometry does not suggest a safe surface over the void.
  for (const side of [-1, 1]) for (const prefix of ['shoulder', 'ground']) {
    const mesh = scene.getObjectByName(`${prefix}:${side}`) as THREE.Mesh;
    const vertices = mesh.geometry.getAttribute('position'), indices = mesh.geometry.index!;
    const kept: number[] = [];
    for (let i = 0; i < indices.count; i += 3) {
      const corners = [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)];
      const x = corners.reduce((sum, v) => sum + vertices.getX(v), 0) / 3;
      const z = corners.reduce((sum, v) => sum + vertices.getZ(v), 0) / 3;
      const y = Math.max(...corners.map(v => vertices.getY(v)));
      const projection = projectToTrack(track, x, z, undefined, y);
      if (!spansFor(side).some(span => within(projection.distance, span))) kept.push(...corners);
    }
    mesh.geometry.setIndex(kept);
  }
  const deck = scene.getObjectByName('decks') as THREE.Mesh;
  const vertices = deck.geometry.getAttribute('position');
  for (let i = 0; i < vertices.count; i++) {
    const projection = projectToTrack(track, vertices.getX(i), vertices.getZ(i), undefined, vertices.getY(i));
    const side = Math.sign(projection.offset), offset = side * edgeAt(projection.distance, side);
    if (Math.abs(projection.offset) <= Math.abs(offset) + 1e-5) continue;
    const sample = sampleTrack(track, projection.distance);
    const y = vertices.getY(i) + surfaceHeightAt(track, projection.distance, offset)
      - surfaceHeightAt(track, projection.distance, projection.offset);
    vertices.setXYZ(i, sample.x + sample.nx * offset, y, sample.z + sample.nz * offset);
  }
  vertices.needsUpdate = true;
  deck.geometry.computeVertexNormals();
  const pillars = scene.getObjectByName('deck-pillars') as THREE.InstancedMesh;
  let kept = 0;
  for (let i = 0; i < pillars.count; i++) {
    pillars.getMatrixAt(i, matrix);
    const projection = projectToTrack(track, matrix.elements[12], matrix.elements[14], undefined,
      matrix.elements[13] + matrix.elements[5] / 2 + 0.6);
    const side = Math.sign(projection.offset), offset = side * (edgeAt(projection.distance, side) - 0.6);
    const sample = sampleTrack(track, projection.distance);
    const x = sample.x + sample.nx * offset, z = sample.z + sample.nz * offset;
    const top = surfaceHeightAt(track, projection.distance, offset) - 0.54;
    if (index.heightAt(x, z, false, 0.45, top) !== undefined) continue;
    transform.position.set(x, (top - 1.35) / 2, z);
    transform.rotation.set(0, 0, 0);
    transform.scale.set(1, top + 1.35, 1);
    transform.updateMatrix();
    pillars.setMatrixAt(kept++, transform.matrix);
  }
  pillars.count = kept;
  pillars.instanceMatrix.needsUpdate = true;
  for (const side of [-1, 1]) {
    const parts: THREE.BufferGeometry[] = [];
    const spans: readonly Pick<SurfaceZone, 'from' | 'to'>[] = spansFor(side).length ? spansFor(side) : track.def.decks;
    for (const span of spans) {
      const end = span.to < span.from ? span.to + track.length : span.to;
      const count = Math.max(1, Math.ceil((end - span.from) / 2));
      const step = (end - span.from) / count;
      for (let i = 0; i < count; i++) {
        const sample = sampleTrack(track, span.from + (i + 0.5) * step);
        place(track, transform, sample, side * (edgeAt(sample.distance, side) - 0.15), -0.32);
        parts.push(new THREE.BoxGeometry(0.3, 0.6, step).applyMatrix4(transform.matrix));
      }
    }
    // A merged mesh survives the shared scenery filter over the lower road.
    const mesh = new THREE.Mesh(mergeGeometries(parts)!, material(0xb18a4f));
    parts.forEach(part => part.dispose());
    mesh.name = `aqueduct:fall-edge:${side}`;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

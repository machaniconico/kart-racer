import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sampleTrack } from '../../sim';
import type { Barrier, SurfaceZone, Track, TrackProjection, TrackSample } from '../../sim';
import { widthAt } from '../../sim/corridor';
import type { CourseTheme as BaseCourseTheme } from './CourseTheme';

// Keep compatibility with callers of the original theme contract.
export interface CourseTheme extends BaseCourseTheme {
  readonly colors: BaseCourseTheme['colors'] & {
    readonly surfaces: Readonly<Partial<Record<SurfaceZone['kind'], number>>>;
    readonly barrier?: number;
  };
}

const surfaceFallback = { dirt: 0x99683f, pit: 0x302724, spin: 0xb77ee0 };
type RibbonOffsets = (distance: number) => readonly [number, number];

export function material(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

/** Match the shoulder slope used by the ground ribbons. */
export function terrainHeight(track: Track, projection: TrackProjection): number {
  const offset = Math.abs(projection.offset);
  const { wallHalfWidth } = widthAt(track, projection.distance);
  return offset < wallHalfWidth + 22
    ? projection.height + (-1.35 - projection.height) * ((offset - wallHalfWidth) / 22) : -1.35;
}

function ribbonGeometry(track: Track, offsets: RibbonOffsets, lift = 0, slope = false,
  from = 0, to = track.length): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const count = Math.max(1, Math.ceil(384 * (to - from) / track.length));
  // A variable-width edge must also follow the sampled centerline's corners;
  // otherwise a straight chord between width keys cuts inside curved sections.
  const distances = sectionDistances(track, count, from, to,
    [...track.def.surfaces.flatMap(zone => [zone.from, zone.to]),
      ...(track.def.widthKeys?.length ? track.samples.map(point => point.distance) : [])]);
  for (const [i, distance] of distances.entries()) {
    const p = sampleTrack(track, distance);
    for (const [j, offset] of offsets(distance).entries()) {
      positions.push(p.x + p.nx * offset, slope && j === 1 ? -1.35 : p.y + lift, p.z + p.nz * offset);
    }
    if (i < distances.length - 1) {
      const n = i * 2;
      indices.push(n, n + 2, n + 1, n + 1, n + 2, n + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Keep corners in the width profile, including keys in the next lap of a wrapped zone. */
function sectionDistances(track: Track, count: number, from = 0, to = track.length,
  boundaries: readonly number[] = []): number[] {
  const distances = new Set(Array.from({ length: count + 1 }, (_, i) => from + i / count * (to - from)));
  for (const distance of [...(track.def.widthKeys ?? []).map(key => key.distance), ...boundaries]) {
    for (let lap = Math.floor(from / track.length); lap <= Math.floor(to / track.length); lap++) {
      const d = distance + lap * track.length;
      if (d > from && d < to) distances.add(d);
    }
  }
  return [...distances].sort((a, b) => a - b);
}

function ribbon(track: Track, scene: THREE.Group, offsets: RibbonOffsets, color: number, lift = 0, slope = false): THREE.Mesh {
  const geo = ribbonGeometry(track, offsets, lift, slope);
  const mat = material(color);
  mat.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

/** All course resources, including theme props and label textures, share one owner. */
export interface Course {
  readonly group: THREE.Group;
  readonly sky: THREE.Mesh;
  dispose(): void;
}

export function buildCourse(track: Track, theme: CourseTheme): Course {
  const group = new THREE.Group();
  group.name = `course:${track.def.id}`;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 16, 12), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { top: { value: new THREE.Color(theme.colors.skyTop) }, bottom: { value: new THREE.Color(theme.colors.skyBottom) } },
    vertexShader: 'varying vec3 vPosition; void main(){vPosition=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vPosition; void main(){float t=smoothstep(-0.08,0.7,normalize(vPosition).y);gl_FragColor=vec4(mix(bottom,top,t),1.0);\n#include <colorspace_fragment>\n}',
  }));
  group.add(sky);
  buildRoad(track, theme, group);
  const surfaces = new Map<SurfaceZone['kind'], THREE.BufferGeometry[]>();
  for (const zone of track.def.surfaces) {
    // Sampling beyond length also handles a single zone crossing the finish line.
    const to = zone.to < zone.from ? zone.to + track.length : zone.to;
    const geometry = ribbonGeometry(track, d => {
      const { roadHalfWidth } = widthAt(track, d);
      return [zone.offsetMin ?? -roadHalfWidth, zone.offsetMax ?? roadHalfWidth];
    }, 0.1, false, zone.from, to);
    const parts = surfaces.get(zone.kind) ?? [];
    parts.push(geometry);
    surfaces.set(zone.kind, parts);
  }
  for (const [kind, parts] of surfaces) {
    const geometry = mergeGeometries(parts)!;
    parts.forEach(part => part.dispose());
    const color = kind === 'dirt' || kind === 'pit' || kind === 'spin'
      ? theme.colors.surfaces[kind] ?? surfaceFallback[kind] : theme.colors.surfaces[kind];
    const mat = material(color);
    mat.side = THREE.DoubleSide;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = `surface:${kind}`;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  buildBarriers(track, theme, group);
  buildScenery(track, theme, group);
  return { group, sky, dispose() { disposeObjectTree(group); group.removeFromParent(); } };
}

export function buildScenery(track: Track, theme: CourseTheme, scene: THREE.Group): void {
  theme.buildProps(track, scene, theme.budget);
  theme.buildLandmarks(track, scene);
}

function buildBarriers(track: Track, theme: CourseTheme, group: THREE.Group): void {
  const batches = new Map<NonNullable<Barrier['scenery']>, Barrier[]>();
  for (const barrier of track.def.barriers ?? []) {
    const scenery = barrier.scenery ?? 'block';
    const batch = batches.get(scenery) ?? [];
    batch.push(barrier);
    batches.set(scenery, batch);
  }
  for (const [scenery, barriers] of batches) {
    const spans = barriers.map(b => (b.to - b.from + track.length) % track.length);
    const segments = Math.max(4, Math.ceil(Math.max(...spans) / 4) * 4);
    const geometry = scenery === 'pillar'
      // Multiples of twelve include z = ±0.5, the two taper joins below.
      ? new THREE.CylinderGeometry(1, 1, 1, Math.ceil(Math.max(24, segments * 2) / 12) * 12)
      : new THREE.BoxGeometry(2, 1, 1, 1, 1, segments);
    const height = scenery === 'pillar' || scenery === 'building' ? 4 : 1.2;
    const mesh = new THREE.InstancedMesh(geometry, material(theme.colors.barrier ?? theme.colors.post), barriers.length);
    const positions: THREE.BufferAttribute[] = [];
    const normals: THREE.BufferAttribute[] = [];
    const transform = new THREE.Matrix4();
    barriers.forEach((barrier, index) => {
      const span = spans[index];
      const taper = Math.min(barrier.taper ?? 4, span / 2);
      const origin = sampleTrack(track, barrier.from + span / 2);
      const shape = geometry.clone();
      const vertices = shape.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < vertices.count; i++) {
        // Four equal template sections put vertices exactly on both taper joins.
        const unit = scenery === 'pillar' ? (vertices.getZ(i) + 1) / 2 : vertices.getZ(i) + 0.5;
        const along = unit < 0.25 ? unit * 4 * taper : unit > 0.75
          ? span - (1 - unit) * 4 * taper : taper + (unit - 0.25) * 2 * (span - 2 * taper);
        const half = barrier.halfWidth * Math.min(1, along / (barrier.taper ?? 4), (span - along) / (barrier.taper ?? 4));
        const point = sampleTrack(track, barrier.from + along);
        // Flatten the circular plan into the physical band. Without normalization
        // the cylinder's x = ±sqrt(1-z²) leaves an invisible collision strip.
        const radius = scenery === 'pillar' ? Math.sqrt(Math.max(0, 1 - vertices.getZ(i) ** 2)) : 1;
        const lateral = radius > 1e-6 ? vertices.getX(i) / radius : 0;
        const offset = barrier.center + lateral * half;
        vertices.setXYZ(i, point.x + point.nx * offset - origin.x,
          point.y + 0.06 + (vertices.getY(i) + 0.5) * height - origin.y,
          point.z + point.nz * offset - origin.z);
      }
      shape.computeVertexNormals();
      positions.push(vertices);
      normals.push(shape.getAttribute('normal') as THREE.BufferAttribute);
      shape.dispose();
      mesh.setMatrixAt(index, transform.makeTranslation(origin.x, origin.y, origin.z));
    });
    // Per-instance morphs keep differently sized, curved and tapered bodies in one
    // draw per scenery. These are the physical bands, without the kart-radius halo.
    geometry.morphAttributes.position = positions;
    geometry.morphAttributes.normal = normals;
    const pose = new THREE.Mesh(geometry, mesh.material);
    barriers.forEach((_, index) => {
      pose.morphTargetInfluences!.fill(0);
      pose.morphTargetInfluences![index] = 1;
      mesh.setMorphAt(index, pose);
    });
    mesh.morphTexture!.needsUpdate = true;
    mesh.name = `barriers:${scenery}`;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
  }
}

/** Dispose shared resources once, including instancing buffers and every texture slot. */
export function disposeObjectTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
      geometries.add(object.geometry);
      for (const mat of Array.isArray(object.material) ? object.material : [object.material]) materials.add(mat);
    }
    if (object instanceof THREE.InstancedMesh) object.dispose();
  });
  const collectTexture = (value: unknown): void => {
    if (value instanceof THREE.Texture) textures.add(value);
    else if (Array.isArray(value)) value.forEach(collectTexture);
  };
  for (const mat of materials) {
    Object.values(mat).forEach(collectTexture);
    if (mat instanceof THREE.ShaderMaterial) Object.values(mat.uniforms).forEach(uniform => collectTexture(uniform.value));
  }
  geometries.forEach(geometry => geometry.dispose());
  textures.forEach(texture => texture.dispose());
  materials.forEach(mat => mat.dispose());
  root.clear();
}

function buildRoad(track: Track, theme: CourseTheme, scene: THREE.Group): void {
  const transform = new THREE.Object3D();
  const colors = theme.colors;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), material(colors.ground));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.45;
  ground.receiveShadow = true;
  scene.add(ground);
  ribbon(track, scene, d => {
    const { roadHalfWidth } = widthAt(track, d);
    return [-roadHalfWidth, roadHalfWidth];
  }, colors.road, 0.06).name = 'road';
  for (const side of [-1, 1]) {
    ribbon(track, scene, d => {
      const w = widthAt(track, d);
      return [side * w.roadHalfWidth, side * w.wallHalfWidth];
    }, colors.shoulder, 0.01).name = `shoulder:${side}`;
    ribbon(track, scene, d => {
      const { wallHalfWidth } = widthAt(track, d);
      return [side * wallHalfWidth, side * (wallHalfWidth + 22)];
    }, colors.ground, 0, true).name = `ground:${side}`;
    ribbon(track, scene, d => {
      const { roadHalfWidth } = widthAt(track, d);
      return [side * (roadHalfWidth - 0.16), side * (roadHalfWidth + 0.06)];
    }, colors.line, 0.075).name = `line:${side}`;
  }
  const distances = sectionDistances(track, Math.floor(track.length / 3));
  const count = distances.length - 1;
  const curb = new THREE.InstancedMesh(new THREE.BoxGeometry(0.65, 0.16, 1), material(0xffffff), count * 2);
  const rails = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.54, 1), material(colors.rail), count * 2);
  const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 1.05, 0.22), material(colors.post), count * 2);
  const dashes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.13, 0.025, 1.8), material(colors.dash), Math.floor(count / 3));
  for (let i = 0; i < count; i++) {
    const from = distances[i]!;
    const to = distances[i + 1]!;
    const length = to - from;
    const p = sampleTrack(track, (from + to) / 2);
    const { roadHalfWidth, wallHalfWidth } = widthAt(track, p.distance);
    const startWidth = widthAt(track, from);
    const endWidth = widthAt(track, to);
    for (let s = 0; s < 2; s++) {
      const side = s * 2 - 1;
      place(track, transform, p, side * (roadHalfWidth + 0.32), 0.12);
      const roadSlope = side * (endWidth.roadHalfWidth - startWidth.roadHalfWidth) / length;
      transform.rotation.y += Math.atan(roadSlope);
      transform.scale.z = (length + (track.def.widthKeys?.length ? 0 : 0.1)) * Math.hypot(1, roadSlope);
      transform.updateMatrix();
      curb.setMatrixAt(i * 2 + s, transform.matrix);
      curb.setColorAt(i * 2 + s, new THREE.Color(i % 2 ? colors.curb[1] : colors.curb[0]));
      place(track, transform, p, side * wallHalfWidth, 0.83);
      const wallSlope = side * (endWidth.wallHalfWidth - startWidth.wallHalfWidth) / length;
      transform.rotation.y += Math.atan(wallSlope);
      transform.scale.z = (length + (track.def.widthKeys?.length ? 0 : 0.18)) * Math.hypot(1, wallSlope);
      transform.updateMatrix();
      rails.setMatrixAt(i * 2 + s, transform.matrix);
      place(track, transform, p, side * wallHalfWidth, 0.51);
      posts.setMatrixAt(i * 2 + s, transform.matrix);
    }
    if (i % 3 === 0 && i / 3 < dashes.count) {
      place(track, transform, p, 0, 0.085);
      dashes.setMatrixAt(i / 3, transform.matrix);
    }
  }
  curb.name = 'curbs';
  rails.name = 'rails';
  posts.name = 'posts';
  rails.castShadow = false;
  scene.add(curb, rails, posts, dashes);
  // Procedural checkered start line and gantry.
  const start = sampleTrack(track, 0);
  const { roadHalfWidth: startHalfWidth } = widthAt(track, 0);
  const arch = new THREE.Group();
  arch.position.set(start.x, start.y, start.z);
  arch.rotation.y = Math.atan2(start.tx, start.tz);
  const gateMaterial = material(colors.gate);
  for (const x of [-startHalfWidth - 1.1, startHalfWidth + 1.1]) {
    const post = box(0.65, 7.5, 0.65, gateMaterial);
    post.position.set(x, 3.75, 0);
    post.castShadow = true;
    arch.add(post);
  }
  const top = box(startHalfWidth * 2 + 3, 1.6, 0.65, gateMaterial);
  top.position.y = 7;
  arch.add(top);
  const banner = textPlane('POCKET CIRCUIT', 768, 80, colors.bannerBackground, colors.bannerText);
  banner.scale.set(startHalfWidth * 1.5, 1.12, 1);
  banner.position.set(0, 7.02, -0.34);
  banner.rotation.y = Math.PI;
  arch.add(banner);
  const rear = banner.clone();
  rear.position.z = 0.34;
  rear.rotation.y = 0;
  arch.add(rear);
  const line = new THREE.InstancedMesh(new THREE.BoxGeometry(startHalfWidth / 8, 0.03, 0.75), material(0xffffff), 48);
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 3; z++) {
      transform.position.set((x - 7.5) * startHalfWidth / 8, 0.09, (z - 1) * 0.75);
      transform.rotation.set(0, 0, 0);
      transform.updateMatrix();
      line.setMatrixAt(x * 3 + z, transform.matrix);
      line.setColorAt(x * 3 + z, new THREE.Color((x + z) % 2 ? colors.checker[1] : colors.checker[0]));
    }
  }
  arch.add(line);
  scene.add(arch);
  // Direction chevrons face approaching drivers at several bends.
  for (const fraction of theme.signFractions) {
    const p = sampleTrack(track, track.length * fraction);
    const sign = textPlane('› › ›', 256, 96, colors.signBackground, colors.signText);
    const offset = widthAt(track, p.distance).wallHalfWidth + 0.25;
    sign.position.set(p.x + p.nx * offset, p.y + 2.5, p.z + p.nz * offset);
    sign.scale.set(4.8, 1.8, 1);
    sign.rotation.y = Math.atan2(-p.nx, -p.nz);
    scene.add(sign);
  }
}

export function place(track: Track, object: THREE.Object3D, point: TrackSample, offset: number, lift: number): void {
  object.position.set(point.x + point.nx * offset, point.y + lift, point.z + point.nz * offset);
  const next = sampleTrack(track, point.distance + 0.5);
  object.rotation.set(-Math.atan2(next.y - point.y, 0.5), Math.atan2(point.tx, point.tz), 0, 'YXZ');
  object.scale.set(1, 1, 1);
  object.updateMatrix();
}

function textPlane(text: string, width: number, height: number, bg: string, fg: string): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.fillStyle = bg;
  context.fillRect(0, 0, width, height);
  context.fillStyle = fg;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `900 ${height * 0.7}px system-ui, sans-serif`;
  context.fillText(text, width / 2, height * 0.5, width * 0.94);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
}

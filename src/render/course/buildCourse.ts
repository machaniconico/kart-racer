import * as THREE from 'three';
import { sampleTrack } from '../../sim';
import type { Track, TrackProjection, TrackSample } from '../../sim';
import type { CourseTheme } from './CourseTheme';

export function material(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

/** Match the shoulder slope used by the ground ribbons. */
export function terrainHeight(track: Track, projection: TrackProjection): number {
  const offset = Math.abs(projection.offset);
  return offset < track.def.wallHalfWidth + 22
    ? projection.height + (-1.35 - projection.height) * ((offset - track.def.wallHalfWidth) / 22) : -1.35;
}

function ribbon(track: Track, scene: THREE.Group, inner: number, outer: number, color: number, lift = 0, slope = false,
  from = 0, to = track.length): THREE.Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  // Use a distance grid so the final segment closes at exactly the first vertex.
  const count = Math.max(1, Math.ceil(384 * (to - from) / track.length));
  for (let i = 0; i <= count; i++) {
    const p = sampleTrack(track, from + i / count * (to - from));
    for (const [j, offset] of [inner, outer].entries()) {
      positions.push(p.x + p.nx * offset, slope && j === 1 ? -1.35 : p.y + lift, p.z + p.nz * offset);
    }
    if (i < count) {
      const n = i * 2;
      indices.push(n, n + 2, n + 1, n + 1, n + 2, n + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
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
  for (const [index, zone] of track.def.surfaces.entries()) {
    // The sim accepts from > to as one zone wrapping the finish line; sampleTrack wraps distances past length.
    const to = zone.to < zone.from ? zone.to + track.length : zone.to;
    const surface = ribbon(track, group, zone.offsetMin ?? -track.def.roadHalfWidth,
      zone.offsetMax ?? track.def.roadHalfWidth, theme.colors.surfaces[zone.kind], 0.1, false, zone.from, to);
    surface.name = `surface:${zone.kind}:${index}`;
  }
  buildScenery(track, theme, group);
  return { group, sky, dispose() { disposeObjectTree(group); group.removeFromParent(); } };
}

export function buildScenery(track: Track, theme: CourseTheme, scene: THREE.Group): void {
  theme.buildProps(track, scene, theme.budget);
  theme.buildLandmarks(track, scene);
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
  ribbon(track, scene, -track.def.roadHalfWidth, track.def.roadHalfWidth, colors.road, 0.06);
  for (const side of [-1, 1]) {
    ribbon(track, scene, side * track.def.roadHalfWidth, side * track.def.wallHalfWidth, colors.shoulder, 0.01);
    ribbon(track, scene, side * track.def.wallHalfWidth, side * (track.def.wallHalfWidth + 22), colors.ground, 0, true);
    ribbon(track, scene, side * (track.def.roadHalfWidth - 0.16), side * (track.def.roadHalfWidth + 0.06), colors.line, 0.075);
  }
  const count = Math.floor(track.length / 3);
  const curb = new THREE.InstancedMesh(new THREE.BoxGeometry(0.65, 0.16, track.length / count + 0.1), material(0xffffff), count * 2);
  const rails = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.54, track.length / count + 0.18), material(colors.rail), count * 2);
  const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 1.05, 0.22), material(colors.post), count * 2);
  const dashes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.13, 0.025, 1.8), material(colors.dash), Math.floor(count / 3));
  for (let i = 0; i < count; i++) {
    const p = sampleTrack(track, (i + 0.5) / count * track.length);
    for (let s = 0; s < 2; s++) {
      const side = s * 2 - 1;
      place(track, transform, p, side * (track.def.roadHalfWidth + 0.32), 0.12);
      curb.setMatrixAt(i * 2 + s, transform.matrix);
      curb.setColorAt(i * 2 + s, new THREE.Color(i % 2 ? colors.curb[1] : colors.curb[0]));
      place(track, transform, p, side * track.def.wallHalfWidth, 0.83);
      rails.setMatrixAt(i * 2 + s, transform.matrix);
      place(track, transform, p, side * track.def.wallHalfWidth, 0.51);
      posts.setMatrixAt(i * 2 + s, transform.matrix);
    }
    if (i % 3 === 0 && i / 3 < dashes.count) {
      place(track, transform, p, 0, 0.085);
      dashes.setMatrixAt(i / 3, transform.matrix);
    }
  }
  rails.castShadow = false;
  scene.add(curb, rails, posts, dashes);
  // Procedural checkered start line and gantry.
  const start = sampleTrack(track, 0);
  const arch = new THREE.Group();
  arch.position.set(start.x, start.y, start.z);
  arch.rotation.y = Math.atan2(start.tx, start.tz);
  const gateMaterial = material(colors.gate);
  for (const x of [-track.def.roadHalfWidth - 1.1, track.def.roadHalfWidth + 1.1]) {
    const post = box(0.65, 7.5, 0.65, gateMaterial);
    post.position.set(x, 3.75, 0);
    post.castShadow = true;
    arch.add(post);
  }
  const top = box(track.def.roadHalfWidth * 2 + 3, 1.6, 0.65, gateMaterial);
  top.position.y = 7;
  arch.add(top);
  const banner = textPlane('POCKET CIRCUIT', 768, 80, colors.bannerBackground, colors.bannerText);
  banner.scale.set(track.def.roadHalfWidth * 1.5, 1.12, 1);
  banner.position.set(0, 7.02, -0.34);
  banner.rotation.y = Math.PI;
  arch.add(banner);
  const rear = banner.clone();
  rear.position.z = 0.34;
  rear.rotation.y = 0;
  arch.add(rear);
  const line = new THREE.InstancedMesh(new THREE.BoxGeometry(track.def.roadHalfWidth / 8, 0.03, 0.75), material(0xffffff), 48);
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 3; z++) {
      transform.position.set((x - 7.5) * track.def.roadHalfWidth / 8, 0.09, (z - 1) * 0.75);
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
    sign.position.set(p.x + p.nx * (track.def.wallHalfWidth + 0.25), p.y + 2.5, p.z + p.nz * (track.def.wallHalfWidth + 0.25));
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

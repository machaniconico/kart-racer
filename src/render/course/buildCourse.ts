import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rollAt, sampleTrack, surfaceHeightAt, wrapDistance } from '../../sim';
import type { Barrier, SurfaceZone, Track, TrackProjection, TrackSample } from '../../sim';
import { widthAt } from '../../sim/corridor';
import type { CourseTheme as BaseCourseTheme } from './CourseTheme';
import { buildMotion } from './motion';

// Keep compatibility with callers of the original theme contract.
export interface CourseTheme extends BaseCourseTheme {
  readonly colors: BaseCourseTheme['colors'] & {
    readonly surfaces: Readonly<Partial<Record<SurfaceZone['kind'], number>>>;
    readonly barrier?: number;
    readonly motionBarrier?: number;
    readonly motionSpin?: number;
  };
}

const surfaceFallback = { dirt: 0x99683f, pit: 0x302724 };
type RibbonOffsets = (distance: number) => readonly [number, number];
type Span = { readonly from: number; readonly to: number };

/** Preserve the original arithmetic, including signed zero, on unbanked courses. */
function pointHeight(track: Track, point: TrackSample, offset: number): number {
  return rollAt(track, point.distance) === 0 ? point.y : surfaceHeightAt(track, point.distance, offset);
}

function withinSpan(track: Track, distance: number, span: Span): boolean {
  const d = wrapDistance(track, distance);
  return span.from <= span.to ? d >= span.from && d < span.to : d >= span.from || d < span.to;
}

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
  if (track.def.decks?.some(deck => withinSpan(track, projection.distance, deck))) return -1.35;
  const height = rollAt(track, projection.distance) === 0 ? projection.height
    : surfaceHeightAt(track, projection.distance, Math.sign(projection.offset) * wallHalfWidth);
  return offset < wallHalfWidth + 22
    ? height + (-1.35 - height) * ((offset - wallHalfWidth) / 22) : -1.35;
}

type GroundPoint = readonly [x: number, y: number, z: number];
const DECK_GROUND_MARGIN = 0.6;

/** Project the slab, with a small lateral clearance, onto the ground. */
function deckFootprints(track: Track): GroundPoint[][] {
  const footprints: GroundPoint[][] = [];
  for (const span of track.def.decks ?? []) {
    const to = span.to < span.from ? span.to + track.length : span.to;
    const distances = sectionDistances(track, Math.max(1, Math.ceil(384 * (to - span.from) / track.length)),
      span.from, to, track.samples.map(point => point.distance));
    const edges = distances.map(d => {
      const p = sampleTrack(track, d), half = widthAt(track, d).wallHalfWidth + DECK_GROUND_MARGIN;
      return [-half, half].map((offset): GroundPoint => [p.x + p.nx * offset, 0, p.z + p.nz * offset]);
    });
    for (let i = 1; i < edges.length; i++) {
      footprints.push([edges[i - 1][0], edges[i][0], edges[i][1], edges[i - 1][1]]);
    }
  }
  return footprints;
}

/** Subtract a convex XZ footprint, interpolating Y to retain the original bank slope. */
function subtractFootprint(polygon: GroundPoint[], footprint: GroundPoint[]): GroundPoint[][] {
  const area = footprint.reduce((sum, a, i) => {
    const b = footprint[(i + 1) % footprint.length];
    return sum + a[0] * b[2] - b[0] * a[2];
  }, 0);
  const sides = footprint.map((a, i) => {
    const b = footprint[(i + 1) % footprint.length];
    return (p: GroundPoint): number => Math.sign(area)
      * ((b[0] - a[0]) * (p[2] - a[2]) - (b[2] - a[2]) * (p[0] - a[0]));
  });
  if (Math.abs(area) < 1e-10 || sides.some(side => polygon.every(p => side(p) <= 1e-9))) return [polygon];
  const kept: GroundPoint[][] = [];
  let remaining = polygon;
  for (const side of sides) {
    const inside: GroundPoint[] = [], outside: GroundPoint[] = [];
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i], b = remaining[(i + 1) % remaining.length];
      const da = side(a), db = side(b);
      if (da >= 0) inside.push(a);
      if (da <= 0) outside.push(a);
      if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
        const t = da / (da - db);
        const point: GroundPoint = [a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        inside.push(point);
        outside.push(point);
      }
    }
    if (outside.length >= 3) kept.push(outside);
    remaining = inside;
    if (remaining.length < 3) break;
  }
  return kept;
}

function ribbonGeometry(track: Track, offsets: RibbonOffsets, lift = 0, slope = false,
  from = 0, to = track.length, boundaries: readonly number[] = [],
  cutouts: readonly SurfaceZone[] = [], omitted: readonly Span[] = []): THREE.BufferGeometry {
  let positions: number[] = [];
  let indices: number[] = [];
  const footprints = slope && omitted.length ? deckFootprints(track) : [];
  const count = Math.max(1, Math.ceil(384 * (to - from) / track.length));
  // A variable-width edge must also follow the sampled centerline's corners;
  // otherwise a straight chord between width keys cuts inside curved sections.
  const distances = sectionDistances(track, count, from, to,
    [...boundaries, ...omitted.flatMap(span => [span.from, span.to]),
      ...track.def.surfaces.flatMap(zone => [zone.from, zone.to]),
      ...(track.def.widthKeys?.length ? track.samples.map(point => point.distance) : [])]);
  for (const distance of distances) {
    const p = sampleTrack(track, distance);
    for (const [j, offset] of offsets(distance).entries()) {
      positions.push(p.x + p.nx * offset, slope && j === 1 ? -1.35 : pointHeight(track, p, offset) + lift,
        p.z + p.nz * offset);
    }
  }
  // Keep the road beside a lane-sized pit, leaving the lowered decal visible.
  for (let i = 0; i < distances.length - 1; i++) {
    const a = distances[i], b = distances[i + 1];
    const middle = (a + b) / 2 % track.length;
    const onDeck = omitted.some(span => withinSpan(track, middle, span));
    if (onDeck && !slope) continue;
    if (footprints.length) {
      const n = i * 2;
      let groundHeight = -1.35;
      if (onDeck) {
        const ceiling = sampleTrack(track, middle).y - 0.6;
        // The 22 m halo sets terrain height only; it does not widen the cutout.
        groundHeight = Math.min(groundHeight, ...[n, n + 1, n + 2, n + 3].map(index =>
          roadHeightAtXZ(track, positions[index * 3], positions[index * 3 + 2], false, 22, ceiling) ?? -1.35));
      }
      for (const triangle of [[n, n + 2, n + 1], [n + 1, n + 2, n + 3]]) {
        // A suspended slab has flat terrain beside it, not a bank hanging over
        // the lower lane. Lower that terrain with any sunken crossing as well.
        let polygons = [triangle.map((index): GroundPoint => [positions[index * 3],
          onDeck ? groundHeight : positions[index * 3 + 1], positions[index * 3 + 2]])];
        for (const footprint of footprints) polygons = polygons.flatMap(polygon => subtractFootprint(polygon, footprint));
        for (const polygon of polygons) {
          const start = positions.length / 3;
          polygon.forEach(point => positions.push(...point));
          for (let j = 1; j < polygon.length - 1; j++) {
            const [a, b, c] = [polygon[0], polygon[j], polygon[j + 1]];
            // Adjacent footprints can leave a shared edge with zero area.
            if (Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) > 1e-8) {
              indices.push(start, start + j, start + j + 1);
            }
          }
        }
      }
      continue;
    }
    const holes = cutouts.filter(zone => zone.from <= zone.to
      ? middle >= zone.from && middle < zone.to : middle >= zone.from || middle < zone.to);
    if (!holes.length) {
      const n = i * 2;
      indices.push(n, n + 2, n + 1, n + 1, n + 2, n + 3);
      continue;
    }
    let bands: [number, number][] = [[-Infinity, Infinity]];
    for (const hole of holes) {
      const left = hole.offsetMin ?? -Infinity, right = hole.offsetMax ?? Infinity;
      bands = bands.flatMap(([lo, hi]): [number, number][] => {
        if (right <= lo || left >= hi) return [[lo, hi]];
        const remaining: [number, number][] = [];
        if (left > lo) remaining.push([lo, left]);
        if (right < hi) remaining.push([right, hi]);
        return remaining;
      });
    }
    for (const [lo, hi] of bands) {
      const n = positions.length / 3;
      for (const d of [a, b]) {
        const p = sampleTrack(track, d);
        const [left, right] = offsets(d);
        for (const offset of [Math.max(left, Math.min(right, lo)), Math.max(left, Math.min(right, hi))]) {
          positions.push(p.x + p.nx * offset, pointHeight(track, p, offset) + lift, p.z + p.nz * offset);
        }
      }
      indices.push(n, n + 2, n + 1, n + 1, n + 2, n + 3);
    }
  }
  if (omitted.length) {
    // Compact away the original vertices replaced by clipped bank polygons.
    const compact: number[] = [];
    const remap = new Map<number, number>();
    indices = indices.map(index => {
      if (!remap.has(index)) {
        remap.set(index, compact.length / 3);
        compact.push(...positions.slice(index * 3, index * 3 + 3));
      }
      return remap.get(index)!;
    });
    positions = compact;
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
  for (const distance of [...(track.def.widthKeys ?? []).map(key => key.distance),
    ...(track.def.bankKeys ?? []).map(key => key.distance), ...boundaries]) {
    for (let lap = Math.floor(from / track.length); lap <= Math.floor(to / track.length); lap++) {
      const d = distance + lap * track.length;
      if (d > from && d < to) distances.add(d);
    }
  }
  return [...distances].sort((a, b) => a - b);
}

function ribbon(track: Track, scene: THREE.Group, offsets: RibbonOffsets, color: number, lift = 0, slope = false,
  cutouts: readonly SurfaceZone[] = [], omitted: readonly Span[] = []): THREE.Mesh {
  const geo = ribbonGeometry(track, offsets, lift, slope, 0, track.length, [], cutouts, omitted);
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
  update(time: number): void;
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
  const surfaces = new Map<Exclude<SurfaceZone['kind'], 'spin'>, THREE.BufferGeometry[]>();
  for (const zone of track.def.surfaces) {
    if (zone.kind === 'spin') continue;
    // Sampling beyond length also handles a single zone crossing the finish line.
    const to = zone.to < zone.from ? zone.to + track.length : zone.to;
    const geometry = ribbonGeometry(track, d => {
      const { roadHalfWidth } = widthAt(track, d);
      return [zone.offsetMin ?? -roadHalfWidth, zone.offsetMax ?? roadHalfWidth];
    }, zone.kind === 'pit' ? 0.06 - 0.3 : 0.1, false, zone.from, to);
    const parts = surfaces.get(zone.kind) ?? [];
    parts.push(geometry);
    surfaces.set(zone.kind, parts);
  }
  for (const [kind, parts] of surfaces) {
    const geometry = mergeGeometries(parts)!;
    parts.forEach(part => part.dispose());
    const color = kind === 'dirt' || kind === 'pit'
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
  buildIslands(track, theme, group);
  buildScenery(track, theme, group);
  const motion = buildMotion(track, theme, group);
  return {
    group, sky,
    update(time) { motion.update(time); },
    dispose() { motion.dispose(); disposeObjectTree(group); group.removeFromParent(); },
  };
}

export function buildScenery(track: Track, theme: CourseTheme, scene: THREE.Group): void {
  const existing = new Set(scene.children);
  theme.buildProps(track, scene, theme.budget);
  theme.buildLandmarks(track, scene);
  if (!track.def.decks?.length) return;
  // Themes keep their original random sequence. Compact only the newly built
  // scenery, keeping instance colors paired with their surviving transforms.
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const position = new THREE.Vector3();
  scene.updateMatrixWorld(true);
  for (const child of scene.children) {
    if (existing.has(child)) continue;
    child.traverse(object => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      let kept = 0;
      for (let i = 0; i < object.count; i++) {
        object.getMatrixAt(i, matrix);
        position.setFromMatrixPosition(matrix).applyMatrix4(object.matrixWorld);
        // Include the removed 22 m embankment beside the upper road: scenery
        // there must not hang over the lower road either.
        const upper = roadHeightAtXZ(track, position.x, position.z, true, 22);
        const lower = upper === undefined ? undefined : roadHeightAtXZ(track, position.x, position.z, false, 0, upper - 0.6);
        if (upper !== undefined && lower !== undefined && lower < upper - 0.6) continue;
        object.setMatrixAt(kept, matrix);
        if (object.instanceColor) {
          object.getColorAt(i, color);
          object.setColorAt(kept, color);
        }
        kept++;
      }
      object.count = kept;
      object.instanceMatrix.needsUpdate = true;
      if (object.instanceColor) object.instanceColor.needsUpdate = true;
    });
  }
}

/** Examine both crossing branches instead of the single nearest XZ projection. */
function roadHeightAtXZ(track: Track, x: number, z: number, deck: boolean, margin = 0,
  ceiling = Infinity): number | undefined {
  let height: number | undefined;
  let nearestSquared = Infinity;
  for (let i = 0; i < track.samples.length; i++) {
    const a = track.samples[i], b = track.samples[(i + 1) % track.samples.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared === 0) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared));
    const d = a.distance + t * ((i + 1 === track.samples.length ? track.length : b.distance) - a.distance);
    if (Boolean(track.def.decks?.some(span => withinSpan(track, d, span))) !== deck) continue;
    const half = widthAt(track, d).wallHalfWidth + margin;
    const squared = (x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2;
    if (squared > half * half + 1e-8 || squared >= nearestSquared) continue;
    const point = sampleTrack(track, d);
    const offset = (x - point.x) * point.nx + (z - point.z) * point.nz;
    const y = pointHeight(track, point, offset);
    if (y >= ceiling) continue;
    nearestSquared = squared;
    height = y;
  }
  return height;
}

function buildDecks(track: Track, theme: CourseTheme, scene: THREE.Group): void {
  if (!track.def.decks?.length) return;
  const positions: number[] = [];
  const indices: number[] = [];
  const supports: { x: number; z: number; bottom: number; top: number }[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]): void => {
    const n = positions.length / 3;
    positions.push(...a, ...b, ...c, ...d);
    indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
  };
  for (const span of track.def.decks) {
    const to = span.to < span.from ? span.to + track.length : span.to;
    const count = Math.max(1, Math.ceil((to - span.from) / 20));
    const supportDistances = Array.from({ length: count + 1 }, (_, i) => span.from + i / count * (to - span.from));
    // The outer row can be longer than the centerline on a bend or width taper.
    for (let i = 1; i < supportDistances.length; i++) {
      const a = sampleTrack(track, supportDistances[i - 1]), b = sampleTrack(track, supportDistances[i]);
      const wa = widthAt(track, a.distance).wallHalfWidth - 0.6;
      const wb = widthAt(track, b.distance).wallHalfWidth - 0.6;
      if ([-1, 1].some(side => Math.hypot(b.x + b.nx * side * wb - a.x - a.nx * side * wa,
        b.z + b.nz * side * wb - a.z - a.nz * side * wa) > 20 + 1e-9)) {
        supportDistances.splice(i, 0, (supportDistances[i - 1] + supportDistances[i]) / 2);
        i--;
      }
    }
    const distances = sectionDistances(track, Math.max(1, Math.ceil(384 * (to - span.from) / track.length)),
      span.from, to, [...track.samples.map(point => point.distance), ...supportDistances]);
    const sections = distances.map(d => {
      const point = sampleTrack(track, d);
      const half = widthAt(track, d).wallHalfWidth;
      const top = [-half, half].map(offset => [point.x + point.nx * offset,
        pointHeight(track, point, offset) + 0.06, point.z + point.nz * offset]);
      return [...top, ...top.map(([x, y, z]) => [x, y - 0.6, z])];
    });
    for (let i = 0; i < sections.length - 1; i++) {
      const a = sections[i], b = sections[i + 1];
      quad(a[0], b[0], b[1], a[1]); // Top.
      quad(a[2], a[3], b[3], b[2]); // Underside.
      quad(a[0], a[2], b[2], b[0]);
      quad(a[1], b[1], b[3], a[3]);
    }
    const first = sections[0], last = sections[sections.length - 1];
    quad(first[0], first[1], first[3], first[2]);
    quad(last[0], last[2], last[3], last[1]);
    for (const d of supportDistances) {
      const point = sampleTrack(track, d);
      for (const side of [-1, 1]) {
        const offset = side * (widthAt(track, d).wallHalfWidth - 0.6);
        const x = point.x + point.nx * offset, z = point.z + point.nz * offset;
        const top = pointHeight(track, point, offset) + 0.06 - 0.6;
        // Decorative supports must not pass through a drivable lower branch.
        // Include the cylinder radius so even its outer face clears the lane.
        if (roadHeightAtXZ(track, x, z, false, 0.45, top) !== undefined) continue;
        const bottom = -1.35;
        if (top > bottom) supports.push({ x, z, bottom, top });
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const deck = new THREE.Mesh(geometry, material(theme.colors.deck ?? theme.colors.road));
  deck.name = 'decks';
  deck.castShadow = true;
  deck.receiveShadow = true;
  const pillars = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.45, 0.45, 1, 8),
    material(theme.colors.pillar ?? theme.colors.post), supports.length);
  const transform = new THREE.Object3D();
  supports.forEach(({ x, z, bottom, top }, i) => {
    transform.position.set(x, (bottom + top) / 2, z);
    transform.scale.set(1, top - bottom, 1);
    transform.updateMatrix();
    pillars.setMatrixAt(i, transform.matrix);
  });
  pillars.name = 'deck-pillars';
  pillars.castShadow = true;
  pillars.receiveShadow = true;
  scene.add(deck, pillars);
}

function buildBarriers(track: Track, theme: CourseTheme, group: THREE.Group): void {
  const batches = new Map<NonNullable<Barrier['scenery']>, Barrier[]>();
  for (const barrier of track.def.barriers ?? []) {
    if (barrier.motion) continue;
    const scenery = barrier.scenery ?? 'block';
    if (scenery === 'rock' || scenery === 'building') continue;
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
          pointHeight(track, point, offset) + 0.06 + (vertices.getY(i) + 0.5) * height - origin.y,
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

function buildIslands(track: Track, theme: CourseTheme, group: THREE.Group): void {
  for (const [index, split] of (track.def.splits ?? []).entries()) {
    const point = sampleTrack(track, split.from - 30);
    const wall = widthAt(track, split.from - 30).wallHalfWidth;
    const lanes = [...split.lanes].sort((a, b) => a.offsetMin - b.offsetMin);
    for (const [side, lane] of lanes.entries()) {
      const tag = lane.risk ? 'SHORT' : 'SAFE';
      const sign = textPlane(split.name ? `${split.name} ${tag}` : tag, 512, 128,
        theme.colors.signBackground, theme.colors.signText);
      const offset = (side === 0 ? -1 : 1) * (wall + 0.25);
      sign.name = `lane-sign:${index}:${side}`;
      sign.position.set(point.x + point.nx * offset, pointHeight(track, point, offset) + 3, point.z + point.nz * offset);
      sign.rotation.y = Math.atan2(-point.tx, -point.tz);
      sign.scale.set(4.8, 1.2, 1);
      group.add(sign);
    }
  }
  const islands = (track.def.barriers ?? []).filter(b => !b.motion && (b.scenery === 'rock' || b.scenery === 'building'));
  if (!islands.length) return;
  const spanOf = (b: Barrier) => (b.to - b.from + track.length) % track.length;
  const halfAt = (b: Barrier, along: number) => b.halfWidth * Math.min(1,
    along / (b.taper ?? 4), (spanOf(b) - along) / (b.taper ?? 4));
  const parts = islands.map(b => {
    const span = spanOf(b), taper = Math.min(b.taper ?? 4, span / 2);
    return ribbonGeometry(track, d => {
      const half = halfAt(b, d - b.from);
      return [b.center - half, b.center + half];
    }, 0.06 + 0.15, false, b.from, b.from + span, [b.from + taper, b.from + span - taper]);
  });
  const geometry = mergeGeometries(parts)!;
  parts.forEach(part => part.dispose());
  const ground = material(theme.colors.ground);
  ground.side = THREE.DoubleSide;
  const island = new THREE.Mesh(geometry, ground);
  island.name = 'islands';
  island.receiveShadow = true;
  group.add(island);

  for (const scenery of ['rock', 'building'] as const) {
    const bodies = islands.filter(b => b.scenery === scenery);
    if (!bodies.length) continue;
    const counts = bodies.map(b => Math.max(1, Math.floor(spanOf(b) / 6)));
    const shape = scenery === 'rock' ? new THREE.DodecahedronGeometry(1, 0) : new THREE.BoxGeometry(1, 1, 1);
    shape.computeBoundingBox();
    const size = shape.boundingBox!.getSize(new THREE.Vector3());
    shape.scale(1 / size.x, 1 / size.y, 1 / size.z);
    const props = new THREE.InstancedMesh(shape, material(theme.colors.barrier ?? theme.colors.post),
      counts.reduce((sum, count) => sum + count, 0));
    const transform = new THREE.Object3D();
    let index = 0;
    bodies.forEach((b, bodyIndex) => {
      const span = spanOf(b), count = counts[bodyIndex];
      for (let i = 0; i < count; i++) {
        const along = (span - (count - 1) * 6) / 2 + i * 6;
        const point = sampleTrack(track, b.from + along);
        const height = scenery === 'rock' ? 4 - i % 3 : 4 + i % 5;
        const width = Math.min(scenery === 'rock' ? height : 4, 2 * halfAt(b, along));
        transform.position.set(point.x + point.nx * b.center, pointHeight(track, point, b.center) + 0.21 + height / 2,
          point.z + point.nz * b.center);
        transform.rotation.set(0, Math.atan2(point.tx, point.tz), 0);
        transform.scale.set(width, height, scenery === 'rock' ? height : 4);
        transform.updateMatrix();
        props.setMatrixAt(index++, transform.matrix);
      }
    });
    props.name = `island-scenery:${scenery}`;
    props.receiveShadow = true;
    // InstancedMesh has one shadow flag: the building batch includes heights > 4 m.
    props.castShadow = scenery === 'rock';
    group.add(props);
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
  }, colors.road, 0.06, false, track.def.surfaces.filter(zone => zone.kind === 'pit'), track.def.decks).name = 'road';
  for (const side of [-1, 1]) {
    ribbon(track, scene, d => {
      const w = widthAt(track, d);
      return [side * w.roadHalfWidth, side * w.wallHalfWidth];
    }, colors.shoulder, 0.01, false, [], track.def.decks).name = `shoulder:${side}`;
    ribbon(track, scene, d => {
      const { wallHalfWidth } = widthAt(track, d);
      return [side * wallHalfWidth, side * (wallHalfWidth + 22)];
    }, colors.ground, 0, true, [], track.def.decks).name = `ground:${side}`;
    ribbon(track, scene, d => {
      const { roadHalfWidth } = widthAt(track, d);
      return [side * (roadHalfWidth - 0.16), side * (roadHalfWidth + 0.06)];
    }, colors.line, 0.075).name = `line:${side}`;
  }
  buildDecks(track, theme, scene);
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
  arch.position.set(start.x, pointHeight(track, start, 0), start.z);
  arch.rotation.order = 'YXZ';
  arch.rotation.y = Math.atan2(start.tx, start.tz);
  // Keep local XZ widths unchanged while shearing the gantry and checker heights.
  const gateMaterial = material(colors.gate);
  for (const x of [-startHalfWidth - 1.1, startHalfWidth + 1.1]) {
    const post = box(0.65, 7.5, 0.65, gateMaterial);
    post.position.set(x, 3.75 + (pointHeight(track, start, x) - start.y), 0);
    post.castShadow = true;
    arch.add(post);
  }
  const top = box(startHalfWidth * 2 + 3, 1.6, 0.65, gateMaterial);
  top.position.y = 7;
  top.rotation.z = rollAt(track, 0);
  arch.add(top);
  const banner = textPlane('POCKET CIRCUIT', 768, 80, colors.bannerBackground, colors.bannerText);
  banner.scale.set(startHalfWidth * 1.5, 1.12, 1);
  banner.position.set(0, 7.02, -0.34);
  banner.rotation.y = Math.PI;
  banner.rotation.z = rollAt(track, 0);
  arch.add(banner);
  const rear = banner.clone();
  rear.position.z = 0.34;
  rear.rotation.y = 0;
  arch.add(rear);
  const line = new THREE.InstancedMesh(new THREE.BoxGeometry(startHalfWidth / 8, 0.03, 0.75), material(0xffffff), 48);
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 3; z++) {
      const offset = (x - 7.5) * startHalfWidth / 8;
      transform.position.set(offset, 0.09 + (pointHeight(track, start, offset) - start.y), (z - 1) * 0.75);
      transform.rotation.set(0, 0, rollAt(track, 0));
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
    sign.position.set(p.x + p.nx * offset, pointHeight(track, p, offset) + 2.5, p.z + p.nz * offset);
    sign.scale.set(4.8, 1.8, 1);
    sign.rotation.y = Math.atan2(-p.nx, -p.nz);
    scene.add(sign);
  }
}

export function place(track: Track, object: THREE.Object3D, point: TrackSample, offset: number, lift: number): void {
  object.position.set(point.x + point.nx * offset, pointHeight(track, point, offset) + lift, point.z + point.nz * offset);
  const next = sampleTrack(track, point.distance + 0.5);
  object.rotation.set(-Math.atan2(pointHeight(track, next, offset) - pointHeight(track, point, offset), 0.5),
    Math.atan2(point.tx, point.tz), rollAt(track, point.distance), 'YXZ');
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

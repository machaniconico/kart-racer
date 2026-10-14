import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WebGLGeometries } from 'three/src/renderers/webgl/WebGLGeometries.js';
import { WebGLInfo } from 'three/src/renderers/webgl/WebGLInfo.js';
import { buildTrack, getTrack, projectToTrack, rollAt, sampleTrack, surfaceHeightAt } from '../../sim';
import type { Barrier, RaceState, SurfaceZone, Track, TrackId } from '../../sim';
import * as trackRegistry from '../../sim/tracks';
import { islandSplit } from '../../sim/tracks/features';
import { LEGACY_MEADOW } from '../../sim/tracks/legacyMeadow.fixture';
import { GameUI } from '../../ui/GameUI';
import { barrierCenterAt, barrierHalfWidthAt, exclusionAt, KART_RADIUS, widthAt } from '../../sim/corridor';
import { bankCourse, figureEightCourse, figureEightCrossings, stadiumSections } from '../../sim/elevation.fixture';
import { kartRotationZ, rolledLocalPointY } from '../kartRoll';
import { GameRenderer } from '../GameRenderer';
import { buildCourse, place, terrainHeight, type Course } from './buildCourse';
import { buildMotion } from './motion';
import { meadow } from './themes/meadow';
import { canyon } from './themes/canyon';
import { snowpeak } from './themes/snowpeak';
import { neon } from './themes/neon';
import { harbor } from './themes/harbor';
import { forest } from './themes/forest';
import { volcano } from './themes/volcano';
import { skyline } from './themes/skyline';

// M2.5 re-measured by e2e/courses.spec.ts, 2026-10-11: Chromium, 1280x720, DPR 1,
// desktop shadows, createRace(127, { trackId }), 8 stationary grid karts.
// GameRenderer.update(state, captureRenderSnapshot(state), 1, 0, 'race')
// rendered 10 times per course; EVERY frame had the calls/triangles below
// (renderer.info.render, including shadows). Meshes count buildCourse only.
// M1-04 -> M2.5 (drawCalls / triangles / meshes):
// meadow 123 / 41_530 / 29 -> 123 / 41_530 / 29 (layout 2).
// canyon 128 / 46_784 / 33 -> 129 / 54_564 / 40 (layout 4).
// snowpeak 125 / 41_810 / 33 -> 125 / 41_952 / 31 (layout 2).
// neon 125 / 66_080 / 30 -> 125 / 62_748 / 30 (layout 2).
// M4-05, same Chromium setup and all 10 frames: snowpeak layout 2 -> 3,
// 125 / 41_952 / 31 -> 125 / 42_296 / 31 (bank boundaries add ribbon triangles).
// M5-05 / v15: same seed-127 Chromium setup after all four layouts and shared followups.
// Grid budgets include shadows; meshes include moving bands and spin discs.
// Approach draw budgets are exercised alongside the grid in e2e/courses.spec.ts.
// M6-09, Chromium headless on darwin, 1280x720 DPR 1, seed 127, all 10 grid frames:
// canyon 138 / 124_808 / 42 -> 139 / 124_630 / 43; pit rim paint adds one mesh,
// pit clipping removes degenerate road triangles, clips edge vertices and wall instances;
// island clearance removes a rock.
// neon 134 / 115_360 / 38 -> 134 / 115_336 / 38; two tapered building instances removed.
// meadow 125 / 107_048 / 34 and snowpeak 129 / 112_768 / 36 are unchanged.
type RenderBaseline = { drawCalls: number; triangles: number; meshes: number };
// M6-05 / v16: Chromium on darwin-arm64, 1280×720, DPR 1, seed 127, 10 stationary frames.
// All ten grid frames matched; all feature views also passed the length-based trianglesCap.
const RENDER_BASELINE: Record<TrackId, RenderBaseline> = {
  meadow: { drawCalls: 125, triangles: 107_048, meshes: 34 },
  canyon: { drawCalls: 139, triangles: 124_630, meshes: 43 },
  snowpeak: { drawCalls: 129, triangles: 112_768, meshes: 36 },
  neon: { drawCalls: 134, triangles: 115_336, meshes: 38 },
  harbor: { drawCalls: 129, triangles: 110_460, meshes: 47 },
  forest: { drawCalls: 134, triangles: 133_980, meshes: 38 },
  volcano: { drawCalls: 132, triangles: 100_648, meshes: 37 },
  skyline: { drawCalls: 136, triangles: 90_174, meshes: 40 },
};

// Only the browser's text drawing context is supplied. All three objects and
// their dispose events are real; these tests run in Vitest's node environment.
const drawText = vi.fn();
beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({
      fillRect() {}, fillText: drawText,
    }) }),
  });
});
afterAll(() => vi.unstubAllGlobals());

const courses: Course[] = [];
function build(...args: Parameters<typeof buildCourse>): Course {
  const course = buildCourse(...args);
  courses.push(course);
  return course;
}
afterEach(() => { courses.splice(0).forEach(course => course.dispose()); });

function islandTrack(scenery: 'rock' | 'building' = 'rock'): Track {
  return buildTrack({ ...LEGACY_MEADOW, scale: 1, controlPoints: [
    [0, 0, 0], [100, 0, 0], [200, 0, 0], [300, 0, 0], [400, 0, 0],
    [400, 0, 200], [0, 0, 200], [-100, 0, 200], [-100, 0, 0],
  ], ...islandSplit({ from: 100.37, to: 180.83, islandHalf: 6, laneWidth: 9, taper: 12,
    scenery, risky: 'inner', bend: 1 }), surfaces: [
    { kind: 'ice', from: 40, to: 50 }, { kind: 'ice', from: 70, to: 80 },
    { kind: 'dirt', from: 115, to: 130, offsetMin: 7, offsetMax: 15 },
    { kind: 'pit', from: 145, to: 155, offsetMin: 7, offsetMax: 15 },
  ] });
}

function meshCount(group: THREE.Group): number {
  let count = 0;
  group.traverse(object => { if (object instanceof THREE.Mesh) count++; });
  return count;
}

function hash(array: Float32Array): number {
  // Ignore signed zero and sub-pixel trigonometric differences across JS engines.
  const rounded = Int32Array.from(array, value => Math.round(value * 10000));
  let result = 0x811c9dc5;
  for (const byte of new Uint8Array(rounded.buffer)) {
    result = Math.imul(result ^ byte, 0x01000193);
  }
  return result >>> 0;
}

describe('banked roads and elevated decks', () => {
  it('preserves the no-deck synthetic fixture geometry and scenery buffers', () => {
    const track = buildTrack({ ...LEGACY_MEADOW, ...figureEightCourse(), decks: undefined });
    const buffers: number[] = [];
    build(track, meadow).group.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const name of ['position', 'normal', 'uv']) {
        const attribute = object.geometry.getAttribute(name);
        if (attribute) buffers.push(attribute.count, hash(Float32Array.from(attribute.array)));
      }
      const index = object.geometry.getIndex();
      if (index) buffers.push(index.count, hash(Float32Array.from(index.array)));
      if (object instanceof THREE.InstancedMesh) {
        buffers.push(object.count, hash(object.instanceMatrix.array as Float32Array));
        if (object.instanceColor) buffers.push(hash(object.instanceColor.array as Float32Array));
      }
    });
    const signature = buffers.reduce((value, entry) => Math.imul(value ^ entry, 0x01000193) >>> 0, 0x811c9dc5);
    // Measured before M5-09: includes ribbon indices/normals and all scenery instances.
    expect(signature).toBe(3519052737);
  });

  it('returns a camera position copy without constructing a WebGL renderer', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1, 2, 3);
    const read = () => Reflect.apply(GameRenderer.prototype.getCameraPosition, { camera }, []);
    const position = read();
    expect(position).toEqual({ x: 1, y: 2, z: 3 });
    position.y = 100;
    expect(read()).toEqual({ x: 1, y: 2, z: 3 });
  });

  it.each(['meadow', 'canyon', 'snowpeak', 'neon'] as const)('%s keeps exact vertex and instance buffers with zero bank', id => {
    // Public courses may be banked; compare absent keys with explicit zero-roll keys.
    const original = buildTrack({ ...getTrack(id).def, bankKeys: undefined });
    const themes = { meadow, canyon, snowpeak, neon };
    const zeroBank = buildTrack({ ...original.def, bankKeys: [
      { distance: 0, roll: 0 }, { distance: original.length, roll: 0 },
    ] });
    const meshes = (course: Course): THREE.Mesh[] => {
      const result: THREE.Mesh[] = [];
      course.group.traverse(object => { if (object instanceof THREE.Mesh) result.push(object); });
      return result;
    };
    const before = meshes(build(original, themes[id]));
    const after = meshes(build(zeroBank, themes[id]));
    const buffers: number[] = [];
    for (const mesh of before) {
      for (const name of ['position', 'normal', 'uv']) {
        const attribute = mesh.geometry.getAttribute(name);
        if (attribute) buffers.push(attribute.count, hash(Float32Array.from(attribute.array)));
      }
      const index = mesh.geometry.getIndex();
      if (index) buffers.push(index.count, hash(Float32Array.from(index.array)));
      if (mesh instanceof THREE.InstancedMesh) {
        buffers.push(mesh.count, hash(mesh.instanceMatrix.array as Float32Array));
        if (mesh.instanceColor) buffers.push(hash(mesh.instanceColor.array as Float32Array));
      }
    }
    const signature = buffers.reduce((value, entry) => Math.imul(value ^ entry, 0x01000193) >>> 0, 0x811c9dc5);
    // M6-09 strict buffers, absent bankKeys, rounded to 0.0001 m before hashing:
    // canyon 1753623716 -> 623313950: rim paint follows lip Y + 0.075 (the floor
    // remains Y - 0.24), road/line clipping removes hole vertices and zero-width
    // triangles; rails/posts/curbs stop at the pit; scenery checks its full footprint.
    // Road vertices/indices 3418/10068 -> 3362/9984; right line vertices 3374 -> 3404;
    // pit-rims 0 -> 36 vertices/90 indices. Curbs/rails 1536 -> 1531 each,
    // posts 1536 -> 1534; rock instances 15 -> 14 (matrix hash 3976052981 -> 2257795301).
    // neon 438666310 -> 1415205385: only island building transforms/count change (11 -> 9).
    // Building matrix hash 2707146 -> 1767788015; its road/wall buffers are unchanged.
    // MEADOW 4166068202 and SNOWPEAK 940168198 stay unchanged. The direct array
    // comparisons below also retain the absent-bank versus zero-bank contract.
    expect(signature).toBe({ meadow: 4166068202, canyon: 623313950, snowpeak: 940168198, neon: 1415205385 }[id]);
    expect(after).toHaveLength(before.length);
    before.forEach((mesh, i) => {
      expect(after[i].geometry.getAttribute('position').array).toEqual(mesh.geometry.getAttribute('position').array);
      expect(after[i].castShadow).toBe(mesh.castShadow);
      if (mesh instanceof THREE.InstancedMesh) {
        expect((after[i] as THREE.InstancedMesh).instanceMatrix.array).toEqual(mesh.instanceMatrix.array);
      }
    });
    expect(kartRotationZ(zeroBank, original.length / 3)).toBe(0);
  });

  it('uses sim surface heights for both ribbon edges, decals, curbs, rails, posts and place()', () => {
    const def = bankCourse(0.3);
    const { rightCorner: [from, to] } = stadiumSections(def);
    const track = buildTrack({ ...def, surfaces: [{ kind: 'ice', from, to, offsetMin: -5, offsetMax: 4 }] });
    const { group } = build(track, meadow);
    const distances = [...new Set([
      ...Array.from({ length: 385 }, (_, i) => i / 384 * track.length),
      ...def.bankKeys!.map(key => key.distance), from, to,
    ])].sort((a, b) => a - b);
    for (const [name, lift, offsets] of [
      ['road', 0.06, (d: number) => [-widthAt(track, d).roadHalfWidth, widthAt(track, d).roadHalfWidth]],
      ['shoulder:1', 0.01, (d: number) => [widthAt(track, d).roadHalfWidth, widthAt(track, d).wallHalfWidth]],
      ['line:-1', 0.075, (d: number) => [-(widthAt(track, d).roadHalfWidth - 0.16), -(widthAt(track, d).roadHalfWidth + 0.06)]],
    ] as const) {
      const vertices = (group.getObjectByName(name) as THREE.Mesh).geometry.getAttribute('position');
      expect(vertices.count).toBe(distances.length * 2);
      distances.forEach((d, i) => offsets(d).forEach((offset, side) => {
        expect(Math.abs(vertices.getY(i * 2 + side) - surfaceHeightAt(track, d, offset) - lift)).toBeLessThan(1e-6);
      }));
    }
    const decal = (group.getObjectByName('surface:ice') as THREE.Mesh).geometry.getAttribute('position');
    for (let i = 0; i < decal.count; i++) {
      expect(Math.abs(decal.getY(i) - surfaceHeightAt(track, from, i % 2 ? 4 : -5) - 0.1)).toBeLessThan(1e-6);
    }
    const sections = [...new Set([
      ...Array.from({ length: Math.floor(track.length / 3) + 1 }, (_, i) => i / Math.floor(track.length / 3) * track.length),
      ...def.bankKeys!.map(key => key.distance),
    ])].sort((a, b) => a - b);
    const matrix = new THREE.Matrix4();
    for (const [name, lift, extra] of [['curbs', 0.12, 0.32], ['rails', 0.83, 0], ['posts', 0.51, 0]] as const) {
      const mesh = group.getObjectByName(name) as THREE.InstancedMesh;
      sections.slice(0, -1).forEach((d, i) => {
        const middle = (d + sections[i + 1]) / 2;
        const width = widthAt(track, middle);
        for (const side of [0, 1]) {
          const offset = (side * 2 - 1) * (extra ? width.roadHalfWidth + extra : width.wallHalfWidth);
          mesh.getMatrixAt(i * 2 + side, matrix);
          expect(Math.abs(matrix.elements[13] - surfaceHeightAt(track, middle, offset) - lift)).toBeLessThan(1e-6);
        }
      });
    }
    const object = new THREE.Object3D(), d = (from + to) / 2;
    place(track, object, sampleTrack(track, d), 3, 0.28);
    expect(object.position.y).toBe(surfaceHeightAt(track, d, 3) + 0.28);
    const wall = widthAt(track, d).wallHalfWidth;
    const projection = { distance: d, offset: wall + 11, height: sampleTrack(track, d).y, heading: 0 };
    expect(terrainHeight(track, projection)).toBeCloseTo((surfaceHeightAt(track, d, wall) - 1.35) / 2, 12);
  });

  it.each([0.3, -0.3, 0])('rolls the kart toward the high side for roll %s at every heading', roll => {
    const def = bankCourse(roll), track = buildTrack(def);
    const { rightCorner: [from, to] } = stadiumSections(def);
    const d = (from + to) / 2;
    expect(kartRotationZ(track, d)).toBe(roll);
    for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.37]) {
      const rotationZ = kartRotationZ(track, d);
      expect(Math.abs(rolledLocalPointY(heading, rotationZ, 3)
        - (surfaceHeightAt(track, d, 3) - surfaceHeightAt(track, d, 0)))).toBeLessThan(0.05);
    }
    expect(kartRotationZ(track, 0)).toBe(0);
    expect(kartRotationZ(track, from - 10)).toBeCloseTo(rollAt(track, from - 10), 12);
  });

  it('adds exactly a slab and one pillar batch with their existing shadow flags', () => {
    const def = { ...LEGACY_MEADOW, ...figureEightCourse() }, track = buildTrack(def);
    const { upper } = figureEightCrossings(def);
    const span = def.decks![0];
    const { group } = build(track, meadow);
    const plain = build(buildTrack({ ...def, decks: undefined }), meadow);
    expect(meshCount(group)).toBe(meshCount(plain.group) + 2);
    const deck = group.getObjectByName('decks') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    expect(deck.castShadow).toBe(true);
    expect(deck.receiveShadow).toBe(true);
    expect(deck.material.color.getHex()).toBe(meadow.colors.road);
    const vertices = deck.geometry.getAttribute('position'), normals = deck.geometry.getAttribute('normal');
    const ys = Array.from({ length: vertices.count }, (_, i) => vertices.getY(i));
    expect(Math.max(...ys)).toBeCloseTo(surfaceHeightAt(track, upper, 0) + 0.06, 5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.6, 5);
    const normalYs = Array.from({ length: normals.count }, (_, i) => normals.getY(i));
    expect(normalYs.some(y => y > 0.99)).toBe(true);
    expect(normalYs.some(y => y < -0.99)).toBe(true);
    expect(normalYs.some(y => Math.abs(y) < 0.01)).toBe(true);
    const cylinders: THREE.InstancedMesh[] = [];
    group.traverse(object => {
      if (object instanceof THREE.InstancedMesh && object.geometry.type === 'CylinderGeometry'
        && object.name !== 'trunks') cylinders.push(object);
    });
    expect(cylinders).toHaveLength(1);
    const pillars = cylinders[0], matrix = new THREE.Matrix4();
    expect(pillars.name).toBe('deck-pillars');
    expect((pillars.material as THREE.MeshLambertMaterial).color.getHex()).toBe(meadow.colors.post);
    expect(pillars.castShadow).toBe(true);
    expect(pillars.receiveShadow).toBe(true);
    expect(pillars.count).toBeGreaterThan(0);
    expect(pillars.count).toBeLessThan((Math.ceil((span.to - span.from) / 20) + 1) * 2);
    for (let i = 0; i < pillars.count; i++) {
      pillars.getMatrixAt(i, matrix);
      const point = new THREE.Vector3().setFromMatrixPosition(matrix);
      expect(point.y - matrix.elements[5] / 2).toBeCloseTo(-1.35, 5);
      expect(point.y + matrix.elements[5] / 2).toBeCloseTo(surfaceHeightAt(track, upper, 0) + 0.06 - 0.6, 5);
    }
    expect(group.getObjectByName('rails')!.castShadow).toBe(false);
    expect((group.getObjectByName('road') as THREE.Mesh).castShadow).toBe(false);
  });

  it('removes scenery above the lower corridor while retaining surviving instance colors', () => {
    const def = figureEightCourse(), track = buildTrack(def);
    const { lower, upper } = figureEightCrossings(def);
    const center = sampleTrack(track, lower), high = sampleTrack(track, upper);
    const matrices = new THREE.Matrix4();
    for (const theme of [meadow, canyon, snowpeak, neon]) {
      const { group } = build(track, theme);
      for (const name of ['trunks', 'crowns', 'rocks', 'flowers', 'snowpeak:trunks', 'snowpeak:rocks',
        'canyon:cacti', 'canyon:stones', 'neon:buildings']) {
        const mesh = group.getObjectByName(name);
        if (!(mesh instanceof THREE.InstancedMesh)) continue;
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrices);
          const x = matrices.elements[12] - center.x, z = matrices.elements[14] - center.z;
          expect(Math.abs(x * center.tx + z * center.tz) < 19.9
            && Math.abs(x * center.nx + z * center.nz) < track.def.wallHalfWidth - 0.001).toBe(false);
        }
      }
    }
    const custom = { ...meadow, buildLandmarks() {}, buildProps(_track: Track, scene: THREE.Group) {
      const props = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), 3);
      [new THREE.Vector3(0, high.y + 1, 0), new THREE.Vector3(high.nx * 30, high.y + 1, high.nz * 30),
        new THREE.Vector3(400, 1, 400)].forEach((position, i) => {
        props.setMatrixAt(i, new THREE.Matrix4().makeTranslation(position));
        props.setColorAt(i, new THREE.Color(i === 2 ? 0x123456 : 0xffffff));
      });
      props.name = 'test-props';
      scene.add(props);
    } };
    const filtered = build(track, custom).group.getObjectByName('test-props') as THREE.InstancedMesh;
    expect(filtered.count).toBe(1);
    const color = new THREE.Color();
    filtered.getColorAt(0, color);
    expect(color.getHex()).toBe(0x123456);
  });

  it.each([0, -4])('keeps every pillar outside the variable-width lower road at height %s', lowerY => {
    const def = { ...LEGACY_MEADOW, ...figureEightCourse() };
    const { lower } = figureEightCrossings(def);
    const track = buildTrack({ ...def, controlPoints: def.controlPoints.map(([x, y, z]) => [x, y + lowerY, z]),
      widthKeys: [
        { distance: 0, roadHalfWidth: 9.36, wallHalfWidth: def.wallHalfWidth },
        { distance: lower - 40, roadHalfWidth: 11, wallHalfWidth: 16 },
        { distance: lower + 40, roadHalfWidth: 13, wallHalfWidth: 18 },
        { distance: lower + 80, roadHalfWidth: 9.36, wallHalfWidth: def.wallHalfWidth },
      ],
    });
    const { group } = build(track, { ...meadow, colors: { ...meadow.colors, deck: 0x123456, pillar: 0x654321 } });
    const pillars = group.getObjectByName('deck-pillars') as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    const center = sampleTrack(track, lower);
    expect(pillars.count).toBeGreaterThan(0);
    for (let i = 0; i < pillars.count; i++) {
      pillars.getMatrixAt(i, matrix);
      const x = matrix.elements[12] - center.x, z = matrix.elements[14] - center.z;
      const along = x * center.tx + z * center.tz;
      const offset = x * center.nx + z * center.nz;
      // The crossing branches are straight for ±40 m; this projection is
      // independent of the renderer's all-samples roadHeightAtXZ lookup.
      expect(Math.abs(along)).toBeLessThan(40);
      expect(Math.abs(offset)).toBeGreaterThan(widthAt(track, lower + along).wallHalfWidth + 0.45 - 1e-5);
      expect(matrix.elements[13] - matrix.elements[5] / 2).toBeCloseTo(-1.35, 5);
    }
    expect((pillars.material as THREE.MeshLambertMaterial).color.getHex()).toBe(0x654321);
    expect(((group.getObjectByName('decks') as THREE.Mesh).material as THREE.MeshLambertMaterial).color.getHex()).toBe(0x123456);
    const ground = [-1, 1].map(side => group.getObjectByName(`ground:${side}`) as THREE.Mesh);
    const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    // Outside the deck cutout, retained terrain must also stay below a sunken
    // crossing. Inspect the ground ribbons, independent of the base plane.
    for (const along of [-30, -20, 20, 30]) for (const offset of [-10, 0, 10]) {
      const point = sampleTrack(track, lower + along);
      ray.ray.origin.set(point.x + point.nx * offset, 100, point.z + point.nz * offset);
      const hits = ray.intersectObjects(ground, false);
      expect(hits.length).toBeGreaterThan(0);
      expect(Math.max(...hits.map(hit => hit.point.y))).toBeLessThanOrEqual(lowerY + 1e-5);
    }
  });

  it.each([false, true])('limits ground cutouts to the deck projection plus 0.6 m and retains banks (taper: %s)', taper => {
    const def = { ...LEGACY_MEADOW, ...figureEightCourse() };
    const { lower, upper } = figureEightCrossings(def);
    const track = buildTrack({ ...def, widthKeys: taper ? [
      { distance: 0, roadHalfWidth: 9.36, wallHalfWidth: def.wallHalfWidth },
      { distance: upper - 20, roadHalfWidth: 9.36, wallHalfWidth: 12 },
      { distance: upper + 20, roadHalfWidth: 9.36, wallHalfWidth: 16 },
      { distance: upper + 40, roadHalfWidth: 9.36, wallHalfWidth: def.wallHalfWidth },
    ] : undefined });
    const deckMargin = 0.6; // metres per side beyond the deck's wallHalfWidth.
    const built = build(track, meadow), plain = build(buildTrack({ ...track.def, decks: undefined }), meadow);
    const grounds = (course: Course): THREE.Mesh[] => [-1, 1].map(side => course.group.getObjectByName(`ground:${side}`) as THREE.Mesh);
    const clipped = grounds(built), original = grounds(plain);
    const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    const hits = (meshes: THREE.Mesh[], x: number, z: number): THREE.Intersection[] => {
      ray.ray.origin.set(x, 100, z);
      return ray.intersectObjects(meshes, false);
    };
    const high = sampleTrack(track, upper);
    let removed = 0, retained = 0;
    // Probe the lower bank across the deck boundary and all the way to the
    // outer edge, so dropping a whole 22 m quad cannot satisfy this test.
    for (let along = -38.7; along < 39; along += 1.3) {
      const p = sampleTrack(track, lower + along), wall = widthAt(track, lower + along).wallHalfWidth;
      for (const side of [-1, 1]) for (let extra = 0.2; extra < 22; extra += 1.7) {
        const x = p.x + p.nx * side * (wall + extra), z = p.z + p.nz * side * (wall + extra);
        const deckAlong = (x - high.x) * high.tx + (z - high.z) * high.tz;
        const deckOffset = (x - high.x) * high.nx + (z - high.z) * high.nz;
        const cut = Math.abs(deckAlong) < 20 && Math.abs(deckOffset) < widthAt(track, upper + deckAlong).wallHalfWidth + deckMargin;
        const before = hits(original, x, z), after = hits(clipped, x, z);
        expect(before.length).toBeGreaterThan(0);
        if (cut) {
          expect(after, `inside projection at ${deckAlong}, ${deckOffset}`).toHaveLength(0);
          removed++;
        } else {
          const lowerBankY = -extra / 22 * 1.35;
          expect(after.some(hit => Math.abs(hit.point.y - lowerBankY) < 1e-4),
            `retained bank at ${deckAlong}, ${deckOffset}`).toBe(true);
          retained++;
        }
      }
    }
    expect(removed).toBeGreaterThan(50);
    expect(retained).toBeGreaterThan(500);
    // Immediately outside the cut, retain ground beside the upper slab at
    // terrain height; a suspended embankment must not block the lower lane.
    for (const along of [-19, -10, 0, 10, 19]) for (const side of [-1, 1]) {
      const p = sampleTrack(track, upper + along), wall = widthAt(track, upper + along).wallHalfWidth;
      for (const extra of [deckMargin - 0.01, deckMargin + 0.01, 21.5]) {
        const after = hits(clipped, p.x + p.nx * side * (wall + extra), p.z + p.nz * side * (wall + extra));
        if (extra < deckMargin) expect(after).toHaveLength(0);
        else expect(after.some(hit => Math.abs(hit.point.y + 1.35) < 1e-5)).toBe(true);
      }
    }
  });

  it('cuts wrapped and multiple deck spans without adding more batches', () => {
    const base = buildTrack(bankCourse(0));
    const track = buildTrack({ ...base.def, decks: [{ from: base.length - 10, to: 10 }, { from: 80, to: 120 }] });
    const { group } = build(track, meadow);
    expect(meshCount(group)).toBe(meshCount(build(base, meadow).group) + 2);
    for (const side of [-1, 1]) {
      const vertices = (group.getObjectByName(`ground:${side}`) as THREE.Mesh).geometry.getAttribute('position');
      for (let i = 0; i < vertices.count; i++) {
        const projection = projectToTrack(track, vertices.getX(i), vertices.getZ(i));
        // Inner edges project exactly to their own straight section.
        if (Math.abs(Math.abs(projection.offset) - track.def.wallHalfWidth) > 1e-3) continue;
        expect(projection.distance > 80.001 && projection.distance < 119.999).toBe(false);
        expect(projection.distance < 9.999 || projection.distance > track.length - 9.999,
          JSON.stringify({ projection, point: [vertices.getX(i), vertices.getY(i), vertices.getZ(i)] })).toBe(false);
      }
    }
  });
});

describe('MEADOW appearance regression', () => {
  it('pins layout 3 seed-127 instance transforms and colors, including distant scenery', () => {
    const { group } = build(getTrack('meadow'), meadow);
    // M5-01: measured in node with the new layout and theme, retaining 384 ribbon divisions.
    const golden = [
      ['trunks', 240, 3605848358, undefined, 0x927050],
      ['crowns', 240, 3266488595, 3039214731, 0x34a67b],
      ['rocks', 72, 308681814, undefined, 0xa3b7a6],
      ['flowers', 192, 4229755394, undefined, 0xffe97e],
      ['peaks', 16, 2646345670, 3153255523, 0x75b99d],
      ['clouds', 36, 3299357665, undefined, 0xf7fff0],
    ] as const;
    for (const [name, count, matrix, color, baseColor] of golden) {
      const mesh = group.getObjectByName(name) as THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
      expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
      expect(mesh.count, name).toBe(count);
      expect(hash(mesh.instanceMatrix.array as Float32Array), name).toBe(matrix);
      expect(mesh.instanceColor ? hash(mesh.instanceColor.array as Float32Array) : undefined, name).toBe(color);
      expect(mesh.material.color.getHex(), name).toBe(baseColor);
    }
  });

  it('preserves road, curbs, lighting, sky and fog colors', () => {
    const { group, sky } = build(getTrack('meadow'), meadow);
    const ribbons = group.children.filter((object): object is THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> =>
      object instanceof THREE.Mesh && object.geometry.type === 'BufferGeometry');
    expect(ribbons.map(mesh => mesh.material.color.getHex())).toEqual([
      0x596d73, 0x98cf64, 0x82c767, 0xf8f6d8, 0x98cf64, 0x82c767, 0xf8f6d8,
      0x99683f, 0xffbe62,
    ]);
    expect(meadow.colors.curb).toEqual([0xeb695f, 0xfff1d1]);
    expect(meadow.colors.sky).toBe(0xa3dce6);
    expect(meadow.fog).toEqual({ color: 0xb4e1df, near: 170, far: 460 });
    expect(meadow.lighting).toEqual({
      hemisphere: { sky: 0xe5faff, ground: 0x6d965b, intensity: 2.25 },
      sun: { color: 0xfff1d4, intensity: 2.25, position: [70, 100, 40], offset: [55, 85, 35] },
    });
    const skyMaterial = sky.material as THREE.ShaderMaterial;
    expect(skyMaterial.uniforms.top.value.getHex()).toBe(0x51b8ed);
    expect(skyMaterial.uniforms.bottom.value.getHex()).toBe(0xdff4ee);
    const road = ribbons[0].geometry.getAttribute('position');
    // 384 divisions plus exact samples, width/bank keys and surface boundaries.
    expect(road.count).toBe(3356);
    for (let side = 0; side < 2; side++) {
      expect([road.getX(side), road.getY(side), road.getZ(side)]).toEqual([
        road.getX(road.count - 2 + side), road.getY(road.count - 2 + side), road.getZ(road.count - 2 + side),
      ]);
    }
  });
});

describe('track-driven surfaces', () => {
  it('draws each kind over its exact distance and lane bounds on a different track shape', () => {
    const base = getTrack('meadow');
    const track = buildTrack({
      ...base.def, widthKeys: [], bankKeys: [],
      scale: 1.25,
      roadHalfWidth: 6,
      surfaces: [
        { kind: 'ice', from: 40, to: 97 },
        { kind: 'boost', from: 173, to: 180, offsetMin: -4, offsetMax: -1 },
        { kind: 'jump', from: 240, to: 242.5, offsetMin: 0, offsetMax: 5 },
        { kind: 'dirt', from: 300, to: 325 },
        { kind: 'pit', from: 350, to: 355 },
      ],
    });
    const { group } = build(track, meadow);
    for (const zone of track.def.surfaces) {
      const surface = group.getObjectByName(`surface:${zone.kind}`) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
      expect(surface.material.color.getHex()).toBe(meadow.colors.surfaces[zone.kind]);
      expect(surface.material.color.getHex()).not.toBe(meadow.colors.road);
      const positions = surface.geometry.getAttribute('position');
      const segments = positions.count / 2 - 1;
      for (let i = 0; i <= segments; i++) {
        const point = sampleTrack(track, zone.from + i / segments * (zone.to - zone.from));
        for (const [side, offset] of [zone.offsetMin ?? -track.def.roadHalfWidth, zone.offsetMax ?? track.def.roadHalfWidth].entries()) {
          expect(positions.getX(i * 2 + side)).toBeCloseTo(point.x + point.nx * offset, 4);
          expect(positions.getY(i * 2 + side)).toBeCloseTo(point.y + (zone.kind === 'pit' ? -0.24 : 0.1), 4);
          expect(positions.getZ(i * 2 + side)).toBeCloseTo(point.z + point.nz * offset, 4);
        }
      }
      expect(surface.geometry.getIndex()!.count).toBe(segments * 6);
    }
  });

  it('draws a single zone that wraps the finish line along the track, not as one chord', () => {
    const base = getTrack('meadow');
    const surfaces: SurfaceZone[] = [{ kind: 'ice', from: base.length - 60, to: 60 }];
    const { group } = build(buildTrack({ ...base.def, widthKeys: [], bankKeys: [], surfaces }), meadow);
    const positions = (group.getObjectByName('surface:ice') as THREE.Mesh).geometry.getAttribute('position');
    const segments = Math.ceil(384 * 120 / base.length);
    expect(positions.count).toBe((segments + 1) * 2);
    const first = sampleTrack(base, base.length - 60);
    const last = sampleTrack(base, 60);
    expect(positions.getX(0)).toBeCloseTo(first.x + first.nx * -base.def.roadHalfWidth, 4);
    expect(positions.getZ(positions.count - 2)).toBeCloseTo(last.z + last.nz * -base.def.roadHalfWidth, 4);
  });

  it('joins surface zones split across the finish line without extending their bounds', () => {
    const base = getTrack('meadow');
    const surfaces: SurfaceZone[] = [
      { kind: 'ice', from: base.length - 8, to: base.length },
      { kind: 'ice', from: 0, to: 7 },
    ];
    const { group } = build(buildTrack({ ...base.def, widthKeys: [], bankKeys: [], surfaces }), meadow);
    const positions = (group.getObjectByName('surface:ice') as THREE.Mesh).geometry.getAttribute('position');
    const join = (Math.ceil(384 * 8 / base.length) + 1) * 2;
    for (let side = 0; side < 2; side++) {
      expect([positions.getX(join - 2 + side), positions.getY(join - 2 + side), positions.getZ(join - 2 + side)]).toEqual([
        positions.getX(join + side), positions.getY(join + side), positions.getZ(join + side),
      ]);
    }
  });

  it('includes width corners on both sides of a wrapped decal', () => {
    const base = getTrack('meadow');
    const track = buildTrack({ ...base.def, bankKeys: [], widthKeys: [
      { distance: 12.37, roadHalfWidth: 12, wallHalfWidth: 14.5 },
      { distance: base.length - 23.17, roadHalfWidth: 7.2, wallHalfWidth: 9 },
    ], surfaces: [{ kind: 'dirt', from: base.length - 40, to: 30 }] });
    const { group } = build(track, meadow);
    const vertices = (group.getObjectByName('surface:dirt') as THREE.Mesh).geometry.getAttribute('position');
    for (const d of [base.length - 40, base.length - 23.17, base.length, base.length + 12.37, base.length + 30]) {
      const point = sampleTrack(track, d);
      const half = widthAt(track, d).roadHalfWidth;
      for (let side = 0; side < 2; side++) {
        let nearest = Infinity;
        for (let i = side; i < vertices.count; i += 2) {
          nearest = Math.min(nearest, Math.hypot(vertices.getX(i) - point.x - point.nx * (side * 2 - 1) * half,
            vertices.getZ(i) - point.z - point.nz * (side * 2 - 1) * half));
        }
        expect(nearest, `wrapped width at ${d}`).toBeLessThan(0.001);
      }
    }
  });
});

describe('variable widths and batched barriers', () => {
  it('follows 7.2 → 12 m widths at every ribbon sample and rail/post/curb instance, including the seam', () => {
    const base = getTrack('meadow');
    const track = buildTrack({ ...base.def, bankKeys: [], widthKeys: [
      { distance: 0, roadHalfWidth: 7.2, wallHalfWidth: 9 },
      { distance: 101.37, roadHalfWidth: 7.2, wallHalfWidth: 9 },
      { distance: 117.37, roadHalfWidth: 12, wallHalfWidth: 14.5 },
      { distance: 150.83, roadHalfWidth: 12, wallHalfWidth: 14.5 },
      { distance: 166.83, roadHalfWidth: 7.2, wallHalfWidth: 9 },
    ], surfaces: [{ kind: 'dirt', from: 0, to: base.length }] });
    const { group } = build(track, meadow);
    const bounds = (d: number, name: string): number[] => {
      const w = widthAt(track, d);
      if (name === 'road' || name === 'surface:dirt') return [-w.roadHalfWidth, w.roadHalfWidth];
      const [kind, sideText] = name.split(':');
      const side = Number(sideText);
      if (kind === 'shoulder') return [side * w.roadHalfWidth, side * w.wallHalfWidth];
      if (kind === 'ground') return [side * w.wallHalfWidth, side * (w.wallHalfWidth + 22)];
      return [side * (w.roadHalfWidth - 0.16), side * (w.roadHalfWidth + 0.06)];
    };
    for (const name of ['road', 'surface:dirt', 'shoulder:-1', 'shoulder:1', 'ground:-1', 'ground:1', 'line:-1', 'line:1']) {
      const positions = (group.getObjectByName(name) as THREE.Mesh).geometry.getAttribute('position');
      const distances = [...new Set([...Array.from({ length: 385 }, (_, i) => i / 384 * track.length),
        ...track.def.widthKeys!.map(key => key.distance), ...track.samples.map(point => point.distance)])].sort((a, b) => a - b);
      expect(positions.count).toBe(distances.length * 2);
      for (const [i, d] of distances.entries()) {
        const p = sampleTrack(track, d);
        bounds(d, name).forEach((offset, side) => {
          const x = positions.getX(i * 2 + side) - p.x;
          const z = positions.getZ(i * 2 + side) - p.z;
          expect(Math.abs(x * p.nx + z * p.nz - offset), name).toBeLessThan(0.01);
        });
      }
      if (name === 'road') {
        let section = 0;
        let maximumError = 0;
        // Include the curved portions and closing seam, not just the vertices.
        for (let d = 0; d < track.length; d += 0.05) {
          while (distances[section + 1] < d) section++;
          const t = (d - distances[section]) / (distances[section + 1] - distances[section]);
          const p = sampleTrack(track, d);
          bounds(d, name).forEach((offset, side) => {
            const a = section * 2 + side, b = a + 2;
            const x = positions.getX(a) * (1 - t) + positions.getX(b) * t - p.x;
            const z = positions.getZ(a) * (1 - t) + positions.getZ(b) * t - p.z;
            maximumError = Math.max(maximumError, Math.abs(x * p.nx + z * p.nz - offset));
          });
        }
        expect(maximumError).toBeLessThan(0.01);
      }
    }
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const count = Math.floor(track.length / 3);
    const stations = [...new Set([...Array.from({ length: count + 1 }, (_, i) => i / count * track.length),
      ...track.def.widthKeys!.map(key => key.distance)])].sort((a, b) => a - b);
    for (const name of ['rails', 'posts', 'curbs']) {
      const mesh = group.getObjectByName(name) as THREE.InstancedMesh;
      expect(mesh.count).toBe((stations.length - 1) * 2);
      for (let i = 0; i < mesh.count; i++) {
        const section = Math.floor(i / 2);
        const d = (stations[section] + stations[section + 1]) / 2;
        const p = sampleTrack(track, d);
        const w = widthAt(track, d);
        mesh.getMatrixAt(i, matrix);
        position.setFromMatrixPosition(matrix);
        const offset = (position.x - p.x) * p.nx + (position.z - p.z) * p.nz;
        expect(Math.abs(offset - (i % 2 * 2 - 1) * (name === 'curbs' ? w.roadHalfWidth + 0.32 : w.wallHalfWidth))).toBeLessThan(0.01);
      }
    }
  });

  // The first 300 m run along +X, so world X measures arc distance and -Z is
  // lateral offset. Cross sections below inspect mesh edges, not sampled widths.
  function straightTrack() {
    return buildTrack({ ...LEGACY_MEADOW, scale: 1, controlPoints: [
      [0, 0, 0], [100, 0, 0], [200, 0, 0], [300, 0, 0], [400, 0, 0],
      [400, 0, 200], [0, 0, 200], [-100, 0, 200], [-100, 0, 0],
    ], widthKeys: [
      { distance: 0, roadHalfWidth: 7.2, wallHalfWidth: 9 },
      { distance: 101.37, roadHalfWidth: 7.2, wallHalfWidth: 9 },
      { distance: 117.37, roadHalfWidth: 12, wallHalfWidth: 14.5 },
      { distance: 150.83, roadHalfWidth: 12, wallHalfWidth: 14.5 },
      { distance: 166.83, roadHalfWidth: 7.2, wallHalfWidth: 9 },
    ], surfaces: [{ kind: 'dirt', from: 95.13, to: 181.21 }] });
  }

  it('matches ribbon edges every 0.05 m through off-grid width corners and inserts zone endpoints', () => {
    const track = straightTrack();
    const { group } = build(track, meadow);
    for (const name of ['road', 'surface:dirt']) {
      const mesh = group.getObjectByName(name) as THREE.Mesh;
      const positions = mesh.geometry.getAttribute('position');
      for (const distance of [95.13, 101.37, 117.37, 150.83, 166.83, 181.21]) {
        expect(Array.from({ length: positions.count / 2 }, (_, i) => positions.getX(i * 2))
          .some(x => Math.abs(x - distance) < 0.0001)).toBe(true);
      }
      for (let step = 0; step <= 1700; step++) {
        const d = 96 + step * 0.05;
        for (let side = 0; side < 2; side++) {
          let offset: number | undefined;
          for (let row = 0; row < positions.count - 2; row += 2) {
            const a = row + side;
            const b = a + 2;
            const x0 = positions.getX(a), x1 = positions.getX(b);
            if (x0 <= d && d <= x1 && Math.abs(positions.getZ(a)) < 20) {
              const t = (d - x0) / (x1 - x0);
              offset = -(positions.getZ(a) * (1 - t) + positions.getZ(b) * t);
              break;
            }
          }
          expect(offset, `${name} side ${side} at ${d}`).toBeDefined();
          expect(Math.abs(offset! - (side * 2 - 1) * widthAt(track, d).roadHalfWidth)).toBeLessThan(0.01);
        }
      }
    }
  });

  it('places both ends of rails and curbs on widening and narrowing boundaries', () => {
    const track = straightTrack();
    const { group } = build(track, meadow);
    const matrix = new THREE.Matrix4();
    const endpoint = new THREE.Vector3();
    for (const name of ['rails', 'curbs']) {
      const mesh = group.getObjectByName(name) as THREE.InstancedMesh;
      let checked = 0;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        const center = new THREE.Vector3().setFromMatrixPosition(matrix);
        if (center.x < 98 || center.x > 172 || Math.abs(center.z) > 20) continue;
        for (const end of [-0.5, 0.5]) {
          endpoint.set(0, 0, end).applyMatrix4(matrix);
          const w = widthAt(track, endpoint.x);
          const half = name === 'rails' ? w.wallHalfWidth : w.roadHalfWidth + 0.32;
          expect(Math.abs(-endpoint.z - (i % 2 * 2 - 1) * half), `${name} at ${endpoint.x}`).toBeLessThan(0.01);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(80);
    }
  });

  it.each(['pillar', 'block'] as const)('batches three %s bodies and ice 2 + dirt 2 into three meshes', scenery => {
    const base = getTrack('meadow');
    const barriers: Barrier[] = [
      { from: 70, to: 90, center: -2, halfWidth: 2, taper: 4, scenery },
      { from: 180, to: 205, center: 3, halfWidth: 1, taper: 6, scenery },
      { from: base.length - 8, to: 8, center: 0, halfWidth: 1.5, taper: 4, scenery },
    ];
    const track = buildTrack({ ...base.def, widthKeys: [], bankKeys: [], barriers, surfaces: [
      { kind: 'ice', from: 40, to: 50 }, { kind: 'ice', from: 80, to: 90 },
      { kind: 'dirt', from: 120, to: 140 }, { kind: 'dirt', from: base.length - 10, to: 10 },
    ] });
    const { group } = build(track, meadow);
    const mesh = group.getObjectByName(`barriers:${scenery}`) as THREE.InstancedMesh;
    expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
    expect(mesh.count).toBe(3);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.geometry.type).toBe(scenery === 'pillar' ? 'CylinderGeometry' : 'BoxGeometry');
    expect(group.children.filter(o => o.name.startsWith('barriers:'))).toHaveLength(1);
    const decals = group.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.name.startsWith('surface:'));
    expect(decals.map(o => o.name).sort()).toEqual(['surface:dirt', 'surface:ice']);
    for (const decal of decals) {
      const mat = decal.material as THREE.MeshLambertMaterial;
      expect(mat.polygonOffset).toBe(true);
      expect(mat.polygonOffsetFactor).toBe(-1);
      const zones = track.def.surfaces.filter(z => `surface:${z.kind}` === decal.name);
      const vertices = zones.reduce((sum, z) => sum + 2 * (1 + Math.ceil(384 * ((z.to - z.from + track.length) % track.length) / track.length)), 0);
      expect(decal.geometry.getAttribute('position').count).toBe(vertices);
      expect(decal.geometry.groups).toHaveLength(0); // A single material draw, even after merging.
    }
    // Resolve the actual instance morphs, as the renderer does. The tips must be
    // on the band endpoints, never on the radius-expanded collision caps.
    const pose = new THREE.Mesh(mesh.geometry, mesh.material);
    const point = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    barriers.forEach((barrier, index) => {
      mesh.getMorphAt(index, pose);
      mesh.getMatrixAt(index, matrix);
      const span = (barrier.to - barrier.from + track.length) % track.length;
      for (const distance of [barrier.from, barrier.from + span]) {
        const tip = sampleTrack(track, distance);
        let nearest = Infinity;
        for (let i = 0; i < mesh.geometry.getAttribute('position').count; i++) {
          pose.getVertexPosition(i, point).applyMatrix4(matrix);
          nearest = Math.min(nearest, Math.hypot(point.x - tip.x - tip.nx * barrier.center, point.z - tip.z - tip.nz * barrier.center));
        }
        expect(nearest).toBeLessThan(0.001);
      }
      const middle = sampleTrack(track, barrier.from + span / 2);
      for (const side of [-1, 1]) {
        let nearest = Infinity;
        for (let i = 0; i < mesh.geometry.getAttribute('position').count; i++) {
          pose.getVertexPosition(i, point).applyMatrix4(matrix);
          nearest = Math.min(nearest, Math.hypot(point.x - middle.x - middle.nx * (barrier.center + side * barrier.halfWidth),
            point.z - middle.z - middle.nz * (barrier.center + side * barrier.halfWidth)));
        }
        expect(nearest).toBeLessThan(0.001);
      }
    });
  });

  it('documents M1-01 Minor (3): the taper approximation permits at most 0.101 m of circle penetration', () => {
    const barrier: Barrier = { from: 40, to: 60, center: 0, halfWidth: 2, taper: 4, scenery: 'pillar' };
    const track = buildTrack({ ...straightTrack().def, barriers: [barrier] });
    const { group } = build(track, meadow);
    const mesh = group.getObjectByName('barriers:pillar') as THREE.InstancedMesh;
    const pose = new THREE.Mesh(mesh.geometry, mesh.material);
    mesh.getMorphAt(0, pose);
    mesh.getMatrixAt(0, pose.matrix);
    pose.matrixAutoUpdate = false;
    pose.updateMatrixWorld(true);
    const exclusion = exclusionAt(track, barrier, 42, 0)!;
    const bodyHalf = 1; // Halfway up the 0 → 2 m taper.
    expect(exclusion.max - bodyHalf).toBe(KART_RADIUS);
    // Measure the actual rendered side from the collision boundary. Removing
    // this penetration needs a true disk expansion in physics; shrinking the
    // visible band would violate the required ±0.01 m match to half(d).
    const normal = exclusion.normalAt(exclusion.max);
    const ray = new THREE.Raycaster(new THREE.Vector3(42, 0.6, -exclusion.max),
      new THREE.Vector3(-normal.d, 0, normal.offset));
    const normalClearance = ray.intersectObject(pose, false)[0].distance;
    expect(normalClearance).toBeCloseTo(KART_RADIUS / Math.hypot(1, 0.5), 4);
    expect(KART_RADIUS - normalClearance).toBeGreaterThan(0.1);
    expect(KART_RADIUS - normalClearance).toBeLessThan(0.101);
  });

  it.each(['pillar', 'block'] as const)('matches the visible %s taper to half(d) at 1, 2 and 3 m', scenery => {
    const base = straightTrack();
    const barriers: Barrier[] = [
      { from: 60, to: 80, center: -2, halfWidth: 2, taper: 4, scenery },
      { from: 110, to: 138, center: 3, halfWidth: 2, taper: 8, scenery },
      { from: 180, to: 186, center: 0, halfWidth: 2, taper: 4, scenery },
    ];
    const track = buildTrack({ ...base.def, barriers });
    const { group } = build(track, meadow);
    const mesh = group.getObjectByName(`barriers:${scenery}`) as THREE.InstancedMesh;
    if (scenery === 'pillar') {
      expect((mesh.geometry as THREE.CylinderGeometry).parameters.radialSegments % 12).toBe(0);
    }
    const pose = new THREE.Mesh(mesh.geometry, mesh.material);
    pose.matrixAutoUpdate = false;
    const ray = new THREE.Raycaster();
    barriers.forEach((barrier, index) => {
      mesh.getMorphAt(index, pose);
      mesh.getMatrixAt(index, pose.matrix);
      pose.updateMatrixWorld(true);
      for (const d of [barrier.from + 1, barrier.from + 2, barrier.from + 3,
        barrier.to - 1, barrier.to - 2, barrier.to - 3]) {
        const half = exclusionAt(track, barrier, d, 0)!.halfWidth - KART_RADIUS;
        for (const side of [-1, 1]) {
          // Raycast the rendered triangles at mid-height; vertex-only tests miss
          // a chord cutting across the taper join or a narrowed circular section.
          ray.set(new THREE.Vector3(d, 0.6, -(barrier.center + side * 10)), new THREE.Vector3(0, 0, side));
          const hits = ray.intersectObject(pose, false);
          expect(hits.length, `${scenery} at ${d}, side ${side}`).toBeGreaterThan(0);
          expect(Math.abs(10 - hits[0].distance - half)).toBeLessThan(0.01);
        }
      }
    });
  });

  it.each([
    ['meadow', meadow], ['canyon', canyon], ['snowpeak', snowpeak], ['neon', neon],
    ['harbor', harbor], ['forest', forest], ['volcano', volcano], ['skyline', skyline],
  ] as const)('%s stays within its measured mesh budget', (id, theme) => {
    const track = getTrack(id);
    const motionMeshes = (track.def.barriers ?? []).filter(barrier => barrier.motion).length
      + track.def.surfaces.filter(zone => zone.kind === 'spin').length;
    const course = build(track, theme);
    const baseline = RENDER_BASELINE[id];
    expect(meshCount(course.group)).toBe(baseline.meshes);
    expect(course.group.getObjectByName('motion')!.children).toHaveLength(motionMeshes);
  });
});

function motionTrack(rate = 0.75, phase = 0): Track {
  return buildTrack({ ...islandTrack().def, widthKeys: undefined, splits: undefined, racingLine: [],
    barriers: [
      { from: 60, to: 80, center: -2, halfWidth: 2, taper: 4, scenery: 'block',
        motion: { kind: 'sweep', amplitude: 3, period: 8, phase } },
      { from: 110, to: 138, center: 3, halfWidth: 2, taper: 8, scenery: 'pillar',
        motion: { kind: 'gate', amplitude: 0, period: 8, phase, minWidth: 0.5 } },
    ], surfaces: [{ kind: 'spin', from: 180, to: 190, offsetMin: -2, offsetMax: 8, rate }],
  });
}

describe('moving bands and spin floors', () => {
  it.each([0.75, -0.75])('matches sim positions, widths and heading at each quarter cycle (rate %s)', rate => {
    const track = motionTrack(rate);
    const course = build(track, neon);
    const motionGroup = course.group.getObjectByName('motion') as THREE.Group;
    expect(motionGroup).toBeInstanceOf(THREE.Group);
    expect(motionGroup.parent).toBe(course.group);
    expect(motionGroup.children).toHaveLength(3);
    expect(course.group.getObjectByName('barriers:block')).toBeUndefined();
    expect(course.group.getObjectByName('barriers:pillar')).toBeUndefined();
    expect(course.group.getObjectByName('surface:spin')).toBeUndefined();
    const period = track.def.barriers![0].motion!.period;
    // Seek backwards too: a predictor correction must not accumulate rotation.
    for (const time of [0, period / 4, period / 2, period / 4, 0]) {
      course.update(time);
      track.def.barriers!.forEach((barrier, index) => {
        const mesh = motionGroup.getObjectByName(`motion:barrier:${index}`) as THREE.Mesh;
        const point = sampleTrack(track, (barrier.from + barrier.to) / 2);
        const center = barrierCenterAt(barrier, time);
        expect(mesh.position.x).toBeCloseTo(point.x + point.nx * center, 6);
        expect(mesh.position.z).toBeCloseTo(point.z + point.nz * center, 6);
        const lateral = (mesh.position.x - point.x) * point.nx + (mesh.position.z - point.z) * point.nz;
        expect(lateral).toBeCloseTo(center, 6);
        expect(mesh.scale.x).toBeCloseTo(barrierHalfWidthAt(barrier, time), 6);
        expect(mesh.scale.y).toBe(1);
        expect(mesh.scale.z).toBe(1);
      });
      const disc = motionGroup.getObjectByName('motion:spin:0') as THREE.Mesh<THREE.CircleGeometry>;
      expect(disc.rotation.y).toBeCloseTo(rate * time, 6);
      expect(disc.rotation.x).toBe(0);
      expect(disc.rotation.z).toBe(0);
      expect(disc.geometry.parameters.radius).toBe(5);
      const point = sampleTrack(track, 185);
      expect(disc.position.x).toBeCloseTo(point.x + point.nx * 3, 6);
      expect(disc.position.z).toBeCloseTo(point.z + point.nz * 3, 6);
      expect(disc.position.y).toBeCloseTo(point.y + 0.12, 6);
    }
  });

  it('initializes nonzero phases and gives exactly three single-material draws without shadow passes', () => {
    const track = motionTrack(0.75, Math.PI / 3);
    const plain = build(buildTrack({ ...track.def, barriers: [], surfaces: [] }), meadow);
    const course = build(track, meadow);
    expect(meshCount(course.group) - meshCount(plain.group)).toBe(3);
    const motionGroup = course.group.getObjectByName('motion')!;
    motionGroup.children.forEach(object => {
      expect(object).toBeInstanceOf(THREE.Mesh);
      expect(object).not.toBeInstanceOf(THREE.InstancedMesh);
      const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
      expect(Array.isArray(mesh.material)).toBe(false);
      expect(mesh.castShadow).toBe(false);
      expect(mesh.material.emissiveIntensity).toBeGreaterThan(0);
    });
    track.def.barriers!.forEach((barrier, index) => {
      const mesh = motionGroup.getObjectByName(`motion:barrier:${index}`) as THREE.Mesh;
      const point = sampleTrack(track, (barrier.from + barrier.to) / 2);
      expect(mesh.position.z).toBeCloseTo(point.z + point.nz * barrierCenterAt(barrier, 0), 6);
      expect(mesh.scale.x).toBeCloseTo(barrierHalfWidthAt(barrier, 0), 6);
      expect((mesh.material as THREE.MeshLambertMaterial).emissive.getHex()).toBe(meadow.colors.barrier ?? meadow.colors.post);
    });
    const disc = motionGroup.getObjectByName('motion:spin:0') as THREE.Mesh<THREE.CircleGeometry, THREE.MeshLambertMaterial>;
    expect(disc.material.emissive.getHex()).toBe(meadow.colors.surfaces.spin);
    expect(disc.material.map).toBeInstanceOf(THREE.DataTexture);
    expect(disc.material.emissiveMap).toBe(disc.material.map);
    const pixels = (disc.material.map as THREE.DataTexture).image.data!;
    expect(new Set(pixels).size).toBeGreaterThan(1);
  });

  it('keeps static bands batched and uses NEON emissive colors only for motion', () => {
    const base = motionTrack();
    const track = buildTrack({ ...base.def, barriers: [...base.def.barriers!,
      { from: 230, to: 250, center: 0, halfWidth: 2, scenery: 'block' },
    ] });
    const course = build(track, neon);
    const batch = course.group.getObjectByName('barriers:block') as THREE.InstancedMesh;
    expect(batch.count).toBe(1);
    const band = course.group.getObjectByName('motion:barrier:0') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    const disc = course.group.getObjectByName('motion:spin:0') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    expect(band.material.emissive.getHex()).toBe(neon.colors.motionBarrier);
    expect(disc.material.emissive.getHex()).toBe(neon.colors.motionSpin);
  });

  it('clears and detaches motion, returning renderer geometry memory to its pre-course value', () => {
    // Use Three's real renderer memory accounting in Node. Only GPU buffer/VAO
    // deletion is stubbed; WebGLGeometries owns increments and dispose listeners.
    const gl = {} as WebGLRenderingContext;
    const renderer = { info: new WebGLInfo(gl) };
    // @types/three omits the fourth bindingStates argument present in r180.
    const geometries = Reflect.construct(WebGLGeometries, [gl, { remove() {} }, renderer.info,
      { releaseStatesOfGeometry() {} }]) as WebGLGeometries;
    const existing = new THREE.Mesh(new THREE.BoxGeometry());
    geometries.get(existing, existing.geometry);
    const before = renderer.info.memory.geometries;
    const course = build(motionTrack(), neon);
    const motionGroup = course.group.getObjectByName('motion')!;
    const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
    course.group.traverse(object => {
      if (object instanceof THREE.Mesh) geometries.get(object, object.geometry);
    });
    motionGroup.children.forEach(object => {
      const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
      resources.add(mesh.geometry).add(mesh.material);
      if (mesh.material.map) resources.add(mesh.material.map);
    });
    const disposals = [...resources].map(resource => {
      const disposed = vi.fn();
      resource.addEventListener('dispose', disposed);
      return disposed;
    });
    expect(renderer.info.memory.geometries).toBeGreaterThan(before + 3);
    course.dispose();
    course.dispose();
    expect(motionGroup.children).toHaveLength(0);
    expect(motionGroup.parent).toBeNull();
    expect(course.group.children).not.toContain(motionGroup);
    expect(course.group.getObjectByName('motion')).toBeUndefined();
    expect(renderer.info.memory.geometries).toBe(before);
    disposals.forEach(disposed => expect(disposed).toHaveBeenCalledOnce());
    existing.geometry.dispose();
    (existing.material as THREE.Material).dispose();
  });

  it('disposes the standalone motion owner without removing its parent or siblings', () => {
    const parent = new THREE.Group();
    const sibling = new THREE.Group();
    parent.add(sibling);
    const updater = buildMotion(motionTrack(), neon, parent);
    const motionGroup = parent.getObjectByName('motion')!;
    updater.update(2);
    updater.dispose();
    expect(motionGroup.children).toHaveLength(0);
    expect(motionGroup.parent).toBeNull();
    expect(parent.children).toEqual([sibling]);
  });
});

describe('M6-09 pit rims and island clearance on real courses', () => {
  it.each([['volcano', volcano], ['skyline', skyline], ['canyon', canyon]] as const)(
    '%s pit decals follow the rim road height within 0.05 m', (id, theme) => {
      const track = getTrack(id);
      const { group } = build(track, theme);
      const pits = track.def.surfaces.filter(zone => zone.kind === 'pit');
      expect(pits.length).toBeGreaterThan(0);
      // The dark pit floor is recessed (and SKYLINE removes it for open air).
      // Warning paint is a separate decal on surviving asphalt at the rim.
      const vertices = (group.getObjectByName('pit-rims') as THREE.Mesh).geometry.getAttribute('position');
      for (let i = 0; i < vertices.count; i++) {
        const p = projectToTrack(track, vertices.getX(i), vertices.getZ(i), undefined, vertices.getY(i));
        expect(Math.abs(vertices.getY(i) - surfaceHeightAt(track, p.distance, p.offset) - 0.06),
          `${id} decal vertex ${i}`).toBeLessThanOrEqual(0.05);
      }
    });

  it.each([['volcano', volcano], ['skyline', skyline], ['canyon', canyon]] as const)(
    '%s has no wall or edge-ribbon vertices inside a pit', (id, theme) => {
      const track = getTrack(id);
      const { group } = build(track, theme);
      const pits = track.def.surfaces.filter(zone => zone.kind === 'pit');
      const matrix = new THREE.Matrix4(), point = new THREE.Vector3();
      let checked = 0;
      for (const name of ['rails', 'posts', 'curbs', 'line:-1', 'line:1', 'shoulder:-1', 'shoulder:1']) {
        const mesh = group.getObjectByName(name) as THREE.Mesh;
        const vertices = mesh.geometry.getAttribute('position');
        const count = mesh instanceof THREE.InstancedMesh ? mesh.count : 1;
        for (let instance = 0; instance < count; instance++) {
          if (mesh instanceof THREE.InstancedMesh) mesh.getMatrixAt(instance, matrix);
          else matrix.identity();
          for (let i = 0; i < vertices.count; i++) {
            point.fromBufferAttribute(vertices, i).applyMatrix4(matrix);
            // Local pit projections avoid confusing SKYLINE's two crossing levels.
            for (const pit of pits) {
              const center = sampleTrack(track, (pit.from + pit.to) / 2);
              if (Math.hypot(point.x - center.x, point.z - center.z) > 40) continue;
              const p = projectToTrack(track, point.x, point.z, center.distance, point.y);
              // sampleTrack interpolates normals, whereas projection uses the
              // centreline chords: rim vertices differ by < 0.1 m on bends.
              const lipTolerance = mesh instanceof THREE.InstancedMesh ? 0.02 : 0.1;
              if (p.distance <= pit.from + lipTolerance || p.distance >= pit.to - lipTolerance) continue;
              checked++;
              const half = widthAt(track, p.distance).roadHalfWidth;
              expect(p.offset > (pit.offsetMin ?? -half) + 0.01
                && p.offset < (pit.offsetMax ?? half) - 0.01, `${id} ${name} at ${p.distance}/${p.offset}`).toBe(false);
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

  it.each([['harbor', harbor], ['skyline', skyline], ['canyon', canyon], ['neon', neon]] as const)(
    '%s scatters no scenery in island sections narrower than 3 m', (id, theme) => {
      const track = getTrack(id);
      const { group } = build(track, theme);
      const islands = track.def.barriers!.filter(b => b.scenery === 'rock' || b.scenery === 'building');
      expect(islands.length).toBeGreaterThan(0);
      const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
      for (const barrier of islands) {
        const halfAt = (d: number) => barrier.halfWidth * Math.min(1,
          (d - barrier.from) / barrier.taper!, (barrier.to - d) / barrier.taper!);
        const props = group.getObjectByName(`island-scenery:${barrier.scenery}`) as THREE.InstancedMesh;
        expect(props.count).toBeGreaterThan(0);
        const candidates = Math.floor((barrier.to - barrier.from) / 6);
        expect(props.count).toBeLessThan(candidates); // Both actual tapered noses reproduce the old needles.
        for (let i = 0; i < props.count; i++) {
          props.getMatrixAt(i, matrix);
          position.setFromMatrixPosition(matrix);
          scale.setFromMatrixScale(matrix);
          const p = projectToTrack(track, position.x, position.z, undefined, position.y - scale.y / 2);
          const half = halfAt(p.distance);
          expect(2 * half, `${id} scenery at ${p.distance}`).toBeGreaterThanOrEqual(3 - 1e-4);
          expect(scale.x).toBeGreaterThanOrEqual(2 - 1e-4);
          // The complete footprint fits the tapered island, with 0.25 m on each side.
          for (const d of [p.distance - scale.z / 2, p.distance + scale.z / 2]) {
            expect(scale.x + 0.5).toBeLessThanOrEqual(2 * halfAt(d) + 1e-3);
          }
        }
      }
    });
});

describe('island splits', () => {
  it.each(['rock', 'building'] as const)('draws the %s island body and scenery every 6 m where its footprint clears the nose', scenery => {
    const track = islandTrack(scenery);
    const barrier = track.def.barriers![0];
    const { group } = build(track, canyon);
    const ribbon = group.getObjectByName('islands') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    expect(ribbon.material.color.getHex()).toBe(canyon.colors.ground);
    const vertices = ribbon.geometry.getAttribute('position');
    for (let i = 0; i < vertices.count; i++) {
      const distance = vertices.getX(i);
      const half = barrier.halfWidth * Math.min(1, (distance - barrier.from) / barrier.taper!,
        (barrier.to - distance) / barrier.taper!);
      expect(-vertices.getZ(i)).toBeCloseTo(barrier.center + (i % 2 * 2 - 1) * half, 4);
      expect(vertices.getY(i)).toBeCloseTo(0.06 + 0.15, 4);
    }
    for (const d of [barrier.from, barrier.from + barrier.taper!, barrier.to - barrier.taper!, barrier.to]) {
      expect(Array.from({ length: vertices.count }, (_, i) => vertices.getX(i)).some(x => Math.abs(x - d) < 0.001)).toBe(true);
    }
    expect(group.children.filter(o => o.name.startsWith('island-scenery:'))).toHaveLength(1);
    expect(group.children.some(o => o.name === `barriers:${scenery}`)).toBe(false);
    const props = group.getObjectByName(`island-scenery:${scenery}`) as THREE.InstancedMesh;
    expect(props).toBeInstanceOf(THREE.InstancedMesh);
    expect(props.count).toBeGreaterThan(0);
    expect(props.count).toBeLessThan(Math.floor((barrier.to - barrier.from) / 6));
    expect(props.geometry.type).toBe(scenery === 'rock' ? 'DodecahedronGeometry' : 'BoxGeometry');
    const matrix = new THREE.Matrix4();
    const heights: number[] = [];
    const positions: number[] = [];
    props.geometry.computeBoundingBox();
    for (let i = 0; i < props.count; i++) {
      props.getMatrixAt(i, matrix);
      const bounds = props.geometry.boundingBox!.clone().applyMatrix4(matrix);
      const height = bounds.max.y - bounds.min.y;
      heights.push(height);
      positions.push(new THREE.Vector3().setFromMatrixPosition(matrix).x);
      expect(height).toBeGreaterThanOrEqual(scenery === 'rock' ? 2 : 4);
      expect(height).toBeLessThanOrEqual(scenery === 'rock' ? 4 : 8);
      expect(bounds.min.y).toBeCloseTo(0.21, 5);
      if (props.castShadow) expect(height).toBeLessThanOrEqual(4);
    }
    expect(Math.max(...heights)).toBeGreaterThanOrEqual(4);
    positions.slice(1).forEach((x, i) => expect(x - positions[i]).toBeCloseTo(6, 4));
  });

  it.each([undefined, 'CANYON FORK'])('places two lane labels outside the walls 30 m before the nose (%s)', name => {
    const base = islandTrack();
    const split = { ...base.def.splits![0], name };
    const track = buildTrack({ ...base.def, splits: [split] });
    drawText.mockClear();
    const { group } = build(track, canyon);
    const signs = group.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.name.startsWith('lane-sign:'));
    expect(signs).toHaveLength(2);
    expect(drawText.mock.calls.map(call => call[0]).filter(text => /SHORT|SAFE/.test(String(text))))
      .toEqual(name ? [`${name} SAFE`, `${name} SHORT`] : ['SAFE', 'SHORT']);
    signs.forEach((sign, side) => {
      expect(sign.position.x).toBeCloseTo(split.from - 30, 4);
      expect(Math.abs(sign.position.x - (track.def.barriers![0].from - 30))).toBeLessThanOrEqual(1);
      expect(Math.abs(sign.position.z)).toBeGreaterThanOrEqual(widthAt(track, split.from - 30).wallHalfWidth + 0.25);
      expect(Math.sign(-sign.position.z)).toBe(side === 0 ? -1 : 1);
      expect((sign.material as THREE.MeshBasicMaterial).map).toBeInstanceOf(THREE.CanvasTexture);
      const normal = new THREE.Vector3(0, 0, 1).applyEuler(sign.rotation);
      const point = sampleTrack(track, split.from - 30);
      expect(normal.dot(new THREE.Vector3(-point.tx, 0, -point.tz))).toBeCloseTo(1, 5);
    });
  });

  it('merges ice 2 + dirt 1 + pit 1 into three decals and exposes a pit 0.3 m below the road', () => {
    const track = islandTrack();
    const { group } = build(track, canyon);
    const decals = group.children.filter(o => o.name.startsWith('surface:'));
    expect(decals.map(o => o.name).sort()).toEqual(['surface:dirt', 'surface:ice', 'surface:pit']);
    const pit = group.getObjectByName('surface:pit') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    expect(pit.material.color.getHex()).toBe(canyon.colors.surfaces.pit);
    const vertices = pit.geometry.getAttribute('position');
    for (let i = 0; i < vertices.count; i++) expect(vertices.getY(i)).toBeCloseTo(0.06 - 0.3, 4);
    group.updateMatrixWorld(true);
    const road = group.getObjectByName('road')!;
    for (const [distance, offset, expected] of [[150, 11, 'surface:pit'], [150, -11, 'road'], [144, 11, 'road'], [156, 11, 'road']] as const) {
      const ray = new THREE.Raycaster(new THREE.Vector3(distance, 10, -offset), new THREE.Vector3(0, -1, 0));
      expect(ray.intersectObjects([road, pit], false)[0]?.object.name).toBe(expected);
    }
  });

  // Island mesh budget, measured against the same course without islands and splits (CANYON and NEON each
  // measured +4 with one island): one merged island ribbon + one batch per scenery kind + two lane signs per
  // split. For one island +N = 4 (ribbon 1 + scenery 1 + signs 2); mixing rock and building adds one more
  // batch, +M = 5. Ribbon and scenery batches are per course (see the two-split test), so a second island adds
  // only its two signs. Pit decals are counted separately (+1 in the fixture below).
  const isIsland = (b: Barrier) => !b.motion && (b.scenery === 'rock' || b.scenery === 'building');
  const withoutIslands = (track: Track): Track => buildTrack({ ...track.def, splits: [],
    barriers: (track.def.barriers ?? []).filter(b => !isIsland(b)) });
  const islandBudget = (track: Track): number => {
    const kinds = new Set((track.def.barriers ?? []).filter(isIsland).map(b => b.scenery));
    return (kinds.size ? 1 + kinds.size : 0) + 2 * (track.def.splits ?? []).length;
  };

  it.each(['canyon', 'neon'] as const)('%s islands cost exactly the per-island budget', id => {
    const track = getTrack(id);
    const theme = id === 'canyon' ? canyon : neon;
    expect(islandBudget(track)).toBe(4);
    expect(meshCount(build(track, theme).group)).toBe(meshCount(build(withoutIslands(track), theme).group) + 4);
  });

  it.each(['rock', 'building'] as const)('adds four meshes plus the pit floor and rim decals for a %s island', scenery => {
    const track = islandTrack(scenery);
    const plain = buildTrack({ ...track.def, barriers: [], splits: [], surfaces: track.def.surfaces.filter(z => z.kind !== 'pit') });
    expect(meshCount(build(track, canyon).group)).toBe(meshCount(build(plain, canyon).group) + islandBudget(track) + 2);
  });

  it('adds one more batch when rock and building islands are mixed', () => {
    const track = islandTrack('rock');
    const mixed = buildTrack({ ...track.def, barriers: [...track.def.barriers!,
      { ...track.def.barriers![0]!, scenery: 'building' as const }] });
    expect(islandBudget(mixed)).toBe(5);
    expect(meshCount(build(mixed, canyon).group)).toBe(meshCount(build(track, canyon).group) + 1);
  });

  // Batching is per course, not per island: all islands share one ribbon mesh, and scenery is one InstancedMesh
  // per kind (rock, building) over every island. So mixing kinds adds exactly one batch for the whole course,
  // whether one island mixes them or each of two islands does; only the two lane signs scale with splits.
  it.each([
    ['both splits mixed', ['rock', 'building'], ['rock', 'building']],
    ['one kind per island', ['rock'], ['building']],
  ] as const)('counts a two-split course once per batch (%s)', (_label, first, second) => {
    const track = islandTrack('rock');
    const [barrier] = track.def.barriers!;
    const [split] = track.def.splits!;
    const shift = 250;
    const barriers = [
      ...first.map(scenery => ({ ...barrier!, scenery })),
      ...second.map(scenery => ({ ...barrier!, from: barrier!.from + shift, to: barrier!.to + shift, scenery })),
    ];
    const two = buildTrack({ ...track.def, barriers,
      splits: [split!, { ...split!, from: split!.from + shift, to: split!.to + shift }] });
    expect(islandBudget(two)).toBe(7);
    expect(meshCount(build(two, canyon).group)).toBe(meshCount(build(withoutIslands(two), canyon).group) + 7);
  });

  it('builds lane signs for splits alone, without rock or building scenery', () => {
    const track = islandTrack();
    const signsOnly = buildTrack({ ...track.def, barriers: [] });
    drawText.mockClear();
    const { group } = build(signsOnly, canyon);
    expect(group.children.filter(o => o.name.startsWith('lane-sign:'))).toHaveLength(2);
    expect(group.getObjectByName('islands')).toBeUndefined();
    expect(drawText.mock.calls.map(call => call[0]).filter(text => ['SHORT', 'SAFE'].includes(text)).sort())
      .toEqual(['SAFE', 'SHORT']);
  });
});

describe('minimap lane drawing', () => {
  class RecordedPath {
    readonly segments: number[][] = [];
    private current = [0, 0];
    moveTo(x: number, y: number) { this.current = [x, y]; }
    lineTo(x: number, y: number) {
      this.segments.push([...this.current, x, y]);
      this.current = [x, y];
    }
  }

  it.each([false, true])('leaves the island center clear and strokes both lane centers (wrapped: %s)', wrapped => {
    const base = islandTrack();
    const split = base.def.splits![0];
    const track = wrapped ? buildTrack({ ...base.def, splits: [{ ...split, from: base.length - 40, to: 180.83 }] }) : base;
    vi.stubGlobal('Path2D', RecordedPath);
    const lookup = vi.spyOn(trackRegistry, 'getTrack').mockReturnValue(track);
    try {
      const strokes: { path: RecordedPath; width: number; color: string }[] = [];
      const context = { lineWidth: 0, strokeStyle: '', setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke(path?: RecordedPath) { if (path) strokes.push({ path, width: this.lineWidth, color: this.strokeStyle }); } };
      // Node has no canvas rasterizer: exercise the real prepareMap/drawMap and
      // inspect every submitted stroke, including outline widths, in pixel space.
      const ui = Object.assign(Object.create(GameUI.prototype), { mapContext: context }) as {
        prepareMap(track: Track): void; drawMap(state: RaceState): void;
        mapScale: number; mapOffsetX: number; mapOffsetZ: number;
      };
      ui.prepareMap(track);
      ui.drawMap({ trackId: track.def.id, karts: [] } as unknown as RaceState);
      const hits = (distance: number, offset: number) => {
        const p = sampleTrack(track, distance);
        const x = (p.x + p.nx * offset) * ui.mapScale + ui.mapOffsetX;
        const y = (p.z + p.nz * offset) * ui.mapScale + ui.mapOffsetZ;
        return strokes.filter(stroke => stroke.path.segments.some(([ax, ay, bx, by]) => {
          const dx = bx - ax, dy = by - ay;
          const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
          if (t < 0 || t > 1) return false; // Canvas paths use the default butt caps.
          return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= stroke.width / 2;
        }));
      };
      expect(hits(140, 0)).toHaveLength(0);
      for (const lane of split.lanes) {
        expect(hits(140, (lane.offsetMin + lane.offsetMax) / 2).at(-1)?.color).toBe('rgba(255, 255, 255, .7)');
      }
      if (wrapped) expect(hits(track.length - 20, 0)).toHaveLength(0);
      else expect(hits(50, 0).at(-1)?.color).toBe('rgba(255, 255, 255, .7)');
    } finally {
      lookup.mockRestore();
    }
  });
});

describe('course resource ownership', () => {
  it.each([
    ['meadow', meadow], ['canyon', canyon], ['snowpeak', snowpeak], ['neon', neon],
  ] as const)('%s releases every geometry, material, label texture and instance buffer on repeated disposal', (id, theme) => {
    const scene = new THREE.Scene();
    for (let iteration = 0; iteration < 2; iteration++) {
      const island = islandSplit({ from: 240, to: 320, islandHalf: 6, laneWidth: 9, taper: 12,
        scenery: iteration === 0 ? 'rock' : 'building', risky: 'inner', bend: 1 });
      const course = build(buildTrack({ ...getTrack(id).def, ...island,
        barriers: [...island.barriers, { from: 80, to: 100, center: 0, halfWidth: 2, scenery: 'block' }],
        surfaces: [{ kind: 'dirt', from: 110, to: 140 }, { kind: 'dirt', from: 170, to: 200 },
          { kind: 'pit', from: 280, to: 290, offsetMin: 7, offsetMax: 15 }],
      }), theme);
      scene.add(course.group);
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>();
      const instances = new Set<THREE.InstancedMesh>();
      course.group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        for (const mat of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(mat);
          for (const value of Object.values(mat)) if (value instanceof THREE.Texture) textures.add(value);
        }
        if (object instanceof THREE.InstancedMesh) {
          instances.add(object);
          if (object.morphTexture) textures.add(object.morphTexture);
        }
      });
      expect(geometries.size).toBeGreaterThan(20);
      expect(textures.size).toBe(4 + theme.signFractions.length); // Banner, chevrons, two lane signs, morph texture.
      for (const name of ['islands', `island-scenery:${iteration === 0 ? 'rock' : 'building'}`,
        'lane-sign:0:0', 'lane-sign:0:1', 'surface:pit']) {
        const mesh = course.group.getObjectByName(name) as THREE.Mesh;
        expect(mesh).toBeInstanceOf(THREE.Mesh);
        expect(geometries.has(mesh.geometry)).toBe(true);
      }
      let geometryDisposals = 0;
      const initialGeometries = geometries.size;
      geometries.forEach(geometry => geometry.addEventListener('dispose', () => { geometries.delete(geometry); geometryDisposals++; }));
      materials.forEach(mat => mat.addEventListener('dispose', () => materials.delete(mat)));
      textures.forEach(texture => texture.addEventListener('dispose', () => textures.delete(texture)));
      instances.forEach(mesh => mesh.addEventListener('dispose', () => instances.delete(mesh)));
      course.dispose();
      course.dispose();
      expect(geometries.size).toBe(0);
      expect(materials.size).toBe(0);
      expect(textures.size).toBe(0);
      expect(instances.size).toBe(0);
      expect(geometryDisposals).toBe(initialGeometries);
      expect(course.group.children).toHaveLength(0);
      expect(scene.children).toHaveLength(0);
    }
  });

  it('owns custom props and landmarks, shared textures, non-map slots and shader textures', () => {
    const track = getTrack('meadow');
    const geometry = new THREE.BoxGeometry();
    const shared = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const normal = shared.clone();
    const uniformTexture = shared.clone();
    const material = new THREE.MeshStandardMaterial({ map: shared, emissiveMap: shared, normalMap: normal });
    const shader = new THREE.ShaderMaterial({ uniforms: { maps: { value: [shared, uniformTexture] } } });
    const disposalCounts = new Map<THREE.BufferGeometry | THREE.Material | THREE.Texture, number>();
    for (const resource of [geometry, shared, normal, uniformTexture, material, shader]) {
      disposalCounts.set(resource, 0);
      resource.addEventListener('dispose', () => disposalCounts.set(resource, disposalCounts.get(resource)! + 1));
    }
    const buildProps = vi.fn((input, group, budget) => {
      expect(input).toBe(track);
      expect(budget).toEqual({ trees: 1, rocks: 0, flowers: 0 });
      group.add(new THREE.Mesh(geometry, [material, shader]));
    });
    const buildLandmarks = vi.fn((input, group) => {
      expect(input).toBe(track);
      group.add(new THREE.Mesh(geometry, material));
    });
    const course = build(track, { ...meadow, budget: { trees: 1, rocks: 0, flowers: 0 }, buildProps, buildLandmarks });
    expect(buildProps).toHaveBeenCalledOnce();
    expect(buildLandmarks).toHaveBeenCalledOnce();
    course.dispose();
    course.dispose();
    expect([...disposalCounts.values()]).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

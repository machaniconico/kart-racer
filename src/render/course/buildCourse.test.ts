import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildTrack, getTrack, sampleTrack } from '../../sim';
import type { SurfaceZone } from '../../sim';
import { buildCourse, type Course } from './buildCourse';
import { meadow } from './themes/meadow';
import { canyon } from './themes/canyon';
import { snowpeak } from './themes/snowpeak';
import { neon } from './themes/neon';

// Only the browser's text drawing context is supplied. All three objects and
// their dispose events are real; these tests run in Vitest's node environment.
beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({
      fillRect() {}, fillText() {},
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

function hash(array: Float32Array): number {
  // Ignore signed zero and sub-pixel trigonometric differences across JS engines.
  const rounded = Int32Array.from(array, value => Math.round(value * 10000));
  let result = 0x811c9dc5;
  for (const byte of new Uint8Array(rounded.buffer)) {
    result = Math.imul(result ^ byte, 0x01000193);
  }
  return result >>> 0;
}

describe('MEADOW appearance regression', () => {
  it('keeps the original seed-127 instance transforms and colors, including distant scenery', () => {
    const { group } = build(getTrack('meadow'), meadow);
    // Captured by running the pre-extraction GameRenderer.buildScenery in node.
    const golden = [
      ['trunks', 150, 1182538673, undefined, 0x927050],
      ['crowns', 150, 2832418568, 334877105, 0x34a67b],
      ['rocks', 54, 2362437325, undefined, 0xa3b7a6],
      ['flowers', 120, 2170573238, undefined, 0xffe97e],
      ['peaks', 16, 2858478304, 3380652807, 0x75b99d],
      ['clouds', 36, 2799982802, undefined, 0xf7fff0],
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
    expect(road.count).toBe(770);
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
      ...base.def,
      scale: 1.25,
      roadHalfWidth: 6,
      surfaces: [
        { kind: 'ice', from: 40, to: 97 },
        { kind: 'boost', from: 173, to: 180, offsetMin: -4, offsetMax: -1 },
        { kind: 'jump', from: 240, to: 242.5, offsetMin: 0, offsetMax: 5 },
      ],
    });
    const { group } = build(track, meadow);
    for (const [index, zone] of track.def.surfaces.entries()) {
      const surface = group.getObjectByName(`surface:${zone.kind}:${index}`) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
      expect(surface.material.color.getHex()).toBe(meadow.colors.surfaces[zone.kind]);
      expect(surface.material.color.getHex()).not.toBe(meadow.colors.road);
      const positions = surface.geometry.getAttribute('position');
      const segments = positions.count / 2 - 1;
      for (let i = 0; i <= segments; i++) {
        const point = sampleTrack(track, zone.from + i / segments * (zone.to - zone.from));
        for (const [side, offset] of [zone.offsetMin ?? -track.def.roadHalfWidth, zone.offsetMax ?? track.def.roadHalfWidth].entries()) {
          expect(positions.getX(i * 2 + side)).toBeCloseTo(point.x + point.nx * offset, 4);
          expect(positions.getY(i * 2 + side)).toBeCloseTo(point.y + 0.1, 4);
          expect(positions.getZ(i * 2 + side)).toBeCloseTo(point.z + point.nz * offset, 4);
        }
      }
      expect(surface.geometry.getIndex()!.count).toBe(segments * 6);
    }
  });

  it('draws a single zone that wraps the finish line along the track, not as one chord', () => {
    const base = getTrack('meadow');
    const surfaces: SurfaceZone[] = [{ kind: 'ice', from: base.length - 60, to: 60 }];
    const { group } = build(buildTrack({ ...base.def, surfaces }), meadow);
    const positions = (group.getObjectByName('surface:ice:0') as THREE.Mesh).geometry.getAttribute('position');
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
    const { group } = build(buildTrack({ ...base.def, surfaces }), meadow);
    const end = (group.getObjectByName('surface:ice:0') as THREE.Mesh).geometry.getAttribute('position');
    const start = (group.getObjectByName('surface:ice:1') as THREE.Mesh).geometry.getAttribute('position');
    for (let side = 0; side < 2; side++) {
      expect([end.getX(end.count - 2 + side), end.getY(end.count - 2 + side), end.getZ(end.count - 2 + side)]).toEqual([
        start.getX(side), start.getY(side), start.getZ(side),
      ]);
    }
  });
});

describe('course resource ownership', () => {
  it.each([
    ['meadow', meadow], ['canyon', canyon], ['snowpeak', snowpeak], ['neon', neon],
  ] as const)('%s releases every geometry, material, label texture and instance buffer on repeated disposal', (id, theme) => {
    const scene = new THREE.Scene();
    for (let iteration = 0; iteration < 2; iteration++) {
      const course = build(getTrack(id), theme);
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
        if (object instanceof THREE.InstancedMesh) instances.add(object);
      });
      expect(geometries.size).toBeGreaterThan(20);
      expect(textures.size).toBe(5); // Front/rear banner share one texture; four chevrons.
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

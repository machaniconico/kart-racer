import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildTrack, getTrack, sampleTrack } from '../../sim';
import type { Barrier, SurfaceZone } from '../../sim';
import { exclusionAt, KART_RADIUS, widthAt } from '../../sim/corridor';
import { buildCourse, type Course } from './buildCourse';
import { meadow } from './themes/meadow';
import { canyon } from './themes/canyon';
import { snowpeak } from './themes/snowpeak';
import { neon } from './themes/neon';

// M1-04 BEFORE implementation, 2026-10-07: Chromium, 1280x720, DPR 1,
// desktop shadows, createRace(127, { trackId }), 8 stationary grid karts.
// GameRenderer.update(state, captureRenderSnapshot(state), 1, 0, 'race')
// rendered 10 times per course; EVERY frame had the calls/triangles below
// (renderer.info.render, including shadows). Meshes count buildCourse only.
const RENDER_BASELINE = {
  meadow: { drawCalls: 123, triangles: 41530, meshes: 29 },
  canyon: { drawCalls: 128, triangles: 46784, meshes: 33 },
  snowpeak: { drawCalls: 125, triangles: 41810, meshes: 33 },
  neon: { drawCalls: 125, triangles: 66080, meshes: 30 },
} as const;

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
        { kind: 'dirt', from: 300, to: 325 },
        { kind: 'pit', from: 350, to: 355 },
        { kind: 'spin', from: 400, to: 405 },
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
    const { group } = build(buildTrack({ ...base.def, surfaces }), meadow);
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
    const track = buildTrack({ ...base.def, widthKeys: [
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
    const track = buildTrack({ ...base.def, widthKeys: [
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
    return buildTrack({ ...getTrack('meadow').def, scale: 1, controlPoints: [
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
    const track = buildTrack({ ...base.def, barriers, surfaces: [
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
  ] as const)('%s stays within the pre-story mesh count + 2', (id, theme) => {
    const { group } = build(getTrack(id), theme);
    let meshes = 0;
    group.traverse(object => { if (object instanceof THREE.Mesh) meshes++; });
    expect(meshes).toBeLessThanOrEqual(RENDER_BASELINE[id].meshes + 2);
  });
});

describe('course resource ownership', () => {
  it.each([
    ['meadow', meadow], ['canyon', canyon], ['snowpeak', snowpeak], ['neon', neon],
  ] as const)('%s releases every geometry, material, label texture and instance buffer on repeated disposal', (id, theme) => {
    const scene = new THREE.Scene();
    for (let iteration = 0; iteration < 2; iteration++) {
      const course = build(buildTrack({ ...getTrack(id).def,
        barriers: [{ from: 80, to: 100, center: 0, halfWidth: 2, scenery: 'block' }],
        surfaces: [{ kind: 'dirt', from: 110, to: 140 }, { kind: 'dirt', from: 170, to: 200 }],
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
      expect(textures.size).toBe(6); // Banner, four chevrons, and one per-instance morph texture.
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

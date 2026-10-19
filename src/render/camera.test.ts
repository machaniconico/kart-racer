import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRace, getTrack, rollAt, sampleTrack, surfaceHeightAt, TRACK_IDS, wrapDistance } from '../sim';
import type { RaceState, Track, TrackId } from '../sim';
import { widthAt } from '../sim/corridor';
import { LOOK_AHEAD_MAX, lookAheadOffset, trackTurn } from './cameraLookAhead';
import { CHASE_CAMERA_LIFT, CHASE_ROAD_CLEARANCE, chaseCameraFloor, chaseCameraY, GameRenderer, LOOK_TARGET_LIFT,
  lookTargetY, ownRoadHeightAt } from './GameRenderer';
import { captureRenderSnapshot } from './snapshot';
import { spire } from './course/themes/spire';

describe('camera look-ahead', () => {
  it('is zero on a straight', () => {
    expect(lookAheadOffset(trackTurn(0, 1, 0, 1), false)).toBe(0);
  });
  it('is mirror-symmetric for left and right curves', () => {
    const a = 0.3;
    const left = lookAheadOffset(trackTurn(0, 1, Math.sin(a), Math.cos(a)), false);
    const right = lookAheadOffset(trackTurn(0, 1, -Math.sin(a), Math.cos(a)), false);
    expect(left).not.toBe(0);
    expect(left).toBeCloseTo(-right, 10);
  });
  it('never exceeds the cap', () => {
    for (const a of [0.5, 1, 2, 3, -3]) expect(Math.abs(lookAheadOffset(a, false))).toBeLessThanOrEqual(LOOK_AHEAD_MAX);
    expect(Math.abs(lookAheadOffset(3, false))).toBe(LOOK_AHEAD_MAX);
  });
  it('is zero under reduced motion', () => {
    expect(lookAheadOffset(1, true)).toBe(0);
  });
  it('drops the look-ahead when facing against the track and fades it when sideways', () => {
    expect(lookAheadOffset(0.4, false, -1)).toBe(0);
    expect(lookAheadOffset(0.4, false, 0.2)).toBe(0);
    expect(Math.abs(lookAheadOffset(0.4, false, 0.5))).toBeLessThan(Math.abs(lookAheadOffset(0.4, false, 1)));
    expect(lookAheadOffset(0.4, false, 1)).toBe(lookAheadOffset(0.4, false));
  });
});

const DT = 1 / 60;

// The real GameRenderer (course, karts, camera smoothing) over a stand-in WebGLRenderer that draws nothing.
const fakeWebGL = () => ({
  shadowMap: {}, outputColorSpace: '', info: { render: { calls: 0 }, programs: [] },
  setClearColor() {}, setPixelRatio() {}, setSize() {}, render() {}, dispose() {},
}) as unknown as THREE.WebGLRenderer;
const canvas = { clientWidth: 640, clientHeight: 360 } as HTMLCanvasElement;
const renderers = new Map<TrackId, { renderer: GameRenderer; state: RaceState }>();
beforeAll(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), devicePixelRatio: 1 });
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillText() {} }) }),
  });
});
afterAll(() => {
  for (const { renderer } of renderers.values()) renderer.dispose();
  vi.unstubAllGlobals();
});

function rig(id: TrackId): { renderer: GameRenderer; state: RaceState } {
  let entry = renderers.get(id);
  if (!entry) {
    const state = createRace(127, { trackId: id, karts: 1 });
    entry = { renderer: new GameRenderer(canvas, state, 0, { webgl: fakeWebGL() }), state };
    renderers.set(id, entry);
  }
  return entry;
}

interface Internals { desiredCamera: THREE.Vector3; desiredTarget: THREE.Vector3; cameraTarget: THREE.Vector3 }
interface ChaseFrame { distance: number; kartY: number; desiredY: number; camera: THREE.Vector3; targetY: number; desiredTargetY: number }

/**
 * Drives kart 0 along the centreline at a fixed speed through GameRenderer.update() at 60 fps and
 * records the actual (smoothed, floored) camera. `lift(d)` adds a jump arc above the road.
 */
function chase(id: TrackId, speed: number, from: number, to: number,
  lift: (distance: number) => number = () => 0): ChaseFrame[] {
  const track = getTrack(id);
  const { renderer, state } = rig(id);
  const kart = state.karts[0]!;
  const internals = renderer as unknown as Internals;
  // A mode change resets the camera history, as on a new race.
  renderer.update(state, captureRenderSnapshot(state), 1, 0, 'title', new Set());
  const frames: ChaseFrame[] = [];
  for (let d = from; d <= to; d += speed * DT) {
    const previous = captureRenderSnapshot(state);
    const p = sampleTrack(track, d);
    const arc = lift(d);
    Object.assign(kart, { x: p.x, y: p.y + arc, z: p.z, heading: Math.atan2(p.tx, p.tz), trackDistance: p.distance,
      lateralOffset: 0, speed, airTime: arc > 0 ? 0.5 : 0, driftTime: 0, driftDirection: 0 });
    renderer.update(state, previous, 1, DT, 'race', new Set());
    const { x, y, z } = renderer.getCameraPosition();
    frames.push({ distance: p.distance, kartY: kart.y, desiredY: internals.desiredCamera.y, camera: new THREE.Vector3(x, y, z),
      targetY: internals.cameraTarget.y, desiredTargetY: internals.desiredTarget.y });
  }
  return frames;
}

/**
 * Independent of the renderer's projection: the nearest road segment within the 60 m behind the
 * kart (the camera's own road), its banked height at the camera's offset.
 */
function ownRoadBelow(track: Track, frame: ChaseFrame): number {
  let nearest = Infinity, height = NaN;
  for (let i = 0; i < track.samples.length; i++) {
    const a = track.samples[i]!, b = track.samples[(i + 1) % track.samples.length]!;
    const behind = wrapDistance(track, frame.distance - a.distance);
    if (behind > 62 && behind < track.length - 8) continue;
    const dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
    if (!lengthSquared) continue;
    const t = Math.max(0, Math.min(1, ((frame.camera.x - a.x) * dx + (frame.camera.z - a.z) * dz) / lengthSquared));
    const lateral = Math.hypot(frame.camera.x - a.x - dx * t, frame.camera.z - a.z - dz * t);
    if (lateral >= nearest) continue;
    const d = a.distance + t * ((i + 1 === track.samples.length ? track.length : b.distance) - a.distance);
    const q = sampleTrack(track, d), half = widthAt(track, d).wallHalfWidth;
    const offset = Math.max(-half, Math.min(half, (frame.camera.x - q.x) * q.nx + (frame.camera.z - q.z) * q.nz));
    nearest = lateral;
    height = rollAt(track, d) === 0 ? q.y : surfaceHeightAt(track, d, offset);
  }
  return height;
}

const clearance = (track: Track, frame: ChaseFrame) => frame.camera.y - ownRoadBelow(track, frame);

/** The steepest descent by 4 m chord, as [distance, grade]. */
function steepest(track: Track): [number, number] {
  let best: [number, number] = [0, 0];
  for (let d = 0; d < track.length; d += 1) {
    const grade = (sampleTrack(track, d + 4).y - sampleTrack(track, d).y) / 4;
    if (grade < best[1]) best = [d, grade];
  }
  return best;
}

// Rounding between the renderer's projection and the brute-force reference.
const EPSILON = 1e-6;

describe('chase camera height (GameRenderer.update path)', () => {
  it.each(TRACK_IDS)('%s keeps the smoothed camera ≥ 1.5 m over its own road, sampled under 1 m', id => {
    const track = getTrack(id);
    const legacy = track.def.physics === undefined;
    for (const speed of [25, 45]) {
      for (const frame of chase(id, speed, 0, track.length)) {
        const at = `${id} ${speed} m/s at ${frame.distance.toFixed(1)}`;
        expect(clearance(track, frame), at).toBeGreaterThanOrEqual(CHASE_ROAD_CLEARANCE - EPSILON);
        if (!legacy) continue;
        // Legacy courses: neither the desired clamp nor the post-smoothing floor ever engages.
        expect(frame.desiredY, at).toBe(frame.kartY + CHASE_CAMERA_LIFT);
        expect(clearance(track, frame), at).toBeGreaterThan(CHASE_ROAD_CLEARANCE + 0.5);
      }
    }
  });

  it('the floor returns y itself when it clears the road, and the road height otherwise', () => {
    const track = getTrack('spire');
    const p = sampleTrack(track, 100);
    expect(chaseCameraFloor(track, p.x, p.y + 1.6, p.z, 100)).toBe(p.y + 1.6);
    expect(chaseCameraFloor(track, p.x, p.y + 0.2, p.z, 100)).toBeCloseTo(p.y + CHASE_ROAD_CLEARANCE, 9);
    // On the road itself, the hinted projection reads the centreline height.
    expect(ownRoadHeightAt(track, p.x, p.z, 100)).toBeCloseTo(p.y, 9);
  });

  it('holds 1.5 m over the road on the −0.50 plunge, where the fixed lift would sink below it', () => {
    const track = getTrack('spire');
    const [plunge, grade] = steepest(track);
    expect(grade).toBeLessThan(-0.45);
    const p = sampleTrack(track, plunge + 4);
    const heading = Math.atan2(p.tx, p.tz);
    const x = p.x - Math.sin(heading) * 10.6, z = p.z - Math.cos(heading) * 10.6;
    const road = ownRoadHeightAt(track, x, z, p.distance);
    expect(p.y + CHASE_CAMERA_LIFT - road).toBeLessThan(CHASE_ROAD_CLEARANCE);
    expect(chaseCameraY(track, x, z, p.y, p.distance)).toBeCloseTo(road + CHASE_ROAD_CLEARANCE, 9);
    for (const speed of [25, 45]) {
      const frames = chase('spire', speed, plunge - 120, plunge + 120);
      expect(frames.some(frame => frame.desiredY > frame.kartY + CHASE_CAMERA_LIFT)).toBe(true);
      for (const frame of frames) {
        expect(clearance(track, frame), `${speed} at ${frame.distance.toFixed(1)}`).toBeGreaterThanOrEqual(CHASE_ROAD_CLEARANCE - EPSILON);
      }
    }
  });

  it('clears the summit crest into the −0.45 descent by 1.5 m', () => {
    const track = getTrack('summit');
    let crest = 0;
    for (let d = 0; d < track.length; d++) if (sampleTrack(track, d).y > sampleTrack(track, crest).y) crest = d;
    const [descent, grade] = steepest(track);
    expect(grade).toBeLessThan(-0.4);
    for (const speed of [25, 45]) {
      const frames = chase('summit', speed, crest - 100, descent + 100);
      expect(frames.some(frame => frame.desiredY > frame.kartY + CHASE_CAMERA_LIFT)).toBe(true);
      for (const frame of frames) {
        expect(clearance(track, frame), `${speed} at ${frame.distance.toFixed(1)}`).toBeGreaterThanOrEqual(CHASE_ROAD_CLEARANCE - EPSILON);
      }
    }
  });

  it('rides above a 6 m jump arc; the look target takes half of it, with no step at landing', () => {
    const track = getTrack('chasm');
    const jump = track.def.surfaces.find(zone => zone.kind === 'jump' && zone.height === 6)!;
    const speed = 42;
    const span = jump.duration! * speed;
    const arc = (d: number) => {
      const t = (d - jump.to) / span;
      return t > 0 && t < 1 ? jump.height! * 4 * t * (1 - t) : 0;
    };
    const frames = chase('chasm', speed, jump.from - 80, jump.to + span + 60, arc);
    for (const frame of frames) {
      expect(frame.camera.y - frame.kartY).toBeGreaterThan(CHASE_ROAD_CLEARANCE);
      expect(clearance(track, frame)).toBeGreaterThanOrEqual(CHASE_ROAD_CLEARANCE - EPSILON);
    }
    const base = frames[0]!;
    expect(Math.max(...frames.map(frame => frame.kartY)) - base.kartY).toBeCloseTo(6, 1);
    expect(Math.max(...frames.map(frame => frame.desiredTargetY)) - base.desiredTargetY).toBeCloseTo(3, 1);
    // Continuous at take-off and landing: no frame-to-frame step in the desired target.
    const steps = frames.slice(1).map((frame, i) => Math.abs(frame.desiredTargetY - frames[i]!.desiredTargetY));
    expect(Math.max(...steps)).toBeLessThan(0.15);
  });

  it('keeps the exact previous airborne look target on legacy courses (half-arc is physics-only)', () => {
    const legacy = getTrack('meadow'), extreme = getTrack('chasm');
    expect(legacy.def.physics).toBeUndefined();
    expect(lookTargetY(legacy, 12, 4, true)).toBe(12 + LOOK_TARGET_LIFT);
    expect(lookTargetY(extreme, 12, 4, true)).toBe(8 + LOOK_TARGET_LIFT);
    expect(lookTargetY(extreme, 12, 4, false)).toBe(12 + LOOK_TARGET_LIFT);
    for (const id of ['meadow', 'canyon'] as const) {
      const frames = chase(id, 30, 100, 160, d => d > 120 && d < 140 ? 2 * Math.sin((d - 120) / 20 * Math.PI) : 0);
      for (const frame of frames) expect(frame.desiredTargetY).toBe(frame.kartY + 1.35);
    }
  });
});

describe('spire chase camera', () => {
  const track = getTrack('spire');
  const beams: THREE.Box3[] = [];
  let frames: ChaseFrame[] = [];
  beforeAll(() => {
    const tower = new THREE.Group();
    spire.buildLandmarks(track, tower);
    tower.updateMatrixWorld(true);
    tower.traverse(object => { if (object instanceof THREE.Mesh) beams.push(new THREE.Box3().setFromObject(object)); });
    frames = [25, 45].flatMap(speed => chase('spire', speed, 0, track.length));
  });

  it('never enters a tower beam (1 m margin for the near plane)', () => {
    expect(beams.length).toBeGreaterThan(10);
    for (const frame of frames) for (const [i, beam] of beams.entries()) {
      expect(beam.clone().expandByScalar(1).containsPoint(frame.camera), `beam ${i} at ${frame.distance.toFixed(1)}`).toBe(false);
    }
  });

  it('keeps ≥ 3 m from every other level of road at the camera position (plunge over turn 1, decks)', () => {
    let nearest = Infinity;
    for (const frame of frames) {
      for (let i = 0; i < track.samples.length; i++) {
        const a = track.samples[i]!, b = track.samples[(i + 1) % track.samples.length]!;
        const dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
        const t = Math.max(0, Math.min(1, ((frame.camera.x - a.x) * dx + (frame.camera.z - a.z) * dz) / lengthSquared));
        const d = a.distance + t * ((i + 1 === track.samples.length ? track.length : b.distance) - a.distance);
        if (Math.hypot(frame.camera.x - a.x - dx * t, frame.camera.z - a.z - dz * t) > widthAt(track, d).wallHalfWidth) continue;
        const behind = wrapDistance(track, frame.distance - d);
        if (behind < 60 || behind > track.length - 5) continue; // The camera's own road.
        const road = sampleTrack(track, d).y;
        // Under a deck, measure to the slab's underside (0.6 m below its top).
        nearest = Math.min(nearest, frame.camera.y >= road ? frame.camera.y - road : road - 0.54 - frame.camera.y);
      }
    }
    expect(nearest).toBeGreaterThan(3);
  });
});

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getTrack, sampleTrack } from '../sim';
import type { RaceState, Track, TrackId } from '../sim';
import { LOOK_AHEAD_DISTANCE, lookAheadOffset, trackTurn } from './cameraLookAhead';
import type { RenderSnapshot } from './snapshot';
import { buildCourse, disposeObjectTree, type Course } from './course/buildCourse';
import type { CourseTheme } from './course/CourseTheme';
import { meadow } from './course/themes/meadow';
import { canyon } from './course/themes/canyon';
import { snowpeak } from './course/themes/snowpeak';
import { neon } from './course/themes/neon';
import { attachKartEffects, createEntityMesh, entityPose, updateKartEffects, type KartEffectVisuals } from './itemVisuals';

const themes: Readonly<Record<TrackId, CourseTheme>> = { meadow, canyon, snowpeak, neon };

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const angleMix = (a: number, b: number, t: number) =>
  a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

function material(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

interface KartVisual {
  root: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Mesh[];
  paint: THREE.MeshLambertMaterial;
  sparks: THREE.InstancedMesh;
  effects: KartEffectVisuals;
}

/** Rendering owns all three objects; the serializable simulation stays unaware of them. */
export class GameRenderer {
  private readonly track: Track;
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(58, 1, 0.2, 650);
  private readonly sun: THREE.DirectionalLight;
  private readonly cameraTarget = new THREE.Vector3();
  private readonly desiredCamera = new THREE.Vector3();
  private readonly desiredTarget = new THREE.Vector3();
  // World-space (x, z) look-at shift, so a kart flipping round mid-blend cannot mirror it outward.
  private readonly lookAhead = { x: 0, z: 0 };
  private readonly sunOffset: THREE.Vector3;
  private readonly transform = new THREE.Object3D();
  private readonly kartVisuals: KartVisual[] = [];
  private readonly boxCubes: THREE.InstancedMesh;
  private readonly boxCores: THREE.InstancedMesh;
  private readonly entities = new Map<number, THREE.Mesh>();
  private readonly course: Course;
  private elapsed = 0;
  private cameraReady = false;
  private lastMode = '';
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private readonly canvas: HTMLCanvasElement, initial: RaceState, private readonly localKartId: number) {
    this.track = getTrack(initial.trackId);
    const theme = themes[this.track.def.themeId];
    const mobile = window.matchMedia('(pointer: coarse)').matches;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(theme.colors.sky);
    this.scene.fog = new THREE.Fog(theme.fog.color, theme.fog.near, theme.fog.far);
    const { hemisphere, sun } = theme.lighting;
    this.scene.add(new THREE.HemisphereLight(hemisphere.sky, hemisphere.ground, hemisphere.intensity));
    this.sun = new THREE.DirectionalLight(sun.color, sun.intensity);
    this.sun.position.set(...sun.position);
    this.sunOffset = new THREE.Vector3(...sun.offset);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -38, right: 38, top: 38, bottom: -38, near: 1, far: 230 });
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.08;
    this.scene.add(this.sun, this.sun.target);
    this.course = buildCourse(this.track, theme);
    this.scene.add(this.course.group);
    this.setRoster(initial.karts);
    const cubeGeometry = new THREE.BoxGeometry(1.3, 1.3, 1.3);
    cubeGeometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(Math.PI / 5, 0, Math.PI / 4)));
    this.boxCubes = new THREE.InstancedMesh(cubeGeometry, material(0x9ce9d2), initial.boxes.length);
    this.boxCores = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.62).translate(0, 0.2, 0), material(0xfff4a3), initial.boxes.length);
    this.boxCubes.castShadow = true;
    for (const mesh of [this.boxCubes, this.boxCores]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // The small set spans the course and bobs every frame; avoid stale instance bounds.
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    }
    this.resize();
  }

  /** Repaint karts by id (array index); missing karts are built, extra ones hidden. */
  setRoster(karts: readonly { color: number }[]): void {
    karts.forEach((kart, id) => {
      if (!this.kartVisuals[id]) {
        const visual = this.buildKart(kart.color);
        this.kartVisuals[id] = visual;
        this.scene.add(visual.root);
      }
      this.kartVisuals[id].paint.color.setHex(kart.color);
    });
    this.kartVisuals.forEach((visual, id) => { visual.root.visible = id < karts.length; });
  }

  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const mobile = window.matchMedia('(pointer: coarse)').matches;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
    this.renderer.shadowMap.type = mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  private buildKart(color: number): KartVisual {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const paint = material(color);
    const dark = material(0x243f43);
    const ivory = material(0xfffce4);
    const chassis = box(1.8, 0.48, 2.8, paint);
    chassis.position.y = 0.65;
    chassis.castShadow = true;
    body.add(chassis);
    const nose = box(1.3, 0.32, 1.3, paint);
    nose.position.set(0, 0.97, 0.77);
    body.add(nose);
    const stripe = box(0.27, 0.02, 1.2, ivory);
    stripe.position.set(0, 1.14, 0.77);
    body.add(stripe);
    const bumper = box(2.1, 0.22, 0.28, dark);
    bumper.position.set(0, 0.55, 1.45);
    body.add(bumper);
    const rear = bumper.clone();
    rear.position.z = -1.45;
    body.add(rear);
    const spoiler = box(2.3, 0.18, 0.5, paint);
    spoiler.position.set(0, 1.2, -1.3);
    body.add(spoiler);
    for (const x of [-0.7, 0.7]) {
      const support = box(0.12, 0.5, 0.15, dark);
      support.position.set(x, 1, -1.3);
      body.add(support);
    }
    const wheels: THREE.Mesh[] = [];
    const wheelGeometry = new THREE.CylinderGeometry(0.43, 0.43, 0.36, 10);
    const hubGeometry = new THREE.CylinderGeometry(0.19, 0.19, 0.38, 8);
    for (const x of [-1.02, 1.02]) for (const z of [-0.95, 0.94]) {
      const wheel = new THREE.Mesh(wheelGeometry, dark);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.45, z);
      const hub = new THREE.Mesh(hubGeometry, ivory);
      wheel.add(hub);
      body.add(wheel);
      wheels.push(wheel);
    }
    const seat = box(0.8, 0.6, 0.65, dark);
    seat.position.set(0, 1.05, -0.5);
    body.add(seat);
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.36, 0.65, 7), ivory);
    torso.position.set(0, 1.32, -0.22);
    body.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.46, 12, 8), paint);
    head.position.set(0, 1.92, -0.18);
    body.add(head);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.37, 10, 6), dark);
    visor.scale.set(1, 0.52, 0.45);
    visor.position.set(0, 1.93, 0.18);
    body.add(visor);
    const helmetStripe = box(0.16, 0.07, 0.67, ivory);
    helmetStripe.position.set(0, 2.34, -0.18);
    body.add(helmetStripe);
    const steering = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.045, 4, 10), dark);
    steering.position.set(0, 1.25, 0.45);
    steering.rotation.x = -0.45;
    body.add(steering);
    // Batch small static details by material; only the separate chassis casts a shadow.
    const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const originals = new Set<THREE.BufferGeometry>();
    for (const child of [...body.children]) {
      if (!(child instanceof THREE.Mesh) || child === chassis || wheels.includes(child)) continue;
      child.updateMatrix();
      const mat = child.material as THREE.Material;
      const parts = batches.get(mat) ?? [];
      parts.push(child.geometry.clone().applyMatrix4(child.matrix));
      batches.set(mat, parts);
      originals.add(child.geometry);
      body.remove(child);
    }
    for (const [mat, parts] of batches) {
      const merged = mergeGeometries(parts);
      if (merged) body.add(new THREE.Mesh(merged, mat));
      parts.forEach((part) => part.dispose());
    }
    originals.forEach((geo) => geo.dispose());
    const sparks = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.13), new THREE.MeshBasicMaterial({ color: 0x64e3ff }), 12);
    root.add(sparks);
    return { root, body, wheels, paint, sparks, effects: attachKartEffects(root) };
  }

  update(state: RaceState, previous: RenderSnapshot, alpha: number, dt: number, mode: 'title' | 'lobby' | 'race' | 'results'): void {
    if (state.trackId !== this.track.def.id) {
      throw new RangeError(`Renderer course ${this.track.def.id} does not match race course ${state.trackId}; recreate GameRenderer`);
    }
    this.elapsed += dt;
    if (mode !== this.lastMode) { this.cameraReady = false; this.lastMode = mode; }
    for (const kart of state.karts) {
      const visual = this.kartVisuals[kart.id];
      const prev = previous.karts[kart.id] ?? kart;
      visual.root.position.set(mix(prev.x, kart.x, alpha), mix(prev.y, kart.y, alpha), mix(prev.z, kart.z, alpha));
      visual.root.rotation.y = angleMix(prev.heading, kart.heading, alpha);
      const p = sampleTrack(this.track, kart.trackDistance);
      const next = sampleTrack(this.track, kart.trackDistance + 1);
      const slope = (next.y - p.y) * Math.cos(kart.heading - Math.atan2(p.tx, p.tz));
      visual.body.rotation.x = -Math.atan(slope);
      visual.body.rotation.z = -kart.steer * Math.min(kart.speed / 32, 1) * 0.075;
      visual.body.position.y = kart.hopTime > 0 ? Math.sin(Math.min(1, kart.hopTime / 0.35) * Math.PI) * 0.48 : 0;
      if (kart.spinTime > 0) visual.body.rotation.y = kart.spinTime * 14;
      else visual.body.rotation.y = kart.driftTime > 0 ? kart.driftDirection * 0.19 : 0;
      for (const wheel of visual.wheels) {
        wheel.rotation.x += kart.speed * dt / 0.43;
        wheel.rotation.y = wheel.position.z > 0 ? kart.steer * 0.3 : 0;
      }
      visual.sparks.visible = kart.driftTime > 0.15;
      if (visual.sparks.visible) {
        (visual.sparks.material as THREE.MeshBasicMaterial).color.setHex(kart.driftTime >= 1.5 ? 0xffae48 : kart.driftTime >= 0.65 ? 0x47dfff : 0xe2f7ea);
        for (let j = 0; j < visual.sparks.count; j++) {
          const t = ((this.elapsed * 2 + j / 12) % 1);
          this.transform.position.set((j % 2 ? -1 : 1) * (1.02 + t * 0.5), 0.2 + Math.sin(t * Math.PI) * 0.55, -1 - t * 2.4);
          this.transform.rotation.set(t * 6, t * 8, 0);
          this.transform.scale.setScalar(1 - t * 0.65);
          this.transform.updateMatrix();
          visual.sparks.setMatrixAt(j, this.transform.matrix);
        }
        visual.sparks.instanceMatrix.needsUpdate = true;
      }
      updateKartEffects(visual.effects, kart, this.elapsed, state.time);
    }
    state.boxes.forEach((item, i) => {
      this.transform.position.set(item.x, item.y + 1.5 + (this.reducedMotion ? 0 : Math.sin(this.elapsed * 2.6 + i) * 0.2), item.z);
      this.transform.rotation.set(0, this.elapsed * 1.1 + i, 0);
      this.transform.scale.setScalar(item.respawnTime <= 0 ? 1 : 0);
      this.transform.updateMatrix();
      this.boxCubes.setMatrixAt(i, this.transform.matrix);
      this.boxCores.setMatrixAt(i, this.transform.matrix);
    });
    this.boxCubes.instanceMatrix.needsUpdate = true;
    this.boxCores.instanceMatrix.needsUpdate = true;
    const active = new Set<number>();
    for (const item of [...state.projectiles, ...state.traps]) {
      active.add(item.id);
      let mesh = this.entities.get(item.id);
      if (!mesh) {
        mesh = createEntityMesh(item.kind);
        this.entities.set(item.id, mesh);
        this.scene.add(mesh);
      }
      const pose = entityPose(mesh);
      const prev = previous.entities.get(item.id) ?? item;
      mesh.position.set(mix(prev.x, item.x, alpha), mix(prev.y, item.y, alpha) + pose.lift, mix(prev.z, item.z, alpha));
      mesh.rotation.y = pose.spin ? this.elapsed * 9 : angleMix(prev.heading, item.heading, alpha);
    }
    for (const [id, mesh] of this.entities) if (!active.has(id)) {
      this.scene.remove(mesh);
      this.entities.delete(id);
    }
    const player = state.karts.find((kart) => kart.id === this.localKartId);
    const playerVisual = player ? this.kartVisuals[this.localKartId] : undefined;
    if (mode === 'title' || mode === 'lobby' || !player || !playerVisual) {
      const p = sampleTrack(this.track, this.track.length - 8);
      const orbit = this.reducedMotion ? 0 : Math.sin(this.elapsed * 0.08) * 0.12;
      const heading = Math.atan2(p.tx, p.tz) + orbit;
      this.desiredCamera.set(p.x - Math.sin(heading) * 30 - p.nx * 19, p.y + 18, p.z - Math.cos(heading) * 30 - p.nz * 19);
      this.desiredTarget.set(p.x + p.tx * 15 + p.nx * 8, p.y + 1.5, p.z + p.tz * 15 + p.nz * 8);
    } else {
      const playerPosition = playerVisual.root.position;
      const heading = playerVisual.root.rotation.y;
      const swing = this.reducedMotion ? 0 : player.driftDirection * Math.min(player.driftTime, 1) * 1.1;
      const distance = this.reducedMotion ? 10 : 9.5 + Math.max(0, player.speed - 20) * 0.055;
      this.desiredCamera.set(playerPosition.x - Math.sin(heading) * distance + Math.cos(heading) * swing, playerPosition.y + 5.1, playerPosition.z - Math.cos(heading) * distance - Math.sin(heading) * swing);
      const here = sampleTrack(this.track, player.trackDistance);
      const ahead = sampleTrack(this.track, player.trackDistance + LOOK_AHEAD_DISTANCE);
      const alignment = Math.sin(heading) * here.tx + Math.cos(heading) * here.tz;
      const lookTarget = lookAheadOffset(trackTurn(here.tx, here.tz, ahead.tx, ahead.tz), this.reducedMotion, alignment);
      // +lateral along the track itself is (tz, -tx): (cos h, -sin h) with (sin h, cos h) = (tx, tz).
      const blend = this.cameraReady ? 1 - Math.exp(-dt * 3) : 1;
      this.lookAhead.x += (lookTarget * here.tz - this.lookAhead.x) * blend;
      this.lookAhead.z += (-lookTarget * here.tx - this.lookAhead.z) * blend;
      this.desiredTarget.set(playerPosition.x + Math.sin(heading) * 6 + this.lookAhead.x, playerPosition.y + 1.35, playerPosition.z + Math.cos(heading) * 6 + this.lookAhead.z);
    }
    const follow = this.cameraReady ? 1 - Math.exp(-dt * 7) : 1;
    this.camera.position.lerp(this.desiredCamera, follow);
    this.cameraTarget.lerp(this.desiredTarget, follow);
    this.camera.lookAt(this.cameraTarget);
    this.cameraReady = true;
    this.course.sky.position.copy(this.camera.position);
    // Without a local kart (spectating, roster mismatch) the sun follows the camera target instead.
    const sunAnchor = playerVisual ? playerVisual.root.position : this.cameraTarget;
    this.sun.position.copy(sunAnchor).add(this.sunOffset);
    this.sun.target.position.copy(sunAnchor);
    this.renderer.render(this.scene, this.camera);
  }

  getTrackId(): TrackId {
    return this.track.def.id;
  }

  getDrawCalls(): number {
    return this.renderer.info.render.calls;
  }

  dispose(): void {
    this.course.dispose();
    disposeObjectTree(this.scene);
    this.sun.dispose();
    this.renderer.dispose();
  }
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  ROAD_HALF_WIDTH, WALL_HALF_WIDTH, TRACK_LENGTH,
  projectToTrack, sampleTrack,
} from '../sim';
import type { RaceState, TrackSample } from '../sim';
import type { RenderSnapshot } from './snapshot';
import { attachKartEffects, createEntityMesh, entityPose, updateKartEffects, type KartEffectVisuals } from './itemVisuals';

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
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(58, 1, 0.2, 650);
  private readonly sun = new THREE.DirectionalLight(0xfff1d4, 2.25);
  private readonly cameraTarget = new THREE.Vector3();
  private readonly desiredCamera = new THREE.Vector3();
  private readonly desiredTarget = new THREE.Vector3();
  private readonly sunOffset = new THREE.Vector3(55, 85, 35);
  private readonly transform = new THREE.Object3D();
  private readonly kartVisuals: KartVisual[] = [];
  private readonly boxCubes: THREE.InstancedMesh;
  private readonly boxCores: THREE.InstancedMesh;
  private readonly entities = new Map<number, THREE.Mesh>();
  private readonly sky: THREE.Mesh;
  private elapsed = 0;
  private cameraReady = false;
  private lastMode = '';
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private readonly canvas: HTMLCanvasElement, initial: RaceState, private readonly localKartId: number) {
    const mobile = window.matchMedia('(pointer: coarse)').matches;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0xa3dce6);
    this.scene.fog = new THREE.Fog(0xb4e1df, 170, 460);
    this.scene.add(new THREE.HemisphereLight(0xe5faff, 0x6d965b, 2.25));
    this.sun.position.set(70, 100, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -38, right: 38, top: 38, bottom: -38, near: 1, far: 230 });
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.08;
    this.scene.add(this.sun, this.sun.target);
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(600, 16, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { top: { value: new THREE.Color(0x51b8ed) }, bottom: { value: new THREE.Color(0xdff4ee) } },
      vertexShader: 'varying vec3 vPosition; void main(){vPosition=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vPosition; void main(){float t=smoothstep(-0.08,0.7,normalize(vPosition).y);gl_FragColor=vec4(mix(bottom,top,t),1.0);\n#include <colorspace_fragment>\n}',
    }));
    this.scene.add(this.sky);
    this.buildCourse();
    this.buildScenery();
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
    // Compiled away in production; lets browser QA call setRoster without touching main.ts.
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

  private ribbon(inner: number, outer: number, color: number, lift = 0, slope = false): void {
    const positions: number[] = [];
    const indices: number[] = [];
    // Use a distance grid so the final segment closes at exactly the first vertex.
    const count = 384;
    for (let i = 0; i <= count; i++) {
      const p = sampleTrack(i / count * TRACK_LENGTH);
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
    this.scene.add(mesh);
  }

  private buildCourse(): void {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), material(0x82c767));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.45;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ribbon(-ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, 0x596d73, 0.06);
    for (const side of [-1, 1]) {
      this.ribbon(side * ROAD_HALF_WIDTH, side * WALL_HALF_WIDTH, 0x98cf64, 0.01);
      this.ribbon(side * WALL_HALF_WIDTH, side * (WALL_HALF_WIDTH + 22), 0x82c767, 0, true);
      this.ribbon(side * (ROAD_HALF_WIDTH - 0.16), side * (ROAD_HALF_WIDTH + 0.06), 0xf8f6d8, 0.075);
    }
    const count = Math.floor(TRACK_LENGTH / 3);
    const curb = new THREE.InstancedMesh(new THREE.BoxGeometry(0.65, 0.16, TRACK_LENGTH / count + 0.1), material(0xffffff), count * 2);
    const rails = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.54, TRACK_LENGTH / count + 0.18), material(0xe9eee0), count * 2);
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 1.05, 0.22), material(0x547e6d), count * 2);
    const dashes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.13, 0.025, 1.8), material(0xaab8b4), Math.floor(count / 3));
    for (let i = 0; i < count; i++) {
      const p = sampleTrack((i + 0.5) / count * TRACK_LENGTH);
      for (let s = 0; s < 2; s++) {
        const side = s * 2 - 1;
        this.place(this.transform, p, side * (ROAD_HALF_WIDTH + 0.32), 0.12);
        curb.setMatrixAt(i * 2 + s, this.transform.matrix);
        curb.setColorAt(i * 2 + s, new THREE.Color(i % 2 ? 0xfff1d1 : 0xeb695f));
        this.place(this.transform, p, side * WALL_HALF_WIDTH, 0.83);
        rails.setMatrixAt(i * 2 + s, this.transform.matrix);
        this.place(this.transform, p, side * WALL_HALF_WIDTH, 0.51);
        posts.setMatrixAt(i * 2 + s, this.transform.matrix);
      }
      if (i % 3 === 0 && i / 3 < dashes.count) {
        this.place(this.transform, p, 0, 0.085);
        dashes.setMatrixAt(i / 3, this.transform.matrix);
      }
    }
    rails.castShadow = false;
    this.scene.add(curb, rails, posts, dashes);
    // Procedural checkered start line and a mint gantry.
    const start = sampleTrack(0);
    const arch = new THREE.Group();
    arch.position.set(start.x, start.y, start.z);
    arch.rotation.y = Math.atan2(start.tx, start.tz);
    const mint = material(0x175c50);
    for (const x of [-ROAD_HALF_WIDTH - 1.1, ROAD_HALF_WIDTH + 1.1]) {
      const post = box(0.65, 7.5, 0.65, mint);
      post.position.set(x, 3.75, 0);
      post.castShadow = true;
      arch.add(post);
    }
    const top = box(ROAD_HALF_WIDTH * 2 + 3, 1.6, 0.65, mint);
    top.position.y = 7;
    arch.add(top);
    const banner = this.textPlane('POCKET CIRCUIT', 768, 80, '#175c50', '#ffffff');
    banner.scale.set(ROAD_HALF_WIDTH * 1.5, 1.12, 1);
    banner.position.set(0, 7.02, -0.34);
    banner.rotation.y = Math.PI;
    arch.add(banner);
    const rear = banner.clone();
    rear.position.z = 0.34;
    rear.rotation.y = 0;
    arch.add(rear);
    const line = new THREE.InstancedMesh(new THREE.BoxGeometry(ROAD_HALF_WIDTH / 8, 0.03, 0.75), material(0xffffff), 48);
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 3; z++) {
        this.transform.position.set((x - 7.5) * ROAD_HALF_WIDTH / 8, 0.09, (z - 1) * 0.75);
        this.transform.rotation.set(0, 0, 0);
        this.transform.updateMatrix();
        line.setMatrixAt(x * 3 + z, this.transform.matrix);
        line.setColorAt(x * 3 + z, new THREE.Color((x + z) % 2 ? 0x203a3d : 0xffffee));
      }
    }
    arch.add(line);
    this.scene.add(arch);
    // Direction chevrons face approaching drivers at several bends.
    for (const fraction of [0.18, 0.37, 0.61, 0.82]) {
      const p = sampleTrack(TRACK_LENGTH * fraction);
      const sign = this.textPlane('› › ›', 256, 96, '#fff0aa', '#184f43');
      sign.position.set(p.x + p.nx * (WALL_HALF_WIDTH + 0.25), p.y + 2.5, p.z + p.nz * (WALL_HALF_WIDTH + 0.25));
      sign.scale.set(4.8, 1.8, 1);
      sign.rotation.y = Math.atan2(-p.nx, -p.nz);
      this.scene.add(sign);
    }
  }

  private place(object: THREE.Object3D, point: TrackSample, offset: number, lift: number): void {
    object.position.set(point.x + point.nx * offset, point.y + lift, point.z + point.nz * offset);
    const next = sampleTrack(point.distance + 0.5);
    object.rotation.set(-Math.atan2(next.y - point.y, 0.5), Math.atan2(point.tx, point.tz), 0, 'YXZ');
    object.scale.set(1, 1, 1);
    object.updateMatrix();
  }

  private textPlane(text: string, width: number, height: number, bg: string, fg: string): THREE.Mesh {
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

  private buildScenery(): void {
    // Scenery uses a local deterministic sequence and never consumes simulation RNG.
    let seed = 127;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const trees = 150;
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.27, 0.4, 2, 5), material(0x927050), trees);
    const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(2.4, 5.7, 6), material(0x34a67b), trees);
    const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1.6, 0), material(0xa3b7a6), 54);
    const flowers = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.22, 0), material(0xffe97e), 120);
    for (let i = 0; i < trees; i++) {
      let x = 0, z = 0, projection = projectToTrack(0, 0);
      for (let tries = 0; tries < 100; tries++) {
        x = (random() - 0.5) * 365;
        z = (random() - 0.5) * 365;
        projection = projectToTrack(x, z);
        if (Math.abs(projection.offset) > WALL_HALF_WIDTH + 6) break;
      }
      const y = Math.abs(projection.offset) < WALL_HALF_WIDTH + 22
        ? mix(projection.height, -1.35, (Math.abs(projection.offset) - WALL_HALF_WIDTH) / 22) : -1.35;
      const scale = 0.75 + random() * 0.7;
      this.transform.position.set(x, y + scale, z);
      this.transform.rotation.set(0, random() * 6.28, 0);
      this.transform.scale.setScalar(scale);
      this.transform.updateMatrix();
      trunks.setMatrixAt(i, this.transform.matrix);
      this.transform.position.y = y + 4.5 * scale;
      this.transform.updateMatrix();
      crowns.setMatrixAt(i, this.transform.matrix);
      crowns.setColorAt(i, new THREE.Color().setHSL(0.37 + random() * 0.07, 0.45, 0.37 + random() * 0.12));
      if (i < rocks.count) {
        this.transform.position.set(x + 3.5, y + 0.25, z + 2);
        this.transform.scale.set(scale * 1.5, scale * 0.8, scale);
        this.transform.updateMatrix();
        rocks.setMatrixAt(i, this.transform.matrix);
      }
    }
    for (let i = 0; i < flowers.count; i++) {
      const p = sampleTrack(random() * TRACK_LENGTH);
      const offset = (ROAD_HALF_WIDTH + 1.2 + random() * 1.2) * (i % 2 ? -1 : 1);
      this.place(this.transform, p, offset, 0.28);
      flowers.setMatrixAt(i, this.transform.matrix);
    }
    crowns.castShadow = true;
    trunks.castShadow = true;
    this.scene.add(trunks, crowns, rocks, flowers);
    const peaks = new THREE.InstancedMesh(new THREE.ConeGeometry(45, 65, 5), material(0x75b99d), 16);
    for (let i = 0; i < peaks.count; i++) {
      const angle = i / peaks.count * Math.PI * 2;
      this.transform.position.set(Math.cos(angle) * 290, 13 + random() * 12, Math.sin(angle) * 290);
      this.transform.rotation.set(0, random() * 3, 0);
      this.transform.scale.set(1 + random(), 0.7 + random() * 0.8, 1 + random());
      this.transform.updateMatrix();
      peaks.setMatrixAt(i, this.transform.matrix);
      peaks.setColorAt(i, new THREE.Color().setHSL(0.4, 0.26, 0.58 + random() * 0.08));
    }
    this.scene.add(peaks);
    const clouds = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xf7fff0 }), 36);
    for (let i = 0; i < clouds.count; i++) {
      const angle = i / clouds.count * Math.PI * 2;
      this.transform.position.set(Math.cos(angle) * 220, 48 + random() * 24, Math.sin(angle) * 220);
      this.transform.scale.set(8 + random() * 13, 3 + random() * 4, 5 + random() * 6);
      this.transform.rotation.set(0, 0, 0);
      this.transform.updateMatrix();
      clouds.setMatrixAt(i, this.transform.matrix);
    }
    this.scene.add(clouds);
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
    this.elapsed += dt;
    if (mode !== this.lastMode) { this.cameraReady = false; this.lastMode = mode; }
    for (const kart of state.karts) {
      const visual = this.kartVisuals[kart.id];
      const prev = previous.karts[kart.id] ?? kart;
      visual.root.position.set(mix(prev.x, kart.x, alpha), mix(prev.y, kart.y, alpha), mix(prev.z, kart.z, alpha));
      visual.root.rotation.y = angleMix(prev.heading, kart.heading, alpha);
      const p = sampleTrack(kart.trackDistance);
      const next = sampleTrack(kart.trackDistance + 1);
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
      const p = sampleTrack(TRACK_LENGTH - 8);
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
      this.desiredTarget.set(playerPosition.x + Math.sin(heading) * 6, playerPosition.y + 1.35, playerPosition.z + Math.cos(heading) * 6);
    }
    const follow = this.cameraReady ? 1 - Math.exp(-dt * 7) : 1;
    this.camera.position.lerp(this.desiredCamera, follow);
    this.cameraTarget.lerp(this.desiredTarget, follow);
    this.camera.lookAt(this.cameraTarget);
    this.cameraReady = true;
    this.sky.position.copy(this.camera.position);
    // Without a local kart (spectating, roster mismatch) the sun follows the camera target instead.
    const sunAnchor = playerVisual ? playerVisual.root.position : this.cameraTarget;
    this.sun.position.copy(sunAnchor).add(this.sunOffset);
    this.sun.target.position.copy(sunAnchor);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        geometries.add(object.geometry);
        for (const mat of Array.isArray(object.material) ? object.material : [object.material]) materials.add(mat);
      }
    });
    geometries.forEach((geo) => geo.dispose());
    materials.forEach((mat) => { if ('map' in mat && mat.map instanceof THREE.Texture) mat.map.dispose(); mat.dispose(); });
    this.renderer.dispose();
  }
}

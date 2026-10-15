import type { ItemType, KartEffects, ProjectileKind, TrapKind } from './itemTypes';
export type { ItemType } from './itemTypes';

export interface InputFrame {
  steer: number;
  throttle: number;
  brake: boolean;
  drift: boolean;
  useItem: boolean;
}

export interface InputSource {
  sample(state: RaceState, kartId: number): InputFrame;
}

export interface RacerSpec { name: string; color: number; human: boolean }
/** Profiles are in slot order; omitted slots use CPU defaults. */
export type CpuLevel = 'easy' | 'normal' | 'hard';
export const CPU_LEVELS: readonly CpuLevel[] = ['easy', 'normal', 'hard'];
export function isCpuLevel(value: unknown): value is CpuLevel {
  return (CPU_LEVELS as readonly unknown[]).includes(value);
}
export interface RaceOptions {
  trackId?: TrackId; racers?: readonly RacerSpec[]; laps?: number;
  /** Defaults to 'normal', which keeps the CPU formulas bit-exact. */
  cpuLevel?: CpuLevel;
  /** 1 to 8 karts; defaults to 8. */
  karts?: number;
  /** Defaults to true. */
  itemBoxes?: boolean;
}
export interface Pose { x: number; y: number; z: number; heading: number }
export interface KartState extends Pose {
  id: number;
  name: string;
  color: number;
  human: boolean;
  effects: KartEffects;
  speed: number;
  steer: number;
  trackDistance: number;
  lateralOffset: number;
  lap: number;
  nextCheckpoint: number;
  lapStartTime: number;
  lapTimes: number[];
  finishTime: number | null;
  driftTime: number;
  driftDirection: number;
  boostTime: number;
  spinTime: number;
  hopTime: number;
  airTime: number;
  item: ItemType | null;
  wrongWay: boolean;
  startedLap: boolean;
  lapProgress: number;
  lapValid: boolean;
  previousDrift: boolean;
  previousItem: boolean;
  aiPhase: number;
  hitCooldown: number;
  /** Index into track.def.barriers of the last band touched; -1 = none. */
  lastBand: number;
}
export interface ItemBox extends Pose { id: number; respawnTime: number }
export interface Projectile extends Pose {
  kind: ProjectileKind;
  id: number; ownerId: number; life: number; bounces: number;
}
export interface Trap extends Pose { kind: TrapKind; id: number; ownerId: number; life: number; age: number }
export interface RaceEvent {
  type: 'countdown' | 'go' | 'pickup' | 'hit' | 'boost' | 'lap' | 'finish' | 'use' |
    'block' | 'explode' | 'storm' | 'ink' | 'aura_start' | 'auto_start';
  kartId: number;
  value?: number;
  x?: number;
  z?: number;
}
export interface RaceState {
  trackId: TrackId;
  laps: number;
  tick: number;
  seed: number;
  phase: 'countdown' | 'racing' | 'finished';
  countdown: number;
  racingTicks: number;
  time: number;
  karts: KartState[];
  boxes: ItemBox[];
  projectiles: Projectile[];
  traps: Trap[];
  events: RaceEvent[];
  nextEntityId: number;
  cpuLevel: CpuLevel;
}
export interface TrackSample {
  x: number; y: number; z: number;
  tx: number; tz: number; nx: number; nz: number;
  distance: number;
}
export interface TrackProjection {
  distance: number; offset: number; height: number; heading: number;
}

export type TrackId = 'meadow' | 'canyon' | 'snowpeak' | 'neon' | 'harbor' | 'forest' | 'volcano' | 'skyline'
  | 'dunes' | 'garden' | 'speedway' | 'bayou' | 'cavern' | 'temple' | 'serpentine' | 'lunar';

export interface WidthKey {
  readonly distance: number;
  readonly roadHalfWidth: number;
  readonly wallHalfWidth: number;
}
/** Bank at an arc-length distance in metres; roll in radians, |roll| ≤ 0.35, > 0 raises the +offset side. */
export interface BankKey { readonly distance: number; readonly roll: number }
/** Deterministic motion evaluated at racingTicks × FIXED_DT seconds; countdown time is zero. */
export interface BarrierMotion {
  /** Sweep moves the lateral centre; gate varies the half-width about a fixed centre. */
  readonly kind: 'sweep' | 'gate';
  /** Nonnegative sweep displacement amplitude in metres; unused for gates. */
  readonly amplitude: number;
  /** Positive duration of one full cycle in seconds. */
  readonly period: number;
  /** Finite angular phase in radians; zero starts at the static geometry. */
  readonly phase: number;
  /** Gate's minimum half-width in metres (required for gates), greater than zero. */
  readonly minWidth?: number;
}
export interface Barrier {
  readonly from: number;
  readonly to: number;
  readonly center: number;
  readonly halfWidth: number;
  readonly taper?: number;
  readonly motion?: BarrierMotion;
  readonly scenery?: 'pillar' | 'rock' | 'building' | 'block';
}
export interface SplitSection {
  readonly name?: string;
  readonly from: number;
  readonly to: number;
  readonly lanes: readonly { readonly offsetMin: number; readonly offsetMax: number; readonly risk: 0 | 1 }[];
}

export interface SurfaceZone {
  readonly kind: 'ice' | 'boost' | 'jump' | 'dirt' | 'pit' | 'spin';
  readonly from: number;
  readonly to: number;
  readonly offsetMin?: number;
  readonly offsetMax?: number;
  /** Spin angular velocity in rad/s; required for spin zones, with 0 < |rate| ≤ 1.5. */
  readonly rate?: number;
}

export interface TrackDef {
  readonly id: TrackId;
  readonly name: string;
  readonly controlPoints: readonly (readonly [x: number, y: number, z: number])[];
  readonly scale: number;
  readonly samplesPerSegment: number;
  readonly spline?: 'uniform' | 'centripetal';
  readonly roadHalfWidth: number;
  readonly wallHalfWidth: number;
  readonly checkpointCount: number;
  readonly boxRows: readonly number[];
  readonly boxLanes: readonly number[];
  readonly racingLine: readonly { readonly distance: number; readonly offset: number }[];
  readonly surfaces: readonly SurfaceZone[];
  readonly themeId: TrackId;
  readonly layoutVersion?: number;
  readonly widthKeys?: readonly WidthKey[];
  /** Linearly interpolated roll (rollAt), wrapping across the seam like widthKeys; absent means 0. */
  readonly bankKeys?: readonly BankKey[];
  readonly barriers?: readonly Barrier[];
  readonly splits?: readonly SplitSection[];
  /** Elevated sections in arc-length metres, for rendering only (supports under the upper pass). */
  readonly decks?: readonly { readonly from: number; readonly to: number }[];
  /** Fraction of checkpoint spacing, applied to gates 1..n-1; gate 0 stays at zero. */
  readonly checkpointPhase?: number;
}

export interface Track {
  readonly def: TrackDef;
  readonly samples: readonly Readonly<TrackSample>[];
  readonly length: number;
  readonly checkpointDistances: readonly number[];
  readonly boxPoses: readonly Readonly<Pose>[];
}

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
export interface RaceOptions { trackId?: TrackId; racers?: readonly RacerSpec[] }
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
}
export interface TrackSample {
  x: number; y: number; z: number;
  tx: number; tz: number; nx: number; nz: number;
  distance: number;
}
export interface TrackProjection {
  distance: number; offset: number; height: number; heading: number;
}

export type TrackId = 'meadow' | 'canyon' | 'snowpeak' | 'neon';

export interface SurfaceZone {
  readonly kind: 'ice' | 'boost' | 'jump';
  readonly from: number;
  readonly to: number;
  readonly offsetMin?: number;
  readonly offsetMax?: number;
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
}

export interface Track {
  readonly def: TrackDef;
  readonly samples: readonly Readonly<TrackSample>[];
  readonly length: number;
  readonly checkpointDistances: readonly number[];
  readonly boxPoses: readonly Readonly<Pose>[];
}

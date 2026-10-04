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
export interface RaceOptions { racers?: readonly RacerSpec[] }
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

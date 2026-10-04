import type * as THREE from 'three';
import type { Track } from '../../sim';

export interface SceneryBudget {
  readonly trees: number;
  readonly rocks: number;
  readonly flowers: number;
}

/** Theme builders attach owned resources to the course group for disposal. */
export interface CourseTheme {
  readonly colors: {
    readonly sky: number;
    readonly skyTop: number;
    readonly skyBottom: number;
    readonly ground: number;
    readonly road: number;
    readonly shoulder: number;
    readonly line: number;
    readonly curb: readonly [number, number];
    readonly rail: number;
    readonly post: number;
    readonly dash: number;
    readonly gate: number;
    readonly bannerBackground: string;
    readonly bannerText: string;
    readonly checker: readonly [number, number];
    readonly signBackground: string;
    readonly signText: string;
    readonly surfaces: Readonly<Record<'ice' | 'boost' | 'jump', number>>;
  };
  readonly fog: { readonly color: number; readonly near: number; readonly far: number };
  readonly lighting: {
    readonly hemisphere: { readonly sky: number; readonly ground: number; readonly intensity: number };
    readonly sun: {
      readonly color: number;
      readonly intensity: number;
      readonly position: readonly [number, number, number];
      readonly offset: readonly [number, number, number];
    };
  };
  readonly signFractions: readonly number[];
  readonly budget: SceneryBudget;
  buildProps(track: Track, scene: THREE.Group, budget: SceneryBudget): void;
  buildLandmarks(track: Track, scene: THREE.Group): void;
}

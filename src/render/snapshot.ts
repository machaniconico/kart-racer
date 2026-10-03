import type { Pose, RaceState } from '../sim';

export interface RenderSnapshot {
  karts: Pose[];
  entities: Map<number, Pose>;
}

/** Copy poses before each fixed tick so later simulation mutations cannot change them. */
export function captureRenderSnapshot(state: RaceState): RenderSnapshot {
  const pose = ({ x, y, z, heading }: Pose): Pose => ({ x, y, z, heading });
  return {
    karts: state.karts.map(pose),
    entities: new Map([...state.projectiles, ...state.traps].map((item) => [item.id, pose(item)])),
  };
}

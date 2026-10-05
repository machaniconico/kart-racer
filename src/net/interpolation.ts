import type { Pose, RaceState } from '../sim/types';
import type { Snapshot } from './snapshotCodec';

export const INTERPOLATION_DELAY_MS = 100;
export const MAX_EXTRAPOLATION_MS = 100;
const HISTORY_MS = 1000;

function mixPose(target: Pose, from: Pose, to: Pose, alpha: number): void {
  target.x = from.x + (to.x - from.x) * alpha;
  target.y = from.y + (to.y - from.y) * alpha;
  target.z = from.z + (to.z - from.z) * alpha;
  const turn = Math.atan2(Math.sin(to.heading - from.heading), Math.cos(to.heading - from.heading));
  target.heading = from.heading + turn * alpha;
}

/** Pose interpolation never advances the simulation or changes its authoritative snapshots. */
export function interpolateState(from: Snapshot, to: Snapshot, hostTime: number, latest: Snapshot = to): RaceState {
  const state = structuredClone(latest.state);
  const duration = to.hostTime - from.hostTime;
  const alpha = duration > 0 ? Math.max(0, Math.min(1, (hostTime - from.hostTime) / duration)) : 1;
  const seconds = Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, hostTime - to.hostTime)) / 1000;
  for (const kart of state.karts) {
    const previous = from.state.karts.find(entry => entry.id === kart.id);
    const current = to.state.karts.find(entry => entry.id === kart.id);
    if (!current) continue;
    mixPose(kart, previous ?? current, current, alpha);
    const discrete = previous && alpha < 1 ? previous : current;
    kart.speed = discrete.speed;
    kart.driftTime = discrete.driftTime;
    kart.boostTime = discrete.boostTime;
    kart.spinTime = discrete.spinTime;
    kart.hopTime = discrete.hopTime;
    kart.hitCooldown = discrete.hitCooldown;
    for (const timer of ['rouletteTime', 'rapidTime', 'auraTime', 'shrinkTime', 'inkTime', 'autoTime'] as const) {
      kart.effects[timer] = discrete.effects[timer];
    }
    kart.x += Math.sin(kart.heading) * kart.speed * seconds;
    kart.z += Math.cos(kart.heading) * kart.speed * seconds;
  }
  const oldEntities = new Map([...from.state.projectiles, ...from.state.traps].map(entity => [entity.id, entity]));
  const newEntities = new Map([...to.state.projectiles, ...to.state.traps].map(entity => [entity.id, entity]));
  for (const entity of [...state.projectiles, ...state.traps]) {
    const previous = oldEntities.get(entity.id);
    const current = newEntities.get(entity.id);
    if (!previous || !current || previous.kind !== entity.kind) continue;
    mixPose(entity, previous, current, alpha);
    if ('bounces' in entity && duration > 0 && seconds > 0) {
      const scale = seconds * 1000 / duration;
      entity.x += (current.x - previous.x) * scale;
      entity.y += (current.y - previous.y) * scale;
      entity.z += (current.z - previous.z) * scale;
    }
  }
  state.events = [];
  return state;
}

/** One second of ordered snapshots, plus the preceding interpolation anchor. */
export class SnapshotBuffer {
  private snapshots: Snapshot[] = [];
  private lastSampleTime = -Infinity;

  get size(): number { return this.snapshots.length; }

  push(snapshot: Snapshot): boolean {
    const latest = this.snapshots.at(-1);
    if (!Number.isFinite(snapshot.hostTime) || snapshot.hostTime < 0 ||
      (latest && (snapshot.raceId !== latest.raceId || snapshot.state.tick <= latest.state.tick ||
        snapshot.hostTime < latest.hostTime))) return false;
    this.snapshots.push(structuredClone(snapshot));
    const cutoff = snapshot.hostTime - HISTORY_MS;
    while (this.snapshots.length > 2 && this.snapshots[1].hostTime < cutoff) this.snapshots.shift();
    if (this.snapshots.length > 64) this.snapshots.shift();
    return true;
  }

  sample(hostTime: number): RaceState | null {
    if (!this.snapshots.length || !Number.isFinite(hostTime)) return null;
    // Clock offset corrections and older rAF timestamps must not rewind poses.
    hostTime = Math.max(hostTime, this.lastSampleTime);
    this.lastSampleTime = hostTime;
    const first = this.snapshots[0];
    const latest = this.snapshots.at(-1)!;
    if (hostTime < first.hostTime) return interpolateState(first, first, first.hostTime, latest);
    for (let index = 1; index < this.snapshots.length; index++) {
      const next = this.snapshots[index];
      if (next.hostTime > hostTime) return interpolateState(this.snapshots[index - 1], next, hostTime, latest);
    }
    return interpolateState(this.snapshots.at(-2) ?? latest, latest, hostTime);
  }

  clear(): void { this.snapshots = []; this.lastSampleTime = -Infinity; }
}

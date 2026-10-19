import type { Pose, RaceState } from '../sim/types';
import { TICK_MS } from './clock';
import type { Snapshot } from './snapshotCodec';

export const INTERPOLATION_DELAY_MS = 100;
export const MAX_EXTRAPOLATION_MS = 100;
const HISTORY_MS = 1000;
/**
 * Backstop when a fall marker is missing: a pair whose kart moved farther than this plus a generous
 * 60 m/s over the pair's simulated time is a teleport (respawn), never interpolated through.
 */
export const TELEPORT_METRES = 15;
const TELEPORT_SPEED = 60;

function mixPose(target: Pose, from: Pose, to: Pose, alpha: number): void {
  target.x = from.x + (to.x - from.x) * alpha;
  target.y = from.y + (to.y - from.y) * alpha;
  target.z = from.z + (to.z - from.z) * alpha;
  const turn = Math.atan2(Math.sin(to.heading - from.heading), Math.cos(to.heading - from.heading));
  target.heading = from.heading + turn * alpha;
}

/**
 * Pose interpolation never advances the simulation or changes its authoritative snapshots.
 * Karts in `respawned` teleported between `from` and `to`: they show `to`, never a blend across the gap.
 */
export function interpolateState(from: Snapshot, to: Snapshot, hostTime: number, latest: Snapshot = to,
  respawned: ReadonlySet<number> = new Set()): RaceState {
  const state = structuredClone(latest.state);
  const duration = to.hostTime - from.hostTime;
  const alpha = duration > 0 ? Math.max(0, Math.min(1, (hostTime - from.hostTime) / duration)) : 1;
  const seconds = Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, hostTime - to.hostTime)) / 1000;
  // Rates use simulated time: a slow host can send two snapshots within one wall millisecond.
  const rateDuration = (to.state.tick - from.state.tick) * TICK_MS;
  for (const kart of state.karts) {
    const current = to.state.karts.find(entry => entry.id === kart.id);
    if (!current) continue;
    const previous = respawned.has(kart.id) ? undefined : from.state.karts.find(entry => entry.id === kart.id);
    mixPose(kart, previous ?? current, current, alpha);
    const discrete = previous && alpha < 1 ? previous : current;
    kart.speed = discrete.speed;
    kart.driftTime = discrete.driftTime;
    kart.boostTime = discrete.boostTime;
    kart.spinTime = discrete.spinTime;
    kart.hopTime = discrete.hopTime;
    kart.hitCooldown = discrete.hitCooldown;
    kart.lastBand = discrete.lastBand;
    for (const timer of ['rouletteTime', 'rapidTime', 'auraTime', 'shrinkTime', 'inkTime', 'autoTime'] as const) {
      kart.effects[timer] = discrete.effects[timer];
    }
    // Advance along the travel direction (heading minus drift slip, as the sim moves) at the latest
    // speed, turning it at the last snapshot pair's heading rate so a curve is followed as an arc.
    const travel = kart.heading - kart.driftDirection * Math.min(0.23, kart.driftTime * 0.35);
    const turn = previous && rateDuration > 0 && seconds > 0
      ? Math.atan2(Math.sin(current.heading - previous.heading), Math.cos(current.heading - previous.heading)) * seconds * 1000 / rateDuration
      : 0;
    // sin(a + t) - sin(a) = 2 sin(t/2) cos(a + t/2): the exact arc, and the straight line as turn -> 0.
    const chord = Math.abs(turn) > 1e-9 ? 2 * Math.sin(turn / 2) / turn : 1;
    kart.x += Math.sin(travel + turn / 2) * kart.speed * seconds * chord;
    kart.z += Math.cos(travel + turn / 2) * kart.speed * seconds * chord;
    // Karts carry no vertical speed, so extrapolate y along the last snapshot pair's slope.
    if (previous && rateDuration > 0) kart.y += (current.y - previous.y) * seconds * 1000 / rateDuration;
  }
  const oldEntities = new Map([...from.state.projectiles, ...from.state.traps].map(entity => [entity.id, entity]));
  const newEntities = new Map([...to.state.projectiles, ...to.state.traps].map(entity => [entity.id, entity]));
  for (const entity of [...state.projectiles, ...state.traps]) {
    const previous = oldEntities.get(entity.id);
    const current = newEntities.get(entity.id);
    if (!previous || !current || previous.kind !== entity.kind) continue;
    mixPose(entity, previous, current, alpha);
    if ('bounces' in entity && rateDuration > 0 && seconds > 0) {
      const scale = seconds * 1000 / rateDuration;
      entity.x += (current.x - previous.x) * scale;
      entity.y += (current.y - previous.y) * scale;
      entity.z += (current.z - previous.z) * scale;
    }
  }
  state.events = [];
  return state;
}

/** Karts that teleported between two snapshots: a host fall marker in (from, to], or the displacement backstop. */
export function respawnedBetween(from: Snapshot, to: Snapshot, falls: readonly { kartId: number; tick: number }[]): Set<number> {
  const respawned = new Set<number>();
  for (const fall of falls) if (fall.tick > from.state.tick && fall.tick <= to.state.tick) respawned.add(fall.kartId);
  const seconds = (to.state.tick - from.state.tick) * TICK_MS / 1000;
  for (const current of to.state.karts) {
    const previous = from.state.karts.find(entry => entry.id === current.id);
    if (previous && Math.hypot(current.x - previous.x, current.z - previous.z) > TELEPORT_METRES + TELEPORT_SPEED * seconds) {
      respawned.add(current.id);
    }
  }
  return respawned;
}

/** One second of ordered snapshots, plus the preceding interpolation anchor. */
export class SnapshotBuffer {
  private snapshots: Snapshot[] = [];
  private lastSampleTime = -Infinity;
  private falls: { kartId: number; tick: number }[] = [];
  private respawnedNow = new Set<number>();

  /** Karts the latest sample() showed at a respawn instead of interpolating to it. */
  get respawned(): ReadonlySet<number> { return this.respawnedNow; }

  /** A host 'fall' event, from an events batch flushed at `tick`: the respawn happened at or before it. */
  markFall(kartId: number, tick: number): void {
    this.falls.push({ kartId, tick });
    const oldest = this.snapshots[0]?.state.tick ?? -Infinity;
    this.falls = this.falls.filter(fall => fall.tick > oldest);
  }

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
    this.respawnedNow = new Set();
    if (hostTime < first.hostTime) return interpolateState(first, first, first.hostTime, latest);
    let from = this.snapshots.at(-2) ?? latest, to = latest, newest = to;
    for (let index = 1; index < this.snapshots.length; index++) {
      if (this.snapshots[index].hostTime > hostTime) { from = this.snapshots[index - 1]; to = this.snapshots[index]; newest = latest; break; }
    }
    this.respawnedNow = respawnedBetween(from, to, this.falls);
    return interpolateState(from, to, hostTime, newest, this.respawnedNow);
  }

  clear(): void { this.snapshots = []; this.lastSampleTime = -Infinity; this.falls = []; this.respawnedNow = new Set(); }
}

import { getAIInput } from '../sim/ai';
import { FIXED_DT, stepRace } from '../sim/race';
import type { InputFrame, KartState, Pose, RaceState } from '../sim/types';
import { NEUTRAL_INPUT, quantizeInput } from './inputBuffer';
import type { RosterPlayer } from './session';
import type { Snapshot } from './snapshotCodec';

export const MAX_REPLAY_TICKS = 40;
export const VISUAL_DECAY_SECONDS = 0.08;
export const VISUAL_SNAP_METRES = 1.5;
const TIMER_SCALES = { boostTime: 50, spinTime: 50, hopTime: 100, airTime: 100, hitCooldown: 100, driftTime: 100,
  rouletteTime: 20 } as const;
type Timers = Pick<KartState, Exclude<keyof typeof TIMER_SCALES, 'rouletteTime'>> & { id: number; rouletteTime: number };

/** Owns a disposable simulation. Only host events may leave GuestSession. */
export class Predictor {
  private predicted: RaceState;
  private readonly pending = new Map<number, InputFrame>();
  private newestInputTick = 0;
  private lastInputs: InputFrame[];
  private localInput: InputFrame;
  private authoritativeTick: number;
  private readonly raceId: number;
  private cpuSlots: Set<number> | null = null;
  private offset = { x: 0, y: 0, z: 0 };
  private previousPose: Pose;
  private replayCount = 0;
  private readonly timerHistory = new Map<number, Timers[]>();

  constructor(snapshot: Snapshot, readonly localSlot: number) {
    this.predicted = structuredClone(snapshot.state);
    const kart = this.predicted.karts.find(entry => entry.id === localSlot);
    if (!kart) throw new RangeError('Unknown prediction slot');
    this.previousPose = this.pose(kart);
    this.predicted.events = [];
    this.lastInputs = snapshot.lastAppliedInput.map(input => ({ ...input }));
    this.localInput = { ...(this.lastInputs[localSlot] ?? NEUTRAL_INPUT) };
    this.authoritativeTick = snapshot.state.tick;
    this.raceId = snapshot.raceId;
    this.restoreRapidTimers();
    this.rememberTimers();
  }

  get tick(): number { return this.predicted.tick; }
  get state(): RaceState { return structuredClone(this.predicted); }
  get pendingCount(): number { return this.pending.size; }
  get replayTicks(): number { return this.replayCount; }
  get visualOffset(): Readonly<{ x: number; y: number; z: number }> { return { ...this.offset }; }
  get previous(): Pose { return { ...this.previousPose }; }
  get kart(): KartState { return structuredClone(this.localKart); }
  private get localKart(): KartState { return this.predicted.karts.find(kart => kart.id === this.localSlot)!; }

  setRoster(players: readonly RosterPlayer[]): void {
    this.cpuSlots = new Set(players.filter(player => player.kind === 'cpu').map(player => player.slot));
  }

  recordInput(tick: number, input: InputFrame): void {
    if (tick <= this.authoritativeTick) return;
    this.pending.set(tick, quantizeInput(input));
    this.newestInputTick = Math.max(this.newestInputTick, tick);
    // Prediction can freeze during a host pause; input delivery continues.
    for (const saved of this.pending.keys()) if (saved <= this.newestInputTick - MAX_REPLAY_TICKS) this.pending.delete(saved);
  }

  advanceTo(tick: number): void {
    const target = Math.min(tick, this.authoritativeTick + MAX_REPLAY_TICKS);
    while (this.predicted.tick < target && this.predicted.phase !== 'finished') {
      this.previousPose = this.pose(this.localKart);
      this.localInput = this.pending.get(this.predicted.tick + 1) ?? this.localInput;
      // HostSession changes human before sampling. Apply the roster to all
      // karts first, including a disconnected human that has become a CPU.
      if (this.cpuSlots) for (const kart of this.predicted.karts) {
        // A snapshot may beat the reliable disconnect roster. Never revive a
        // CPU from a stale roster; there is no mid-race joining in this protocol.
        if (this.cpuSlots.has(kart.id)) kart.human = false;
      }
      const inputs: InputFrame[] = [];
      for (const kart of this.predicted.karts) {
        inputs[kart.id] = !kart.human ? getAIInput(this.predicted, kart.id)
          : kart.id === this.localSlot ? this.localInput : this.lastInputs[kart.id] ?? NEUTRAL_INPUT;
      }
      stepRace(this.predicted, inputs);
      this.predicted.events = [];
      this.rememberTimers();
    }
  }

  /** Returns true when a >40-tick discontinuity requires a new clock anchor. */
  reconcile(snapshot: Snapshot): boolean {
    if (snapshot.raceId !== this.raceId || snapshot.state.tick <= this.authoritativeTick) return false;
    const old = this.pose(this.localKart);
    const target = this.tick;
    const snap = Math.abs(target - snapshot.state.tick) > MAX_REPLAY_TICKS;
    this.authoritativeTick = snapshot.state.tick;
    this.predicted = structuredClone(snapshot.state);
    this.predicted.events = [];
    // Preserve sub-quantum precision only when the host confirms the same
    // wire bucket. In particular, 1/60s of boost rounds to .02s and would
    // otherwise grant an extra acceleration tick on every reconciliation.
    for (const saved of this.timerHistory.get(this.authoritativeTick) ?? []) {
      const kart = this.predicted.karts.find(kart => kart.id === saved.id)!;
      for (const field of Object.keys(TIMER_SCALES) as (keyof typeof TIMER_SCALES)[]) {
        const scale = TIMER_SCALES[field];
        if (field === 'rouletteTime') {
          if (Math.round(saved[field] * scale) / scale === kart.effects[field]) kart.effects[field] = saved[field];
        } else if (Math.round(saved[field] * scale) / scale === kart[field]) kart[field] = saved[field];
      }
    }
    this.timerHistory.clear();
    this.lastInputs = snapshot.lastAppliedInput.map(input => ({ ...input }));
    this.localInput = { ...(this.lastInputs[this.localSlot] ?? NEUTRAL_INPUT) };
    for (const tick of this.pending.keys()) if (tick <= this.authoritativeTick) this.pending.delete(tick);
    this.restoreRapidTimers();
    this.rememberTimers();
    this.previousPose = this.pose(this.localKart);
    if (!snap) this.advanceTo(target);
    this.replayCount = this.tick - this.authoritativeTick;
    const corrected = this.localKart;
    this.offset.x += old.x - corrected.x;
    this.offset.y += old.y - corrected.y;
    this.offset.z += old.z - corrected.z;
    if (snap || !(Math.hypot(this.offset.x, this.offset.y, this.offset.z) <= VISUAL_SNAP_METRES)) {
      this.offset = { x: 0, y: 0, z: 0 };
      this.previousPose = this.pose(corrected);
    }
    return snap;
  }

  decayVisualOffset(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const scale = Math.exp(-seconds / VISUAL_DECAY_SECONDS);
    this.offset.x *= scale;
    this.offset.y *= scale;
    this.offset.z *= scale;
  }

  private restoreRapidTimers(): void {
    // The explicit unused bit distinguishes a fresh pickup from an active
    // timer rounded to zero. Preserve the active item's final use tick.
    for (const kart of this.predicted.karts) {
      if (kart.item === 'rapidDash' && !kart.effects.rapidUnused) {
        kart.effects.rapidTime = Math.max(kart.effects.rapidTime, FIXED_DT);
      }
    }
  }

  private rememberTimers(): void {
    this.timerHistory.set(this.tick, this.predicted.karts.map(({ id, boostTime, spinTime, hopTime, airTime, hitCooldown, driftTime, effects }) =>
      ({ id, boostTime, spinTime, hopTime, airTime, hitCooldown, driftTime, rouletteTime: effects.rouletteTime })));
    for (const tick of this.timerHistory.keys()) if (tick < this.tick - MAX_REPLAY_TICKS) this.timerHistory.delete(tick);
  }

  private pose({ x, y, z, heading }: Pose): Pose { return { x, y, z, heading }; }
}

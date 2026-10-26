import { getAIInput } from '../sim/ai';
import { FIXED_DT, stepRace } from '../sim/race';
import type { InputFrame, KartState, Pose, RaceState } from '../sim/types';
import { INPUT_HOLD_TICKS, NEUTRAL_INPUT, quantizeInput } from './inputBuffer';
import type { RosterPlayer } from './session';
import type { Snapshot } from './snapshotCodec';

export const MAX_REPLAY_TICKS = 40;
export const VISUAL_DECAY_SECONDS = 0.08;
export const VISUAL_SNAP_METRES = 1.5;
/** Local falls this close in ticks are one respawn seen twice (prediction, replay, host batch). */
export const FALL_DEDUPE_TICKS = 6;
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
  /** Every input sent for the last MAX_REPLAY_TICKS + INPUT_HOLD_TICKS ticks, kept across reconciles. */
  private readonly sent = new Map<number, InputFrame>();
  private authoritativeTick: number;
  private readonly raceId: number;
  private cpuSlots: Set<number> | null = null;
  private offset = { x: 0, y: 0, z: 0 };
  private previousPose: Pose;
  private replayCount = 0;
  private correctionMetres = 0;
  private readonly timerHistory = new Map<number, Timers[]>();
  /** Ticks of the local kart's respawns already counted, predicted or reported by the host. */
  private localFalls: number[] = [];
  /**
   * Host-reported local respawns not yet applied: the batch covered ticks (from, to], so the fall is
   * at or before `to`. They wait for a reconcile onto a snapshot at tick >= to, which moves the kart.
   */
  private hostFalls: { from: number; to: number }[] = [];
  private fallCount = 0;
  private fellThisReconcile = false;

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
  /** Local-kart displacement applied by the latest accepted reconcile; 0 before any. */
  get lastCorrectionMetres(): number { return this.correctionMetres; }
  get visualOffset(): Readonly<{ x: number; y: number; z: number }> { return { ...this.offset }; }
  get previous(): Pose { return { ...this.previousPose }; }
  get kart(): KartState { return structuredClone(this.localKart); }
  private get localKart(): KartState { return this.predicted.karts.find(kart => kart.id === this.localSlot)!; }

  /** Generation of local respawns (falls): it changes once per respawn, however it was learnt. */
  get localFallCount(): number { return this.fallCount; }

  /**
   * The host reported a local fall in an events batch covering ticks (fromTick, toTick]. Already
   * predicted or replayed: nothing to do. Otherwise it counts when a snapshot at or after toTick is
   * reconciled (that is when the kart moves), or now if one already was.
   */
  markFall(fromTick: number, toTick: number): void {
    if (this.seenFall(fromTick, toTick)) return;
    if (toTick > this.authoritativeTick) {
      this.hostFalls.push({ from: fromTick, to: toTick });
      return;
    }
    this.noteLocalFall(fromTick, toTick);
    this.previousPose = this.pose(this.localKart);
  }

  private seenFall(fromTick: number, toTick: number): boolean {
    return this.localFalls.some(tick => tick > fromTick - FALL_DEDUPE_TICKS && tick <= toTick + FALL_DEDUPE_TICKS);
  }

  /** A respawn snaps exactly onto its point: no visual correction is carried across it. */
  private noteLocalFall(fromTick: number, toTick: number): void {
    if (!this.seenFall(fromTick, toTick)) {
      this.localFalls = [...this.localFalls.slice(-7), toTick];
      this.fallCount++;
    }
    this.offset = { x: 0, y: 0, z: 0 };
  }

  setRoster(players: readonly RosterPlayer[]): void {
    this.cpuSlots = new Set(players.filter(player => player.kind === 'cpu').map(player => player.slot));
  }

  recordInput(tick: number, input: InputFrame): void {
    const quantized = quantizeInput(input);
    this.sent.set(tick, quantized);
    for (const saved of this.sent.keys()) if (saved < tick - MAX_REPLAY_TICKS - INPUT_HOLD_TICKS) this.sent.delete(saved);
    if (tick <= this.authoritativeTick) return;
    this.pending.set(tick, quantized);
    this.newestInputTick = Math.max(this.newestInputTick, tick);
    // Prediction can freeze during a host pause; input delivery continues.
    for (const saved of this.pending.keys()) if (saved <= this.newestInputTick - MAX_REPLAY_TICKS) this.pending.delete(saved);
  }

  advanceTo(tick: number): void {
    const target = Math.min(tick, this.authoritativeTick + MAX_REPLAY_TICKS);
    while (this.predicted.tick < target && this.predicted.phase !== 'finished') {
      this.previousPose = this.pose(this.localKart);
      const next = this.predicted.tick + 1;
      const input = this.pending.get(next);
      if (input) this.localInput = input;
      // A tick before our newest send that was never sent (a re-anchor skipped it) never will be: the host
      // InputBuffer repeats our newest earlier input for INPUT_HOLD_TICKS, then applies neutral. A tick not
      // sent yet keeps the held input.
      else if (next < this.newestInputTick) this.localInput = this.repeatedInput(next);
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
      if (this.predicted.events.some(event => event.type === 'fall' && event.kartId === this.localSlot)) {
        this.noteLocalFall(this.predicted.tick - 1, this.predicted.tick);
        // Never interpolate from the pre-fall pose: the respawn is drawn as it is.
        this.previousPose = this.pose(this.localKart);
        this.fellThisReconcile = true;
      }
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
        // v20 countdown snapshots carry exact held ticks. Local input history cannot
        // overrule them: sending an input does not prove that the host received it.
        if (field === 'boostTime' && this.predicted.phase === 'countdown') continue;
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
    // Host falls this snapshot now contains (batch tick at or before it): the kart moves now, so cut now.
    this.fellThisReconcile = false;
    for (const fall of this.hostFalls.filter(fall => fall.to <= this.authoritativeTick)) {
      this.noteLocalFall(fall.from, fall.to);
      this.fellThisReconcile = true;
    }
    this.hostFalls = this.hostFalls.filter(fall => fall.to > this.authoritativeTick);
    if (!snap) this.advanceTo(target);
    this.replayCount = this.tick - this.authoritativeTick;
    const corrected = this.localKart;
    this.correctionMetres = Math.hypot(old.x - corrected.x, old.y - corrected.y, old.z - corrected.z);
    this.offset.x += old.x - corrected.x;
    this.offset.y += old.y - corrected.y;
    this.offset.z += old.z - corrected.z;
    if (snap || this.fellThisReconcile || !(Math.hypot(this.offset.x, this.offset.y, this.offset.z) <= VISUAL_SNAP_METRES)) {
      this.offset = { x: 0, y: 0, z: 0 };
      this.previousPose = this.pose(corrected);
    }
    this.fellThisReconcile = false;
    return snap;
  }

  decayVisualOffset(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const scale = Math.exp(-seconds / VISUAL_DECAY_SECONDS);
    this.offset.x *= scale;
    this.offset.y *= scale;
    this.offset.z *= scale;
  }

  /** What the host applied for a tick we never sent: our newest input at most INPUT_HOLD_TICKS older. */
  private repeatedInput(tick: number): InputFrame {
    for (let sent = tick - 1; sent >= tick - INPUT_HOLD_TICKS; sent--) {
      const input = this.sent.get(sent);
      if (input) return input;
    }
    return { ...NEUTRAL_INPUT };
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
    // lastBand is an exact wire field: reconcile restores it from snapshot.state
    // before replay. Keeping a predicted copy here could overwrite a host correction;
    // replay events are discarded in advanceTo, so they cannot play a second hit.
    this.timerHistory.set(this.tick, this.predicted.karts.map(({ id, boostTime, spinTime, hopTime, airTime, hitCooldown, driftTime, effects }) =>
      ({ id, boostTime, spinTime, hopTime, airTime, hitCooldown, driftTime, rouletteTime: effects.rouletteTime })));
    for (const tick of this.timerHistory.keys()) if (tick < this.tick - MAX_REPLAY_TICKS) this.timerHistory.delete(tick);
  }

  private pose({ x, y, z, heading }: Pose): Pose { return { x, y, z, heading }; }
}

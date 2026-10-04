import { captureRenderSnapshot } from '../render/snapshot';
import type { RenderSnapshot } from '../render/snapshot';
import { createRace } from '../sim/race';
import { COURSE_FINGERPRINT } from '../sim/tracks';
import type { InputFrame, RaceEvent, RaceState, TrackId } from '../sim/types';
import { ClockSync, packPing, packPong, TICK_MS, TickMap, unpackClock } from './clock';
import { INPUT_HISTORY, NEUTRAL_INPUT, pack, quantizeInput } from './inputBuffer';
import { INTERPOLATION_DELAY_MS, SnapshotBuffer } from './interpolation';
import { Predictor } from './predictor';
import { encodeControlMessage, isProfile, PacketKind, parseControlMessage, PROTOCOL_VERSION } from './protocol';
import type { ControlMessage, RaceStart, RejectReason } from './protocol';
import { normalize } from './roomCode';
import type { NetPhase, RosterPlayer, RosterView } from './session';
import { decodeSnapshot } from './snapshotCodec';
import type { Snapshot } from './snapshotCodec';
import { TransportError } from './transport';
import type { ChannelKind, PeerLink, Transport, TransportErrorCode, WireData } from './transport';

export interface GuestSessionOptions {
  name?: string;
  color?: number;
  /** The same monotonic millisecond clock is used by reception, input and expiry. */
  now?: () => number;
  /** Predict the local kart; false retains the interpolation-only N4 view. */
  prediction?: boolean;
}

export interface GuestFrame { state: RaceState; previous: RenderSnapshot; alpha: number }
export type GuestCloseReason = 'host_lost' | 'left' | RejectReason | TransportErrorCode;

/** Call frame every render and tick once per fixed 60Hz step. */
export class GuestSession {
  private readonly now: () => number;
  private readonly prediction: boolean;
  private predictor: Predictor | null = null;
  private pendingSnapshot: Snapshot | null = null;
  private predictionAt = 0;
  private visualAt = 0;
  private inputRtt = 0;
  private readonly clock = new ClockSync();
  private readonly ticks = new TickMap();
  private readonly snapshots = new SnapshotBuffer();
  private readonly listeners = new Set<() => void>();
  private readonly pings = new Set<number>();
  private link: PeerLink | null = null;
  private generation = 0;
  private currentPhase: NetPhase = 'idle';
  private selectedTrackId: TrackId = 'meadow';
  private closeReason: GuestCloseReason | null = null;
  private isStalled = false;
  private code = '';
  private slot = -1;
  private players: RosterPlayer[] = [];
  private name: string;
  private color: number;
  private raceId: number | null = null;
  private template: RaceState | null = null;
  private result: RaceState | null = null;
  private latestTick = 0;
  private eventTick = -1;
  private pendingEvents: RaceEvent[] = [];
  private lastSnapshotAt = 0;
  private lastPongAt = 0;
  private lastPollAt: number | null = null;
  private stallExcused = false;
  private joinedAt = 0;
  private fallbackOffset = 0;
  private nextPingAt = 0;
  private pingCount = 0;
  private inputTick: number | null = null;
  private lastSentInputTick = -1;
  private pendingUseItem = false;
  private inputHistory: InputFrame[] = [];

  constructor(private readonly transport: Transport, options: GuestSessionOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.prediction = options.prediction ?? true;
    this.name = options.name ?? 'Guest';
    this.color = options.color ?? 0x38bdf8;
    if (!isProfile({ type: 'profile', name: this.name, color: this.color })) throw new TypeError('Invalid guest profile');
  }

  get phase(): NetPhase { return this.currentPhase; }
  get course(): TrackId { return this.selectedTrackId; }
  get reason(): GuestCloseReason | null { return this.closeReason; }
  get stalled(): boolean { return this.isStalled; }
  get localSlot(): number { return this.slot; }
  get rtt(): number { return this.clock.rtt; }
  get offset(): number { return this.clock.ready ? this.clock.offset : this.fallbackOffset; }
  get lead(): number {
    return this.prediction ? Math.max(this.clock.lead, Math.ceil(this.inputRtt / (2 * TICK_MS)) + 2) : this.clock.lead;
  }
  get predictedState(): RaceState | null { return this.predictor?.state ?? null; }
  get replayTicks(): number { return this.predictor?.replayTicks ?? 0; }
  get visualOffset(): Readonly<{ x: number; y: number; z: number }> {
    return this.predictor?.visualOffset ?? { x: 0, y: 0, z: 0 };
  }
  get roster(): RosterView {
    return { roomCode: this.code, localSlot: this.slot, players: this.players.map(player => ({ ...player })) };
  }
  get finalState(): RaceState | null { return this.result ? structuredClone(this.result) : null; }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void { for (const listener of this.listeners) listener(); }
  private setPhase(phase: NetPhase): void { this.currentPhase = phase; this.notify(); }
  private get activeRace(): boolean { return this.phase === 'countdown' || this.phase === 'racing'; }

  async join(roomCode: string): Promise<void> {
    if (this.phase !== 'idle' && this.phase !== 'closed') throw new Error('Guest is already connected');
    const code = normalize(roomCode);
    if (!code) throw new TypeError('Invalid room code');
    const generation = ++this.generation;
    this.code = code;
    this.slot = -1;
    this.players = [];
    this.selectedTrackId = 'meadow';
    this.closeReason = null;
    this.raceId = null;
    this.clearRace();
    this.clock.reset();
    this.inputRtt = 0;
    this.pings.clear();
    this.pingCount = 0;
    this.fallbackOffset = 0;
    this.joinedAt = this.now();
    this.lastPongAt = this.joinedAt;
    this.nextPingAt = this.joinedAt;
    this.setPhase('connecting');
    try {
      const link = await this.transport.join(code);
      if (generation !== this.generation) { link.close(); return; }
      this.link = link;
      link.onClose(() => { if (generation === this.generation) this.finish('host_lost'); });
      // Transport implementations may synchronously flush queued messages here.
      link.onMessage((kind, data) => {
        if (generation === this.generation && this.phase !== 'closed') this.receive(kind, data);
      });
      if (this.phase === 'closed') return;
      this.send('reliable', encodeControlMessage({ type: 'hello', protocol: PROTOCOL_VERSION,
        course: COURSE_FINGERPRINT, name: this.name, color: this.color }));
      this.poll();
    } catch (error) {
      if (generation === this.generation) this.finish(error instanceof TransportError ? error.code : 'host_lost');
    }
  }

  updateProfile(name: string, color: number): boolean {
    const message = { type: 'profile', name, color } as const;
    if (this.phase !== 'lobby' || !isProfile(message)) return false;
    this.name = name;
    this.color = color;
    return this.send('reliable', encodeControlMessage(message));
  }

  close(): void {
    if (this.phase === 'closed') return;
    this.send('reliable', encodeControlMessage({ type: 'leave' }));
    this.finish('left');
  }

  private finish(reason: GuestCloseReason): void {
    if (this.phase === 'closed') return;
    ++this.generation;
    const link = this.link;
    this.link = null;
    this.closeReason = reason;
    this.pings.clear();
    this.clearRace();
    this.setPhase('closed');
    link?.close();
  }

  private send(kind: ChannelKind, data: WireData): boolean {
    if (!this.link || this.phase === 'closed') return false;
    try { this.link.send(kind, data); return true; }
    catch { this.finish('host_lost'); return false; }
  }

  private clearRace(): void {
    this.template = this.result = null;
    this.predictor = null;
    this.pendingSnapshot = null;
    this.snapshots.clear();
    this.latestTick = 0;
    this.eventTick = -1;
    this.pendingEvents = [];
    this.inputTick = null;
    this.lastSentInputTick = -1;
    this.pendingUseItem = false;
    this.inputHistory = [];
    this.isStalled = false;
  }

  private start(message: RaceStart, now: number): void {
    this.clearRace();
    this.raceId = message.raceId;
    this.players = message.roster;
    this.template = createRace(message.seed, { trackId: message.trackId });
    for (const kart of this.template.karts) {
      const player = this.players.find(entry => entry.slot === kart.id);
      kart.human = !!player && player.kind !== 'cpu';
      if (player) { kart.name = player.name; kart.color = player.color; }
    }
    this.ticks.reset(0, message.startAtHostTime);
    const initial = { raceId: message.raceId, hostTime: message.startAtHostTime,
      state: this.template, lastAppliedInput: this.template.karts.map(() => ({ ...NEUTRAL_INPUT })) };
    this.snapshots.push(initial);
    if (this.prediction) {
      this.predictor = new Predictor(initial, this.slot);
      this.predictor.setRoster(this.players);
      this.predictionAt = this.visualAt = now;
    }
    // A scheduled start is not a snapshot outage while everybody waits on the grid.
    this.lastSnapshotAt = Math.max(now, message.startAtHostTime - this.offset);
    this.setPhase('countdown');
  }

  private receive(kind: ChannelKind, data: WireData): void {
    const now = this.now();
    if (kind === 'reliable') {
      const message = parseControlMessage(data);
      if (message) this.control(message, now);
      return;
    }
    const clock = unpackClock(data);
    if (clock?.kind === PacketKind.PING) {
      this.send('unreliable', packPong(clock.t0, now));
      return;
    }
    if (clock?.kind === PacketKind.PONG) {
      if (this.pings.delete(clock.t0) && this.clock.sample(clock.t0, clock.hostNow, now)) {
        this.lastPongAt = now;
        // Clock offset uses the minimum RTT. Input lead must react immediately
        // to a slower path instead of waiting ten seconds for that sample to age.
        this.inputRtt = Math.max(now - clock.t0, this.inputRtt * 0.9);
      }
      return;
    }
    if (!this.activeRace || !this.template) return;
    const snapshot = decodeSnapshot(data, this.template);
    if (!snapshot || snapshot.raceId !== this.raceId || snapshot.state.tick <= this.latestTick ||
      !this.snapshots.push(snapshot)) return;
    // lap events contain the lap number, not its duration. Boundary timestamps
    // in snapshots recover durations; race_end supplies the exact final history.
    for (const kart of snapshot.state.karts) {
      const known = this.template.karts.find(entry => entry.id === kart.id)!;
      if (kart.lap <= known.lap) continue;
      if (kart.lap === known.lap + 1 && known.lapTimes.length === known.lap && kart.lapStartTime >= known.lapStartTime) {
        known.lapTimes.push(kart.lapStartTime - known.lapStartTime);
      }
      known.lap = kart.lap;
      known.lapStartTime = kart.lapStartTime;
    }
    this.latestTick = snapshot.state.tick;
    this.ticks.update(snapshot.state.tick, snapshot.hostTime);
    this.fallbackOffset = snapshot.hostTime - now;
    this.lastSnapshotAt = now;
    // Keep interpolation history, but replay only the newest snapshot before
    // the next simulation/render frame when several datagrams arrive together.
    if (this.predictor) this.pendingSnapshot = snapshot;
    if (this.isStalled) { this.isStalled = false; this.notify(); }
    // Results are gated on the reliable, full-precision race_end state.
    if (snapshot.state.phase !== 'countdown' && this.phase === 'countdown') this.setPhase('racing');
  }

  private control(message: ControlMessage, now: number): void {
    switch (message.type) {
      case 'welcome':
        if (this.phase !== 'connecting') return;
        this.slot = message.slot;
        this.players = message.roster;
        this.selectedTrackId = message.trackId;
        this.fallbackOffset = message.hostTime - now;
        this.lastPongAt = now;
        this.setPhase('lobby');
        break;
      case 'reject':
        if (this.phase === 'connecting') this.finish(message.reason);
        break;
      case 'course':
        if (this.phase !== 'lobby') return;
        this.selectedTrackId = message.trackId;
        this.notify();
        break;
      case 'roster':
        if (this.slot < 0) return;
        this.players = message.players;
        this.predictor?.setRoster(this.players);
        this.notify();
        break;
      case 'race_start':
        if (this.phase === 'lobby' && message.trackId !== this.selectedTrackId) {
          // The guest stays in the lobby; make the otherwise silent mismatch visible.
          console.warn(`Ignored race_start for course ${message.trackId}; the lobby course is ${this.selectedTrackId}.`);
        }
        if (this.phase === 'lobby' && message.trackId === this.selectedTrackId &&
          (this.raceId === null || message.raceId > this.raceId) &&
          message.roster.some(player => player.slot === this.slot)) this.start(message, now);
        break;
      case 'events':
        if (!this.activeRace || message.raceId !== this.raceId || message.tick < this.eventTick) return;
        this.eventTick = message.tick;
        this.pendingEvents.push(...message.events);
        break;
      case 'race_end':
        if (!this.activeRace || message.raceId !== this.raceId || message.finalState.tick < this.latestTick ||
          message.finalState.trackId !== this.selectedTrackId) return;
        this.result = message.finalState;
        this.predictor = null;
        this.pendingSnapshot = null;
        this.isStalled = false;
        this.setPhase('results');
        break;
      case 'return_lobby':
        if (this.phase !== 'results' && !this.activeRace) return;
        this.clearRace();
        this.setPhase('lobby');
        break;
      case 'host_closed': this.finish('host_lost'); break;
    }
  }

  /** The caller blocked the main thread since the last poll (e.g. rebuilding the renderer).
   * That time is not host silence: no PONG or snapshot could be handled meanwhile. */
  excuseStall(): void { this.stallExcused = true; }

  private poll(): number {
    const now = this.now();
    if (this.stallExcused && this.lastPollAt !== null) {
      const gap = Math.max(0, now - this.lastPollAt);
      // Shift by the stall but never past now: a PONG or snapshot handled after the stall already
      // carries a fresh time. A deadline already in the future (the scheduled race start) is kept.
      const excuse = (at: number): number => at > now ? at : Math.min(now, at + gap);
      this.lastPongAt = excuse(this.lastPongAt);
      this.lastSnapshotAt = excuse(this.lastSnapshotAt);
    }
    this.stallExcused = false;
    this.lastPollAt = now;
    // Never pass rAF's older frame timestamp into ClockSync.expire/sample.
    this.clock.expire(now);
    if (this.phase === 'connecting' && now - this.joinedAt >= 5000) this.finish('timeout');
    if ((this.phase === 'lobby' || this.phase === 'results') && now - this.lastPongAt >= 5000) this.finish('host_lost');
    if (this.activeRace) {
      const silence = now - this.lastSnapshotAt;
      if (silence >= 5000) this.finish('host_lost');
      else if (this.isStalled !== (silence >= 1500)) { this.isStalled = silence >= 1500; this.notify(); }
    }
    if (this.link && now >= this.nextPingAt) {
      for (const t0 of this.pings) if (now - t0 > 10_000) this.pings.delete(t0);
      this.pings.add(now);
      this.pingCount++;
      this.nextPingAt = now + (this.pingCount < 5 ? 100 : 500);
      this.send('unreliable', packPing(now));
    }
    return now;
  }

  tick(input: InputFrame): void {
    const now = this.poll();
    this.reconcilePrediction(now);
    if (!this.activeRace || this.raceId === null || now + this.offset < this.ticks.hostTimeAt(0)) return;
    let frame: InputFrame;
    try { frame = quantizeInput(input); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      frame = { ...NEUTRAL_INPUT };
    }
    this.pendingUseItem ||= frame.useItem;
    const desired = Math.max(0, Math.ceil(this.ticks.hostTickAt(now + this.offset)) + this.lead);
    if (this.inputTick !== null && Math.abs(desired - this.inputTick) >= this.lead + 10) {
      this.inputTick = null;
      this.inputHistory = [];
    }
    let target = this.inputTick === null ? desired : this.inputTick + 1;
    // Slow down by skipping a send: the host rejects repeated latestTick values.
    if (this.inputTick !== null && desired - target >= 2) target++;
    else if (this.inputTick !== null && target - desired >= 2) return;
    // Do not enqueue seconds of future input while the host is paused. Allow
    // two snapshot periods (6 ticks, tolerating one loss), transit, and input lead.
    const ceiling = this.latestTick + 6 + (this.lead - 2) + this.lead;
    if (target <= this.lastSentInputTick || target > ceiling || target > 0xffffffff) return;
    frame.useItem = this.pendingUseItem;
    if (this.inputTick !== null && target > this.inputTick + 1) this.inputHistory.unshift({ ...frame });
    this.inputHistory.unshift(frame);
    this.inputHistory.length = Math.min(INPUT_HISTORY, target + 1, this.inputHistory.length);
    this.inputTick = target;
    this.lastSentInputTick = target;
    this.pendingUseItem = false;
    if (this.predictor) {
      for (const [index, input] of this.inputHistory.entries()) this.predictor.recordInput(target - index, input);
      this.predictor.advanceTo(target);
      this.predictionAt = now;
    }
    this.send('unreliable', pack({ slot: this.slot, raceId: this.raceId, latestTick: target, frames: this.inputHistory }));
  }

  private reconcilePrediction(now: number): void {
    if (!this.predictor || !this.pendingSnapshot) return;
    const snapshot = this.pendingSnapshot;
    this.pendingSnapshot = null;
    this.decayPrediction(now);
    if (this.predictor.reconcile(snapshot)) {
      this.inputTick = null;
      this.inputHistory = [];
      this.nextPingAt = now;
      this.predictionAt = now;
    }
  }

  private decayPrediction(now: number): void {
    const time = Math.max(this.visualAt, now);
    this.predictor?.decayVisualOffset((time - this.visualAt) / 1000);
    this.visualAt = time;
  }

  frame(now: number = this.now()): GuestFrame | null {
    this.reconcilePrediction(this.poll());
    if (this.phase === 'results' && this.result) {
      const state = structuredClone(this.result);
      state.events = this.pendingEvents.splice(0);
      return { state, previous: captureRenderSnapshot(state), alpha: 1 };
    }
    if (!this.activeRace) return null;
    const state = this.snapshots.sample(now + this.offset - INTERPOLATION_DELAY_MS);
    if (!state) return null;
    // Buffered snapshots predate subsequently recovered lap boundaries.
    for (const kart of state.karts) {
      kart.lapTimes = [...(this.template?.karts.find(entry => entry.id === kart.id)?.lapTimes ?? kart.lapTimes)];
    }
    let alpha = 1;
    const previous = captureRenderSnapshot(state);
    if (this.predictor && this.inputTick !== null) {
      this.decayPrediction(now);
      const local = this.predictor.kart;
      const index = state.karts.findIndex(kart => kart.id === this.slot);
      const offset = this.predictor.visualOffset;
      local.lapTimes = [...state.karts[index].lapTimes];
      local.x += offset.x;
      local.y += offset.y;
      local.z += offset.z;
      state.karts[index] = local;
      const pose = this.predictor.previous;
      previous.karts[index] = { ...pose, x: pose.x + offset.x, y: pose.y + offset.y, z: pose.z + offset.z };
      alpha = Math.max(0, Math.min(1, (now - this.predictionAt) / TICK_MS));
    }
    // Prediction events are discarded inside Predictor; only reliable host
    // events feed audio/HUD, exactly once even when several frames are rendered.
    state.events = this.pendingEvents.splice(0);
    return { state, previous, alpha };
  }
}

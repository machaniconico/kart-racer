import { getAIInput } from '../sim/ai';
import { createRace } from '../sim/race';
import { COURSE_FINGERPRINT, TRACK_IDS } from '../sim/tracks';
import type { InputFrame, InputSource, RaceEvent, RaceState, TrackId } from '../sim/types';
import { CLOCK_WINDOW_MS, ClockSync, packPing, packPong, unpackClock } from './clock';
import { InputBuffer, NEUTRAL_INPUT, unpack } from './inputBuffer';
import { encodeControlMessage, isHello, isProfile, MAX_EVENTS, MAX_PLAYERS, PacketKind,
  parseControlMessage, PROTOCOL_VERSION } from './protocol';
import type { ControlMessage, Hello, Profile, RejectReason } from './protocol';
import { normalize } from './roomCode';
import type { NetPhase, RosterPlayer, RosterView } from './session';
import { encodeSnapshot } from './snapshotCodec';
import type { ChannelKind, PeerLink, Transport, TransportError, TransportHost, WireData } from './transport';

/** Lets a rejected guest drain the reject message before the host drops the link. */
const REJECT_CLOSE_MS = 3000;

export interface HostSessionOptions {
  roomCode: string;
  name?: string;
  color?: number;
  /** Use the same monotonic clock for reception, frame(), and afterTick(). */
  now?: () => number;
  hostInput?: InputSource;
}

interface Guest {
  link: PeerLink;
  slot: number | null;
  rejected: boolean;
  clock: ClockSync;
  pings: Set<number>;
  pingCount: number;
  nextPingAt: number;
}

/** Host-owned simulation; sample all slots before stepRace, then call afterTick
 * on every tick. Call frame() in the lobby as well to keep RTT estimates current.
 * onChange fires on roster and phase changes; onBrokerLost when the broker cannot
 * be reached again (existing guests keep playing, new guests cannot join).
 */
export class HostSession {
  private readonly now: () => number;
  private readonly roomCode: string;
  private readonly players: RosterPlayer[];
  private readonly guests = new Map<PeerLink, Guest>();
  private readonly listeners = new Set<() => void>();
  private readonly buffers = Array.from({ length: MAX_PLAYERS }, (_, slot) => new InputBuffer({ slot }));
  private readonly sampledTicks = Array<number>(MAX_PLAYERS).fill(0);
  private readonly lastInputs = Array.from({ length: MAX_PLAYERS }, () => ({ ...NEUTRAL_INPUT }));
  private readonly sources: InputSource[];
  private pendingEvents: RaceEvent[] = [];
  private currentPhase: NetPhase = 'lobby';
  private selectedTrackId: TrackId = 'meadow';
  private currentRaceId = 0;
  private currentState: RaceState | null = null;
  private completedTick = 0;
  private startAt = 0;

  constructor(private readonly transportHost: TransportHost, options: HostSessionOptions) {
    // PeerJS may choose another code after a broker ID collision.
    const code = normalize(transportHost.roomCode);
    if (code === null) throw new TypeError('Invalid room code');
    this.roomCode = code;
    this.now = options.now ?? (() => performance.now());
    this.players = createRace(1).karts.map(kart => ({
      slot: kart.id, name: kart.name, color: kart.color,
      kind: kart.id === 0 ? 'host' : 'cpu', connected: kart.id === 0,
    }));
    const profile: Profile = { type: 'profile', name: options.name ?? this.players[0].name,
      color: options.color ?? this.players[0].color };
    if (!isProfile(profile) || !this.assignProfile(0, profile)) throw new TypeError('Invalid host profile');
    this.sources = this.players.map((_, slot) => ({
      sample: (state: RaceState): InputFrame => {
        if (state !== this.currentState || !this.inRace) return { ...NEUTRAL_INPUT };
        const tick = state.tick + 1;
        this.sampledTicks[slot] = Math.max(this.sampledTicks[slot], tick);
        const kart = state.karts.find(candidate => candidate.id === slot);
        if (kart) kart.human = this.players[slot].kind !== 'cpu';
        const input = this.players[slot].kind === 'cpu' ? getAIInput(state, slot)
          : slot === 0 ? options.hostInput?.sample(state, slot) ?? { ...NEUTRAL_INPUT }
          : this.buffers[slot].get(tick);
        this.lastInputs[slot] = { ...input };
        return { ...input };
      },
    }));
    transportHost.onJoin(link => this.accept(link));
  }

  static async create(transport: Transport, options: HostSessionOptions): Promise<HostSession> {
    const host = await transport.host(options.roomCode);
    try { return new HostSession(host, options); }
    catch (error) { host.close(); throw error; }
  }

  get phase(): NetPhase { return this.currentPhase; }
  get course(): TrackId { return this.selectedTrackId; }
  get raceId(): number { return this.currentRaceId; }
  get state(): RaceState | null { return this.currentState; }
  get startAtHostTime(): number { return this.startAt; }
  get roster(): RosterView {
    return { roomCode: this.roomCode, localSlot: 0, players: this.copyPlayers() };
  }
  /** Guest RTT estimates by slot (ms), for diagnostics. */
  get rtts(): Record<number, number> {
    const result: Record<number, number> = {};
    for (const guest of this.guests.values()) if (guest.slot !== null) result[guest.slot] = guest.clock.rtt;
    return result;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onBrokerLost(handler: (error: TransportError) => void): void {
    this.transportHost.onBrokerLost(handler);
  }

  private notify(): void { for (const listener of this.listeners) listener(); }
  private get inRace(): boolean { return this.currentPhase === 'countdown' || this.currentPhase === 'racing'; }
  private copyPlayers(): RosterPlayer[] { return this.players.map(player => ({ ...player })); }

  inputSource(slot: number): InputSource {
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PLAYERS) throw new RangeError('Invalid slot');
    return this.sources[slot];
  }

  /** Returns the state the caller should advance, starting at startAtHostTime. */
  startRace(seed = Math.floor(Math.random() * 0x100000000)): RaceState {
    if (this.currentPhase !== 'lobby') throw new Error('A race can only start in the lobby');
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Invalid race seed');
    // The wire race ID is u8. Never wrap and accept packets from an earlier race.
    if (this.currentRaceId === 255) throw new RangeError('Race IDs exhausted; create a new room');
    const now = this.now();
    let maxRTT = 0;
    for (const guest of this.guests.values()) {
      if (guest.slot === null) continue;
      guest.clock.expire(now);
      maxRTT = Math.max(maxRTT, guest.clock.rtt);
    }
    this.currentRaceId++;
    this.startAt = now + Math.max(1500, 2 * maxRTT);
    this.completedTick = 0;
    this.pendingEvents = [];
    this.sampledTicks.fill(0);
    this.buffers.forEach(buffer => buffer.reset(this.currentRaceId));
    this.lastInputs.forEach((_, slot) => { this.lastInputs[slot] = { ...NEUTRAL_INPUT }; });
    this.currentState = createRace(seed, { trackId: this.selectedTrackId, racers: this.players.map(player => ({
      name: player.name, color: player.color, human: player.kind !== 'cpu',
    })) });
    this.currentPhase = 'countdown';
    this.broadcast({ type: 'race_start', raceId: this.currentRaceId, seed, trackId: this.selectedTrackId,
      roster: this.copyPlayers(), startAtHostTime: this.startAt });
    this.notify();
    return this.currentState;
  }

  returnToLobby(): void {
    if (this.currentPhase === 'closed' || this.currentPhase === 'lobby') return;
    this.currentPhase = 'lobby';
    this.currentState = null;
    this.pendingEvents = [];
    this.buffers.forEach(buffer => buffer.reset());
    this.broadcast({ type: 'return_lobby' });
    this.notify();
  }

  setProfile(name: string, color: number): boolean {
    const profile: Profile = { type: 'profile', name, color };
    if (this.currentPhase !== 'lobby' || !isProfile(profile) || !this.assignProfile(0, profile)) return false;
    this.broadcastRoster();
    return true;
  }

  setCourse(id: TrackId): boolean {
    if (this.currentPhase !== 'lobby' || !TRACK_IDS.includes(id)) return false;
    this.selectedTrackId = id;
    this.broadcast({ type: 'course', trackId: id });
    this.notify();
    return true;
  }

  /** Host-originated probes measure RTT without trusting a guest-supplied duration.
   * Both endpoints answer PING using packPong(t0, now()). No rAF time is mixed in.
   */
  frame(): void {
    if (this.currentPhase === 'closed') return;
    const now = this.now();
    for (const guest of this.guests.values()) {
      if (guest.slot === null) continue;
      guest.clock.expire(now);
      for (const t0 of guest.pings) if (now - t0 > CLOCK_WINDOW_MS) guest.pings.delete(t0);
      if (now < guest.nextPingAt) continue;
      guest.pings.add(now);
      guest.pingCount++;
      guest.nextPingAt = now + (guest.pingCount < 5 ? 100 : 500);
      this.send(guest, 'unreliable', packPing(now));
    }
  }

  afterTick(state: RaceState): void {
    if (!this.inRace || state !== this.currentState || state.tick <= this.completedTick) return;
    this.completedTick = state.tick;
    const phase = state.phase === 'countdown' ? 'countdown' : 'racing';
    const changed = phase !== this.currentPhase;
    this.currentPhase = phase;
    this.pendingEvents.push(...state.events.map(event => ({ ...event })));
    this.frame();
    if (state.tick % 3 === 0) {
      // One malformed/unsupported state must not terminate the simulation loop.
      try {
        const snapshot = encodeSnapshot(state, this.currentRaceId, this.now(), this.lastInputs);
        this.broadcastWire('unreliable', snapshot);
      } catch (error) { console.warn('Host snapshot skipped', error); }
      this.flushEvents(state.tick);
    }
    if (state.phase === 'finished') {
      this.flushEvents(state.tick);
      this.currentPhase = 'results';
      this.broadcast({ type: 'race_end', raceId: this.currentRaceId, finalState: state });
      this.notify();
    } else if (changed) this.notify();
  }

  close(): void {
    if (this.currentPhase === 'closed') return;
    this.currentPhase = 'closed';
    this.broadcast({ type: 'host_closed' });
    this.guests.clear();
    this.pendingEvents = [];
    this.currentState = null;
    this.transportHost.close();
    this.notify();
  }

  private accept(link: PeerLink): void {
    if (this.currentPhase === 'closed') { link.close(); return; }
    const guest: Guest = { link, slot: null, rejected: false, clock: new ClockSync(),
      pings: new Set(), pingCount: 0, nextPingAt: 0 };
    this.guests.set(link, guest);
    link.onClose(() => this.disconnect(guest));
    link.onMessage((kind, data) => this.receive(guest, kind, data));
  }

  private receive(guest: Guest, kind: ChannelKind, data: WireData): void {
    if (!this.guests.has(guest.link) || guest.rejected || this.currentPhase === 'closed') return;
    if (kind === 'reliable') {
      const message = parseControlMessage(data);
      if (!message) {
        if (guest.slot === null && this.isBadNameHello(data)) this.reject(guest, 'bad_name');
        return;
      }
      if (message.type === 'hello' && guest.slot === null) this.hello(guest, message);
      else if (message.type === 'leave') {
        this.disconnect(guest);
        guest.link.close();
      } else if (message.type === 'profile' && guest.slot !== null && this.currentPhase === 'lobby' &&
        this.assignProfile(guest.slot, message)) this.broadcastRoster();
      return;
    }
    if (guest.slot === null) return;
    const clock = unpackClock(data);
    if (clock?.kind === PacketKind.PING) {
      this.send(guest, 'unreliable', packPong(clock.t0, this.now()));
    } else if (clock?.kind === PacketKind.PONG) {
      if (guest.pings.delete(clock.t0)) guest.clock.sample(clock.t0, clock.hostNow, this.now());
    } else if (this.inRace) {
      const packet = unpack(data);
      if (packet && packet.slot === guest.slot && packet.raceId === this.currentRaceId) {
        // sample() requests state.tick + 1 before afterTick reports its completion.
        this.buffers[guest.slot].receive(packet, Math.max(this.completedTick, this.sampledTicks[guest.slot]));
      }
    }
  }

  private hello(guest: Guest, message: Hello): void {
    if (message.protocol !== PROTOCOL_VERSION || message.course !== COURSE_FINGERPRINT) {
      this.reject(guest, 'version'); return;
    }
    if (this.currentPhase !== 'lobby') { this.reject(guest, 'in_race'); return; }
    const player = this.players.find(candidate => candidate.slot > 0 && candidate.kind === 'cpu');
    if (!player) { this.reject(guest, 'full'); return; }
    guest.slot = player.slot;
    player.kind = 'guest';
    player.connected = true;
    // An occupied/unknown requested color falls back to this slot's free color.
    this.assignProfile(player.slot, { ...message, type: 'profile',
      color: this.colorAvailable(player.slot, message.color) ? message.color : player.color });
    this.send(guest, 'reliable', encodeControlMessage({ type: 'welcome', slot: player.slot,
      roster: this.copyPlayers(), hostTime: this.now(), trackId: this.selectedTrackId }));
    this.broadcastRoster();
    this.frame();
  }

  private reject(guest: Guest, reason: RejectReason): void {
    guest.rejected = true;
    this.send(guest, 'reliable', encodeControlMessage({ type: 'reject', reason }));
    // Let the guest close after receiving reject; immediate close drops queued data.
    setTimeout(() => {
      if (this.guests.get(guest.link) !== guest) return;
      this.guests.delete(guest.link);
      guest.link.close();
    }, REJECT_CLOSE_MS);
  }

  /** A hello that is valid except for its name must get reject:bad_name, not silence. */
  private isBadNameHello(data: WireData): boolean {
    if (typeof data !== 'string') return false;
    try {
      const value: unknown = JSON.parse(data);
      return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'hello' &&
        isHello({ ...value, name: 'Guest' });
    } catch { return false; }
  }

  private colorAvailable(slot: number, color: number): boolean {
    return this.players.some(player => player.color === color) &&
      !this.players.some(player => player.slot !== slot && player.kind !== 'cpu' && player.color === color);
  }

  private assignProfile(slot: number, profile: Profile): boolean {
    if (!this.colorAvailable(slot, profile.color)) return false;
    const player = this.players[slot];
    const other = this.players.find(candidate => candidate.slot !== slot && candidate.color === profile.color);
    if (other) other.color = player.color;
    player.name = profile.name;
    player.color = profile.color;
    return true;
  }

  private disconnect(guest: Guest): void {
    if (!this.guests.delete(guest.link) || guest.slot === null) return;
    const player = this.players[guest.slot];
    player.kind = 'cpu';
    player.connected = false;
    this.buffers[guest.slot].reset(this.currentRaceId);
    const kart = this.currentState?.karts.find(candidate => candidate.id === guest.slot);
    if (kart) kart.human = false;
    if (this.currentPhase !== 'closed') this.broadcastRoster();
  }

  private flushEvents(tick: number): void {
    while (this.pendingEvents.length) this.broadcast({ type: 'events', raceId: this.currentRaceId,
      tick, events: this.pendingEvents.splice(0, MAX_EVENTS) });
  }
  private broadcastRoster(): void {
    this.broadcast({ type: 'roster', players: this.copyPlayers() });
    this.notify();
  }
  private broadcast(message: ControlMessage): void {
    try { this.broadcastWire('reliable', encodeControlMessage(message)); }
    catch (error) { console.warn('Host control message skipped', error); }
  }
  private broadcastWire(kind: ChannelKind, data: WireData): void {
    for (const guest of this.guests.values()) if (guest.slot !== null) this.send(guest, kind, data);
  }
  private send(guest: Guest, kind: ChannelKind, data: WireData): void {
    try { guest.link.send(kind, data); }
    catch { this.disconnect(guest); guest.link.close(); }
  }
}

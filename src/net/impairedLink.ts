import type { ChannelKind, PeerLink, Transport, TransportHost, WireData } from './transport';

export interface ImpairmentProfile {
  latencyMs: number;
  jitterMs: number;
  lossRate: number;
  seed?: number;
  bursts?: { periodMs: number; lengthMs: number; extraLatencyMs: number; lossRate: number };
}

type Timer = ReturnType<typeof setTimeout>;
interface Timers {
  setTimeout(callback: () => void, delayMs: number): Timer;
  clearTimeout(timer: Timer): void;
  now(): number;
}
interface Pending { timer: Timer; at: number; deliver: () => void }

function validate(profile: ImpairmentProfile): void {
  const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
  const rate = (value: number) => nonnegative(value) && value <= 1;
  const seed = profile.seed ?? 1;
  const burst = profile.bursts;
  if (!nonnegative(profile.latencyMs) || !nonnegative(profile.jitterMs) || !rate(profile.lossRate) ||
    !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff ||
    (burst && (!Number.isFinite(burst.periodMs) || burst.periodMs <= 0 ||
      !nonnegative(burst.lengthMs) || burst.lengthMs > burst.periodMs ||
      !nonnegative(burst.extraLatencyMs) || !rate(burst.lossRate)))) {
    throw new RangeError('Invalid impairment profile');
  }
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

class ImpairedLink implements PeerLink {
  private closed = false;
  private listening = false;
  private readonly handlers: ((kind: ChannelKind, data: WireData) => void)[] = [];
  private readonly pending = new Set<Pending>();
  private draining: (() => void)[] | null = null;
  private readonly reliableDue = { send: 0, receive: 0 };

  constructor(private readonly inner: PeerLink, private readonly timers: Timers,
    private readonly delay: (kind: ChannelKind) => number | null) {
    inner.onClose(() => this.cancel());
  }

  get peerId(): string { return this.inner.peerId; }

  send(kind: ChannelKind, data: WireData): void {
    this.schedule('send', kind, data, wire => this.inner.send(kind, wire));
  }

  onMessage(handler: (kind: ChannelKind, data: WireData) => void): void {
    if (this.closed) return;
    this.handlers.push(handler);
    // Subscribe lazily so an inner transport can replay its pre-subscription inbox.
    if (this.listening) return;
    this.listening = true;
    this.inner.onMessage((kind, data) => this.schedule('receive', kind, data, wire => {
      for (const receive of this.handlers) receive(kind, wire);
    }));
  }

  onClose(handler: (reason: string) => void): void { this.inner.onClose(handler); }

  close(): void {
    this.cancel();
    this.inner.close();
  }

  cancel(): void {
    this.closed = true;
    for (const message of this.pending) this.timers.clearTimeout(message.timer);
    this.pending.clear();
    this.handlers.length = 0;
  }

  /** Disabling impairment drains the old queue before later synchronous sends can overtake it. */
  flush(after?: () => void): void {
    if (!this.pending.size) return;
    const messages = [...this.pending].sort((a, b) => a.at - b.at);
    for (const message of messages) this.timers.clearTimeout(message.timer);
    this.pending.clear();
    this.reliableDue.send = this.reliableDue.receive = 0;
    const deliveries = messages.map(message => message.deliver);
    if (after) deliveries.push(after);
    if (this.draining) { this.draining.push(...deliveries); return; }
    this.draining = deliveries;
    try {
      // Reentrant sends append here, after all previously queued packets and subscribers.
      for (let index = 0; index < deliveries.length && !this.closed; index++) deliveries[index]();
    } finally {
      this.draining = null;
    }
  }

  private schedule(direction: 'send' | 'receive', kind: ChannelKind, data: WireData,
    deliver: (wire: WireData) => void): void {
    if (this.closed) return;
    const delay = this.delay(kind);
    if (delay === null) {
      // Only the transition to passthrough needs a queue for reentrant callbacks.
      if (this.draining) this.draining.push(() => deliver(data));
      else if (this.pending.size) this.flush(() => deliver(data));
      else deliver(data);
      return;
    }
    if (delay < 0) return; // Only unreliable packets can be selected for loss.
    const now = this.timers.now();
    let at = now + delay;
    if (kind === 'reliable') {
      at = Math.max(at, this.reliableDue[direction]);
      this.reliableDue[direction] = at;
    }
    // Delayed packets own their bytes, just as a send on the underlying wire does.
    const wire = typeof data === 'string' ? data : data.slice(0);
    const message: Pending = { timer: this.timers.setTimeout(() => {
      this.pending.delete(message);
      if (!this.closed) message.deliver();
    }, at - now), at, deliver: () => deliver(wire) };
    this.pending.add(message);
  }
}

/** Adds deterministic impairments to each wrapped endpoint's send and receive paths. */
export class ImpairingTransport implements Transport {
  private profile: ImpairmentProfile | null = null;
  private random = mulberry32(1);
  private readonly links = new Set<ImpairedLink>();

  constructor(private readonly inner: Transport, private readonly timers: Timers = {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: timer => clearTimeout(timer),
    now: () => performance.now(),
  }) {}

  setProfile(profile: ImpairmentProfile | null): void {
    if (profile) validate(profile);
    this.profile = profile ? { ...profile, bursts: profile.bursts ? { ...profile.bursts } : undefined } : null;
    this.random = mulberry32(profile?.seed ?? 1);
    if (!profile) for (const link of this.links) link.flush();
  }

  async host(roomCode: string): Promise<TransportHost> {
    const host = await this.inner.host(roomCode);
    const links = new Set<ImpairedLink>();
    return {
      get roomCode() { return host.roomCode; },
      onJoin: handler => host.onJoin(link => {
        const wrapped = this.wrap(link);
        links.add(wrapped);
        wrapped.onClose(() => links.delete(wrapped));
        handler(wrapped);
      }),
      onBrokerLost: handler => host.onBrokerLost(handler),
      close: () => {
        for (const link of links) link.cancel();
        host.close();
      },
    };
  }

  async join(roomCode: string): Promise<PeerLink> { return this.wrap(await this.inner.join(roomCode)); }

  private wrap(inner: PeerLink): ImpairedLink {
    const link = new ImpairedLink(inner, this.timers, kind => this.delay(kind));
    this.links.add(link);
    inner.onClose(() => this.links.delete(link));
    return link;
  }

  private delay(kind: ChannelKind): number | null {
    const profile = this.profile;
    if (!profile) return null;
    const { latencyMs, jitterMs, lossRate, bursts } = profile;
    const inBurst = bursts && this.timers.now() % bursts.periodMs < bursts.lengthMs;
    if (kind === 'unreliable' && this.random() < lossRate) return -1;
    if (kind === 'unreliable' && inBurst && this.random() < bursts.lossRate) return -1;
    return Math.max(0, latencyMs + (this.random() * 2 - 1) * jitterMs) +
      (inBurst ? bursts.extraLatencyMs : 0);
  }
}

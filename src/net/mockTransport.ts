import { normalize, toPeerId } from './roomCode';
import { TransportError } from './transport';
import type { ChannelKind, PeerLink, Transport, TransportHost, WireData } from './transport';

export interface MockTransportOptions {
  seed?: number;
  /** One-way delay. RTT without jitter is twice this value. */
  latencyMs?: number;
  /** Uniform +/- jitter applied independently in each direction. */
  jitterMs?: number;
  lossRate?: number;
  reorderRate?: number;
  /** Extra random delay for packets selected for reordering. */
  reorderDelayMs?: number;
}

interface Delivery { at: number; sequence: number; link: MockLink; kind: ChannelKind; data: WireData }

class MockLink implements PeerLink {
  other!: MockLink;
  closed = false;
  reliableDue = 0;
  private closeReason = '';
  private readonly messageHandlers: ((kind: ChannelKind, data: WireData) => void)[] = [];
  private readonly closeHandlers: ((reason: string) => void)[] = [];

  constructor(readonly peerId: string, private readonly network: MockTransport, private readonly detached: () => void) {}

  send(kind: ChannelKind, data: WireData): void {
    if (this.closed) return;
    if (kind !== 'reliable' && kind !== 'unreliable') throw new TypeError('Invalid channel');
    if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) throw new TypeError('Invalid wire data');
    this.network.schedule(this, kind, data);
  }
  onMessage(handler: (kind: ChannelKind, data: WireData) => void): void { this.messageHandlers.push(handler); }
  onClose(handler: (reason: string) => void): void {
    if (this.closed) handler(this.closeReason);
    else this.closeHandlers.push(handler);
  }
  deliver(kind: ChannelKind, data: WireData): void {
    if (this.closed) return;
    for (const handler of this.messageHandlers) handler(kind, data);
  }
  close(): void { this.disconnect('closed', 'peer_closed'); }
  disconnect(reason: string, remoteReason = reason): void {
    if (this.closed) return;
    // Both ends become closed before any callback may send or close again.
    this.closed = this.other.closed = true;
    this.closeReason = reason;
    this.other.closeReason = remoteReason;
    this.network.cancel(this);
    this.detached();
    this.messageHandlers.length = this.other.messageHandlers.length = 0;
    const errors: unknown[] = [];
    for (const [link, closeReason] of [[this, reason], [this.other, remoteReason]] as const) {
      for (const handler of link.closeHandlers.splice(0)) {
        try { handler(closeReason); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Mock close handler failed');
  }
}

class MockHost implements TransportHost {
  readonly links = new Set<MockLink>();
  private handler: ((link: PeerLink) => void) | undefined;
  private pending: MockLink[] = [];
  closed = false;

  constructor(private readonly remove: () => void) {}

  onJoin(handler: (link: PeerLink) => void): void {
    if (this.closed) return;
    this.handler = handler;
    for (const link of this.pending.splice(0)) if (!link.closed) handler(link);
  }
  accept(link: MockLink): void {
    this.links.add(link);
    if (this.handler) this.handler(link);
    else this.pending.push(link);
  }
  forget(link: MockLink): void {
    this.links.delete(link);
    this.pending = this.pending.filter(pending => pending !== link);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.remove();
    this.pending = [];
    this.handler = undefined;
    const errors: unknown[] = [];
    for (const link of this.links) {
      try { link.disconnect('host_closed'); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Mock host close handler failed');
  }
}

/** One instance is an isolated virtual network; call host/join for every participant. */
export class MockTransport implements Transport {
  private readonly rooms = new Map<string, MockHost>();
  private readonly options: Required<MockTransportOptions>;
  private randomState: number;
  private clock = 0;
  private nextPeer = 1;
  private nextSequence = 0;
  private deliveries: Delivery[] = [];

  constructor(options: MockTransportOptions = {}) {
    this.options = { seed: 1, latencyMs: 20, jitterMs: 0, lossRate: 0, reorderRate: 0,
      reorderDelayMs: 40, ...options };
    const settings = this.options;
    if (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 0xffffffff ||
      ![settings.latencyMs, settings.jitterMs, settings.reorderDelayMs].every(value => Number.isFinite(value) && value >= 0) ||
      ![settings.lossRate, settings.reorderRate].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new RangeError('Invalid mock network options');
    }
    this.randomState = settings.seed;
  }
  get now(): number { return this.clock; }
  get pendingMessages(): number { return this.deliveries.length; }

  async host(roomCode: string): Promise<TransportHost> {
    const code = normalize(roomCode);
    if (code === null) throw new TypeError('Invalid room code');
    if (this.rooms.has(code)) throw new TransportError('room_taken');
    const host = new MockHost(() => this.rooms.delete(code));
    this.rooms.set(code, host);
    return host;
  }
  async join(roomCode: string): Promise<PeerLink> {
    const code = normalize(roomCode);
    if (code === null) throw new TypeError('Invalid room code');
    const host = this.rooms.get(code);
    if (!host || host.closed) throw new TransportError('room_not_found');
    const hostLink = new MockLink(`mock-guest-${this.nextPeer++}`, this, () => host.forget(hostLink));
    const guestLink = new MockLink(toPeerId(code), this, () => host.forget(hostLink));
    hostLink.other = guestLink;
    guestLink.other = hostLink;
    host.accept(hostLink);
    return guestLink;
  }

  private random(): number {
    // Mulberry32 also has a non-degenerate stream for seed zero.
    this.randomState = (this.randomState + 0x6d2b79f5) >>> 0;
    let value = this.randomState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  }

  /** Internal link operation; randomness is consumed only by send, never by advance. */
  schedule(sender: MockLink, kind: ChannelKind, data: WireData): void {
    const { latencyMs, jitterMs, lossRate, reorderRate, reorderDelayMs } = this.options;
    if (kind === 'unreliable' && this.random() < lossRate) return;
    let delay = Math.max(0, latencyMs + (this.random() * 2 - 1) * jitterMs);
    if (kind === 'unreliable' && this.random() < reorderRate) delay += this.random() * reorderDelayMs;
    let at = this.clock + delay;
    if (kind === 'reliable') {
      at = Math.max(at, sender.reliableDue);
      sender.reliableDue = at;
    }
    const delivery: Delivery = { at, sequence: this.nextSequence++, link: sender.other, kind,
      data: typeof data === 'string' ? data : data.slice(0) };
    this.deliveries.push(delivery);
    this.deliveries.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
  }
  cancel(link: MockLink): void {
    this.deliveries = this.deliveries.filter(delivery => delivery.link !== link && delivery.link !== link.other);
  }

  advance(ms: number): void {
    const target = this.clock + ms;
    if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(target)) throw new RangeError('Invalid clock advance');
    let count = 0;
    while (this.deliveries.length && this.deliveries[0].at <= target) {
      if (++count > 100_000) throw new Error('Mock network did not quiesce');
      const delivery = this.deliveries.shift()!;
      this.clock = delivery.at;
      delivery.link.deliver(delivery.kind, delivery.data);
    }
    this.clock = target;
  }

  flush(): void {
    let count = 0;
    while (this.deliveries.length) {
      if (++count > 100_000) throw new Error('Mock network did not quiesce');
      this.advance(this.deliveries[0].at - this.clock);
    }
  }
}

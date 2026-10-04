import type { DataConnection, Peer, PeerOptions } from 'peerjs';
import { unpackClock } from './clock';
import { PacketKind } from './protocol';
import { generateRoomCode, normalize, toPeerId } from './roomCode';
import { TransportError } from './transport';
import type { ChannelKind, PeerLink, Transport, TransportErrorCode, TransportHost, WireData } from './transport';

const BROKER_TIMEOUT_MS = 8_000;
const ICE_TIMEOUT_MS = 15_000;
const DISCONNECTED_TIMEOUT_MS = 8_000;
const RAW_TIMEOUT_MS = 2_000;
const CHANNEL_LABEL = 'pcircuit-unreliable-v1';
const CONTROL_KEY = '__pcircuitTransport';
// PeerJS 1.5 JSON rejects frames >= 16,300 bytes instead of chunking them.
const JSON_FRAME_BYTES = 16_000;
const CHUNK_CHARS = 2_048;
const MAX_REASSEMBLY_CHARS = 1_048_576;
const encoder = new TextEncoder();

interface ChannelDebug {
  peerId: string;
  kind: ChannelKind;
  mode: 'peerjs' | 'raw' | 'fallback' | 'reliable-fallback';
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly readyState: RTCDataChannelState;
}

function debugNet() {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  const target = window as Window & {
    __kartDebug?: { net?: { channels: ChannelDebug[]; rttMs: Record<string, number> }; [key: string]: unknown };
  };
  const debug = target.__kartDebug ??= {};
  return debug.net ??= { channels: [], rttMs: {} };
}

function describeChannel(peerId: string, kind: ChannelKind, mode: ChannelDebug['mode'], channel: RTCDataChannel) {
  const entry: ChannelDebug = {
    peerId, kind, mode,
    get ordered() { return channel.ordered; },
    get maxRetransmits() { return channel.maxRetransmits; },
    get readyState() { return channel.readyState; },
  };
  debugNet()?.channels.push(entry);
  return () => {
    const net = debugNet();
    if (net) net.channels = net.channels.filter(value => value !== entry);
  };
}

function errorCode(error: unknown, fallback: TransportErrorCode): TransportErrorCode {
  const type = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
  if (type === 'unavailable-id') return 'room_taken';
  if (type === 'peer-unavailable') return 'room_not_found';
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
    return 'broker_unreachable';
  }
  if (type === 'webrtc' || type === 'negotiation-failed') return 'ice_failed';
  return fallback;
}

function wireData(data: unknown): WireData | undefined {
  if (typeof data === 'string' || data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    // Copy just the view, not the surrounding buffer (which may be pooled).
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  }
}

async function openPeer(id: string | undefined, options: PeerOptions): Promise<Peer> {
  // Keep all PeerJS runtime code out of the single-player entry chunk.
  const { Peer } = await import('peerjs');
  return new Promise((resolve, reject) => {
    const peer = id === undefined ? new Peer(options) : new Peer(id, options);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      peer.off('error', onError);
      peer.off('disconnected', onLost);
      peer.off('close', onLost);
      peer.off('open', onOpen);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onLost);
    };
    const timer = setTimeout(() => fail('broker_unreachable'), BROKER_TIMEOUT_MS);
    const fail = (code: TransportErrorCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      peer.destroy();
      reject(new TransportError(code));
    };
    const onError = (error: unknown) => fail(errorCode(error, 'broker_unreachable'));
    const onLost = () => fail('broker_unreachable');
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(peer);
    };
    peer.on('error', onError);
    peer.on('disconnected', onLost);
    peer.on('close', onLost);
    peer.on('open', onOpen);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onLost);
  });
}

class PeerJsLink implements PeerLink {
  readonly peerId: string;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: TransportError) => void;
  private readySettled = false;
  private closeReason: string | undefined;
  private raw?: RTCDataChannel;
  private fallback?: DataConnection;
  private unreliableMode: 'raw' | 'peerjs' | 'reliable' = 'raw';
  private removeRawDebug?: () => void;
  private removeFallback?: () => void;
  private remoteRawReady = false;
  private started = false;
  private iceTimer: ReturnType<typeof setTimeout>;
  private rawTimer?: ReturnType<typeof setTimeout>;
  private disconnectedTimer?: ReturnType<typeof setTimeout>;
  private pending: { kind: ChannelKind; data: WireData }[] = [];
  private pendingBytes = 0;
  private controlFragments = '';
  private readonly messageHandlers: ((kind: ChannelKind, data: WireData) => void)[] = [];
  private readonly closeHandlers: ((reason: string) => void)[] = [];
  private readonly cleanup: (() => void)[] = [];
  private readonly pings = new Set<number>();

  constructor(private readonly peer: Peer, readonly control: DataConnection, private readonly guest: boolean) {
    this.peerId = control.peer;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.iceTimer = setTimeout(() => this.disconnect('ice_failed'), ICE_TIMEOUT_MS);
    const onData = (data: unknown) => this.receiveControl(data);
    const onOpen = () => this.start();
    const onControlError = (error: unknown) => this.disconnect(errorCode(error, 'ice_failed'));
    const onControlClose = () => this.disconnect(this.readySettled ? 'peer_closed' : 'ice_failed');
    const pc = control.peerConnection;
    const onIceStateChange = () => {
      if (this.closed) return;
      const state = pc.iceConnectionState;
      if (state === 'disconnected' && this.disconnectedTimer === undefined) {
        this.disconnectedTimer = setTimeout(() => this.disconnect('peer_closed'), DISCONNECTED_TIMEOUT_MS);
      } else if (state === 'connected' || state === 'completed') {
        clearTimeout(this.disconnectedTimer);
        this.disconnectedTimer = undefined;
      } else if (state === 'failed') {
        this.disconnect('ice_failed');
      } else if (state === 'closed') {
        onControlClose();
      }
    };
    control.on('data', onData);
    control.on('open', onOpen);
    control.on('error', onControlError);
    control.on('close', onControlClose);
    pc.addEventListener('iceconnectionstatechange', onIceStateChange);
    this.cleanup.push(() => {
      control.off('data', onData);
      control.off('open', onOpen);
      control.off('error', onControlError);
      control.off('close', onControlClose);
      pc.removeEventListener('iceconnectionstatechange', onIceStateChange);
    });
    const onError = (error: unknown) => {
      const code = errorCode(error, 'ice_failed');
      // Host Peer errors may belong to a different guest's SDP/ICE negotiation.
      // Its individual connection (or deadline) decides that link's outcome.
      if (!this.readySettled && (this.guest || code === 'broker_unreachable')) this.disconnect(code);
    };
    const onDisconnected = () => { if (!this.readySettled) this.disconnect('broker_unreachable'); };
    const onClose = () => this.disconnect('peer_closed');
    peer.on('error', onError);
    peer.on('disconnected', onDisconnected);
    peer.on('close', onClose);
    this.cleanup.push(() => {
      peer.off('error', onError);
      peer.off('disconnected', onDisconnected);
      peer.off('close', onClose);
    });
    if (guest && typeof window !== 'undefined') {
      const onPageHide = () => this.close();
      window.addEventListener('pagehide', onPageHide);
      this.cleanup.push(() => window.removeEventListener('pagehide', onPageHide));
    }
    onIceStateChange();
    if (control.open) this.start();
  }

  get closed(): boolean { return this.closeReason !== undefined; }

  private start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.cleanup.push(describeChannel(this.peerId, 'reliable', 'peerjs', this.control.dataChannel));
    try {
      // Both ends open the same negotiated stream. In-band channels would be
      // consumed by PeerJS's ondatachannel handler, replacing its JSON channel.
      const channel = this.control.peerConnection.createDataChannel(CHANNEL_LABEL, {
        negotiated: true, id: 42, ordered: false, maxRetransmits: 0,
      });
      this.raw = channel;
      channel.binaryType = 'arraybuffer';
      if (channel.ordered || channel.maxRetransmits !== 0) {
        this.useFallback();
        return;
      }
      channel.onmessage = event => this.receive('unreliable', event.data);
      channel.onopen = () => {
        if (this.closed || this.unreliableMode !== 'raw' || this.removeRawDebug) return;
        this.removeRawDebug = describeChannel(this.peerId, 'unreliable', 'raw', channel);
        console.info('[PeerJsTransport] raw unreliable: ordered=false, maxRetransmits=0', this.peerId);
        // A negotiated channel can open locally even if the other browser cannot
        // create it. Wait for explicit confirmation before exposing the link.
        this.control.send({ [CONTROL_KEY]: 'raw-ready' });
        if (this.remoteRawReady) this.opened();
      };
      channel.onerror = channel.onclose = () => this.useFallback();
      this.rawTimer = setTimeout(() => this.useFallback(), RAW_TIMEOUT_MS);
      if (channel.readyState === 'open') channel.onopen(new Event('open'));
    } catch {
      this.useFallback();
    }
  }

  private useFallback(): void {
    if (this.closed || this.unreliableMode !== 'raw') return;
    if (this.readySettled) { this.useReliableFallback(); return; }
    this.unreliableMode = 'peerjs';
    this.closeRaw();
    this.control.send({ [CONTROL_KEY]: 'fallback' });
    if (this.closed) return;
    if (this.guest) {
      try {
        this.attachFallback(this.peer.connect(this.peerId, {
          reliable: false, serialization: 'binary', label: CHANNEL_LABEL,
          metadata: { connectionId: this.control.connectionId },
        }));
      } catch {
        this.disconnect('ice_failed');
      }
    }
  }

  private closeRaw(): void {
    clearTimeout(this.rawTimer);
    this.removeRawDebug?.();
    this.removeRawDebug = undefined;
    if (this.raw) {
      this.raw.onopen = this.raw.onmessage = this.raw.onerror = this.raw.onclose = null;
      this.raw.close();
      this.raw = undefined;
    }
  }

  private useReliableFallback(): void {
    if (this.closed || this.unreliableMode === 'reliable') return;
    if (!this.control.open) { this.disconnect('peer_closed'); return; }
    this.unreliableMode = 'reliable';
    this.closeRaw();
    this.removeFallback?.();
    this.cleanup.push(describeChannel(this.peerId, 'unreliable', 'reliable-fallback', this.control.dataChannel));
    this.control.send({ [CONTROL_KEY]: 'reliable-fallback' });
    if (this.closed) return;
    console.info('[PeerJsTransport] fallback: existing reliable channel', this.peerId);
    this.opened();
  }

  attachFallback(connection: DataConnection): void {
    if (this.closed || this.fallback || this.unreliableMode === 'reliable') { connection.close(); return; }
    this.useFallback();
    // PeerJS send() can synchronously emit an error and close the primary link.
    if (this.closed || this.unreliableMode !== 'peerjs') { connection.close(); return; }
    this.fallback = connection;
    const onData = (data: unknown) => this.receive('unreliable', data);
    const onLost = () => {
      if (this.readySettled) this.useReliableFallback();
      else this.disconnect('ice_failed');
    };
    let removeDebug: (() => void) | undefined;
    const opened = () => {
      if (this.closed || removeDebug) return;
      removeDebug = describeChannel(this.peerId, 'unreliable', 'fallback', connection.dataChannel);
      console.info('[PeerJsTransport] fallback: reliable=false (unordered, retransmissions allowed)', this.peerId);
      this.opened();
    };
    this.removeFallback = () => {
      connection.off('data', onData);
      connection.off('error', onLost);
      connection.off('close', onLost);
      connection.off('open', opened);
      removeDebug?.();
      this.fallback = undefined;
      this.removeFallback = undefined;
      connection.close();
    };
    connection.on('data', onData);
    connection.on('error', onLost);
    connection.on('close', onLost);
    connection.on('open', opened);
    if (connection.open) opened();
  }

  private opened(): void {
    if (this.closed) return;
    clearTimeout(this.rawTimer);
    clearTimeout(this.iceTimer);
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady();
  }

  private receiveControl(data: unknown): void {
    if (this.closed) return;
    if (data && typeof data === 'object' && CONTROL_KEY in data) {
      const envelope = data as Record<string, unknown>;
      if (envelope[CONTROL_KEY] === 'chunk') {
        if (typeof envelope.part !== 'string' || envelope.part.length > CHUNK_CHARS ||
          typeof envelope.last !== 'boolean' ||
          this.controlFragments.length + envelope.part.length > MAX_REASSEMBLY_CHARS) {
          this.disconnect('receive_overflow');
          return;
        }
        this.controlFragments += envelope.part;
        if (envelope.last) {
          const serialized = this.controlFragments;
          this.controlFragments = '';
          let decoded: unknown;
          try { decoded = JSON.parse(serialized); } catch { return; }
          // Reassembled frames contain application data, never another chunk.
          if (typeof decoded === 'string' || (decoded && typeof decoded === 'object' &&
            CONTROL_KEY in decoded && (decoded[CONTROL_KEY] === 'buffer' || decoded[CONTROL_KEY] === 'unreliable'))) {
            this.receiveControl(decoded);
          }
        }
      }
      else if (envelope[CONTROL_KEY] === 'fallback') this.useFallback();
      else if (envelope[CONTROL_KEY] === 'reliable-fallback') this.useReliableFallback();
      else if (envelope[CONTROL_KEY] === 'raw-ready') {
        this.remoteRawReady = true;
        if (this.unreliableMode === 'raw' && this.raw?.readyState === 'open') this.opened();
      }
      else if (envelope[CONTROL_KEY] === 'buffer' && Array.isArray(envelope.bytes) &&
        envelope.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
        this.receive('reliable', Uint8Array.from(envelope.bytes));
      }
      else if (envelope[CONTROL_KEY] === 'unreliable') {
        if (typeof envelope.data === 'string') this.receive('unreliable', envelope.data);
        else if (Array.isArray(envelope.data) &&
          envelope.data.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
          this.receive('unreliable', Uint8Array.from(envelope.data));
        }
      }
      return;
    }
    this.receive('reliable', data);
  }

  private sendControl(payload: string | Record<string, unknown>): void {
    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_REASSEMBLY_CHARS) throw new RangeError('Transport message is too large');
    if (encoder.encode(serialized).byteLength < JSON_FRAME_BYTES) {
      this.control.send(payload);
      return;
    }
    // Reliable ordering permits one bounded assembly, without IDs or retry queues.
    // 2,048 code units fit even with six-byte JSON escaping per code unit.
    for (let offset = 0; offset < serialized.length && !this.closed; offset += CHUNK_CHARS) {
      this.control.send({ [CONTROL_KEY]: 'chunk', part: serialized.slice(offset, offset + CHUNK_CHARS),
        last: offset + CHUNK_CHARS >= serialized.length });
    }
  }

  private receive(kind: ChannelKind, value: unknown): void {
    if (this.closed) return;
    const data = wireData(value);
    if (data === undefined) return;
    if (import.meta.env.DEV) {
      const packet = unpackClock(data);
      if (packet?.kind === PacketKind.PONG && this.pings.delete(packet.t0)) {
        const rtt = performance.now() - packet.t0;
        const net = debugNet();
        if (net) net.rttMs[this.peerId] = rtt;
        console.info(`[PeerJsTransport] RTT ${rtt.toFixed(2)} ms`, this.peerId);
      }
    }
    if (!this.messageHandlers.length) {
      // A bounded inbox covers welcome/ping arriving before onMessage registers.
      this.pendingBytes += typeof data === 'string' ? data.length * 2 : data.byteLength;
      if (this.pending.length >= 256 || this.pendingBytes > 1_048_576) {
        this.disconnect('receive_overflow');
        return;
      }
      this.pending.push({ kind, data });
      return;
    }
    for (const handler of this.messageHandlers) handler(kind, data);
  }

  send(kind: ChannelKind, data: WireData): void {
    if (this.closed) return;
    if (kind !== 'reliable' && kind !== 'unreliable') throw new TypeError('Invalid channel');
    if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) throw new TypeError('Invalid wire data');
    if (import.meta.env.DEV) {
      const packet = unpackClock(data);
      if (packet?.kind === PacketKind.PING) {
        if (this.pings.size >= 128) this.pings.delete(this.pings.values().next().value!);
        this.pings.add(packet.t0);
      }
    }
    if (kind === 'reliable') {
      this.sendControl(typeof data === 'string' ? data : { [CONTROL_KEY]: 'buffer', bytes: [...new Uint8Array(data)] });
    } else if (this.unreliableMode === 'reliable') {
      this.sendControl({ [CONTROL_KEY]: 'unreliable', data: typeof data === 'string' ? data : [...new Uint8Array(data)] });
    } else if (this.unreliableMode === 'peerjs') {
      if (this.fallback?.open) this.fallback.send(data);
    } else {
      if (this.raw?.readyState === 'open') {
        try {
          // Both wire types are native send overloads; DOM typings lack their union.
          this.raw.send(data as ArrayBuffer);
          return;
        } catch { /* The channel can fail before its close/error event arrives. */ }
      }
      this.useReliableFallback();
      if (!this.closed) this.send('unreliable', data);
    }
  }

  onMessage(handler: (kind: ChannelKind, data: WireData) => void): void {
    if (this.closed) return;
    this.messageHandlers.push(handler);
    const pending = this.pending.splice(0);
    this.pendingBytes = 0;
    for (const message of pending) {
      if (this.closed) break;
      handler(message.kind, message.data);
    }
  }

  onClose(handler: (reason: string) => void): void {
    if (this.closeReason !== undefined) handler(this.closeReason);
    else this.closeHandlers.push(handler);
  }

  close(): void { this.disconnect('closed'); }

  disconnect(reason: string): void {
    if (this.closed) return;
    this.closeReason = reason;
    clearTimeout(this.iceTimer);
    clearTimeout(this.rawTimer);
    clearTimeout(this.disconnectedTimer);
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(new TransportError(reason === 'broker_unreachable' || reason === 'room_not_found' ? reason : 'ice_failed'));
    }
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.pending = [];
    this.pendingBytes = 0;
    this.messageHandlers.length = 0;
    this.controlFragments = '';
    this.pings.clear();
    this.closeRaw();
    this.removeFallback?.();
    this.control.close();
    if (this.guest) this.peer.destroy();
    const net = debugNet();
    if (net) delete net.rttMs[this.peerId];
    for (const handler of this.closeHandlers.splice(0)) {
      try { handler(reason); } catch (error) { console.error('[PeerJsTransport] close handler failed', error); }
    }
  }
}

/** The final code is exposed because a collision can regenerate the requested code. */
export class PeerJsHost implements TransportHost {
  readonly peerId: string;
  private readonly links = new Map<string, PeerJsLink>();
  private pending: PeerJsLink[] = [];
  private handler?: (link: PeerLink) => void;
  private closed = false;
  private brokerTimer?: ReturnType<typeof setTimeout>;
  private brokerError?: TransportError;
  private readonly brokerHandlers: ((error: TransportError) => void)[] = [];
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly peer: Peer, readonly roomCode: string) {
    this.peerId = toPeerId(roomCode);
    const onConnection = (connection: DataConnection) => {
      if (this.closed) { connection.close(); return; }
      if (connection.label === CHANNEL_LABEL && !connection.reliable && connection.serialization === 'binary') {
        const primary = this.links.get(connection.metadata?.connectionId);
        if (primary?.peerId === connection.peer) primary.attachFallback(connection);
        else connection.close();
        return;
      }
      if (!connection.reliable || connection.serialization !== 'json') { connection.close(); return; }
      const link = new PeerJsLink(peer, connection, false);
      this.links.set(connection.connectionId, link);
      link.onClose(() => {
        this.links.delete(connection.connectionId);
        this.pending = this.pending.filter(value => value !== link);
      });
      void link.ready.then(() => {
        if (this.closed || link.closed) return;
        if (this.handler) this.handler(link);
        else this.pending.push(link);
      }, () => { /* The failed connection has already been closed. */ });
    };
    const onDisconnected = () => {
      if (this.closed || this.brokerTimer !== undefined || this.brokerError) return;
      this.brokerTimer = setTimeout(() => this.brokerLost(), BROKER_TIMEOUT_MS);
      try { peer.reconnect(); } catch { this.brokerLost(); }
    };
    const onOpen = () => {
      clearTimeout(this.brokerTimer);
      this.brokerTimer = undefined;
      this.brokerError = undefined;
    };
    const onError = (error: unknown) => {
      const code = errorCode(error, 'ice_failed');
      if (this.brokerTimer !== undefined && (code === 'broker_unreachable' || code === 'room_taken')) this.brokerLost();
    };
    const onClose = () => this.close();
    peer.on('connection', onConnection);
    peer.on('disconnected', onDisconnected);
    peer.on('open', onOpen);
    peer.on('error', onError);
    peer.on('close', onClose);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onClose);
    this.cleanup.push(() => {
      peer.off('connection', onConnection);
      peer.off('disconnected', onDisconnected);
      peer.off('open', onOpen);
      peer.off('error', onError);
      peer.off('close', onClose);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onClose);
    });
  }

  private brokerLost(): void {
    if (this.closed || this.brokerError) return;
    clearTimeout(this.brokerTimer);
    this.brokerTimer = undefined;
    this.brokerError = new TransportError('broker_unreachable');
    for (const handler of this.brokerHandlers) {
      try { handler(this.brokerError); } catch (error) { console.error('[PeerJsTransport] broker handler failed', error); }
    }
  }

  onBrokerLost(handler: (error: TransportError) => void): void {
    if (this.closed) return;
    this.brokerHandlers.push(handler);
    if (this.brokerError) handler(this.brokerError);
  }

  onJoin(handler: (link: PeerLink) => void): void {
    if (this.closed) return;
    this.handler = handler;
    for (const link of this.pending.splice(0)) if (!link.closed) handler(link);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.brokerTimer);
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.brokerHandlers.length = 0;
    this.pending = [];
    this.handler = undefined;
    for (const link of this.links.values()) link.disconnect('host_closed');
    this.links.clear();
    this.peer.destroy();
  }
}

export class PeerJsTransport implements Transport {
  constructor(private readonly options: PeerOptions = {}) {}

  async host(roomCode: string): Promise<PeerJsHost> {
    let code = normalize(roomCode);
    if (code === null) throw new TypeError('Invalid room code');
    for (let retries = 0; ; retries++) {
      try {
        const peer = await openPeer(toPeerId(code), this.options);
        return new PeerJsHost(peer, code);
      } catch (error) {
        if (!(error instanceof TransportError) || error.code !== 'room_taken' || retries === 3) throw error;
        code = generateRoomCode();
      }
    }
  }

  async join(roomCode: string): Promise<PeerLink> {
    const code = normalize(roomCode);
    if (code === null) throw new TypeError('Invalid room code');
    const peer = await openPeer(undefined, this.options);
    try {
      const connection = peer.connect(toPeerId(code), { reliable: true, serialization: 'json' });
      const link = new PeerJsLink(peer, connection, true);
      await link.ready;
      return link;
    } catch (error) {
      peer.destroy();
      if (error instanceof TransportError) throw error;
      throw new TransportError(errorCode(error, 'ice_failed'));
    }
  }
}

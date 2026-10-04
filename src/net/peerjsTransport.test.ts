import { EventEmitter } from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { packPing, packPong } from './clock';
import { PeerJsTransport } from './peerjsTransport';
import { generateRoomCode, toPeerId } from './roomCode';
import type { PeerLink } from './transport';

vi.mock('peerjs', () => ({ Peer: FakePeer }));
vi.mock('./roomCode', async importOriginal => ({
  ...await importOriginal<typeof import('./roomCode')>(), generateRoomCode: vi.fn(() => 'CD3Y'),
}));

const CONTROL = '__pcircuitTransport';

class FakeChannel {
  readyState: RTCDataChannelState = 'connecting';
  binaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly ordered = false, readonly maxRetransmits: number | null = 0) {}
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 'closed';
    this.onclose?.(new Event('close'));
  });
  open(): void { this.readyState = 'open'; this.onopen?.(new Event('open')); }
}

class FakePC extends EventTarget {
  iceConnectionState: RTCIceConnectionState = 'new';
  channels: FakeChannel[] = [];
  createDataChannel = vi.fn((_label: string, _options: RTCDataChannelInit) => {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  });
  changeIce(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.dispatchEvent(new Event('iceconnectionstatechange'));
  }
}

class FakeConnection extends EventEmitter {
  open = false;
  connectionId = 'control-1';
  peerConnection = new FakePC();
  dataChannel = new FakeChannel(true, null);
  constructor(readonly peer = toPeerId('AB2X'), readonly reliable = true,
    readonly serialization = 'json', readonly label = '', readonly metadata = {}) { super(); }
  send = vi.fn();
  close = vi.fn(() => {
    this.open = false;
    this.dataChannel.close();
    this.emit('close');
  });
  start(): void {
    this.open = true;
    this.dataChannel.open();
    this.peerConnection.changeIce('connected');
    this.emit('open');
  }
}

class FakePeer extends EventEmitter {
  static peers: FakePeer[] = [];
  connections: FakeConnection[] = [];
  destroyed = false;
  constructor(readonly idOrOptions: unknown, readonly options?: unknown) {
    super(); FakePeer.peers.push(this);
  }
  connect = vi.fn((id: string, options: { reliable: boolean; serialization: string; label?: string; metadata?: object }) => {
    const connection = new FakeConnection(id, options.reliable, options.serialization, options.label, options.metadata);
    this.connections.push(connection);
    return connection;
  });
  destroy = vi.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  });
  reconnect = vi.fn();
}

type DebugWindow = EventTarget & {
  __kartDebug?: { net: { channels: { mode: string; ordered: boolean; maxRetransmits: number | null }[];
    rttMs: Record<string, number> } };
};
let browser: DebugWindow;
const tick = () => vi.advanceTimersByTimeAsync(0);
const latestPeer = () => FakePeer.peers.at(-1)!;

async function connecting() {
  const promise = new PeerJsTransport().join(' ab2x ');
  // Observe early rejections even while fake time advances toward the deadline.
  void promise.catch(() => {});
  await tick();
  const peer = latestPeer();
  peer.emit('open');
  await tick();
  return { peer, control: peer.connections[0], promise };
}

async function connected() {
  const setup = await connecting();
  setup.control.start();
  const raw = setup.control.peerConnection.channels[0];
  raw.open();
  setup.control.emit('data', { [CONTROL]: 'raw-ready' });
  return { ...setup, raw, link: await setup.promise };
}

async function hosting() {
  const promise = new PeerJsTransport().host(' ab2x ');
  await tick();
  const peer = latestPeer();
  peer.emit('open');
  return { peer, host: await promise };
}

async function accept(peer: FakePeer) {
  const control = new FakeConnection('guest-id');
  peer.emit('connection', control);
  control.start();
  const raw = control.peerConnection.channels[0];
  raw.open();
  control.emit('data', { [CONTROL]: 'raw-ready' });
  await tick();
  return { control, raw };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakePeer.peers = [];
  browser = new EventTarget();
  vi.stubGlobal('window', browser);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(generateRoomCode).mockReset().mockReturnValue('CD3Y');
});
afterEach(() => {
  browser.dispatchEvent(new Event('pagehide'));
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PeerJsTransport setup', () => {
  it('uses the normalized host ID and the reliable JSON guest connection', async () => {
    const { host, peer } = await hosting();
    expect(host.roomCode).toBe('AB2X');
    expect(peer.idOrOptions).toBe(toPeerId('AB2X'));
    const { peer: guest, link } = await connected();
    expect(guest.idOrOptions).toEqual({});
    expect(guest.connect).toHaveBeenCalledExactlyOnceWith(toPeerId('AB2X'), { reliable: true, serialization: 'json' });
    link.close(); host.close();
  });

  it('regenerates collisions at most three times and exposes the assigned code', async () => {
    vi.mocked(generateRoomCode).mockReturnValueOnce('CD3Y').mockReturnValueOnce('EF4Z').mockReturnValueOnce('GH5X');
    const promise = new PeerJsTransport().host('AB2X');
    await tick();
    for (let attempt = 0; attempt < 3; attempt++) {
      const peer = latestPeer();
      peer.emit('error', { type: 'unavailable-id' });
      await tick();
      expect(peer.destroy).toHaveBeenCalledOnce();
    }
    latestPeer().emit('open');
    const host = await promise;
    expect(host.roomCode).toBe('GH5X');
    expect(FakePeer.peers.map(peer => peer.idOrOptions)).toEqual([
      toPeerId('AB2X'), toPeerId('CD3Y'), toPeerId('EF4Z'), toPeerId('GH5X'),
    ]);
    host.close();
  });

  it('rejects after the fourth unavailable-id response', async () => {
    const promise = new PeerJsTransport().host('AB2X');
    const rejected = expect(promise).rejects.toMatchObject({ code: 'room_taken' });
    await tick();
    for (let attempt = 0; attempt < 4; attempt++) {
      latestPeer().emit('error', { type: 'unavailable-id' });
      await tick();
    }
    await rejected;
    expect(generateRoomCode).toHaveBeenCalledTimes(3);
    expect(FakePeer.peers).toHaveLength(4);
  });

  it('reports broker_unreachable at 8 seconds and cleans up pending setup', async () => {
    const promise = new PeerJsTransport().host('AB2X');
    const rejected = expect(promise).rejects.toMatchObject({ code: 'broker_unreachable' });
    await tick();
    const peer = latestPeer();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(peer.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(peer.destroy).toHaveBeenCalledOnce();
    expect(peer.eventNames()).toEqual([]);
  });

  it('maps peer-unavailable to room_not_found', async () => {
    const { peer, promise } = await connecting();
    peer.emit('error', { type: 'peer-unavailable' });
    await expect(promise).rejects.toMatchObject({ code: 'room_not_found' });
    expect(peer.destroyed).toBe(true);
  });

  it('reports ice_failed at 15 seconds after the broker opens', async () => {
    const { peer, promise } = await connecting();
    const rejected = expect(promise).rejects.toMatchObject({ code: 'ice_failed' });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(peer.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(peer.destroyed).toBe(true);
  });
});

describe('disconnect detection and cleanup', () => {
  it('closes once after 8 seconds disconnected without a PeerJS close event', async () => {
    const { control, link, peer } = await connected();
    const closed = vi.fn();
    link.onClose(closed);
    control.peerConnection.changeIce('disconnected');
    await vi.advanceTimersByTimeAsync(4_000);
    control.peerConnection.changeIce('disconnected');
    await vi.advanceTimersByTimeAsync(3_999);
    expect(closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toHaveBeenCalledExactlyOnceWith('peer_closed');
    expect(peer.destroyed).toBe(true);
    expect(browser.__kartDebug?.net.channels).toEqual([]);
    link.close();
    expect(closed).toHaveBeenCalledOnce();
  });

  it.each(['connected', 'completed'] as const)('cancels the grace period on %s and rearms on a later disconnect', async state => {
    const { control, link } = await connected();
    const closed = vi.fn();
    link.onClose(closed);
    control.peerConnection.changeIce('disconnected');
    await vi.advanceTimersByTimeAsync(7_999);
    control.peerConnection.changeIce(state);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(closed).not.toHaveBeenCalled();
    control.peerConnection.changeIce('disconnected');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(closed).toHaveBeenCalledExactlyOnceWith('peer_closed');
  });

  it('releases the host link after an abandoned guest and accepts a new guest', async () => {
    const { host, peer } = await hosting();
    const links: PeerLink[] = [];
    host.onJoin(link => links.push(link));
    const { control } = await accept(peer);
    const closed = vi.fn();
    links[0].onClose(closed);
    control.peerConnection.changeIce('disconnected');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(closed).toHaveBeenCalledExactlyOnceWith('peer_closed');
    expect(peer.destroyed).toBe(false);
    await accept(peer);
    expect(links).toHaveLength(2);
    host.close();
  });

  it('runs all close handlers despite exceptions and removes listeners and timers', async () => {
    const { control, link, raw, peer } = await connected();
    const removeIce = vi.spyOn(control.peerConnection, 'removeEventListener');
    const removePage = vi.spyOn(browser, 'removeEventListener');
    const closed = vi.fn();
    link.onClose(() => { throw new Error('consumer failed'); });
    link.onClose(closed);
    control.peerConnection.changeIce('disconnected');
    expect(() => link.close()).not.toThrow();
    expect(closed).toHaveBeenCalledExactlyOnceWith('closed');
    expect(removeIce).toHaveBeenCalledWith('iceconnectionstatechange', expect.any(Function));
    expect(removePage).toHaveBeenCalledWith('pagehide', expect.any(Function));
    expect(control.eventNames()).toEqual([]);
    expect(peer.eventNames()).toEqual([]);
    expect([raw.onopen, raw.onmessage, raw.onerror, raw.onclose]).toEqual([null, null, null, null]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('destroys the guest peer and closes the host on pagehide', async () => {
    const { peer: hostPeer, host } = await hosting();
    const joined = vi.fn();
    host.onJoin(joined);
    await accept(hostPeer);
    const hostClosed = vi.fn();
    (joined.mock.calls[0][0] as PeerLink).onClose(hostClosed);
    const { peer: guestPeer, link } = await connected();
    const guestClosed = vi.fn();
    link.onClose(guestClosed);
    browser.dispatchEvent(new Event('pagehide'));
    expect(hostClosed).toHaveBeenCalledExactlyOnceWith('host_closed');
    expect(guestClosed).toHaveBeenCalledExactlyOnceWith('closed');
    expect(hostPeer.destroy).toHaveBeenCalledOnce();
    expect(guestPeer.destroy).toHaveBeenCalledOnce();
    expect(hostPeer.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('unreliable channel and fallback', () => {
  it('opens a negotiated unordered channel without retransmissions and normalizes views', async () => {
    const { control, raw, link } = await connected();
    expect(control.peerConnection.createDataChannel).toHaveBeenCalledExactlyOnceWith('pcircuit-unreliable-v1', {
      negotiated: true, id: 42, ordered: false, maxRetransmits: 0,
    });
    expect(raw.binaryType).toBe('arraybuffer');
    expect(browser.__kartDebug?.net.channels).toContainEqual(expect.objectContaining({ mode: 'raw', ordered: false, maxRetransmits: 0 }));
    const bytes = new Uint8Array([99, 1, 2, 99]);
    raw.onmessage?.({ data: bytes.subarray(1, 3) });
    const received = vi.fn();
    link.onMessage(received);
    expect(received).toHaveBeenCalledWith('unreliable', new Uint8Array([1, 2]).buffer);
    link.send('unreliable', 'text');
    link.send('unreliable', bytes.buffer);
    expect(raw.send.mock.calls).toEqual([['text'], [bytes.buffer]]);
  });

  it.each(['unsupported', 'wrong-options', 'remote-timeout'] as const)('uses a reliable:false connection for initial %s', async failure => {
    const { control, peer, promise } = await connecting();
    if (failure === 'unsupported') control.peerConnection.createDataChannel.mockImplementation(() => { throw new Error('unsupported'); });
    if (failure === 'wrong-options') control.peerConnection.createDataChannel.mockReturnValue(new FakeChannel(true, null));
    control.start();
    if (failure === 'remote-timeout') {
      control.peerConnection.channels[0].open();
      expect(browser.__kartDebug?.net.channels.some(channel => channel.mode === 'raw')).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(peer.connect).toHaveBeenLastCalledWith(toPeerId('AB2X'), {
      reliable: false, serialization: 'binary', label: 'pcircuit-unreliable-v1', metadata: { connectionId: 'control-1' },
    });
    const fallback = peer.connections[1];
    fallback.start();
    const link = await promise;
    expect(browser.__kartDebug?.net.channels.map(channel => channel.mode)).toEqual(['peerjs', 'fallback']);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('reliable=false'), link.peerId);
    link.send('unreliable', 'packet');
    expect(fallback.send).toHaveBeenCalledWith('packet');
    const received = vi.fn();
    link.onMessage(received);
    fallback.emit('data', new Uint8Array([1, 2]));
    expect(received).toHaveBeenCalledWith('unreliable', new Uint8Array([1, 2]).buffer);
  });

  it.each(['close', 'error'] as const)('keeps a ready link alive after raw %s using the reliable channel', async failure => {
    const { control, raw, peer, link } = await connected();
    const closed = vi.fn();
    link.onClose(closed);
    if (failure === 'close') raw.close();
    else raw.onerror?.(new Event('error'));
    expect(peer.connect).toHaveBeenCalledTimes(1);
    expect(browser.__kartDebug?.net.channels.map(channel => channel.mode)).toEqual(['peerjs', 'reliable-fallback']);
    expect(control.send).toHaveBeenCalledWith({ [CONTROL]: 'reliable-fallback' });
    link.send('unreliable', new Uint8Array([3, 4]).buffer);
    expect(control.send).toHaveBeenLastCalledWith({ [CONTROL]: 'unreliable', data: [3, 4] });
    link.send('unreliable', 'message');
    expect(control.send).toHaveBeenLastCalledWith({ [CONTROL]: 'unreliable', data: 'message' });
    const received = vi.fn();
    link.onMessage(received);
    control.emit('data', { [CONTROL]: 'unreliable', data: [5, 6] });
    control.emit('data', { [CONTROL]: 'unreliable', data: 'reply' });
    control.emit('data', { [CONTROL]: 'unreliable', data: [-1] });
    expect(received.mock.calls).toEqual([
      ['unreliable', new Uint8Array([5, 6]).buffer], ['unreliable', 'reply'],
    ]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(closed).not.toHaveBeenCalled();
    expect(peer.destroyed).toBe(false);
    link.send('reliable', 'control remains usable');
    expect(control.send).toHaveBeenLastCalledWith('control remains usable');
  });

  it('switches both directions when the remote announces reliable fallback', async () => {
    const { control, raw, link } = await connected();
    control.emit('data', { [CONTROL]: 'reliable-fallback' });
    control.emit('data', { [CONTROL]: 'reliable-fallback' });
    expect(raw.close).toHaveBeenCalledOnce();
    expect(browser.__kartDebug?.net.channels.map(channel => channel.mode)).toEqual(['peerjs', 'reliable-fallback']);
    link.send('unreliable', 'response');
    expect(control.send).toHaveBeenLastCalledWith({ [CONTROL]: 'unreliable', data: 'response' });
  });

  it.each(['throws', 'closing'] as const)('uses reliable fallback when raw send %s before a close event', async failure => {
    const { control, raw, link } = await connected();
    const closed = vi.fn();
    link.onClose(closed);
    if (failure === 'throws') raw.send.mockImplementation(() => { throw new DOMException('channel failed', 'OperationError'); });
    else raw.readyState = 'closing';
    expect(() => link.send('unreliable', 'input')).not.toThrow();
    expect(control.send).toHaveBeenLastCalledWith({ [CONTROL]: 'unreliable', data: 'input' });
    expect(browser.__kartDebug?.net.channels.map(channel => channel.mode)).toEqual(['peerjs', 'reliable-fallback']);
    expect(closed).not.toHaveBeenCalled();
  });

  it('keeps the link after a ready PeerJS fallback closes and removes its listeners', async () => {
    const { control, peer, promise } = await connecting();
    control.peerConnection.createDataChannel.mockImplementation(() => { throw new Error('unsupported'); });
    control.start();
    const fallback = peer.connections[1];
    fallback.start();
    const link = await promise;
    const closed = vi.fn();
    link.onClose(closed);
    fallback.close();
    expect(fallback.eventNames()).toEqual([]);
    expect(browser.__kartDebug?.net.channels.map(channel => channel.mode)).toEqual(['peerjs', 'reliable-fallback']);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(closed).not.toHaveBeenCalled();
  });

  it('records ping/pong RTT in browser debug state and logs it', async () => {
    const { raw, link } = await connected();
    const t0 = performance.now();
    link.send('unreliable', packPing(t0));
    raw.onmessage?.({ data: packPong(t0, t0 + 1) });
    expect(browser.__kartDebug?.net.rttMs[link.peerId]).toBeGreaterThanOrEqual(0);
    expect(console.info).toHaveBeenCalledWith(expect.stringMatching(/RTT .* ms/), link.peerId);
  });
});

describe('reliable JSON size limits', () => {
  it.each(['reliable', 'unreliable'] as const)('round-trips large %s messages below the PeerJS frame limit', async kind => {
    const { link, control, raw } = await connected();
    if (kind === 'unreliable') raw.close();
    const closed = vi.fn();
    const received = vi.fn();
    link.onClose(closed);
    link.onMessage(received);
    control.send.mockImplementation(payload => {
      if (new TextEncoder().encode(JSON.stringify(payload)).byteLength >= 16_300) {
        control.emit('error', { type: 'message-too-big' });
      }
    });
    const messages = ['\0😀\uD800\\"'.repeat(3_000), new Uint8Array(20_000).fill(255).buffer];
    for (const message of messages) {
      control.send.mockClear();
      link.send(kind, message);
      expect(control.send.mock.calls.length).toBeGreaterThan(1);
      expect(closed).not.toHaveBeenCalled();
      for (const [frame] of control.send.mock.calls) control.emit('data', JSON.parse(JSON.stringify(frame)));
      expect(received).toHaveBeenLastCalledWith(kind, message);
    }
    expect(received).toHaveBeenCalledTimes(messages.length);
  });

  it('bounds partial reassembly and rejects nested or malformed chunks', async () => {
    const { link, control } = await connected();
    const received = vi.fn();
    const closed = vi.fn();
    link.onMessage(received);
    link.onClose(closed);
    control.emit('data', { [CONTROL]: 'chunk', part: '{', last: true });
    control.emit('data', { [CONTROL]: 'chunk', part: JSON.stringify({ [CONTROL]: 'chunk', part: '"nested"', last: true }), last: true });
    expect(received).not.toHaveBeenCalled();
    control.emit('data', { [CONTROL]: 'chunk', part: '"ok"', last: true });
    expect(received).toHaveBeenCalledExactlyOnceWith('reliable', 'ok');
    for (let i = 0; i < 513; i++) control.emit('data', { [CONTROL]: 'chunk', part: 'x'.repeat(2_048), last: false });
    expect(closed).toHaveBeenCalledExactlyOnceWith('receive_overflow');
  });
});

describe('host broker recovery', () => {
  it('reconnects once per outage, clears the deadline on open, and keeps links alive', async () => {
    const { peer, host } = await hosting();
    const lost = vi.fn();
    host.onBrokerLost(lost);
    await accept(peer);
    peer.emit('disconnected');
    peer.emit('disconnected');
    expect(peer.reconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(7_999);
    peer.emit('open');
    await vi.advanceTimersByTimeAsync(8_001);
    expect(lost).not.toHaveBeenCalled();
    expect(peer.destroyed).toBe(false);
    peer.emit('disconnected');
    expect(peer.reconnect).toHaveBeenCalledTimes(2);
    host.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('notifies every subscriber after 8 seconds, replays late subscriptions, and preserves P2P', async () => {
    const { peer, host } = await hosting();
    const joined = vi.fn();
    host.onJoin(joined);
    const { control } = await accept(peer);
    const link = joined.mock.calls[0][0] as PeerLink;
    const closed = vi.fn();
    link.onClose(closed);
    host.onBrokerLost(() => { throw new Error('consumer failed'); });
    const lost = vi.fn();
    host.onBrokerLost(lost);
    peer.emit('disconnected');
    await vi.advanceTimersByTimeAsync(7_999);
    expect(lost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(lost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'broker_unreachable' }));
    const late = vi.fn();
    host.onBrokerLost(late);
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ code: 'broker_unreachable' }));
    peer.emit('disconnected');
    expect(peer.reconnect).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    link.send('reliable', 'still connected');
    expect(control.send).toHaveBeenCalledWith('still connected');
  });

  it.each(['throw', 'error'] as const)('reports reconnect %s without closing healthy links', async failure => {
    const { host, peer } = await hosting();
    const lost = vi.fn();
    host.onBrokerLost(lost);
    if (failure === 'throw') peer.reconnect.mockImplementation(() => { throw new Error('reconnect failed'); });
    peer.emit('disconnected');
    if (failure === 'error') peer.emit('error', { type: 'unavailable-id' });
    expect(lost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'broker_unreachable' }));
    expect(peer.destroyed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

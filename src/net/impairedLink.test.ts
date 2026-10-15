import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImpairingTransport } from './impairedLink';
import type { ImpairmentProfile } from './impairedLink';
import { TransportError } from './transport';
import type { ChannelKind, PeerLink, Transport, WireData } from './transport';

const BASE: ImpairmentProfile = { latencyMs: 60, jitterMs: 0, lossRate: 0, seed: 1 };

async function harness(mode: 'join' | 'host' = 'join', injected = true) {
  const messages: ((kind: ChannelKind, data: WireData) => void)[] = [];
  const closes: ((reason: string) => void)[] = [];
  let closeReason: string | null = null;
  const disconnect = (reason: string) => {
    if (closeReason !== null) return;
    closeReason = reason;
    for (const handler of closes) handler(reason);
  };
  const raw: PeerLink = {
    peerId: 'test-peer',
    send: vi.fn(), close: vi.fn(() => disconnect('closed')),
    onMessage: handler => messages.push(handler),
    onClose: handler => { if (closeReason !== null) handler(closeReason); else closes.push(handler); },
  };
  let accept: ((link: PeerLink) => void) | undefined;
  let brokerLost: ((error: TransportError) => void) | undefined;
  const rawHost = {
    roomCode: 'CD3Y',
    onJoin: vi.fn((handler: (link: PeerLink) => void) => { accept = handler; }),
    onBrokerLost: vi.fn((handler: (error: TransportError) => void) => { brokerLost = handler; }),
    close: vi.fn(() => disconnect('host_closed')),
  };
  const inner: Transport = { host: vi.fn(async () => rawHost), join: vi.fn(async () => raw) };
  const timers = {
    setTimeout: vi.fn((callback: () => void, ms: number) => setTimeout(callback, ms)),
    clearTimeout: vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)),
    now: () => Date.now(),
  };
  const transport = new ImpairingTransport(inner, injected ? timers : undefined);
  const host = await transport.host('AB2X');
  let link!: PeerLink;
  if (mode === 'join') link = await transport.join('AB2X');
  else { host.onJoin(joined => { link = joined; }); accept!(raw); }
  const received = vi.fn();
  link.onMessage(received);
  return { transport, host, rawHost, inner, raw, link, received, timers, disconnect,
    receive: (kind: ChannelKind, data: WireData) => { for (const handler of messages) handler(kind, data); },
    loseBroker: (error: TransportError) => brokerLost?.(error) };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(['join', 'host'] as const)('ImpairingTransport %s link', mode => {
  it('passes null profiles synchronously without timers or byte copies', async () => {
    const h = await harness(mode);
    const data = new Uint8Array([1, 2]).buffer;
    h.transport.setProfile(null);
    for (const kind of ['reliable', 'unreliable'] as const) {
      h.link.send(kind, data);
      expect(h.raw.send).toHaveBeenLastCalledWith(kind, data);
      expect(vi.mocked(h.raw.send).mock.calls.at(-1)![1]).toBe(data);
      h.receive(kind, data);
      expect(h.received).toHaveBeenLastCalledWith(kind, data);
      expect(h.received.mock.calls.at(-1)![1]).toBe(data);
    }
    expect(h.link.peerId).toBe('test-peer');
    expect(h.timers.setTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('delays both directions and preserves every reliable packet in order despite jitter and total loss', async () => {
    const h = await harness(mode);
    h.transport.setProfile({ ...BASE, jitterMs: 60, lossRate: 1,
      bursts: { periodMs: 1000, lengthMs: 100, extraLatencyMs: 20, lossRate: 1 } });
    for (let i = 0; i < 30; i++) { h.link.send('reliable', `${i}`); h.receive('reliable', `${i}`); }
    expect(h.raw.send).not.toHaveBeenCalled();
    expect(h.received).not.toHaveBeenCalled();
    vi.runAllTimers();
    const expected = Array.from({ length: 30 }, (_, i) => ['reliable', `${i}`]);
    expect(vi.mocked(h.raw.send).mock.calls).toEqual(expected);
    expect(h.received.mock.calls).toEqual(expected);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops only unreliable packets in both directions', async () => {
    const h = await harness(mode);
    h.transport.setProfile({ ...BASE, lossRate: 1 });
    for (const kind of ['reliable', 'unreliable'] as const) {
      h.link.send(kind, kind); h.receive(kind, kind);
    }
    vi.advanceTimersByTime(59);
    expect(h.raw.send).not.toHaveBeenCalled();
    expect(h.received).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(vi.mocked(h.raw.send).mock.calls).toEqual([['reliable', 'reliable']]);
    expect(h.received.mock.calls).toEqual([['reliable', 'reliable']]);
  });

  it('keeps send and receive reliable deadlines independent when the profile changes', async () => {
    const h = await harness(mode);
    h.transport.setProfile({ ...BASE, latencyMs: 100 });
    h.link.send('reliable', 'first');
    h.transport.setProfile({ ...BASE, latencyMs: 0 });
    h.link.send('reliable', 'second');
    h.receive('reliable', 'reply');
    vi.advanceTimersByTime(0);
    expect(h.received).toHaveBeenCalledWith('reliable', 'reply');
    expect(h.raw.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(vi.mocked(h.raw.send).mock.calls).toEqual([['reliable', 'first'], ['reliable', 'second']]);
  });

  it('drains pending packets on disabling impairment, then bypasses synchronously', async () => {
    const h = await harness(mode);
    h.transport.setProfile(BASE);
    h.link.send('reliable', 'before'); h.receive('reliable', 'before');
    h.transport.setProfile(null);
    expect(vi.getTimerCount()).toBe(0);
    h.link.send('reliable', 'after'); h.receive('reliable', 'after');
    expect(vi.mocked(h.raw.send).mock.calls).toEqual([['reliable', 'before'], ['reliable', 'after']]);
    expect(h.received.mock.calls).toEqual([['reliable', 'before'], ['reliable', 'after']]);
    expect(h.timers.setTimeout).toHaveBeenCalledTimes(2);
  });

  it.each(['send', 'receive'] as const)('preserves reliable order when draining %s causes a synchronous reply', async direction => {
    const h = await harness(mode);
    const transfer = (data: string) => direction === 'send' ? h.link.send('reliable', data) : h.receive('reliable', data);
    const reply = (_kind: ChannelKind, data: WireData) => {
      if (data === 'first') transfer('third');
      if (data === 'second') transfer('fourth');
    };
    if (direction === 'send') vi.mocked(h.raw.send).mockImplementation(reply);
    else h.link.onMessage(reply);
    const laterSubscriber = vi.fn();
    h.link.onMessage(laterSubscriber);
    h.transport.setProfile(BASE);
    transfer('first'); transfer('second');
    h.transport.setProfile(null);
    const expected = ['first', 'second', 'third', 'fourth'].map(data => ['reliable', data]);
    expect(direction === 'send' ? vi.mocked(h.raw.send).mock.calls : h.received.mock.calls).toEqual(expected);
    if (direction === 'receive') expect(laterSubscriber.mock.calls).toEqual(expected);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses periodic half-open burst windows for extra latency', async () => {
    const h = await harness(mode);
    h.transport.setProfile({ ...BASE, latencyMs: 10,
      bursts: { periodMs: 1000, lengthMs: 100, extraLatencyMs: 200, lossRate: 0 } });
    h.link.send('unreliable', 'in'); h.receive('unreliable', 'in');
    vi.advanceTimersByTime(100); // Exact end of the burst: no extra latency.
    h.link.send('unreliable', 'out'); h.receive('unreliable', 'out');
    vi.advanceTimersByTime(10);
    expect(vi.mocked(h.raw.send).mock.calls).toEqual([['unreliable', 'out']]);
    expect(h.received.mock.calls).toEqual([['unreliable', 'out']]);
    vi.advanceTimersByTime(99);
    expect(h.received).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(h.raw.send).toHaveBeenLastCalledWith('unreliable', 'in');
    expect(h.received).toHaveBeenLastCalledWith('unreliable', 'in');
    vi.advanceTimersByTime(790); // Exact next period: extra latency returns.
    h.link.send('unreliable', 'next'); h.receive('unreliable', 'next');
    vi.advanceTimersByTime(209);
    expect(h.received).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(h.raw.send).toHaveBeenLastCalledWith('unreliable', 'next');
    expect(h.received).toHaveBeenLastCalledWith('unreliable', 'next');
  });

  it('applies burst loss only inside the window and only to unreliable packets', async () => {
    const h = await harness(mode);
    h.transport.setProfile({ ...BASE, latencyMs: 0,
      bursts: { periodMs: 1000, lengthMs: 100, extraLatencyMs: 0, lossRate: 1 } });
    for (const kind of ['reliable', 'unreliable'] as const) {
      h.link.send(kind, 'in'); h.receive(kind, 'in');
    }
    vi.advanceTimersByTime(100);
    h.link.send('unreliable', 'out'); h.receive('unreliable', 'out');
    vi.runAllTimers();
    const expected = [['reliable', 'in'], ['unreliable', 'out']];
    expect(vi.mocked(h.raw.send).mock.calls).toEqual(expected);
    expect(h.received.mock.calls).toEqual(expected);
  });

  it.each(['local', 'remote', 'host'] as const)('propagates %s close immediately and cancels all pending timers', async source => {
    const h = await harness(mode);
    const closed = vi.fn();
    h.link.onClose(closed);
    h.transport.setProfile(BASE);
    for (const kind of ['reliable', 'unreliable'] as const) {
      h.link.send(kind, 'pending'); h.receive(kind, 'pending');
    }
    expect(vi.getTimerCount()).toBe(4);
    if (source === 'local') h.link.close();
    else if (source === 'remote') h.disconnect('peer_closed');
    else h.host.close();
    expect(closed).toHaveBeenCalledExactlyOnceWith(source === 'local' ? 'closed' : `${source === 'remote' ? 'peer' : 'host'}_closed`);
    expect(vi.getTimerCount()).toBe(0);
    h.link.send('reliable', 'late'); h.receive('reliable', 'late');
    h.transport.setProfile(null);
    vi.runAllTimers();
    expect(h.raw.send).not.toHaveBeenCalled();
    expect(h.received).not.toHaveBeenCalled();
    const lateClose = vi.fn();
    h.link.onClose(lateClose);
    expect(lateClose).toHaveBeenCalledTimes(1);
  });
});

describe('ImpairingTransport configuration and forwarding', () => {
  it.each(['send', 'receive'] as const)('preserves another link\'s reliable %s order during profile disabling', async direction => {
    const first = await harness();
    const second = await harness();
    vi.mocked(first.inner.join).mockResolvedValueOnce(second.raw);
    const other = await first.transport.join('AB2X');
    const received = vi.fn();
    other.onMessage(received);
    const transfer = (data: string) => direction === 'send' ? other.send('reliable', data) : second.receive('reliable', data);
    first.link.onMessage(() => transfer('new'));
    first.transport.setProfile(BASE);
    first.receive('reliable', 'trigger');
    transfer('old');
    first.transport.setProfile(null);
    expect(direction === 'send' ? vi.mocked(second.raw.send).mock.calls : received.mock.calls)
      .toEqual([['reliable', 'old'], ['reliable', 'new']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards room codes, broker loss, and transport errors', async () => {
    const h = await harness();
    expect(h.inner.host).toHaveBeenCalledWith('AB2X');
    expect(h.inner.join).toHaveBeenCalledWith('AB2X');
    expect(h.host.roomCode).toBe('CD3Y');
    const lost = vi.fn();
    const error = new TransportError('broker_unreachable');
    h.host.onBrokerLost(lost); h.loseBroker(error);
    expect(lost).toHaveBeenCalledExactlyOnceWith(error);
    vi.mocked(h.inner.host).mockRejectedValueOnce(error);
    vi.mocked(h.inner.join).mockRejectedValueOnce(error);
    await expect(h.transport.host('AB2X')).rejects.toBe(error);
    await expect(h.transport.join('AB2X')).rejects.toBe(error);
  });

  it('supports default global timers and clones delayed binary packets', async () => {
    const h = await harness('join', false);
    h.transport.setProfile(BASE);
    const data = new Uint8Array([1, 2]);
    h.link.send('unreliable', data.buffer); h.receive('unreliable', data.buffer);
    data[0] = 9;
    vi.advanceTimersByTime(60);
    expect(new Uint8Array(vi.mocked(h.raw.send).mock.calls[0][1] as ArrayBuffer)).toEqual(new Uint8Array([1, 2]));
    expect(new Uint8Array(h.received.mock.calls[0][1])).toEqual(new Uint8Array([1, 2]));
  });

  it('replays the same seeded losses and jitter, defaults to seed 1, and isolates caller mutations', async () => {
    async function trace(seed?: number) {
      const h = await harness();
      const profile = { latencyMs: 60, jitterMs: 60, lossRate: 0.3, seed };
      h.transport.setProfile(profile);
      profile.lossRate = 1;
      for (let i = 0; i < 50; i++) h.link.send('unreliable', `${i}`);
      const delays = h.timers.setTimeout.mock.calls.map(([, ms]) => ms);
      vi.runAllTimers();
      return { delays, messages: vi.mocked(h.raw.send).mock.calls };
    }
    const first = await trace();
    expect(first.delays.length).toBeGreaterThan(0);
    expect(first.delays.length).toBeLessThan(50);
    expect(new Set(first.delays).size).toBeGreaterThan(1);
    expect(first.delays.every(ms => ms >= 0 && ms <= 120)).toBe(true);
    expect(await trace(1)).toEqual(first);
    expect(await trace(7)).not.toEqual(first);
  });

  const burst = { periodMs: 1000, lengthMs: 100, extraLatencyMs: 200, lossRate: 0.4 };
  const invalid = [
    ...['latencyMs', 'jitterMs'].flatMap(key => [-1, NaN, Infinity].map(value => ({ ...BASE, [key]: value }))),
    ...[-0.1, 1.1, NaN, Infinity].map(lossRate => ({ ...BASE, lossRate })),
    ...[-1, 0.5, 0x100000000, NaN, Infinity].map(seed => ({ ...BASE, seed })),
    ...[0, -1, NaN, Infinity].map(periodMs => ({ ...BASE, bursts: { ...burst, periodMs } })),
    ...[-1, 1001, NaN, Infinity].map(lengthMs => ({ ...BASE, bursts: { ...burst, lengthMs } })),
    ...[-1, NaN, Infinity].map(extraLatencyMs => ({ ...BASE, bursts: { ...burst, extraLatencyMs } })),
    ...[-0.1, 1.1, NaN, Infinity].map(lossRate => ({ ...BASE, bursts: { ...burst, lossRate } })),
  ];
  it.each(invalid)('rejects an invalid profile atomically: %j', async profile => {
    const h = await harness();
    h.transport.setProfile(BASE);
    expect(() => h.transport.setProfile(profile)).toThrow(RangeError);
    h.link.send('reliable', 'unchanged');
    vi.advanceTimersByTime(59);
    expect(h.raw.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.raw.send).toHaveBeenCalledWith('reliable', 'unchanged');
  });

  it('accepts boundary values including seed zero and an empty burst window', async () => {
    const h = await harness();
    expect(() => h.transport.setProfile({ latencyMs: 0, jitterMs: 0, lossRate: 1, seed: 0,
      bursts: { periodMs: 1, lengthMs: 0, extraLatencyMs: 0, lossRate: 0 } })).not.toThrow();
    expect(() => h.transport.setProfile({ ...BASE, seed: 0xffffffff,
      bursts: { periodMs: 1, lengthMs: 1, extraLatencyMs: 0, lossRate: 1 } })).not.toThrow();
  });
});

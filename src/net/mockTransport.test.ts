import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockTransport } from './mockTransport';
import { generateRoomCode, toPeerId } from './roomCode';

vi.mock('./roomCode', async importOriginal => ({
  ...await importOriginal<typeof import('./roomCode')>(), generateRoomCode: vi.fn(() => 'CD3Y'),
}));
afterEach(() => vi.mocked(generateRoomCode).mockReset().mockReturnValue('CD3Y'));

describe('MockTransport host parity', () => {
  it('exposes the normalized room code and has a silent broker hook', async () => {
    const host = await new MockTransport().host(' ab2x ');
    expect(host.roomCode).toBe('AB2X');
    const lost = vi.fn();
    host.onBrokerLost(lost);
    host.close();
    expect(lost).not.toHaveBeenCalled();
  });

  it('regenerates occupied codes and routes guests to the actual host', async () => {
    const transport = new MockTransport();
    const original = await transport.host('AB2X');
    const replacement = await transport.host('ab2x');
    const originalJoined = vi.fn();
    const replacementJoined = vi.fn();
    original.onJoin(originalJoined);
    replacement.onJoin(replacementJoined);
    expect(replacement.roomCode).toBe('CD3Y');
    const guest = await transport.join(replacement.roomCode);
    expect(guest.peerId).toBe(toPeerId('CD3Y'));
    expect(originalJoined).not.toHaveBeenCalled();
    expect(replacementJoined).toHaveBeenCalledOnce();
    replacement.close();
    await expect(transport.join('CD3Y')).rejects.toMatchObject({ code: 'room_not_found' });
    await transport.join('AB2X');
    expect(originalJoined).toHaveBeenCalledOnce();
    expect((await transport.host('CD3Y')).roomCode).toBe('CD3Y');
    original.close();
  });

  it('tries up to three regenerated codes before succeeding', async () => {
    const transport = new MockTransport();
    await transport.host('AB2X');
    await transport.host('CD3Y');
    await transport.host('EF4Z');
    vi.mocked(generateRoomCode).mockReturnValueOnce('CD3Y').mockReturnValueOnce('EF4Z').mockReturnValueOnce('GH5X');
    expect((await transport.host('AB2X')).roomCode).toBe('GH5X');
    expect(generateRoomCode).toHaveBeenCalledTimes(3);
  });

  it('reports room_taken after three failed regenerations without replacing the existing host', async () => {
    const transport = new MockTransport();
    const host = await transport.host('AB2X');
    vi.mocked(generateRoomCode).mockReturnValue('AB2X');
    await expect(transport.host('AB2X')).rejects.toMatchObject({ code: 'room_taken' });
    expect(generateRoomCode).toHaveBeenCalledTimes(3);
    const joined = vi.fn();
    host.onJoin(joined);
    await transport.join('AB2X');
    expect(joined).toHaveBeenCalledOnce();
  });
});

describe('MockTransport latency (RTT 80 ± 20 ms)', () => {
  async function arrivals(seed: number) {
    const network = new MockTransport({ seed, latencyMs: 40, jitterMs: 10 });
    const host = await network.host('AB2X');
    const received: { index: number; delay: number }[] = [];
    const sentAt: number[] = [];
    host.onJoin(link => link.onMessage((_kind, data) => {
      const index = Number(data);
      received.push({ index, delay: network.now - sentAt[index] });
    }));
    const guest = await network.join('AB2X');
    for (let index = 0; index < 400; index++) {
      sentAt[index] = network.now;
      guest.send('unreliable', String(index));
      network.advance(index % 3 === 0 ? 7 : 0);
    }
    network.flush();
    host.close();
    return received;
  }

  it('delivers every one-way packet 30-50 ms after sending, spread across the jitter window', async () => {
    const received = await arrivals(7);
    expect(received).toHaveLength(400);
    const delays = received.map(entry => entry.delay);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(30);
    expect(Math.max(...delays)).toBeLessThanOrEqual(50);
    expect(Math.min(...delays)).toBeLessThan(32);
    expect(Math.max(...delays)).toBeGreaterThan(48);
    expect(Math.abs(delays.reduce((sum, delay) => sum + delay, 0) / delays.length - 40)).toBeLessThan(1.5);
  });

  it('is deterministic per seed: the same seed reproduces arrival order and delays', async () => {
    const first = await arrivals(42);
    expect(await arrivals(42)).toEqual(first);
    const order = first.map(entry => entry.index);
    expect(order).not.toEqual([...order].sort((a, b) => a - b)); // jitter reorders packets
    expect((await arrivals(43)).map(entry => entry.index)).not.toEqual(order);
  });
});

describe('MockTransport hold/release', () => {
  async function setup(options = {}) {
    const network = new MockTransport({ latencyMs: 20, ...options });
    const host = await network.host('AB2X');
    let hostLink!: import('./transport').PeerLink;
    host.onJoin(link => { hostLink = link; });
    const guest = await network.join('AB2X');
    return { network, host, hostLink, guest };
  }

  it('queues deliveries while held and releases them in order at the release time', async () => {
    const { network, hostLink, guest } = await setup();
    const got: [number, string][] = [];
    hostLink.onMessage((_k, data) => got.push([network.now, data as string]));
    network.hold(hostLink.peerId);
    guest.send('reliable', 'a');
    network.advance(5);
    guest.send('unreliable', 'b');
    network.advance(100);
    expect(got).toEqual([]);
    guest.send('reliable', 'c'); // hold does not stop scheduling
    network.advance(100);
    network.release(hostLink.peerId);
    expect(got).toEqual([[205, 'a'], [205, 'b'], [205, 'c']]);
    guest.send('reliable', 'd');
    network.flush();
    expect(got[3]).toEqual([225, 'd']);
  });

  it('holds only the matching receiver, and the guest side by its room peer id', async () => {
    const { network, hostLink, guest } = await setup();
    const atGuest: string[] = [];
    const atHost: string[] = [];
    guest.onMessage((_k, data) => atGuest.push(data as string));
    hostLink.onMessage((_k, data) => atHost.push(data as string));
    network.hold(toPeerId('AB2X'));
    hostLink.send('reliable', 'toGuest');
    guest.send('reliable', 'toHost');
    network.flush();
    expect(atHost).toEqual(['toHost']);
    expect(atGuest).toEqual([]);
    network.release(guest.peerId);
    expect(atGuest).toEqual(['toGuest']);
  });

  it('drops held deliveries when the link closes', async () => {
    const { network, hostLink, guest } = await setup();
    const got: string[] = [];
    hostLink.onMessage((_k, data) => got.push(data as string));
    network.hold(hostLink.peerId);
    guest.send('reliable', 'a');
    network.flush();
    guest.close();
    network.release(hostLink.peerId);
    expect(got).toEqual([]);
  });
});

describe('MockTransport bursts', () => {
  const bursts = { periodMs: 100, lengthMs: 30, extraLatencyMs: 50, lossRate: 0.5 };

  async function run(options: object) {
    const network = new MockTransport({ seed: 5, latencyMs: 20, ...options });
    const host = await network.host('AB2X');
    const got = new Map<number, number>();
    const sentAt: number[] = [];
    host.onJoin(link => link.onMessage((_k, data) => got.set(Number(data), network.now - sentAt[Number(data)])));
    const guest = await network.join('AB2X');
    for (let i = 0; i < 400; i++) {
      sentAt[i] = network.now;
      guest.send('unreliable', String(i));
      network.advance(5);
    }
    network.flush();
    return { got, sentAt };
  }

  it('adds latency and loss only for sends inside the burst window, deterministically', async () => {
    const { got, sentAt } = await run({ bursts });
    const inWindow = (i: number) => sentAt[i] % 100 < 30;
    for (const [i, delay] of got) expect(delay).toBe(inWindow(i) ? 70 : 20);
    const inside = [...Array(400).keys()].filter(inWindow);
    const outside = [...Array(400).keys()].filter(i => !inWindow(i));
    expect(outside.every(i => got.has(i))).toBe(true);
    const survived = inside.filter(i => got.has(i)).length;
    expect(survived).toBeGreaterThan(0);
    expect(survived).toBeLessThan(inside.length);
    expect([...(await run({ bursts })).got]).toEqual([...got]);
  });

  it('leaves reliable traffic lossless inside a burst', async () => {
    const network = new MockTransport({ latencyMs: 20, bursts: { ...bursts, lossRate: 1 } });
    const host = await network.host('AB2X');
    const got: string[] = [];
    host.onJoin(link => link.onMessage((_k, data) => got.push(data as string)));
    const guest = await network.join('AB2X');
    guest.send('reliable', 'x');
    network.flush();
    expect(got).toEqual(['x']);
    expect(network.now).toBe(70);
  });

  it('rejects invalid burst options', () => {
    for (const bad of [{ periodMs: 0 }, { lengthMs: -1 }, { extraLatencyMs: Number.NaN }, { lossRate: 2 }]) {
      expect(() => new MockTransport({ bursts: { ...bursts, ...bad } })).toThrow(RangeError);
    }
  });

  it('does not change the seed-1 delivery schedule when bursts is absent', async () => {
    const network = new MockTransport({ seed: 1, latencyMs: 20, jitterMs: 8, lossRate: 0.3, reorderRate: 0.5, reorderDelayMs: 60 });
    const host = await network.host('AB2X');
    const got: [number, string][] = [];
    host.onJoin(link => link.onMessage((_k, data) => got.push([network.now, data as string])));
    const guest = await network.join('AB2X');
    for (let i = 0; i < 20; i++) guest.send('unreliable', String(i));
    network.flush();
    expect(got.map(([at, v]) => `${at.toFixed(3)}:${v}`).join(' ')).toBe('12.044:0 15.829:16 18.813:2 19.266:15 20.737:13 21.446:10 27.736:18 37.101:19 44.045:3 59.104:6 64.264:1');
  });
});

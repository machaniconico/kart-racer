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

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

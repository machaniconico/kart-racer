import { describe, expect, it, vi } from 'vitest';
import { createRace } from '../sim/race';
import { GuestSession } from './guestSession';
import { MockTransport } from './mockTransport';
import { NEUTRAL_INPUT } from './inputBuffer';
import { encodeControlMessage, parseControlMessage } from './protocol';
import type { ControlMessage } from './protocol';
import type { RosterPlayer } from './session';
import { encodeSnapshot } from './snapshotCodec';
import type { PeerLink } from './transport';
import { packPong, unpackClock } from './clock';
import { PacketKind } from './protocol';

const roster: RosterPlayer[] = createRace(1).karts.map(kart => ({
  slot: kart.id, name: kart.id === 1 ? 'Guest' : kart.name, color: kart.color,
  kind: kart.id === 0 ? 'host' : kart.id === 1 ? 'guest' : 'cpu', connected: true,
}));

async function joinedGuest() {
  const network = new MockTransport({ latencyMs: 0 });
  const host = await network.host('AB2X');
  let link!: PeerLink;
  host.onJoin(peer => {
    link = peer;
    peer.onMessage((kind, data) => {
      if (kind === 'reliable' && parseControlMessage(data)?.type === 'hello') peer.send('reliable', encodeControlMessage({
        type: 'welcome', trackId: 'canyon', slot: 1, roster, hostTime: network.now,
      }));
    });
  });
  const guest = new GuestSession(network, { name: 'Guest', color: roster[1].color, now: () => network.now, prediction: false });
  await guest.join('AB2X');
  network.advance(0);
  const send = (message: ControlMessage) => { link.send('reliable', encodeControlMessage(message)); network.advance(0); };
  return { network, host, guest, send, link };
}

describe('GuestSession course updates outside the lobby (C-006)', () => {
  it('ignores course messages during the countdown and the race, keeping the race course', async () => {
    const h = await joinedGuest();
    try {
      expect(h.guest.phase).toBe('lobby');
      expect(h.guest.course).toBe('canyon');
      const startAt = h.network.now + 3000;
      h.send({ type: 'race_start', trackId: 'canyon', seed: 7, raceId: 1, roster, startAtHostTime: startAt });
      expect(h.guest.phase).toBe('countdown');
      h.send({ type: 'course', trackId: 'neon' });
      expect(h.guest.course).toBe('canyon');
      expect(h.guest.frame()!.state.trackId).toBe('canyon');

      // A racing snapshot moves the guest out of the countdown; the course stays locked.
      const racing = createRace(7, { trackId: 'canyon', racers: roster.map(player => ({
        name: player.name, color: player.color, human: player.kind !== 'cpu',
      })) });
      Object.assign(racing, { phase: 'racing', countdown: 0, tick: 200, time: 0.5 });
      h.link.send('unreliable', encodeSnapshot(racing, 1, startAt + 100, racing.karts.map(() => ({ ...NEUTRAL_INPUT }))));
      h.network.advance(150);
      h.guest.frame();
      expect(h.guest.phase).toBe('racing');
      h.send({ type: 'course', trackId: 'snowpeak' });
      expect(h.guest.course).toBe('canyon');
      expect(h.guest.frame()!.state.trackId).toBe('canyon');
    } finally { h.host.close(); }
  });

  it('warns when it ignores a race_start for a different course', async () => {
    const h = await joinedGuest();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.send({ type: 'race_start', trackId: 'neon', seed: 7, raceId: 1, roster, startAtHostTime: h.network.now });
      expect(h.guest.phase).toBe('lobby');
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toMatch(/neon.*canyon/);
      h.send({ type: 'race_start', trackId: 'canyon', seed: 7, raceId: 1, roster, startAtHostTime: h.network.now });
      expect(h.guest.phase).toBe('countdown');
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      h.host.close();
    }
  });

  it('does not count an excused local stall as host silence, but still times out afterwards', async () => {
    const h = await joinedGuest(); // This host never answers PING.
    try {
      h.guest.frame();
      h.network.advance(6000); // e.g. a renderer rebuild blocked the main thread.
      h.guest.excuseStall();
      h.guest.frame();
      expect(h.guest.phase).toBe('lobby');
      h.network.advance(5000);
      h.guest.frame();
      expect(h.guest.phase).toBe('closed');
      expect(h.guest.reason).toBe('host_lost');
    } finally { h.host.close(); }
  });

  it('does not push a PONG received right after the stall into the future', async () => {
    const h = await joinedGuest();
    const pings: number[] = [];
    h.link.onMessage((kind, data) => {
      const clock = kind === 'unreliable' ? unpackClock(data) : null;
      if (clock?.kind === PacketKind.PING) pings.push(clock.t0);
    });
    try {
      for (let i = 0; i < 5 && pings.length === 0; i++) { h.network.advance(100); h.guest.frame(); h.network.advance(0); }
      expect(pings.length).toBeGreaterThan(0);
      h.network.advance(6000); // Renderer rebuild blocked the main thread.
      // The host's answer is handled before the next poll.
      h.link.send('unreliable', packPong(pings[pings.length - 1], h.network.now));
      h.network.advance(0);
      h.guest.excuseStall();
      h.guest.frame();
      expect(h.guest.phase).toBe('lobby');
      h.network.advance(5000);
      h.guest.frame();
      expect(h.guest.phase).toBe('closed');
      expect(h.guest.reason).toBe('host_lost');
    } finally { h.host.close(); }
  });

  it('keeps the scheduled race-start grace across an excused stall', async () => {
    const h = await joinedGuest();
    try {
      const startAt = h.network.now + 12_000; // The host delays the start for slow peers.
      h.send({ type: 'race_start', trackId: 'canyon', seed: 7, raceId: 1, roster, startAtHostTime: startAt });
      h.guest.frame();
      h.network.advance(6000);
      h.guest.excuseStall();
      h.guest.frame();
      h.network.advance(5500); // 11.5 s: still before the start, so no snapshot is due yet.
      h.guest.frame();
      expect(h.guest.phase).not.toBe('closed');
    } finally { h.host.close(); }
  });

  it('still reports host loss after an unexcused gap', async () => {
    const h = await joinedGuest();
    try {
      h.guest.frame();
      h.network.advance(5000);
      h.guest.frame();
      expect(h.guest.phase).toBe('closed');
    } finally { h.host.close(); }
  });
});

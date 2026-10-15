import { afterAll, describe, expect, it, vi } from 'vitest';
import { getAIInput } from '../sim/ai';
import { stepRace } from '../sim/race';
import type { KartState, TrackId } from '../sim/types';
import { TICK_MS } from './clock';
import { GuestSession } from './guestSession';
import { HostSession } from './hostSession';
import { SnapshotBuffer } from './interpolation';
import { MockTransport } from './mockTransport';
import type { MockTransportOptions } from './mockTransport';
import { Predictor } from './predictor';

// Commit-message draft (this fix pass must not commit):
// test(net): verify M8-05 adaptive quality and deterministic impaired links
//
// M8-05: deterministic fixed/adaptive A/B, prediction enabled, race seed 431.
// Original P1 (60 +/- 40 ms, loss 0.1, seed 92) did not meet the >=20 fixed pops pin:
// profile course   mode      pops freezes max error(m) delay(ms) p99 correction(m)
// jitter  meadow   fixed        0       0            -   100-100            0.0037
// jitter  meadow   adaptive     0       0       0.2013   100-178            0.0037
// jitter  skyline  fixed        0       0            -   100-100            0.0062
// jitter  skyline  adaptive     0       0       0.1927   100-178            0.0062
// Adopted P1 (reviewer-approved): latencyMs 60, jitterMs 60, lossRate 0.2, seed 92, 600 ticks.
// P2: latencyMs 60, jitterMs 15, lossRate 0.05, seed 7, 900 ticks;
// bursts: periodMs 3000, lengthMs 400, extraLatencyMs 200, lossRate 0.4.
// profile course   mode      pops freezes max error(m) delay(ms) p99 correction(m)
// jitter  meadow   fixed       27      42            -   100-100            0.0044
// jitter  meadow   adaptive     0       0       0.7584   100-211            0.0044
// jitter  skyline  fixed       29      42            -   100-100            0.0069
// jitter  skyline  adaptive     0       0       0.4872   100-217            0.0069
// spiky   meadow   fixed       89     441            -   100-100            0.1733
// spiky   meadow   adaptive    42     210       0.7776   100-250            0.1733
// spiky   skyline  fixed       82     427            -   100-100            0.4497
// spiky   skyline  adaptive    68     294       0.4069   100-250            0.4497
// Pops/freezes count remote kart-frames. Error uses renderHostTime minus the latest
// snapshot's send time as age, matching M6-07; only age <= 100 ms contributes.
// All runs stay racing after countdown, reason null, stalled transitions 0.
// Adaptive render time stays within 0.85..1.15 x elapsed time, regressions 0.
// Adopted profiles: 4 tests / 8 runs; measured 7.71 s tests / 8.27 s including import
// alongside the full suite. Runtime is checked against the 40 s file budget.
const PROFILES = [
  { name: 'jitter', ticks: 600, options: { latencyMs: 60, jitterMs: 60, lossRate: 0.2, seed: 92 } },
  { name: 'spiky', ticks: 900, options: { latencyMs: 60, jitterMs: 15, lossRate: 0.05,
    bursts: { periodMs: 3000, lengthMs: 400, extraLatencyMs: 200, lossRate: 0.4 }, seed: 7 } },
] satisfies { name: string; ticks: number; options: MockTransportOptions }[];
type Profile = typeof PROFILES[number];
type Pose = Pick<KartState, 'id' | 'x' | 'y' | 'z' | 'speed'>;
interface View {
  now: number;
  renderHostTime: number;
  delayMs: number;
  ageMs: number;
  karts: Pose[];
}

const poses = (karts: KartState[]): Pose[] => karts.filter(kart => kart.id !== 1)
  .map(({ id, x, y, z, speed }) => ({ id, x, y, z, speed }));
const distance = (a: Pose, b: Pose): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const popLimit = (speed: number, dtMs: number): number => 2 * Math.abs(speed) * dtMs / 1000 + 0.1;
const percentile99 = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.99) - 1];

async function drive(profile: Profile, trackId: TrackId, renderDelay: 'fixed' | 'adaptive') {
  const network = new MockTransport(profile.options);
  const host = await HostSession.create(network, {
    roomCode: 'AB2X', now: () => network.now, hostInput: { sample: getAIInput },
  });
  const guest = new GuestSession(network, { now: () => network.now, prediction: true, renderDelay });
  const sample = vi.spyOn(SnapshotBuffer.prototype, 'sample');
  const corrections: number[] = [];
  const reconcile = Predictor.prototype.reconcile;
  const correctionSpy = vi.spyOn(Predictor.prototype, 'reconcile').mockImplementation(function (this: Predictor, snapshot) {
    const result = reconcile.call(this, snapshot);
    corrections.push(this.lastCorrectionMetres);
    return result;
  });
  let stalledTransitions = 0;
  let stalled = false;
  const unsubscribe = guest.onChange(() => {
    if (guest.stalled && !stalled) stalledTransitions++;
    stalled = guest.stalled;
  });
  try {
    await guest.join('AB2X');
    host.setCourse(trackId);
    for (let n = 0; n < 200; n++) { host.frame(); guest.frame(); network.advance(10); }
    expect(guest.localSlot).toBe(1);
    expect(guest.course).toBe(trackId);
    const state = host.startRace(431);
    const startAt = host.startAtHostTime;
    network.advance(startAt - network.now);
    const history: Pose[][] = [poses(state.karts)];
    const sentAt = new Map<number, number>([[0, startAt]]);
    const views: View[] = [];
    let racing = false;
    for (let tick = 1; tick <= profile.ticks; tick++) {
      guest.tick(getAIInput(state, 1));
      network.advance(TICK_MS);
      stepRace(state, state.karts.map(kart => host.inputSource(kart.id).sample(state, kart.id)));
      history[state.tick] = poses(state.karts);
      host.afterTick(state);
      sentAt.set(state.tick, network.now);
      const view = guest.frame();
      expect(view).not.toBeNull();
      const newestTick = sample.mock.results.at(-1)!.value.tick as number;
      expect(sentAt.has(newestTick)).toBe(true);
      sample.mockClear();
      views.push({ now: network.now, renderHostTime: guest.renderHostTime, delayMs: guest.renderDelayMs,
        ageMs: guest.renderHostTime - sentAt.get(newestTick)!, karts: poses(view!.state.karts) });
      racing ||= guest.phase === 'racing';
      expect(guest.phase).toBe(racing ? 'racing' : 'countdown');
      expect(guest.reason).toBeNull();
      expect(guest.stalled).toBe(false);
    }
    expect(guest.phase).toBe('racing');
    expect(guest.stalled).toBe(false);
    expect(stalledTransitions).toBe(0);
    expect(views).toHaveLength(profile.ticks);
    expect(corrections.length).toBeGreaterThan(100);
    let pops = 0;
    let freezes = 0;
    let maxError = 0;
    let errorChecks = 0;
    const hostTick = (view: View): number => Math.max(0, (view.renderHostTime - startAt) / TICK_MS);
    for (const [index, view] of views.entries()) {
      const previous = views[index - 1];
      if (renderDelay === 'adaptive') {
        expect(view.delayMs).toBeGreaterThanOrEqual(100);
        expect(view.delayMs).toBeLessThanOrEqual(250);
        if (profile.name === 'jitter' && view.now - startAt >= 3000) {
          expect(view.delayMs).toBeGreaterThanOrEqual(140);
          expect(view.delayMs).toBeLessThanOrEqual(220);
        }
        if (previous) {
          const dt = view.now - previous.now;
          expect(view.renderHostTime - previous.renderHostTime).toBeGreaterThanOrEqual(0.85 * dt);
          expect(view.renderHostTime - previous.renderHostTime).toBeLessThanOrEqual(1.15 * dt);
        }
      }
      for (const [kartIndex, kart] of view.karts.entries()) {
        if (previous) {
          const displacement = distance(kart, previous.karts[kartIndex]);
          // Exclude authoritative discontinuities only for this kart and this rendered interval.
          let teleport = false;
          for (let tick = Math.max(1, Math.floor(hostTick(previous)) + 1); tick <= Math.ceil(hostTick(view)); tick++) {
            const current = history[tick][kartIndex];
            teleport ||= distance(current, history[tick - 1][kartIndex]) > popLimit(current.speed, TICK_MS);
          }
          if (!teleport && displacement > popLimit(kart.speed, view.now - previous.now)) pops++;
          if (Math.abs(kart.speed) > 5 && displacement < 0.01) freezes++;
        }
        if (renderDelay === 'adaptive' && view.ageMs <= 100) {
          const tick = hostTick(view);
          const from = history[Math.floor(tick)][kartIndex];
          const to = history[Math.ceil(tick)][kartIndex];
          const alpha = tick - Math.floor(tick);
          const error = distance(kart, { ...from, x: from.x + (to.x - from.x) * alpha,
            y: from.y + (to.y - from.y) * alpha, z: from.z + (to.z - from.z) * alpha });
          maxError = Math.max(maxError, error);
          errorChecks++;
        }
      }
    }
    const p99 = percentile99(corrections);
    const delay = [Math.min(...views.map(view => view.delayMs)), Math.max(...views.map(view => view.delayMs))];
    console.info(`${profile.name} ${trackId} ${renderDelay}: pops=${pops} freezes=${freezes} error=${maxError.toFixed(4)} delay=${delay.map(n => n.toFixed(2)).join('..')} p99=${p99.toFixed(4)}`);
    if (renderDelay === 'adaptive') {
      expect(errorChecks).toBeGreaterThan(profile.ticks * 3);
      expect(maxError).toBeLessThan(1);
      expect(guest.renderTimeRegressions).toBe(0);
    }
    if (profile.name === 'jitter') expect(p99).toBeLessThanOrEqual(1);
    return { pops, freezes };
  } finally {
    unsubscribe();
    sample.mockRestore();
    correctionSpy.mockRestore();
    host.close();
  }
}

const startedAt = performance.now();
afterAll(() => { expect(performance.now() - startedAt, 'quality test file runtime').toBeLessThan(40_000); });

describe('M8-05 network quality with prediction', () => {
  it.each(PROFILES.flatMap(profile => (['meadow', 'skyline'] as const).map(trackId => ({ profile, trackId }))))
  ('$profile.name / $trackId: adaptive meets the fixed-delay A/B bounds', async ({ profile, trackId }) => {
    const fixed = await drive(profile, trackId, 'fixed');
    const adaptive = await drive(profile, trackId, 'adaptive');
    if (profile.name === 'jitter') {
      expect(fixed.pops, 'P1 must expose at least 20 pops; strengthen the profile and report if it does not').toBeGreaterThanOrEqual(20);
      expect(adaptive.pops).toBeLessThanOrEqual(fixed.pops * 0.5);
      expect(adaptive.freezes).toBeLessThanOrEqual(fixed.freezes * 0.5);
    } else {
      expect(adaptive.pops).toBeLessThanOrEqual(fixed.pops);
      expect(adaptive.freezes).toBeLessThanOrEqual(fixed.freezes);
    }
  }, 40_000);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { corridorAt, exclusionAt, validateTrackDef } from '../sim/corridor';
import * as race from '../sim/race';
import { buildTrack, sampleTrack } from '../sim/track';
import * as tracks from '../sim/tracks';
import { LEGACY_MEADOW } from '../sim/tracks/legacyMeadow.fixture';
import type { Barrier, InputFrame, RaceState, TrackDef } from '../sim/types';
import { TICK_MS } from './clock';
import { GuestSession } from './guestSession';
import { HostSession } from './hostSession';
import { NEUTRAL_INPUT } from './inputBuffer';
import { MockTransport } from './mockTransport';
import { Predictor } from './predictor';
import { MAX_PLAYERS } from './protocol';
import * as codec from './snapshotCodec';

// The predictor's own stepRace calls are observed to read the hit events it discards.
vi.mock('../sim/race', async importOriginal => {
  const actual = await importOriginal<typeof import('../sim/race')>();
  return { ...actual, stepRace: vi.fn(actual.stepRace) };
});

const { stepRace: realStep } = await vi.importActual<typeof import('../sim/race')>('../sim/race');
const realEncode = codec.encodeSnapshot;

// M3-03's sweep band (center 0, half-width 1.2, taper 4, amplitude 4, period 6), here on a long straight.
const SWEEP: Barrier = { from: 1400, to: 1440, center: 0, halfWidth: 1.2, taper: 4,
  motion: { kind: 'sweep', amplitude: 4.0, period: 6, phase: 0 } };
const BASE_BYTES = codec.SNAPSHOT_HEADER_BYTES + MAX_PLAYERS * codec.SNAPSHOT_KART_BYTES + codec.SNAPSHOT_BOX_COUNT;
const RACE_TICKS = 720; // 10 s approach + passing
const FULL: InputFrame = { ...NEUTRAL_INPUT, throttle: 1 };

function motionDef(): TrackDef {
  return {
    ...LEGACY_MEADOW, scale: 1, checkpointCount: 2,
    controlPoints: [
      [-1500, 3, 0], [-1000, 3, 0], [-500, 3, 0], [0, 3, 0],
      [500, 3, 0], [1000, 3, 0], [1500, 3, 0], [1500, 3, 1000], [-1500, 3, 1000],
    ],
    // The wire layout needs 24 boxes; put every row past the first straight so no item reaches the band.
    boxRows: [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
    surfaces: [], barriers: [SWEEP],
    // CPUs pass the band on the + side (sweep exclusion reaches ±6.15 m); the guest uses the - side in run A.
    racingLine: [{ distance: 1350, offset: 8 }, { distance: 1490, offset: 8 }],
  };
}

interface Run {
  corrections: number[];
  hostHits: number[];
  guestHits: number[];
  inside: string[];
  timeChecks: number;
  snapshotLengths: { bytes: number; entities: number }[];
  finalDistance: number;
}

async function drive(startDistance: number, offset: number): Promise<Run> {
  const track = buildTrack(motionDef());
  vi.spyOn(tracks, 'getTrack').mockReturnValue(track);
  const snapshotLengths: Run['snapshotLengths'] = [];
  vi.spyOn(codec, 'encodeSnapshot').mockImplementation((state, ...rest) => {
    const wire = realEncode(state, ...rest);
    snapshotLengths.push({ bytes: wire.byteLength, entities: state.projectiles.length + state.traps.length });
    return wire;
  });
  const corrections: number[] = [];
  const inside: string[] = [];
  const reconcile = Predictor.prototype.reconcile;
  vi.spyOn(Predictor.prototype, 'reconcile').mockImplementation(function (this: Predictor, snapshot) {
    const snap = reconcile.call(this, snapshot);
    const state = this.state;
    if (snapshot.state.phase === 'racing' && snapshot.state.racingTicks > 0) {
      corrections.push(this.lastCorrectionMetres);
      const kart = this.kart;
      const exclusion = exclusionAt(track, SWEEP, kart.trackDistance, state.time);
      if (exclusion && kart.lateralOffset > exclusion.min + 1e-6 && kart.lateralOffset < exclusion.max - 1e-6) {
        inside.push(`tick ${state.tick} d ${kart.trackDistance.toFixed(2)} offset ${kart.lateralOffset.toFixed(3)} ` +
          `exclusion [${exclusion.min.toFixed(3)}, ${exclusion.max.toFixed(3)}]`);
      }
    }
    return snap;
  });
  // Guest-side hits: the latest simulation of each racing tick (replays overwrite the first guess).
  const guestHitTicks = new Map<number, boolean>();
  let hostStepping = false;
  const step = vi.mocked(race.stepRace);
  step.mockImplementation((state, inputs) => {
    realStep(state, inputs);
    if (!hostStepping && state.phase === 'racing') {
      guestHitTicks.set(state.racingTicks, state.events.some(event => event.type === 'hit' && event.kartId === 1 && event.value === 1));
    }
  });

  const network = new MockTransport({ seed: 7, latencyMs: 40, jitterMs: 10 });
  const host = await HostSession.create(network, { roomCode: 'AB2X', now: () => network.now,
    hostInput: { sample: () => ({ ...NEUTRAL_INPUT }) } });
  const guest = new GuestSession(network, { now: () => network.now, prediction: true });
  try {
    await guest.join('AB2X');
    for (let n = 0; n < 200; n++) { host.frame(); guest.frame(); network.advance(10); }
    const state = host.startRace(431);
    const kart = state.karts[1];
    const sample = sampleTrack(track, startDistance);
    Object.assign(kart, { x: sample.x + sample.nx * offset, y: sample.y, z: sample.z + sample.nz * offset,
      heading: Math.atan2(sample.tx, sample.tz), speed: 0, trackDistance: startDistance, lateralOffset: offset });
    network.advance(host.startAtHostTime - network.now);
    const history = new Map<number, RaceState>([[0, structuredClone(state)]]);
    const hostHits: number[] = [];
    const views: { tick: number; time: number; d: number }[] = [];
    for (let n = 0; state.racingTicks <= RACE_TICKS + 30; n++) {
      if (n > 60 * 30) throw new Error('race did not start');
      guest.tick(FULL);
      network.advance(TICK_MS);
      const applied = state.karts.map(entry => host.inputSource(entry.id).sample(state, entry.id));
      hostStepping = true;
      race.stepRace(state, applied);
      hostStepping = false;
      history.set(state.tick, structuredClone(state));
      for (const event of state.events) {
        if (event.type === 'hit' && event.kartId === 1 && event.value === 1) hostHits.push(state.racingTicks);
      }
      host.afterTick(state);
      guest.frame();
      const predicted = guest.predictedState;
      if (predicted && predicted.phase === 'racing' && predicted.racingTicks <= RACE_TICKS) {
        views.push({ tick: predicted.tick, time: predicted.time, d: predicted.karts[1].trackDistance });
      }
    }
    let timeChecks = 0;
    for (const view of views) {
      const reference = history.get(view.tick);
      expect(reference, `host tick ${view.tick}`).toBeDefined();
      expect(view.time, `time at tick ${view.tick}`).toBe(reference!.time);
      for (const d of [view.d, (SWEEP.from + SWEEP.to) / 2]) {
        expect(corridorAt(track, d, view.time)).toEqual(corridorAt(track, d, reference!.time));
      }
      timeChecks++;
    }
    const guestHits = [...guestHitTicks].filter(([, hit]) => hit).map(([tick]) => tick).sort((a, b) => a - b);
    return { corrections, hostHits, guestHits, inside, timeChecks, snapshotLengths, finalDistance: state.karts[1].trackDistance };
  } finally {
    host.close();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('net motion on a sweep band (RTT 80 ± 20 ms)', () => {
  it('builds a valid course', () => {
    expect(() => validateTrackDef(motionDef())).not.toThrow();
  });

  it('run A: passing beside the band keeps every correction ≤ 1.0 m with matching time and corridor', async () => {
    // Reaches the band 10 s after the start at 36.6 m/s, on the - side clear of the ±6.15 m sweep.
    const run = await drive(1068, -8.5);
    expect(run.finalDistance).toBeGreaterThan(SWEEP.to);
    expect(run.hostHits).toEqual([]);
    expect(run.corrections.length).toBeGreaterThan(200);
    expect(Math.max(...run.corrections)).toBeLessThanOrEqual(1.0);
    expect(run.timeChecks).toBeGreaterThan(RACE_TICKS - 10);
    expect(run.snapshotLengths.length).toBeGreaterThan(200);
    for (const { bytes, entities } of run.snapshotLengths) expect(bytes).toBe(BASE_BYTES + 25 * entities);
  }, 60_000);

  it('run B: driving into the band hits on the same racing tick and never tunnels through', async () => {
    // Centre line, arriving at the cap at t ≈ 9 s when the sweep centre crosses 0.
    // Recorded result (seed 7): hit at racingTick 539 on both sides, max correction ≈ 0.0005 m.
    const run = await drive(1104, 0);
    expect(run.hostHits.length).toBeGreaterThan(0);
    expect(run.guestHits).toEqual(run.hostHits);
    expect(run.corrections.length).toBeGreaterThan(200);
    expect(run.inside).toEqual([]);
    expect(Number.isFinite(Math.max(...run.corrections))).toBe(true);
  }, 60_000);
});

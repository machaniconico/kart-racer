import { getAIInput } from '../ai';
import { KART_RADIUS, widthAt } from '../corridor';
import { createRace, stepRace } from '../race';
import { surfaceAt } from '../surfaces';
import { getTrack } from './index';
import { CPU_LEVELS } from '../types';
import type { CpuLevel, RaceState, Track, TrackId } from '../types';

/**
 * Shape measurements for course design checks. Course tests import these to verify the
 * features a layout promises; nothing in the simulation depends on them.
 * All lengths are in metres along the sampled centre line, angles in radians.
 */

/** |κ| below this (radius above 200 m) is treated as straight and never counts as a reversal. */
export const S_CURVE_DEADBAND = 1 / 200;
const HAIRPIN_WINDOW = 120;
const HAIRPIN_TURN = 150 * Math.PI / 180;
const S_CURVE_WINDOW = 300;
const S_CURVE_REVERSALS = 3;
const S_CURVE_MAX_RADIUS = 70;
const COMPOUND_TURN = Math.PI / 2;
/** Same-sign corners are split only where the curvature is numerically zero, not by the S-curve deadband. */
const NUMERICAL_ZERO = 1e-9;
const COMPOUND_RADIUS_RATIO = 1.25;

export interface CurvaturePoint {
  readonly distance: number;
  /** Signed 1 / r from the circumcircle of the neighbouring samples; positive turns left in x-z. */
  readonly curvature: number;
  /** Heading change at this sample, from the incoming to the outgoing chord. */
  readonly turn: number;
}

export interface Hairpin {
  readonly from: number;
  readonly to: number;
  /** Largest absolute heading change within 120 m of the section. */
  readonly turn: number;
  readonly minRadius: number;
  /** Where minRadius occurs; the band check uses widthAt here. */
  readonly at: number;
}

export interface Bend {
  readonly from: number;
  readonly to: number;
  readonly sign: -1 | 1;
  readonly turn: number;
  readonly minRadius: number;
}

export interface SCurve {
  readonly from: number;
  readonly to: number;
  readonly reversals: number;
  readonly bends: readonly Bend[];
}

export interface CompoundCorner extends Bend {
  /** Radii of the curvature maxima, tightest first and widest last. */
  readonly peakRadii: readonly [number, number];
}

function wrap(distance: number, length: number): number {
  return ((distance % length) + length) % length;
}

// Maximum H1 totals across seeds [1, 42, 98765] on the old sixteen courses (8 CPUs × 3 laps).
// Pinned against the recorded rows in handling.test.ts; shared with the M11 lap harness.
// M12-21: 1 -> 2 each from the re-measured rows (serpentine wall 2, neon band 2); the hits fall 17-140 s into races, not at GO.
// M12-22: band 2 -> 1 (neon re-measured at cpuPace 1.02); wall stays 2 (serpentine unchanged).
export const WALL_HITS_MAX_EXISTING = 2;
export const BAND_HITS_MAX_EXISTING = 1;

export interface CpuLapOptions {
  readonly seeds?: readonly number[];
  readonly cpuLevels?: readonly CpuLevel[];
  readonly maxTicks?: number;
  /** Maximum falls per seed, assessed separately at each difficulty. Required on courses with fall zones. */
  readonly fallBudget?: number;
  /** Total wall hits across seeds at each difficulty; M11-00 measured a legacy maximum of 1. */
  readonly wallHitBudget?: number;
  /** Total band hits across seeds at each difficulty; defaults to the legacy H1 maximum. */
  readonly bandHitBudget?: number;
  readonly itemBoxes?: boolean;
}

export interface CpuLapRun {
  readonly seed: number;
  readonly state: RaceState;
  readonly falls: number;
  readonly wallHits: number;
  readonly bandHits: number;
  readonly pitFalls: number;
  readonly finished: boolean;
}

export interface CpuLapMetrics {
  readonly cpuLevel: CpuLevel;
  readonly runs: readonly CpuLapRun[];
  readonly falls: number;
  readonly meanFalls: number;
  readonly wallHits: number;
  readonly bandHits: number;
  readonly passed: boolean;
}

/** Eight CPUs × three laps, with event counts kept outside the serialized simulation state. */
export function measureCpuLaps(trackId: TrackId, options: CpuLapOptions = {}): CpuLapMetrics[] {
  const { seeds = [1, 42, 98765], cpuLevels = CPU_LEVELS, maxTicks = 60 * 420,
    fallBudget = Infinity, wallHitBudget = WALL_HITS_MAX_EXISTING,
    bandHitBudget = BAND_HITS_MAX_EXISTING, itemBoxes = true } = options;
  if (!seeds.length || !cpuLevels.length || !Number.isInteger(maxTicks) || maxTicks < 1 ||
    !(fallBudget >= 0) || !(wallHitBudget >= 0) || !(bandHitBudget >= 0)) {
    throw new RangeError('Invalid CPU lap measurement options');
  }
  const track = getTrack(trackId);
  if (options.fallBudget === undefined && track.def.surfaces.some(zone => zone.kind === 'fall')) {
    throw new RangeError('fallBudget is required for courses with fall zones');
  }
  return cpuLevels.map(cpuLevel => {
    const runs = seeds.map(seed => {
      const state = createRace(seed, { trackId, racers: [], karts: 8, laps: 3, cpuLevel, itemBoxes });
      let falls = 0;
      let wallHits = 0;
      let bandHits = 0;
      let pitFalls = 0;
      for (let tick = 0; tick < maxTicks && state.phase !== 'finished'; tick++) {
        stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
        for (const event of state.events) {
          if (event.type === 'fall') { falls++; continue; }
          if (event.type !== 'hit') continue;
          if (event.value === 1) { bandHits++; continue; }
          if (event.value === 2) { pitFalls++; continue; }
          const kart = state.karts.find(candidate => candidate.id === event.kartId)!;
          const limit = widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS;
          if (Math.abs(kart.lateralOffset) >= limit - 0.01) wallHits++;
        }
      }
      const finished = state.phase === 'finished' && state.karts.every(kart =>
        kart.lap === 3 && kart.lapTimes.length === 3 && kart.finishTime !== null);
      return { seed, state, falls, wallHits, bandHits, pitFalls, finished };
    });
    const falls = runs.reduce((sum, run) => sum + run.falls, 0);
    const meanFalls = falls / seeds.length;
    const wallHits = runs.reduce((sum, run) => sum + run.wallHits, 0);
    const bandHits = runs.reduce((sum, run) => sum + run.bandHits, 0);
    return { cpuLevel, runs, falls, meanFalls, wallHits, bandHits,
      passed: runs.every(run => run.finished) && meanFalls <= fallBudget &&
        wallHits <= wallHitBudget && bandHits <= bandHitBudget };
  });
}

/** Signed curvature at every sample (3-point circumcircle in x-z), wrapping at the seam. */
export function curvatureProfile(track: Track): CurvaturePoint[] {
  const { samples } = track;
  const n = samples.length;
  return samples.map((b, i) => {
    const a = samples[(i + n - 1) % n]!;
    const c = samples[(i + 1) % n]!;
    const abx = b.x - a.x; const abz = b.z - a.z;
    const bcx = c.x - b.x; const bcz = c.z - b.z;
    const cross = abx * bcz - abz * bcx;
    const product = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(c.x - a.x, c.z - a.z);
    const curvature = product > 0 ? 2 * cross / product : 0;
    const turn = Math.atan2(cross, abx * bcx + abz * bcz);
    return { distance: b.distance, curvature, turn };
  });
}

/** Smallest centre-line curvature radius on the course (Infinity on a straight). */
export function minCurvatureRadius(track: Track): number {
  return 1 / Math.max(0, ...curvatureProfile(track).map(point => Math.abs(point.curvature)));
}

export function elevationRange(track: Track): { min: number; max: number; range: number } {
  const heights = track.samples.map(sample => sample.y);
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  return { min, max, range: max - min };
}

/** Largest |Δy / Δdistance| between neighbouring samples, including the seam. */
export function maxSlope(track: Track): number {
  const { samples, length } = track;
  let result = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i]!;
    const b = samples[(i + 1) % samples.length]!;
    const run = wrap(b.distance - a.distance, length);
    if (run > 0) result = Math.max(result, Math.abs(b.y - a.y) / run);
  }
  return result;
}

/**
 * Width-normalized dirt coverage of the road: dirt road area / (2 * roadHalfWidth * length), by
 * midpoint samples every 0.5 m along and 64 across, using surfaceAt's precedence (ice wins over dirt).
 */
export function dirtCoverage(track: Track): number {
  const step = 0.5;
  const lateralSamples = 64;
  let dirtMetres = 0;
  for (let start = 0; start < track.length; start += step) {
    const length = Math.min(step, track.length - start);
    const distance = start + length / 2;
    const halfWidth = widthAt(track, distance).roadHalfWidth;
    for (let lateral = 0; lateral < lateralSamples; lateral++) {
      const offset = -halfWidth + (lateral + 0.5) / lateralSamples * 2 * halfWidth;
      if (surfaceAt(track, distance, offset) === 'dirt') dirtMetres += length / lateralSamples;
    }
  }
  return dirtMetres / track.length;
}

/**
 * Sections that turn at least 150° within 120 m and whose tightest radius lies in
 * [wallHalfWidth + 2.5, wallHalfWidth + 8], wallHalfWidth being widthAt at that point.
 */
export function findHairpins(track: Track): Hairpin[] {
  const profile = curvatureProfile(track);
  const n = profile.length;
  const { length } = track;
  // From each start, take the shortest window of at most 120 m that turns at least 150° and
  // whose own tightest radius lies in the band at that point. Only accepted windows are
  // merged, so a neighbouring corner outside the band cannot veto a valid hairpin.
  const covered = new Array<boolean>(n).fill(false);
  const windowTurn = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let turn = 0;
    let tightest = i;
    let accepted = -1;
    for (let k = 0; k < n; k++) {
      const j = (i + k) % n;
      if (wrap(profile[j]!.distance - profile[i]!.distance, length) > HAIRPIN_WINDOW) break;
      turn += profile[j]!.turn;
      if (Math.abs(profile[j]!.curvature) > Math.abs(profile[tightest]!.curvature)) tightest = j;
      if (Math.abs(turn) < HAIRPIN_TURN) continue;
      const radius = 1 / Math.abs(profile[tightest]!.curvature);
      const wall = widthAt(track, profile[tightest]!.distance).wallHalfWidth;
      if (radius >= wall + 2.5 && radius <= wall + 8) { accepted = k; break; }
    }
    for (let m = 0; m <= accepted; m++) {
      const index = (i + m) % n;
      covered[index] = true;
      windowTurn[index] = Math.max(windowTurn[index]!, Math.abs(turn));
    }
  }
  const result: Hairpin[] = [];
  for (let [start, end] of coveredRuns(covered)) {
    // Windows may start on the approach straight; the hairpin itself is the curved part.
    while (start < end && Math.abs(profile[start % n]!.curvature) < S_CURVE_DEADBAND) start++;
    while (end > start && Math.abs(profile[end % n]!.curvature) < S_CURVE_DEADBAND) end--;
    let tightest = start;
    let turn = 0;
    for (let k = start; k <= end; k++) {
      const index = k % n;
      if (Math.abs(profile[index]!.curvature) > Math.abs(profile[tightest % n]!.curvature)) tightest = k;
      turn = Math.max(turn, windowTurn[index]!);
    }
    const at = profile[tightest % n]!.distance;
    result.push({ from: profile[start % n]!.distance, to: profile[end % n]!.distance, turn,
      minRadius: 1 / Math.abs(profile[tightest % n]!.curvature), at });
  }
  return result;
}

/** Maximal runs of true values as [start, end] indices; end may exceed n - 1 when a run wraps the seam. */
function coveredRuns(flags: readonly boolean[]): [number, number][] {
  const n = flags.length;
  if (flags.every(Boolean)) return [[0, n - 1]];
  const first = flags.findIndex(flag => !flag);
  const runs: [number, number][] = [];
  for (let k = 1; k <= n; k++) {
    const index = first + k;
    if (!flags[index % n]) continue;
    if (runs.length && runs[runs.length - 1]![1] === index - 1) runs[runs.length - 1]![1] = index;
    else runs.push([index, index]);
  }
  return runs;
}

interface Run { start: number; end: number; sign: -1 | 1 }

/** Contiguous same-sign runs with |κ| above zero, as sample index ranges (end may exceed n - 1). */
function signedRuns(profile: readonly CurvaturePoint[], zero: number): Run[] {
  const n = profile.length;
  const sign = (i: number): -1 | 0 | 1 => {
    const curvature = profile[i % n]!.curvature;
    return Math.abs(curvature) <= zero ? 0 : curvature > 0 ? 1 : -1;
  };
  let first = -1;
  for (let i = 0; i < n; i++) if (sign(i) !== sign(i + n - 1)) { first = i; break; }
  if (first < 0) return sign(0) === 0 ? [] : [{ start: 0, end: n - 1, sign: sign(0) as -1 | 1 }];
  const runs: Run[] = [];
  for (let k = 0; k < n; k++) {
    const index = first + k;
    const s = sign(index);
    if (s === 0) continue;
    const last = runs[runs.length - 1];
    if (last && last.sign === s && last.end === index - 1) last.end = index;
    else runs.push({ start: index, end: index, sign: s });
  }
  return runs;
}

function toBend(profile: readonly CurvaturePoint[], run: Run): Bend {
  const n = profile.length;
  let turn = 0;
  let maxCurvature = 0;
  for (let k = run.start; k <= run.end; k++) {
    turn += profile[k % n]!.turn;
    maxCurvature = Math.max(maxCurvature, Math.abs(profile[k % n]!.curvature));
  }
  return { from: profile[run.start % n]!.distance, to: profile[run.end % n]!.distance,
    sign: run.sign, turn, minRadius: 1 / maxCurvature };
}

/**
 * Sections in which the curvature sign reverses at least three times within 300 m, every bend
 * having a tightest radius <= 70 m. A bend is a run of same-sign samples with |κ| >= 1/200;
 * deadband samples belong to no bend, so a straight between two same-sign bends is never a
 * reversal. Every run of at least four consecutive bends whose span (first bend's start to
 * last bend's end) is <= 300 m, with three or more sign changes and all radii <= 70 m, is a
 * candidate; overlapping or touching candidates are reported as one section.
 */
export function findSCurves(track: Track): SCurve[] {
  const profile = curvatureProfile(track);
  const { length } = track;
  // signedRuns treats |κ| <= zero as straight, so this makes exactly |κ| < 1/200 the deadband.
  const bends = signedRuns(profile, S_CURVE_DEADBAND - Number.EPSILON).map(run => toBend(profile, run));
  const count = bends.length;
  const bend = (k: number) => bends[k % count]!;
  const flags = new Array<boolean>(count).fill(false);
  for (let k = 0; k < count; k++) {
    let reversals = 0;
    for (let m = k + 1; m < k + count; m++) {
      if (wrap(bend(m).to - bend(k).from, length) > S_CURVE_WINDOW) break;
      if (bend(m).sign !== bend(m - 1).sign) reversals++;
      if (reversals < S_CURVE_REVERSALS) continue;
      let tight = true;
      for (let j = k; j <= m; j++) tight &&= bend(j).minRadius <= S_CURVE_MAX_RADIUS;
      if (tight) for (let j = k; j <= m; j++) flags[j % count] = true;
    }
  }
  if (!flags.some(Boolean)) return [];
  return coveredRuns(flags).map(([start, end]) => {
    const section = Array.from({ length: end - start + 1 }, (_, i) => bend(start + i));
    const reversals = section.filter((item, i) => i > 0 && item.sign !== section[i - 1]!.sign).length;
    return { from: section[0]!.from, to: section[section.length - 1]!.to, reversals, bends: section };
  });
}

/**
 * Same-sign sections turning at least 90° that hold two curvature maxima whose radii differ
 * by at least 25% (the wider radius >= 1.25 x the tighter one). A maximum is a sample whose
 * |κ| is at least 1/200 (a bend, not a straight) and a local maximum against its neighbours
 * (>= the previous, > the next, so a flat plateau counts once at its end). Neighbours wrap at
 * the seam, so a section covering the whole lap is compared cyclically.
 */
export function findCompoundCorners(track: Track): CompoundCorner[] {
  const profile = curvatureProfile(track);
  const n = profile.length;
  const result: CompoundCorner[] = [];
  const at = (k: number) => Math.abs(profile[((k % n) + n) % n]!.curvature);
  for (const run of signedRuns(profile, NUMERICAL_ZERO)) {
    const bend = toBend(profile, run);
    if (Math.abs(bend.turn) < COMPOUND_TURN) continue;
    const peaks: number[] = [];
    for (let k = run.start; k <= run.end; k++) {
      const here = at(k);
      if (here >= S_CURVE_DEADBAND && here >= at(k - 1) && here > at(k + 1)) peaks.push(1 / here);
    }
    if (peaks.length < 2) continue;
    const tight = Math.min(...peaks);
    const wide = Math.max(...peaks);
    if (wide >= COMPOUND_RADIUS_RATIO * tight) result.push({ ...bend, peakRadii: [tight, wide] });
  }
  return result;
}

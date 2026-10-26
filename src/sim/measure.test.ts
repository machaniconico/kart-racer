import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getAIInput } from './ai';
import { widthAt } from './corridor';
import * as items from './items';
import * as itemTable from './itemTable';
import { getRank } from './laps';
import { createRace, KART_RADIUS, NEUTRAL_INPUT, stepRace } from './race';
import { surfaceAt } from './surfaces';
import { getTrack, TRACK_IDS } from './tracks';
import type { CpuLevel, ItemType, RaceState, TrackId } from './types';

// Run: KART_MEASURE=1 npx vitest run src/sim/measure.test.ts --disableConsoleIntercept
// Stdout contains one M12_MEASURE_JSON line. Nothing writes or refreshes the before snapshot.
// Helpers live here because M12-20's file lock permits no separate test-support module.
export const MEASURE_SEEDS = [1, 42, 98765] as const;
export const ITEM_ORDER = ['dash', 'trap', 'bolt', 'seeker', 'skycomet', 'tripleDash',
  'rapidDash', 'aura', 'storm', 'ink', 'decoy', 'bomb', 'autopilot', 'barrier'] as const satisfies readonly ItemType[];
const MAX_TICKS = 60 * 420;
const emptyDraws = () => Array.from({ length: 8 }, () => ITEM_ORDER.map(() => 0));
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const ratio = (numerator: number, denominator: number) => denominator === 0 ? null : numerator / denominator;

export interface ItemRun {
  seed: number;
  drawsByRank: number[][];
  hitsByRank: number[];
  pickups: number;
  firstLapLeader: number;
  winner: number;
}

/** Only reads emitted item hits, without guessing from a kart's later wall position.
 * Every item damage path runs inside these three public entry points. The observers call
 * each original exactly once; chooseItem's observer preserves its single RNG draw and rank.
 * All spies are scoped to one synchronous run and restored even if a completeness check fails.
 */
function observeItems(run: ItemRun): () => void {
  const chooseItem = itemTable.chooseItem;
  const useItem = items.useItem;
  const onKartContact = items.onKartContact;
  const advanceItems = items.advanceItems;
  function recordHits(state: RaceState, start: number): void {
    for (const event of state.events.slice(start)) {
      if (event.type === 'hit') run.hitsByRank[getRank(state, event.kartId) - 1]!++;
    }
  }
  const spies = [
    vi.spyOn(itemTable, 'chooseItem').mockImplementation((state, rank) => {
      const item = chooseItem(state, rank);
      run.drawsByRank[rank - 1]![ITEM_ORDER.indexOf(item)]!++;
      return item;
    }),
    vi.spyOn(items, 'useItem').mockImplementation((state, kart, input) => {
      const start = state.events.length;
      useItem(state, kart, input);
      recordHits(state, start);
    }),
    vi.spyOn(items, 'onKartContact').mockImplementation((state, first, second) => {
      const start = state.events.length;
      onKartContact(state, first, second);
      recordHits(state, start);
    }),
    vi.spyOn(items, 'advanceItems').mockImplementation((track, state, dt) => {
      const start = state.events.length;
      advanceItems(track, state, dt);
      recordHits(state, start);
    }),
  ];
  return () => spies.forEach(spy => spy.mockRestore());
}

function drive(state: RaceState): void {
  stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
}

function completedLaps(state: RaceState) {
  expect(state.phase, `${state.trackId}: incomplete race at tick ${state.tick}`).toBe('finished');
  expect(state.karts).toHaveLength(8);
  return state.karts.map(kart => {
    expect(kart.lap).toBe(3);
    expect(kart.lapTimes).toHaveLength(3);
    expect(kart.finishTime).not.toBeNull();
    expect(kart.lapTimes.every(time => Number.isFinite(time) && time > 0)).toBe(true);
    return { id: kart.id, lapTimes: [...kart.lapTimes], finishTime: kart.finishTime! };
  });
}

export function measureCpuCourse(trackId: TrackId, cpuLevel: CpuLevel = 'normal') {
  const track = getTrack(trackId);
  let totalLapTime = 0;
  let wallHits = 0;
  let bandHits = 0;
  const runs = MEASURE_SEEDS.map(seed => {
    const state = createRace(seed, { trackId, racers: [], karts: 8, laps: 3, cpuLevel, itemBoxes: true });
    const run: ItemRun = { seed, drawsByRank: emptyDraws(), hitsByRank: Array<number>(8).fill(0),
      pickups: 0, firstLapLeader: -1, winner: -1 };
    let runWallHits = 0;
    let runBandHits = 0;
    let pitFalls = 0;
    let falls = 0;
    const restore = observeItems(run);
    try {
      for (let tick = 0; tick < MAX_TICKS && state.phase !== 'finished'; tick++) {
        drive(state);
        for (const event of state.events) {
          if (event.type === 'pickup') run.pickups++;
          if (event.type === 'fall') falls++;
          // Exactly handling.test.ts's countHits convention, including its wall tolerance.
          if (event.type !== 'hit') continue;
          if (event.value === 1) { runBandHits++; continue; }
          if (event.value === 2) { pitFalls++; continue; }
          const kart = state.karts[event.kartId]!;
          const limit = widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS;
          if (Math.abs(kart.lateralOffset) >= limit - 0.01) runWallHits++;
        }
        if (run.firstLapLeader === -1) {
          // Resolve simultaneous first-lap crossings using the sim's ranking/tie rule.
          const crossed = state.karts.filter(kart => kart.lapTimes.length > 0)
            .sort((a, b) => getRank(state, a.id) - getRank(state, b.id));
          if (crossed.length) run.firstLapLeader = crossed[0]!.id;
        }
      }
      const karts = completedLaps(state);
      expect(state.karts.every(kart => !kart.human)).toBe(true);
      expect(sum(run.drawsByRank.map(sum))).toBe(run.pickups);
      expect(run.firstLapLeader).toBeGreaterThanOrEqual(0);
      run.winner = state.karts.find(kart => getRank(state, kart.id) === 1)!.id;
      // Keep the grouping/order of additions identical to handling.test.ts for exact literals.
      for (const kart of karts) totalLapTime += sum(kart.lapTimes);
      wallHits += runWallHits;
      bandHits += runBandHits;
      return { ...run, ticks: state.tick, karts, wallHits: runWallHits, bandHits: runBandHits, pitFalls, falls };
    } finally {
      restore();
    }
  });
  return { baseline: { version: 'm12' as const, meanLap: totalLapTime / 72, wallHits, bandHits }, runs };
}

export function measureEffectDurations() {
  function activate(item: ItemType) {
    const state = createRace(42, { karts: 2, itemBoxes: false });
    state.phase = 'racing';
    const human = state.karts[0]!;
    const cpu = state.karts[1]!;
    // The human must lead to receive ink. Observe immediately, before timer subtraction.
    human.startedLap = cpu.startedLap = true;
    human.lapProgress = 100;
    cpu.lapProgress = 0;
    const owner = item === 'ink' || item === 'storm' ? cpu : human;
    owner.item = item;
    items.useItem(state, owner, { ...NEUTRAL_INPUT, useItem: true });
    return human.effects;
  }
  return { ink: activate('ink').inkTime, aura: activate('aura').auraTime,
    shrink: activate('storm').shrinkTime, autopilot: activate('autopilot').autoTime };
}

export function summarizeItems(runs: readonly ItemRun[]) {
  const drawsByRank = emptyDraws();
  const hitsByRank = Array<number>(8).fill(0);
  for (const run of runs) {
    for (let rank = 0; rank < 8; rank++) {
      hitsByRank[rank]! += run.hitsByRank[rank]!;
      for (let item = 0; item < ITEM_ORDER.length; item++) {
        drawsByRank[rank]![item]! += run.drawsByRank[rank]![item]!;
      }
    }
  }
  const countItems = (ranks: number[], selected: readonly ItemType[]) => sum(ranks.map(rank =>
    sum(selected.map(item => drawsByRank[rank - 1]![ITEM_ORDER.indexOf(item)]!))));
  const firstDefensive = countItems([1], ['trap', 'decoy', 'barrier', 'dash']);
  const lastComeback = countItems([7, 8], ['skycomet', 'rapidDash', 'aura', 'storm', 'autopilot', 'tripleDash']);
  const firstDraws = sum(drawsByRank[0]!);
  const lastDraws = sum(drawsByRank[6]!) + sum(drawsByRank[7]!);
  const meanHitsSecondToFourth = sum(hitsByRank.slice(1, 4)) / 3;
  const leaderWins = runs.filter(run => run.firstLapLeader === run.winner).length;
  return {
    itemOrder: ITEM_ORDER, drawsByRank, hitsByRank,
    firstPlaceDefensive: { count: firstDefensive, draws: firstDraws, ratio: ratio(firstDefensive, firstDraws) },
    lastTwoComeback: { count: lastComeback, draws: lastDraws, ratio: ratio(lastComeback, lastDraws) },
    firstPlaceHitRatio: { hits: hitsByRank[0]!, meanHitsSecondToFourth,
      ratio: ratio(hitsByRank[0]!, meanHitsSecondToFourth) },
    firstLapLeaderWinRate: { wins: leaderWins, races: runs.length, ratio: ratio(leaderWins, runs.length) },
    effectDurationsSeconds: measureEffectDurations(),
  };
}

function measureDigest(trackId: TrackId): number {
  const state = createRace(7, { trackId, racers: [] });
  for (let tick = 0; tick < 1800; tick++) drive(state);
  const value = state.karts.map(kart => [kart.x, kart.z, kart.speed, kart.trackDistance, kart.heading]);
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
}

function measureHumanCourse(trackId: TrackId) {
  let totalLapTime = 0;
  const runs = MEASURE_SEEDS.map(seed => {
    // Eight human-performance karts: same grid, seeds, AI inputs and items as the CPU sample,
    // but human max speed and no CPU rubber band. All eight must finish, not just slot zero.
    const racers = createRace(seed, { trackId }).karts.map(({ name, color }) => ({ name, color, human: true }));
    const state = createRace(seed, { trackId, racers, karts: 8, laps: 3, cpuLevel: 'normal', itemBoxes: true });
    for (let tick = 0; tick < MAX_TICKS && state.phase !== 'finished'; tick++) drive(state);
    const karts = completedLaps(state);
    expect(state.karts.every(kart => kart.human)).toBe(true);
    for (const kart of karts) totalLapTime += sum(kart.lapTimes);
    return { seed, ticks: state.tick, karts };
  });
  return { meanLap: totalLapTime / 72, runs };
}

function measureDunesDirt() {
  const track = getTrack('dunes');
  const distanceStep = 0.5;
  const lateralSamples = 64;
  let dirtEquivalentMetres = 0;
  let centerlineDirtMetres = 0;
  // Width-normalized coverage responds to moving dirt to the outside as well as shortening it.
  // Midpoint quadrature clips the last longitudinal cell and tests actual surface precedence.
  for (let start = 0; start < track.length; start += distanceStep) {
    const length = Math.min(distanceStep, track.length - start);
    const distance = start + length / 2;
    const halfWidth = widthAt(track, distance).roadHalfWidth;
    if (surfaceAt(track, distance, 0) === 'dirt') centerlineDirtMetres += length;
    for (let lateral = 0; lateral < lateralSamples; lateral++) {
      const offset = -halfWidth + (lateral + 0.5) / lateralSamples * 2 * halfWidth;
      if (surfaceAt(track, distance, offset) === 'dirt') dirtEquivalentMetres += length / lateralSamples;
    }
  }
  return { method: 'width-normalized road coverage, midpoint samples', distanceStep, lateralSamples,
    trackLength: track.length, dirtEquivalentMetres, ratio: dirtEquivalentMetres / track.length,
    centerlineDirtMetres, centerlineRatio: centerlineDirtMetres / track.length };
}

// itemBalance.test imports the helpers, not this opt-in suite. Avoid registering duplicate tests.
if (expect.getState().testPath === fileURLToPath(import.meta.url)) {
  describe.skipIf(process.env.KART_MEASURE !== '1')('M12 measurement harness', () => {
    it('item observers preserve the exact seeded state and PRNG stream', () => {
      const reference = createRace(7, { racers: [] });
      for (let tick = 0; tick < 1800; tick++) drive(reference);
      const observed = createRace(7, { racers: [] });
      const run: ItemRun = { seed: 7, drawsByRank: emptyDraws(), hitsByRank: Array<number>(8).fill(0),
        pickups: 0, firstLapLeader: -1, winner: -1 };
      const restore = observeItems(run);
      try {
        for (let tick = 0; tick < 1800; tick++) drive(observed);
      } finally {
        restore();
      }
      expect(sum(run.drawsByRank.map(sum))).toBeGreaterThan(0);
      expect(observed).toEqual(reference);
    });

    it('getAIInput drives a human=true kart without an adapter or state mutation', () => {
      const state = createRace(42, { karts: 1, itemBoxes: false });
      for (let tick = 0; tick < 180; tick++) drive(state);
      const before = JSON.stringify(state);
      const input = getAIInput(state, 0);
      expect(input.throttle).toBeGreaterThan(0);
      expect(Number.isFinite(input.steer)).toBe(true);
      expect(JSON.stringify(state)).toBe(before);
      stepRace(state, [input]);
      expect(state.karts[0]!.human).toBe(true);
      expect(state.karts[0]!.speed).toBeGreaterThan(0);
    });

    it('outputs all course measurements and pasteable pin literals as JSON', () => {
      const courses = TRACK_IDS.map(trackId => {
        const digest = measureDigest(trackId);
        const cpu = measureCpuCourse(trackId);
        const humanModel = measureHumanCourse(trackId);
        // M12-22 (C2): easy/hard samples use the same 72-lap method; only their baseline rows are kept.
        const levels = { easy: measureCpuCourse(trackId, 'easy').baseline, hard: measureCpuCourse(trackId, 'hard').baseline };
        return { trackId, digest, ...cpu, humanModel, levels,
          cpuToHumanRatio: cpu.baseline.meanLap / humanModel.meanLap,
          levelRatios: { easy: levels.easy.meanLap / humanModel.meanLap, normal: cpu.baseline.meanLap / humanModel.meanLap,
            hard: levels.hard.meanLap / humanModel.meanLap } };
      });
      const digest = Object.fromEntries(courses.map(course => [course.trackId, course.digest]));
      const BASELINE = Object.fromEntries(courses.map(course => [course.trackId, course.baseline]));
      const report = {
        story: 'M12-20', platform: `${process.platform}-${process.arch}`, node: process.version,
        parameters: { seeds: MEASURE_SEEDS, karts: 8, laps: 3, cpuLevel: 'normal', itemBoxes: true,
          maxTicks: MAX_TICKS, digestSeed: 7, digestTicks: 1800, humanModel: '8 human=true karts driven by getAIInput' },
        definitions: {
          draws: 'Actual chooseItem calls; rank at draw time; rows ranks 1-8, columns itemOrder.',
          hits: 'Item hit events only (useItem/onKartContact/advanceItems), rank before lap tracking; excludes wall, band, pit and fall.',
          leader: 'First kart completing lap 1, ties use getRank; winner uses final getRank.',
          effects: 'Seconds immediately after useItem on a human kart, before timer decay.',
          baseline: 'Same summation and hit classification as handling.test.ts; version labels generated M12 rows.',
        },
        levelRatios: Object.fromEntries(courses.map(course => [course.trackId, course.levelRatios])),
        levelBaselines: Object.fromEntries(courses.map(course => [course.trackId, course.levels])),
        digest, BASELINE, humanModelLap: Object.fromEntries(courses.map(course => [course.trackId, course.humanModel.meanLap])),
        itemBalance: summarizeItems(courses.flatMap(course => course.runs)),
        dunesDirtCoverage: measureDunesDirt(), courses,
        literals: {
          digest: `const ${process.platform === 'darwin' ? 'DARWIN' : process.platform.toUpperCase()}_FINGERPRINTS: Record<TrackId, number> = {\n${courses.map(course => `  ${course.trackId}: ${course.digest},`).join('\n')}\n};`,
          BASELINE: `const BASELINE = {\n${courses.map(({ trackId, baseline: row }) => `  ${trackId}: { version: '${row.version}', meanLap: ${row.meanLap}, wallHits: ${row.wallHits}, bandHits: ${row.bandHits} },`).join('\n')}\n};`,
        },
      };
      expect(courses).toHaveLength(TRACK_IDS.length);
      expect(report.itemBalance.firstLapLeaderWinRate.races).toBe(TRACK_IDS.length * MEASURE_SEEDS.length);
      console.info(`M12_MEASURE_JSON ${JSON.stringify(report)}`);
    }, 600_000);
  });
}

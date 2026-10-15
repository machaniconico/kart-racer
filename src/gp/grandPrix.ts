import { getRank } from '../sim/laps';
import { createRace } from '../sim/race';
import type { CpuLevel, KartState, RaceState, TrackId } from '../sim/types';

export type CupId = 'sunrise' | 'horizon';

export interface Cup {
  readonly id: CupId;
  readonly name: string;
  readonly tracks: readonly TrackId[];
}

export const CUPS: readonly Cup[] = [
  { id: 'sunrise', name: 'SUNRISE CUP', tracks: ['meadow', 'canyon', 'snowpeak', 'neon'] },
  { id: 'horizon', name: 'HORIZON CUP', tracks: ['harbor', 'forest', 'volcano', 'skyline'] },
];

export const GP_POINTS = [10, 8, 6, 5, 4, 3, 2, 1] as const;

export interface RaceResult {
  trackId: TrackId;
  /** Kart IDs in finishing order, including DNFs in simulation progress order. */
  order: number[];
  /** Points indexed by kart ID. */
  points: number[];
}

export interface GrandPrix {
  cupId: CupId;
  laps: number;
  cpuLevel: CpuLevel;
  raceIndex: number;
  results: RaceResult[];
  /** Owned roster snapshot; refreshed from each final race state. */
  karts: Pick<KartState, 'id' | 'name' | 'color'>[];
}

export interface StandingRow {
  kartId: number;
  name: string;
  color: number;
  points: number;
  /** One-based placing in the latest race, or zero before any races. */
  lastPosition: number;
  gained: number;
}

function getCup(cupId: string): Cup {
  const cup = CUPS.find(candidate => candidate.id === cupId);
  if (!cup) throw new RangeError(`Unknown cup: ${cupId}`);
  return cup;
}

function roster(state: RaceState): GrandPrix['karts'] {
  return state.karts.map(({ id, name, color }) => ({ id, name, color }));
}

export function createGrandPrix(cupId: string, laps: number, cpuLevel: CpuLevel): GrandPrix {
  const cup = getCup(cupId);
  // Use the simulation's default grid until the first finalState supplies the actual roster.
  const initialState = createRace(1, { trackId: cup.tracks[0], laps, cpuLevel });
  return { cupId: cup.id, laps, cpuLevel, raceIndex: 0, results: [], karts: roster(initialState) };
}

export function nextTrack(gp: GrandPrix): TrackId | null {
  return isComplete(gp) ? null : getCup(gp.cupId).tracks[gp.raceIndex] ?? null;
}

export function recordRace(gp: GrandPrix, finalState: RaceState): GrandPrix {
  if (gp.results.length >= 4) throw new RangeError('A Grand Prix contains four races');
  const expectedTrack = nextTrack(gp);
  if (finalState.trackId !== expectedTrack) {
    throw new RangeError(`Expected a ${expectedTrack} race but received ${finalState.trackId}`);
  }
  if (finalState.phase !== 'finished') {
    throw new RangeError(`Expected a finished race but received phase ${finalState.phase}`);
  }
  if (finalState.laps !== gp.laps) {
    throw new RangeError(`Expected a ${gp.laps}-lap race but received ${finalState.laps} laps`);
  }
  // Match GameUI.showResults, including finish-time ties and unfinished racers.
  const order = [...finalState.karts]
    .sort((a, b) => getRank(finalState, a.id) - getRank(finalState, b.id))
    .map(kart => kart.id);
  const points: number[] = Array(GP_POINTS.length).fill(0);
  order.forEach((kartId, position) => { points[kartId] = GP_POINTS[position] ?? 0; });
  const result: RaceResult = { trackId: finalState.trackId, order, points };
  return {
    ...gp,
    raceIndex: gp.raceIndex + 1,
    results: [...gp.results, result],
    karts: roster(finalState),
  };
}

export function standings(gp: GrandPrix): StandingRow[] {
  const last = gp.results.at(-1);
  return gp.karts.map(kart => ({
    kartId: kart.id,
    name: kart.name,
    color: kart.color,
    points: gp.results.reduce((total, result) => total + (result.points[kart.id] ?? 0), 0),
    lastPosition: last ? last.order.indexOf(kart.id) + 1 : 0,
    gained: gp.raceIndex === 0 ? 0 : last?.points[kart.id] ?? 0,
  })).sort((a, b) => b.points - a.points || a.lastPosition - b.lastPosition || a.kartId - b.kartId);
}

export function isComplete(gp: GrandPrix): boolean {
  return gp.results.length === 4;
}

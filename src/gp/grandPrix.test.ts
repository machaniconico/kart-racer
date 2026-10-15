import { describe, expect, it } from 'vitest';
import { getAIInput } from '../sim/ai';
import { getRank } from '../sim/laps';
import { createRace, stepRace } from '../sim/race';
import { TRACK_IDS } from '../sim/tracks';
import type { RaceState, TrackId } from '../sim/types';
import { CUPS, GP_POINTS, createGrandPrix, isComplete, nextTrack, recordRace, standings } from './grandPrix';
import type { GrandPrix } from './grandPrix';

const IDS = [0, 1, 2, 3, 4, 5, 6, 7];

function finalRace(trackId: TrackId, order: number[] = IDS): RaceState {
  const state = createRace(42, { trackId, laps: 1 });
  state.phase = 'finished';
  for (const kart of state.karts) {
    kart.lap = 1;
    kart.finishTime = 60 + order.indexOf(kart.id);
  }
  return state;
}

function freezeDeep(value: object): void {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') freezeDeep(child);
  }
  Object.freeze(value);
}

describe('Grand Prix', () => {
  it('defines two four-race cups in TRACK_IDS order and the eight-place points table', () => {
    expect(CUPS).toEqual([
      { id: 'sunrise', name: 'SUNRISE CUP', tracks: ['meadow', 'canyon', 'snowpeak', 'neon'] },
      { id: 'horizon', name: 'HORIZON CUP', tracks: ['harbor', 'forest', 'volcano', 'skyline'] },
    ]);
    for (const cup of CUPS) {
      expect(cup.tracks).toHaveLength(4);
      expect(TRACK_IDS.filter(trackId => cup.tracks.includes(trackId))).toEqual(cup.tracks);
    }
    expect(CUPS.flatMap(cup => cup.tracks)).toEqual(TRACK_IDS);
    expect(GP_POINTS).toEqual([10, 8, 6, 5, 4, 3, 2, 1]);
  });

  it.each(['easy', 'normal', 'hard'] as const)('starts with eight zero-point rows at %s difficulty', cpuLevel => {
    const gp = createGrandPrix('sunrise', 2, cpuLevel);
    expect(gp).toMatchObject({ cupId: 'sunrise', laps: 2, cpuLevel, raceIndex: 0, results: [] });
    expect(isComplete(gp)).toBe(false);
    expect(nextTrack(gp)).toBe('meadow');
    expect(standings(gp)).toEqual(createRace(1).karts.map(kart => ({
      kartId: kart.id, name: kart.name, color: kart.color, points: 0, lastPosition: 0, gained: 0,
    })));
  });

  it('rejects unknown cups and invalid lap counts', () => {
    expect(() => createGrandPrix('missing', 1, 'normal')).toThrow(RangeError);
    for (const laps of [0, 4, 1.5, NaN]) {
      expect(() => createGrandPrix('sunrise', laps, 'normal')).toThrow(RangeError);
    }
  });

  it.each(CUPS)('$id advances through four races, conserves points, and rejects a fifth result', cup => {
    let gp = createGrandPrix(cup.id, 1, 'normal');
    const raceTotal = GP_POINTS.reduce((sum, points) => sum + points, 0);
    for (const [index, trackId] of cup.tracks.entries()) {
      expect(nextTrack(gp)).toBe(trackId);
      expect(isComplete(gp)).toBe(false);
      const order = [...IDS.slice(index), ...IDS.slice(0, index)];
      gp = recordRace(gp, finalRace(trackId, order));
      expect(gp.raceIndex).toBe(index + 1);
      expect(gp.results).toHaveLength(index + 1);
      expect(gp.results[index]).toEqual({
        trackId, order, points: IDS.map(id => GP_POINTS[order.indexOf(id)]),
      });
      expect(standings(gp).reduce((sum, row) => sum + row.points, 0)).toBe(raceTotal * (index + 1));
      expect(standings(gp).reduce((sum, row) => sum + row.gained, 0)).toBe(raceTotal);
      for (const row of standings(gp)) {
        expect(row.lastPosition).toBe(order.indexOf(row.kartId) + 1);
        expect(row.gained).toBe(GP_POINTS[row.lastPosition - 1]);
      }
    }
    expect(standings(gp).reduce((sum, row) => sum + row.points, 0)).toBe(raceTotal * 4);
    expect(isComplete(gp)).toBe(true);
    expect(nextTrack(gp)).toBeNull();
    const snapshot = structuredClone(gp);
    expect(() => recordRace(gp, finalRace(cup.tracks[0]))).toThrow(RangeError);
    expect(gp).toEqual(snapshot);
  });

  it('uses results length, rather than raceIndex, to determine completion', () => {
    const gp = createGrandPrix('sunrise', 1, 'normal');
    expect(isComplete({ ...gp, raceIndex: 4 })).toBe(false);
    const result = recordRace(gp, finalRace('meadow')).results[0];
    expect(isComplete({ ...gp, results: Array(4).fill(result) })).toBe(true);
    expect(isComplete({ ...gp, results: Array(5).fill(result) })).toBe(false);
  });

  it('sorts by total points before the latest race placing', () => {
    let gp = createGrandPrix('sunrise', 1, 'normal');
    gp = recordRace(gp, finalRace('meadow'));
    gp = recordRace(gp, finalRace('canyon'));
    gp = recordRace(gp, finalRace('snowpeak', [1, 0, 2, 3, 4, 5, 6, 7]));
    expect(standings(gp).slice(0, 2)).toMatchObject([
      { kartId: 0, points: 28, lastPosition: 2, gained: 8 },
      { kartId: 1, points: 26, lastPosition: 1, gained: 10 },
    ]);
  });

  it('breaks equal total points by latest race placing before kart ID', () => {
    let gp = createGrandPrix('sunrise', 1, 'normal');
    gp = recordRace(gp, finalRace('meadow'));
    gp = recordRace(gp, finalRace('canyon', [1, 0, 2, 3, 4, 5, 6, 7]));
    expect(standings(gp).slice(0, 2)).toMatchObject([
      { kartId: 1, points: 18, lastPosition: 1, gained: 10 },
      { kartId: 0, points: 18, lastPosition: 2, gained: 8 },
    ]);
  });

  it('breaks ties in both points and lastPosition by kart ID', () => {
    const gp = createGrandPrix('sunrise', 1, 'normal');
    gp.karts.reverse();
    const rows = standings(gp);
    expect(rows.map(row => row.kartId)).toEqual(IDS);
    expect(rows.every(row => row.points === 0 && row.lastPosition === 0 && row.gained === 0)).toBe(true);
    expect(gp.karts.map(kart => kart.id)).toEqual([...IDS].reverse());
  });

  it('updates immutably and snapshots names and colors from the final state', () => {
    const gp = recordRace(createGrandPrix('sunrise', 1, 'hard'), finalRace('meadow'));
    const state = finalRace('canyon', [...IDS].reverse());
    for (const kart of state.karts) {
      kart.name = `CUSTOM ${kart.id}`;
      kart.color = 0x123450 + kart.id;
    }
    state.karts.reverse();
    const previous = structuredClone(gp);
    const finalSnapshot = structuredClone(state);
    freezeDeep(gp);
    freezeDeep(state);
    const updated = recordRace(gp, state);
    expect(gp).toEqual(previous);
    expect(state).toEqual(finalSnapshot);
    expect(updated).not.toBe(gp);
    expect(updated.results).not.toBe(gp.results);
    expect(updated.karts).not.toBe(gp.karts);
    expect(updated.raceIndex).toBe(2);
    expect(updated.results[0]).toEqual(gp.results[0]);
    for (const row of standings(updated)) {
      expect(row.name).toBe(`CUSTOM ${row.kartId}`);
      expect(row.color).toBe(0x123450 + row.kartId);
      expect(updated.karts.find(kart => kart.id === row.kartId)).not.toBe(state.karts.find(kart => kart.id === row.kartId));
    }
    const rows = standings(updated);
    rows[0].name = 'CHANGED';
    rows[0].points = -1;
    expect(standings(updated)[0]).not.toEqual(rows[0]);
  });

  it('keeps finishers ahead of DNFs and ranks DNFs by getRank progress, including ID ties', () => {
    const state = finalRace('meadow');
    for (const kart of state.karts) {
      kart.finishTime = null;
      kart.lap = 0;
      kart.startedLap = true;
      kart.lapProgress = kart.id * 100;
    }
    state.karts[0].finishTime = 80;
    state.karts[3].finishTime = 80;
    state.karts[2].lap = 1;
    state.karts[6].lapProgress = state.karts[7].lapProgress;
    state.karts.reverse();
    const gp = recordRace(createGrandPrix('sunrise', 1, 'normal'), state);
    const expected = [0, 3, 2, 6, 7, 5, 4, 1];
    expect(gp.results[0].order).toEqual(expected);
    expect(expected.map(id => getRank(state, id))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(gp.results[0].points).toEqual(IDS.map(id => GP_POINTS[expected.indexOf(id)]));
  });

  it('matches the GameUI getRank ordering after an actual one-lap meadow race finishes', () => {
    const state = createRace(42, { trackId: 'meadow', laps: 1 });
    for (let tick = 0; tick < 60 * 240 && state.phase !== 'finished'; tick++) {
      stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
    }
    expect(state.phase).toBe('finished');
    expect(state.karts[0].lap).toBe(1);
    expect(state.karts[0].finishTime).not.toBeNull();
    // This is the leaderboard comparator in GameUI.showResults; no DOM is needed.
    const uiOrder = [...state.karts].sort((a, b) => getRank(state, a.id) - getRank(state, b.id));
    const gp: GrandPrix = recordRace(createGrandPrix('sunrise', 1, 'normal'), state);
    expect(gp.results[0].order).toEqual(uiOrder.map(kart => kart.id));
    expect(standings(gp)).toEqual(uiOrder.map((kart, position) => ({
      kartId: kart.id, name: kart.name, color: kart.color,
      points: GP_POINTS[position], lastPosition: position + 1, gained: GP_POINTS[position],
    })));
  });
});

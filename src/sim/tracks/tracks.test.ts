// M2.5-01 layout 2: captured on darwin-arm64 after widening MEADOW and opening its S-bend.
const MEADOW_LENGTH = 651.3870652457298;
const MEADOW_LENGTH_FNV = 1870658347;
const MEADOW_SAMPLES_FNV = 3738102832;
// Re-measured on darwin-arm64 after M4.5-00 (protocol v14 adds RaceState.laps and KartState.lastBand).
// Before M4.5-00: const MEADOW_RACE_JSON = "{\"tick\":0,\"seed\":435756210,\"phase\":\"countdown\",\"countdown\":3,\"racingTicks\":0,\"time\":0,\"karts\":[{\"id\":0,\"name\":\"YOU\",\"color\":16760632,\"human\":true,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-16.407252314117894,\"y\":0.6961194974964738,\"z\":77.35594127399195,\"heading\":0.782293767163611,\"speed\":0,\"steer\":0,\"trackDistance\":629.8870652457298,\"lateralOffset\":2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.00039552769817338267,\"hitCooldown\":0,\"airTime\":0},{\"id\":1,\"name\":\"PIP\",\"color\":16736128,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-19.244446354118946,\"y\":0.6961194974964738,\"z\":80.17557422517238,\"heading\":0.782293767163611,\"speed\":0,\"steer\":0,\"trackDistance\":629.8870652457298,\"lateralOffset\":-2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.0989440093237117,\"hitCooldown\":0,\"airTime\":0},{\"id\":2,\"name\":\"NOVA\",\"color\":5691841,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-13.239861631540375,\"y\":0.6606880653731978,\"z\":80.4137036319051,\"heading\":0.8307987629895911,\"speed\":0,\"steer\":0,\"trackDistance\":634.3870652457298,\"lateralOffset\":2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":3.872981199589887,\"hitCooldown\":0,\"airTime\":0},{\"id\":3,\"name\":\"MOSS\",\"color\":9206783,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-15.937006081832212,\"y\":0.6606880653731978,\"z\":83.36758443760121,\"heading\":0.8307987629895911,\"speed\":0,\"steer\":0,\"trackDistance\":634.3870652457298,\"lateralOffset\":-2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.44999315499256415,\"hitCooldown\":0,\"airTime\":0},{\"id\":4,\"name\":\"ZIPP\",\"color\":5097215,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-9.932446388945161,\"y\":0.6453236778162523,\"z\":83.20056657256076,\"heading\":0.9175411179469832,\"speed\":0,\"steer\":0,\"trackDistance\":638.8870652457298,\"lateralOffset\":2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":3.5090858454991762,\"hitCooldown\":0,\"airTime\":0},{\"id\":5,\"name\":\"ROCO\",\"color\":16745807,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-12.363544844117202,\"y\":0.6453236778162523,\"z\":86.37700487689789,\"heading\":0.9175411179469832,\"speed\":0,\"steer\":0,\"trackDistance\":638.8870652457298,\"lateralOffset\":-2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":1.0905988508139832,\"hitCooldown\":0,\"airTime\":0},{\"id\":6,\"name\":\"LUNE\",\"color\":15747658,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-6.420286086066656,\"y\":0.64920414989886,\"z\":85.57356249749027,\"heading\":1.0466328972315282,\"speed\":0,\"steer\":0,\"trackDistance\":643.3870652457298,\"lateralOffset\":2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.9252013005878403,\"hitCooldown\":0,\"airTime\":0},{\"id\":7,\"name\":\"TAFF\",\"color\":16053488,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-8.422241785841015,\"y\":0.64920414989886,\"z\":89.03653425252107,\"heading\":1.0466328972315282,\"speed\":0,\"steer\":0,\"trackDistance\":643.3870652457298,\"lateralOffset\":-2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.637475637761937,\"hitCooldown\":0,\"airTime\":0}],\"boxes\":[{\"id\":100,\"x\":76.89339401485844,\"y\":4.375789042390751,\"z\":74.77602686368924,\"heading\":2.0956755973311427,\"respawnTime\":0},{\"id\":101,\"x\":74.22248554502359,\"y\":4.375789042390751,\"z\":70.16352776387747,\"heading\":2.0956755973311427,\"respawnTime\":0},{\"id\":102,\"x\":71.55157707518873,\"y\":4.375789042390751,\"z\":65.5510286640657,\"heading\":2.0956755973311427,\"respawnTime\":0},{\"id\":103,\"x\":97.77283362236902,\"y\":1.9206114791333937,\"z\":-69.26041264828078,\"heading\":-3.126732770704232,\"respawnTime\":0},{\"id\":104,\"x\":92.4434220864985,\"y\":1.9206114791333937,\"z\":-69.1812123873582,\"heading\":-3.126732770704232,\"respawnTime\":0},{\"id\":105,\"x\":87.11401055062798,\"y\":1.9206114791333937,\"z\":-69.10201212643562,\"heading\":-3.126732770704232,\"respawnTime\":0},{\"id\":106,\"x\":-28.74806213051165,\"y\":0.37504665095980727,\"z\":-100.30248145906039,\"heading\":-1.1734945973987285,\"respawnTime\":0},{\"id\":107,\"x\":-26.68571640451832,\"y\":0.37504665095980727,\"z\":-95.38764370929925,\"heading\":-1.1734945973987285,\"respawnTime\":0},{\"id\":108,\"x\":-24.623370678524992,\"y\":0.37504665095980727,\"z\":-90.47280595953812,\"heading\":-1.1734945973987285,\"respawnTime\":0},{\"id\":109,\"x\":-97.77022053390193,\"y\":5.81934191821757,\"z\":16.07484845839771,\"heading\":0.43597961145160524,\"respawnTime\":0},{\"id\":110,\"x\":-92.93880584972241,\"y\":5.81934191821757,\"z\":13.823997030716516,\"heading\":0.43597961145160524,\"respawnTime\":0},{\"id\":111,\"x\":-88.1073911655429,\"y\":5.81934191821757,\"z\":11.57314560303532,\"heading\":0.43597961145160524,\"respawnTime\":0}],\"projectiles\":[],\"traps\":[],\"events\":[],\"nextEntityId\":112,\"trackId\":\"meadow\"}";
const MEADOW_RACE_JSON = "{\"laps\":3,\"tick\":0,\"seed\":435756210,\"phase\":\"countdown\",\"countdown\":3,\"racingTicks\":0,\"time\":0,\"karts\":[{\"id\":0,\"name\":\"YOU\",\"color\":16760632,\"human\":true,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-16.407252314117894,\"y\":0.6961194974964738,\"z\":77.35594127399195,\"heading\":0.782293767163611,\"speed\":0,\"steer\":0,\"trackDistance\":629.8870652457298,\"lateralOffset\":2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.00039552769817338267,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":1,\"name\":\"PIP\",\"color\":16736128,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-19.244446354118946,\"y\":0.6961194974964738,\"z\":80.17557422517238,\"heading\":0.782293767163611,\"speed\":0,\"steer\":0,\"trackDistance\":629.8870652457298,\"lateralOffset\":-2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.0989440093237117,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":2,\"name\":\"NOVA\",\"color\":5691841,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-13.239861631540375,\"y\":0.6606880653731978,\"z\":80.4137036319051,\"heading\":0.8307987629895911,\"speed\":0,\"steer\":0,\"trackDistance\":634.3870652457298,\"lateralOffset\":2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":3.872981199589887,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":3,\"name\":\"MOSS\",\"color\":9206783,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-15.937006081832212,\"y\":0.6606880653731978,\"z\":83.36758443760121,\"heading\":0.8307987629895911,\"speed\":0,\"steer\":0,\"trackDistance\":634.3870652457298,\"lateralOffset\":-2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.44999315499256415,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":4,\"name\":\"ZIPP\",\"color\":5097215,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-9.932446388945161,\"y\":0.6453236778162523,\"z\":83.20056657256076,\"heading\":0.9175411179469832,\"speed\":0,\"steer\":0,\"trackDistance\":638.8870652457298,\"lateralOffset\":2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":3.5090858454991762,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":5,\"name\":\"ROCO\",\"color\":16745807,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-12.363544844117202,\"y\":0.6453236778162523,\"z\":86.37700487689789,\"heading\":0.9175411179469832,\"speed\":0,\"steer\":0,\"trackDistance\":638.8870652457298,\"lateralOffset\":-2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":1.0905988508139832,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":6,\"name\":\"LUNE\",\"color\":15747658,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-6.420286086066656,\"y\":0.64920414989886,\"z\":85.57356249749027,\"heading\":1.0466328972315282,\"speed\":0,\"steer\":0,\"trackDistance\":643.3870652457298,\"lateralOffset\":2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.9252013005878403,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":7,\"name\":\"TAFF\",\"color\":16053488,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-8.422241785841015,\"y\":0.64920414989886,\"z\":89.03653425252107,\"heading\":1.0466328972315282,\"speed\":0,\"steer\":0,\"trackDistance\":643.3870652457298,\"lateralOffset\":-2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.637475637761937,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1}],\"boxes\":[{\"id\":100,\"x\":76.89339401485844,\"y\":4.375789042390751,\"z\":74.77602686368924,\"heading\":2.0956755973311427,\"respawnTime\":0},{\"id\":101,\"x\":74.22248554502359,\"y\":4.375789042390751,\"z\":70.16352776387747,\"heading\":2.0956755973311427,\"respawnTime\":0},{\"id\":102,\"x\":71.55157707518873,\"y\":4.375789042390751,\"z\":65.5510286640657,\"heading\":2.0956755973311427,\"respawnTime\":0},{\"id\":103,\"x\":97.77283362236902,\"y\":1.9206114791333937,\"z\":-69.26041264828078,\"heading\":-3.126732770704232,\"respawnTime\":0},{\"id\":104,\"x\":92.4434220864985,\"y\":1.9206114791333937,\"z\":-69.1812123873582,\"heading\":-3.126732770704232,\"respawnTime\":0},{\"id\":105,\"x\":87.11401055062798,\"y\":1.9206114791333937,\"z\":-69.10201212643562,\"heading\":-3.126732770704232,\"respawnTime\":0},{\"id\":106,\"x\":-28.74806213051165,\"y\":0.37504665095980727,\"z\":-100.30248145906039,\"heading\":-1.1734945973987285,\"respawnTime\":0},{\"id\":107,\"x\":-26.68571640451832,\"y\":0.37504665095980727,\"z\":-95.38764370929925,\"heading\":-1.1734945973987285,\"respawnTime\":0},{\"id\":108,\"x\":-24.623370678524992,\"y\":0.37504665095980727,\"z\":-90.47280595953812,\"heading\":-1.1734945973987285,\"respawnTime\":0},{\"id\":109,\"x\":-97.77022053390193,\"y\":5.81934191821757,\"z\":16.07484845839771,\"heading\":0.43597961145160524,\"respawnTime\":0},{\"id\":110,\"x\":-92.93880584972241,\"y\":5.81934191821757,\"z\":13.823997030716516,\"heading\":0.43597961145160524,\"respawnTime\":0},{\"id\":111,\"x\":-88.1073911655429,\"y\":5.81934191821757,\"z\":11.57314560303532,\"heading\":0.43597961145160524,\"respawnTime\":0}],\"projectiles\":[],\"traps\":[],\"events\":[],\"nextEntityId\":112,\"trackId\":\"meadow\"}";

import { describe, expect, it } from 'vitest';
import { getAIInput } from '../ai';
import { validateTrackDef, widthAt } from '../corridor';
import { DEFAULT_LAPS } from '../laps';
import { createRace, stepRace } from '../race';
import { buildTrack, projectToTrack, sampleTrack, slopeAt, wrapDistance } from '../track';
import type { RaceState, TrackDef, TrackId } from '../types';
import { COURSE_FINGERPRINT, getTrack, TRACK_IDS, TRACKS } from './index';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';

function fnv1a32(value: unknown): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return hash >>> 0;
}

function expectFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(expectFrozen);
}

describe('course registry and MEADOW golden baseline', () => {
  it('pins the layout 2 length and every sample bit', () => {
    const track = getTrack('meadow');
    expect(track.length).toBe(MEADOW_LENGTH);
    expect(fnv1a32(track.length)).toBe(MEADOW_LENGTH_FNV);
    expect(fnv1a32(track.samples)).toBe(MEADOW_SAMPLES_FNV);
  });

  it('pins the layout 2 initial race JSON and default course', () => {
    const state = createRace(1, { trackId: 'meadow' });
    expect(JSON.stringify(state)).toBe(MEADOW_RACE_JSON);
    expect(JSON.stringify(createRace(1))).toBe(JSON.stringify(state));
    expect(JSON.stringify(JSON.parse(MEADOW_RACE_JSON))).toBe(MEADOW_RACE_JSON);
  });

  it('fixes registry order and course identities', () => {
    expect(TRACK_IDS).toEqual(['meadow', 'canyon', 'snowpeak', 'neon']);
    expect(TRACK_IDS.map(id => TRACKS[id].name)).toEqual([
      'MEADOW LOOP', 'SUNSCAR CANYON', 'FROSTBITE PEAK', 'NEON NIGHTLINE',
    ]);
    for (const id of TRACK_IDS) {
      expect(getTrack(id).def.id).toBe(id);
      expect(getTrack(id).def.themeId).toBe(id);
      expect(getTrack(id).def).toBe(TRACKS[id]);
      expect(getTrack(id)).toBe(getTrack(id));
    }
    expect(new Set(TRACK_IDS.map(getTrack)).size).toBe(4);
    expect(COURSE_FINGERPRINT).toBe(fnv1a32(TRACK_IDS.map(id => TRACKS[id])));
    expectFrozen(TRACK_IDS);
    expectFrozen(TRACKS);
  });

  it.each(['', 'MEADOW', 'unknown', '__proto__', 'constructor'])('rejects unknown ID %j', id => {
    expect(() => getTrack(id)).toThrow(RangeError);
    expect(() => createRace(1, { trackId: id as TrackId })).toThrow(RangeError);
  });

  it('rejects non-string course IDs received from JSON', () => {
    for (const trackId of [null, 1, {}]) {
      const options = JSON.parse(JSON.stringify({ trackId }));
      expect(() => createRace(1, options)).toThrow(RangeError);
    }
  });

  it('enforces the twelve-box layout at build time', () => {
    const def = TRACKS.meadow;
    expect(() => buildTrack({ ...def, boxRows: def.boxRows.slice(1) })).toThrow(RangeError);
    expect(() => buildTrack({ ...def, boxLanes: [...def.boxLanes, 6] })).toThrow(RangeError);
  });

  it('owns immutable data independent of mutable source definitions and race state', () => {
    const source = JSON.parse(JSON.stringify(TRACKS.meadow));
    const track = buildTrack(source);
    const serialized = JSON.stringify(track);
    source.controlPoints[0][0] = 1000;
    source.boxRows[0] = 0.9;
    expect(JSON.stringify(track)).toBe(serialized);
    expectFrozen(track);
    const state = createRace(1);
    state.boxes[0]!.x += 123;
    expect(createRace(1).boxes[0]!.x).toBe(getTrack('meadow').boxPoses[0]!.x);
  });

  it('supports a closed centripetal course without changing the default uniform sampler', () => {
    const def: TrackDef = { ...TRACKS.meadow, spline: 'centripetal' };
    const track = buildTrack(def);
    expect(track.samples.every(sample => Object.values(sample).every(Number.isFinite))).toBe(true);
    expect(sampleTrack(track, track.length)).toEqual(sampleTrack(track, 0));
    expect(track.samples).not.toEqual(getTrack('meadow').samples);
    expect(buildTrack(JSON.parse(JSON.stringify(def)))).toEqual(track);
  });
});

describe.each(TRACK_IDS)('%s course contract', id => {
  const track = getTrack(id);

  it('validates the width profile, passages, grid, boxes and racing line', () => {
    expect(() => validateTrackDef(track.def)).not.toThrow();
  });

  it('keeps every grade within 30%, including the seam', () => {
    for (const sample of track.samples) {
      expect(Math.abs(slopeAt(track, sample.distance)), `distance ${sample.distance}`).toBeLessThanOrEqual(0.30);
    }
  });

  it('keeps curvature radius at least wall half-width plus 2.5m, including the seam', () => {
    const points = track.samples;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length]!;
      const b = points[i]!;
      const c = points[(i + 1) % points.length]!;
      const twiceArea = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      const radius = Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) *
        Math.hypot(c.x - a.x, c.z - a.z) / (2 * twiceArea);
      expect(radius, `distance ${b.distance}`).toBeGreaterThanOrEqual(widthAt(track, b.distance).wallHalfWidth + 2.5);
    }
  });

  it('projects continuously every 0.5m at every integer offset within the local wall width', () => {
    let largestDelta = 0;
    const maxOffset = Math.floor(Math.max(track.def.wallHalfWidth,
      ...(track.def.widthKeys ?? []).map(key => key.wallHalfWidth)));
    for (let offset = -maxOffset; offset <= maxOffset; offset++) {
      let previous = 0;
      for (let distance = 0; distance <= track.length + 1; distance += 0.5) {
        if (Math.abs(offset) > Math.floor(widthAt(track, distance).wallHalfWidth)) {
          previous = distance;
          continue;
        }
        const sample = sampleTrack(track, distance);
        const projection = projectToTrack(track, sample.x + sample.nx * offset,
          sample.z + sample.nz * offset, previous);
        const delta = wrapDistance(track, projection.distance - previous + track.length / 2) - track.length / 2;
        largestDelta = Math.max(largestDelta, Math.abs(delta));
        previous = projection.distance;
      }
    }
    expect(largestDelta).toBeLessThan(2);
  });

  it('closes exactly, with unit orthogonal tangents/normals and grade at most 0.30', () => {
    expect(sampleTrack(track, track.length)).toEqual(sampleTrack(track, 0));
    expect(wrapDistance(track, -1)).toBeCloseTo(track.length - 1, 10);
    let largestGrade = 0;
    for (let i = 0; i < track.samples.length; i++) {
      const point = track.samples[i]!;
      const next = track.samples[(i + 1) % track.samples.length]!;
      const ds = i === track.samples.length - 1 ? track.length - point.distance : next.distance - point.distance;
      largestGrade = Math.max(largestGrade, Math.abs((next.y - point.y) / ds));
    }
    for (let distance = 0; distance < track.length; distance += 0.5) {
      const point = sampleTrack(track, distance);
      expect(point.tx * point.nx + point.tz * point.nz).toBeCloseTo(0, 14);
      expect(Math.hypot(point.tx, point.tz)).toBeCloseTo(1, 14);
      expect(Math.hypot(point.nx, point.nz)).toBeCloseTo(1, 14);
    }
    expect(largestGrade).toBeLessThanOrEqual(0.30);
  });

  it('builds twelve boxes, every checkpoint, and the declared course widths', () => {
    const state = createRace(1, { trackId: id });
    expect(state.trackId).toBe(id);
    expect(state.boxes).toHaveLength(12);
    expect(track.boxPoses).toHaveLength(12);
    expect(track.checkpointDistances).toHaveLength(track.def.checkpointCount);
    expect(track.checkpointDistances).toEqual(Array.from({ length: track.def.checkpointCount },
      (_, i) => i * track.length / track.def.checkpointCount));
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    expect(buildTrack(JSON.parse(JSON.stringify(track.def)))).toEqual(track);
  });

  it.each([1, 42, 98765])('finishes eight CPUs over three laps and matches JSON replay every tick (seed %i)', seed => {
    const state = createRace(seed, { trackId: id, racers: [] });
    expect(createRace(seed, { trackId: id, racers: [] })).toEqual(state);
    const hasJump = getTrack(id).def.surfaces.some(zone => zone.kind === 'jump');
    let restored: RaceState = JSON.parse(JSON.stringify(state));
    for (let tick = 0; tick < 60 * 180 && state.phase !== 'finished'; tick++) {
      stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
      stepRace(restored, restored.karts.map(kart => getAIInput(restored, kart.id)));
      expect(JSON.stringify(restored)).toBe(JSON.stringify(state));
      if (!hasJump) expect(state.karts.every(kart => kart.airTime === 0)).toBe(true);
      // Exercise restoring an active race as well as the initial grid.
      if (tick === 1000) restored = JSON.parse(JSON.stringify(restored));
    }
    expect(state.phase).toBe('finished');
    expect(state.karts).toHaveLength(8);
    for (const kart of state.karts) {
      expect(kart.human).toBe(false);
      expect(kart.lap).toBe(DEFAULT_LAPS);
      expect(kart.lapTimes).toHaveLength(3);
      expect(kart.finishTime).not.toBeNull();
      expect(kart.airTime).toBe(0);
    }
  }, 30_000);
});

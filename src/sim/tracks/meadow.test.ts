import { describe, expect, it } from 'vitest';
import { getAIInput } from '../ai';
import { corridorAt, validateCoursePlayability, validateTrackDef, widthAt } from '../corridor';
import { createRace, KART_RADIUS, stepRace } from '../race';
import { racingLineOffset } from '../surfaces';
import { rollAt, slopeAt } from '../track';
import { curvatureProfile, elevationRange, findCompoundCorners, findHairpins, findSCurves, maxSlope, minCurvatureRadius } from './shapeMetrics';
import { BASE_ROAD_HALF_WIDTH, BASE_WALL_HALF_WIDTH } from './widths';
import { getTrack } from './index';

// M5-01 layout 3: measured on darwin-arm64 with the external measure-meadow.ts scratchpad.
const MEADOW_LENGTH = 2286.353556318704;
const MEADOW_LENGTH_FNV = 856254705;
const MEADOW_SAMPLES_FNV = 2486413260;
// Initial race includes the new grid and eight item rows (24 box poses).
const MEADOW_RACE_JSON = "{\"laps\":3,\"tick\":0,\"seed\":435756210,\"phase\":\"countdown\",\"countdown\":3,\"racingTicks\":0,\"time\":0,\"karts\":[{\"id\":0,\"name\":\"YOU\",\"color\":16760632,\"human\":true,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-21.627648937470674,\"y\":1,\"z\":-1.5199344088656441,\"heading\":1.6421928875837943,\"speed\":0,\"steer\":0,\"trackDistance\":2264.853556318704,\"lateralOffset\":2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.00039552769817338267,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":1,\"name\":\"PIP\",\"color\":16736128,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-21.342305260314966,\"y\":1,\"z\":2.4698749833117897,\"heading\":1.6421928875837943,\"speed\":0,\"steer\":0,\"trackDistance\":2264.853556318704,\"lateralOffset\":-2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.0989440093237117,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":2,\"name\":\"NOVA\",\"color\":5691841,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-17.122580249588,\"y\":1,\"z\":-1.839951983366779,\"heading\":1.6339734031513242,\"speed\":0,\"steer\":0,\"trackDistance\":2269.353556318704,\"lateralOffset\":2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":3.872981199589887,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":3,\"name\":\"MOSS\",\"color\":9206783,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-16.870040018203408,\"y\":1,\"z\":2.1520679854625615,\"heading\":1.6339734031513242,\"speed\":0,\"steer\":0,\"trackDistance\":2269.353556318704,\"lateralOffset\":-2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.44999315499256415,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":4,\"name\":\"ZIPP\",\"color\":5097215,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-12.50125343700973,\"y\":1,\"z\":-1.9999996072238773,\"heading\":1.5714230453407882,\"speed\":0,\"steer\":0,\"trackDistance\":2273.853556318704,\"lateralOffset\":2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":3.5090858454991762,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":5,\"name\":\"ROCO\",\"color\":16745807,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-12.49874656299027,\"y\":1,\"z\":1.9999996072238773,\"heading\":1.5714230453407882,\"speed\":0,\"steer\":0,\"trackDistance\":2273.853556318704,\"lateralOffset\":-2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":1.0905988508139832,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":6,\"name\":\"LUNE\",\"color\":15747658,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-8,\"y\":1,\"z\":-2,\"heading\":1.5707963267948966,\"speed\":0,\"steer\":0,\"trackDistance\":2278.353556318704,\"lateralOffset\":2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.9252013005878403,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1},{\"id\":7,\"name\":\"TAFF\",\"color\":16053488,\"human\":false,\"effects\":{\"rouletteTime\":0,\"rapidTime\":0,\"rapidUnused\":1,\"auraTime\":0,\"shrinkTime\":0,\"inkTime\":0,\"autoTime\":0,\"charges\":0,\"holding\":0,\"aiHoldTicks\":0,\"orbitKind\":0,\"orbitCount\":0},\"x\":-8,\"y\":1,\"z\":2,\"heading\":1.5707963267948966,\"speed\":0,\"steer\":0,\"trackDistance\":2278.353556318704,\"lateralOffset\":-2,\"lap\":0,\"nextCheckpoint\":0,\"lapStartTime\":0,\"lapTimes\":[],\"finishTime\":null,\"driftTime\":0,\"driftDirection\":0,\"boostTime\":0,\"spinTime\":0,\"hopTime\":0,\"item\":null,\"wrongWay\":false,\"startedLap\":false,\"lapProgress\":0,\"lapValid\":true,\"previousDrift\":false,\"previousItem\":false,\"aiPhase\":0.637475637761937,\"hitCooldown\":0,\"airTime\":0,\"lastBand\":-1}],\"boxes\":[{\"id\":100,\"x\":45.727071126374085,\"y\":1,\"z\":5.33,\"heading\":1.5707963267948966,\"respawnTime\":0},{\"id\":101,\"x\":45.727071126374085,\"y\":1,\"z\":0,\"heading\":1.5707963267948966,\"respawnTime\":0},{\"id\":102,\"x\":45.727071126374085,\"y\":1,\"z\":-5.33,\"heading\":1.5707963267948966,\"respawnTime\":0},{\"id\":103,\"x\":251.57337232407284,\"y\":1,\"z\":28.631210947894726,\"heading\":-0.10921738216875998,\"respawnTime\":0},{\"id\":104,\"x\":256.8716146277621,\"y\":1,\"z\":29.212182970799013,\"heading\":-0.10921738216875998,\"respawnTime\":0},{\"id\":105,\"x\":262.16985693145136,\"y\":1,\"z\":29.7931549937033,\"heading\":-0.10921738216875998,\"respawnTime\":0},{\"id\":106,\"x\":1.098334636058207,\"y\":0.9631389062505836,\"z\":86.11725597254832,\"heading\":-0.7625465828372847,\"respawnTime\":0},{\"id\":107,\"x\":4.952347128095765,\"y\":0.9631389062505836,\"z\":89.79903376475937,\"heading\":-0.7625465828372847,\"respawnTime\":0},{\"id\":108,\"x\":8.806359620133323,\"y\":0.9631389062505836,\"z\":93.48081155697042,\"heading\":-0.7625465828372847,\"respawnTime\":0},{\"id\":109,\"x\":-159.16449304004186,\"y\":9.089146744084996,\"z\":248.85355206894752,\"heading\":-1.6907536621501522,\"respawnTime\":0},{\"id\":110,\"x\":-159.80233333708924,\"y\":9.089146744084996,\"z\":254.14524931609446,\"heading\":-1.6907536621501522,\"respawnTime\":0},{\"id\":111,\"x\":-160.4401736341366,\"y\":9.089146744084996,\"z\":259.4369465632414,\"heading\":-1.6907536621501522,\"respawnTime\":0},{\"id\":112,\"x\":-293.2370378140654,\"y\":1.5916731015593477,\"z\":66.76916748977018,\"heading\":-3.0677693366725274,\"respawnTime\":0},{\"id\":113,\"x\":-298.5525204731605,\"y\":1.5916731015593477,\"z\":67.16228846461001,\"heading\":-3.0677693366725274,\"respawnTime\":0},{\"id\":114,\"x\":-303.8680031322556,\"y\":1.5916731015593477,\"z\":67.55540943944985,\"heading\":-3.0677693366725274,\"respawnTime\":0},{\"id\":115,\"x\":-248.9098005580753,\"y\":1,\"z\":-171.84299021525388,\"heading\":2.567377412619909,\"respawnTime\":0},{\"id\":116,\"x\":-253.38496888590623,\"y\":1,\"z\":-174.73811861267924,\"heading\":2.567377412619909,\"respawnTime\":0},{\"id\":117,\"x\":-257.8601372137372,\"y\":1,\"z\":-177.6332470101046,\"heading\":2.567377412619909,\"respawnTime\":0},{\"id\":118,\"x\":-19.359326160664587,\"y\":1,\"z\":-212.03985129479565,\"heading\":1.9689136174519044,\"respawnTime\":0},{\"id\":119,\"x\":-21.425679551611122,\"y\":1,\"z\":-216.95300544093476,\"heading\":1.9689136174519044,\"respawnTime\":0},{\"id\":120,\"x\":-23.492032942557657,\"y\":1,\"z\":-221.86615958707387,\"heading\":1.9689136174519044,\"respawnTime\":0},{\"id\":121,\"x\":192.07942208802876,\"y\":1,\"z\":-121.80468098227676,\"heading\":-0.06750712854028702,\"respawnTime\":0},{\"id\":122,\"x\":197.3972817285399,\"y\":1,\"z\":-121.445141215599,\"heading\":-0.06750712854028702,\"respawnTime\":0},{\"id\":123,\"x\":202.71514136905103,\"y\":1,\"z\":-121.08560144892122,\"heading\":-0.06750712854028702,\"respawnTime\":0}],\"projectiles\":[],\"traps\":[],\"events\":[],\"nextEntityId\":124,\"trackId\":\"meadow\"}";

function fnv1a32(value: unknown): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return hash >>> 0;
}

describe('MEADOW course', () => {
  it('pins its layout version', () => {
    expect(getTrack('meadow').def.layoutVersion).toBe(3);
  });

  it('pins the layout 3 length and every sample bit', () => {
    const track = getTrack('meadow');
    expect(track.length).toBe(MEADOW_LENGTH);
    expect(fnv1a32(track.length)).toBe(MEADOW_LENGTH_FNV);
    expect(fnv1a32(track.samples)).toBe(MEADOW_SAMPLES_FNV);
  });

  it('pins the layout 3 initial race JSON and default course', () => {
    const state = createRace(1, { trackId: 'meadow' });
    expect(state.cpuLevel).toBe('normal');
    // M7-00: compared without the added cpuLevel key so the pre-v17 golden stays byte-identical.
    expect(JSON.stringify({ ...state, cpuLevel: undefined })).toBe(MEADOW_RACE_JSON);
    expect(JSON.stringify(createRace(1))).toBe(JSON.stringify(state));
    expect(JSON.stringify(JSON.parse(MEADOW_RACE_JSON))).toBe(MEADOW_RACE_JSON);
  });

  it('keeps the course length between 2100 and 2400 m', () => {
    const track = getTrack('meadow');
    expect(track.length).toBeGreaterThanOrEqual(2100);
    expect(track.length).toBeLessThanOrEqual(2400);
  });

  it('validates the beginner layout, gates, item rows and prohibited features', () => {
    const track = getTrack('meadow');
    expect(() => validateTrackDef(track.def)).not.toThrow();
    expect(() => validateCoursePlayability(track.def)).not.toThrow();
    expect(track.def.checkpointCount).toBe(24);
    expect(track.checkpointDistances).toHaveLength(24);
    expect(track.def.boxRows).toHaveLength(8);
    expect(track.boxPoses).toHaveLength(24);
    expect(track.def.roadHalfWidth).toBe(BASE_ROAD_HALF_WIDTH);
    expect(track.def.wallHalfWidth).toBe(BASE_WALL_HALF_WIDTH);
    expect(track.def.splits ?? []).toEqual([]);
    expect(track.def.decks ?? []).toEqual([]);
    expect(track.def.barriers ?? []).toEqual([]);
    expect(track.def.surfaces.map(zone => zone.kind).sort()).toEqual(['dirt', 'dirt', 'jump']);
  });

  it('measures a hairpin, four alternating bends and compound corners with safe curvature', () => {
    const track = getTrack('meadow');
    expect(findHairpins(track).length).toBeGreaterThanOrEqual(1);
    const curves = findSCurves(track);
    expect(curves.length).toBeGreaterThanOrEqual(1);
    expect(curves.some(curve => curve.reversals >= 3)).toBe(true);
    expect(findCompoundCorners(track).length).toBeGreaterThanOrEqual(1);
    expect(minCurvatureRadius(track)).toBeGreaterThanOrEqual(17);
    expect(minCurvatureRadius(track) - (BASE_WALL_HALF_WIDTH + 2.5)).toBeGreaterThanOrEqual(0.8);
    expect(maxSlope(track)).toBeGreaterThanOrEqual(0.08);
    expect(maxSlope(track)).toBeLessThanOrEqual(0.12);
    expect(elevationRange(track).range).toBeGreaterThanOrEqual(6);
  });

  it('keeps one narrow passage, one bank and an uphill-to-level jump on the main route', () => {
    const track = getTrack('meadow');
    expect(track.def.widthKeys).toEqual([
      { distance: 1145, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
      { distance: 1165, roadHalfWidth: 5.15, wallHalfWidth: 7.5 },
      { distance: 1195, roadHalfWidth: 5.15, wallHalfWidth: 7.5 },
      { distance: 1215, roadHalfWidth: BASE_ROAD_HALF_WIDTH, wallHalfWidth: BASE_WALL_HALF_WIDTH },
    ]);
    expect(widthAt(track, 1170)).toEqual({ roadHalfWidth: 5.15, wallHalfWidth: 7.5 });
    for (let d = 1145; d <= 1215; d += 0.5) {
      const passages = corridorAt(track, d, 0);
      expect(passages).toHaveLength(1);
      expect(passages[0]!.max - passages[0]!.min).toBeGreaterThanOrEqual(2.55);
    }
    expect(track.def.bankKeys).toHaveLength(4);
    expect(track.def.bankKeys!.map(key => key.roll)).toEqual([0, 0.18, 0.18, 0]);
    expect(rollAt(track, 850)).toBeGreaterThanOrEqual(0.15);
    expect(rollAt(track, 850)).toBeLessThanOrEqual(0.25);
    const jump = track.def.surfaces.find(zone => zone.kind === 'jump')!;
    expect(jump.offsetMin).toBeUndefined();
    expect(jump.offsetMax).toBeUndefined();
    expect(slopeAt(track, jump.from - 40)).toBeGreaterThan(0.01);
    expect(Math.abs(slopeAt(track, jump.to))).toBeLessThan(0.02);
    for (let d = jump.to; d <= jump.to + 40; d += 0.5) {
      expect(slopeAt(track, d)).toBeGreaterThanOrEqual(slopeAt(track, jump.to) - 0.05);
    }
  });

  it('covers the whole lap with a strictly ordered line and outside-inside-outside hairpin', () => {
    const track = getTrack('meadow');
    const line = track.def.racingLine;
    expect(line[0]).toEqual({ distance: 0, offset: 0 });
    expect(line.at(-1)).toEqual({ distance: track.length, offset: line[0]!.offset });
    for (let i = 1; i < line.length; i++) expect(line[i]!.distance).toBeGreaterThan(line[i - 1]!.distance);
    const profile = curvatureProfile(track);
    for (const hairpin of findHairpins(track)) {
      const sign = Math.sign(profile.find(point => point.distance === hairpin.at)!.curvature);
      expect(sign * racingLineOffset(track, hairpin.from)).toBeGreaterThan(0);
      expect(sign * racingLineOffset(track, (hairpin.from + hairpin.to) / 2)).toBeLessThan(0);
      expect(sign * racingLineOffset(track, hairpin.to)).toBeGreaterThan(0);
    }
  });

  // M5-01 / darwin-arm64: 8 CPUs × seeds [1, 42, 98765] × 3 laps = 72 laps.
  // Scratchpad measurement: meanLap 68.50115740740742 s, wallHits 0, bandHits 0.
  // Geometry: 2286.353556318704 m, min radius 18.115594961681918 m,
  // max slope 0.1051888209920538, elevation range 8.643142700195312 m.
  it('finishes all 72 CPU laps within the pace and collision budgets', () => {
    const track = getTrack('meadow');
    const lapTimes: number[] = [];
    let wallHits = 0;
    let bandHits = 0;
    for (const seed of [1, 42, 98765]) {
      const state = createRace(seed, { trackId: 'meadow', racers: [] });
      for (let tick = 0; tick < 60 * 420 && state.phase !== 'finished'; tick++) {
        stepRace(state, state.karts.map(kart => getAIInput(state, kart.id)));
        for (const event of state.events) {
          if (event.type !== 'hit') continue;
          if (event.value === 1) { bandHits++; continue; }
          if (event.value === 2) continue;
          const kart = state.karts[event.kartId]!;
          if (Math.abs(kart.lateralOffset) >= widthAt(track, kart.trackDistance).wallHalfWidth - KART_RADIUS - 0.01) wallHits++;
        }
      }
      expect(state.phase).toBe('finished');
      expect(state.karts).toHaveLength(8);
      for (const kart of state.karts) {
        expect(kart.human).toBe(false);
        expect(kart.lapTimes).toHaveLength(3);
        expect(kart.finishTime).not.toBeNull();
        lapTimes.push(...kart.lapTimes);
      }
    }
    expect(lapTimes).toHaveLength(72);
    const meanLap = lapTimes.reduce((sum, time) => sum + time, 0) / lapTimes.length;
    expect(meanLap).toBeGreaterThanOrEqual(60);
    expect(meanLap).toBeGreaterThanOrEqual(track.length / 40);
    expect(meanLap).toBeLessThanOrEqual(track.length / 20);
    expect(wallHits).toBeLessThanOrEqual(6);
    expect(bandHits).toBe(0);
  }, 120_000);
});

import { existsSync } from 'node:fs';
import { test, expect, type TestInfo } from '@playwright/test';
import type { KartDebug } from '../src/main';
import { getTrack } from '../src/sim/tracks';

declare const window: Window & { __kartDebug: KartDebug };

// Seed 127, 1280x720, DPR 1, ten stationary frames including shadows and item boxes.
// RENDER_BASELINE excludes the M12-06 box addition: 128 / 83_516 + 1 / 6_048.
const AQUEDUCT_RENDER = { drawCalls: 129, triangles: 89_564 };

// Match the existing course golden gate. CI pinning belongs to the publish flow;
// missing platforms remain annotated until their images have been captured.
function goldenPresent(testInfo: TestInfo, name: string): boolean {
  if (process.env.KART_GOLDENS === 'write') return true;
  const platform = process.env.KART_GOLDEN_PLATFORM ?? process.platform;
  const path = testInfo.snapshotPath(name).replace(`/__screenshots__/${process.platform}/`, `/__screenshots__/${platform}/`);
  if (existsSync(path)) return true;
  const description = `${platform}: ${name} (capture with goldens-linux.yml)`;
  testInfo.annotations.push({ type: 'golden-skipped', description });
  console.warn(`golden-skipped ${description}`);
  return false;
}

test('M12-34: AQUEDUCT completes three laps through lower, upper, crossing and lower return', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.waitForFunction(() => !!window.__kartDebug);
  await page.locator('#course-select input[value="aqueduct"]').check();
  await expect(page.locator('#course-name')).toHaveText('AQUEDUCT');
  await page.locator('#start-race').click();
  await page.locator('#pause-race').click();
  const grid = await page.evaluate(() => {
    const debug = window.__kartDebug;
    const { createRace, captureRenderSnapshot } = debug.modules;
    const renderer = debug.renderer!;
    const state = createRace(127, { trackId: 'aqueduct' });
    state.tick = 4; // Refresh the minimap at the same stationary tick as the other course specs.
    Object.assign(debug.state, state);
    debug.advance(0);
    const minimap = (document.querySelector('#minimap-canvas') as HTMLCanvasElement).toDataURL('image/png').split(',')[1]!;
    (renderer as unknown as { elapsed: number }).elapsed = 0;
    const snapshot = captureRenderSnapshot(state);
    renderer.update(state, snapshot, 1, 0, 'title');
    const samples = [];
    for (let frame = 0; frame < 10; frame++) {
      renderer.update(state, snapshot, 1, 0, 'race');
      const { calls: drawCalls, triangles } = renderer.renderer.info.render;
      samples.push({ drawCalls, triangles });
    }
    const png = renderer.renderer.domElement.toDataURL('image/png').split(',')[1]!;
    // The route gate isolates driving from pickups, without changing kart performance.
    Object.assign(debug.state, createRace(127, { trackId: 'aqueduct', itemBoxes: false }));
    debug.advance(0);
    return { samples, png, minimap };
  });
  await testInfo.attach('aqueduct-start-grid', { body: Buffer.from(grid.png, 'base64'), contentType: 'image/png' });
  await testInfo.attach('aqueduct-minimap', { body: Buffer.from(grid.minimap, 'base64'), contentType: 'image/png' });
  for (const [name, png] of [['aqueduct-start-grid.png', grid.png], ['aqueduct-minimap.png', grid.minimap]]) {
    if (goldenPresent(testInfo, name)) {
      expect(Buffer.from(png, 'base64')).toMatchSnapshot(name, { threshold: 0.2, maxDiffPixels: 0 });
    }
  }
  await testInfo.attach('aqueduct-render-baseline', { body: JSON.stringify(grid.samples), contentType: 'application/json' });
  for (const sample of grid.samples) expect(sample).toEqual(AQUEDUCT_RENDER);
  await page.locator('#resume-race').click();
  await expect.poll(() => page.evaluate(() => window.__kartDebug.state.phase), { timeout: 30_000 }).toBe('racing');
  const route = await page.evaluate(() => {
    const debug = window.__kartDebug;
    const { getTrack, captureRenderSnapshot } = debug.modules;
    const track = getTrack('aqueduct');
    const deck = track.def.decks![0]!;
    const upper = track.samples.filter(point => point.distance >= deck.from && point.distance <= deck.to)
      .reduce((best, point) => Math.abs(point.z) < Math.abs(best.z) ? point : best);
    const lower = track.samples.filter(point => point.y < upper.y - 10)
      .reduce((best, point) => Math.hypot(point.x - upper.x, point.z - upper.z)
        < Math.hypot(best.x - upper.x, best.z - upper.z) ? point : best);
    const gates = [
      { name: 'lower', distance: lower.distance },
      { name: 'upper', distance: deck.from + 35 },
      { name: 'crossing', distance: upper.distance },
      { name: 'lower-return', distance: track.length * 0.85 },
    ];
    const visits: { name: string; tick: number; distance: number; x: number; y: number; z: number; png: string }[] = [];
    let launched = false;
    let landed = false;
    let falls = 0;
    let maxStep = 0;
    for (let tick = 0; tick < 60 * 420 && debug.state.phase !== 'finished'; tick++) {
      const before = debug.state.karts[0].trackDistance;
      debug.advance(1, true);
      const kart = debug.state.karts[0];
      falls += debug.state.events.filter(event => event.type === 'fall' && event.kartId === 0).length;
      if (visits.length === gates.length) continue;
      const step = Math.abs(kart.trackDistance - before);
      maxStep = Math.max(maxStep, Math.min(step, track.length - step));
      if (!kart.startedLap) continue;
      if (launched && kart.airTime === 0) landed = true;
      launched ||= kart.airTime > 0;
      const gate = gates[visits.length]!;
      if (kart.trackDistance < gate.distance) continue;
      const renderer = debug.renderer!;
      const snapshot = captureRenderSnapshot(debug.state);
      renderer.update(debug.state, snapshot, 1, 0, 'title');
      renderer.update(debug.state, snapshot, 1, 0, 'race');
      visits.push({ name: gate.name, tick: debug.state.tick, distance: kart.trackDistance,
        x: kart.x, y: kart.y, z: kart.z,
        png: renderer.renderer.domElement.toDataURL('image/png').split(',')[1]! });
    }
    return { visits, launched, landed, falls, maxStep, splits: track.def.splits ?? [],
      crossingGap: upper.y - lower.y, phase: debug.state.phase,
      lapTimes: debug.state.karts[0].lapTimes, finishTime: debug.state.karts[0].finishTime };
  });
  for (const visit of route.visits) {
    await testInfo.attach(`aqueduct-${visit.name}`, { body: Buffer.from(visit.png, 'base64'), contentType: 'image/png' });
  }
  const evidence = { ...route, visits: route.visits.map(({ png: _png, ...visit }) => visit) };
  await testInfo.attach('aqueduct-route', { body: JSON.stringify(evidence), contentType: 'application/json' });
  console.info('M12-34 aqueduct route', JSON.stringify(evidence));
  expect(route.splits).toEqual([]);
  expect(route.visits.map(visit => visit.name)).toEqual(['lower', 'upper', 'crossing', 'lower-return']);
  expect(route.visits[0].y).toBeCloseTo(0, 1);
  expect(route.visits[1].y).toBeGreaterThan(15);
  expect(route.visits[2].y).toBeCloseTo(16, 1);
  expect(route.visits[3].y).toBeCloseTo(0, 1);
  expect(Math.hypot(route.visits[2].x - route.visits[0].x, route.visits[2].z - route.visits[0].z)).toBeLessThan(5);
  expect(route.crossingGap).toBeCloseTo(16, 1);
  expect(route.maxStep).toBeLessThan(1);
  expect(route.launched).toBe(true);
  expect(route.landed).toBe(true);
  expect(route.falls).toBe(0);
  expect(route.phase).toBe('finished');
  expect(route.lapTimes).toHaveLength(3);
  expect(route.finishTime).toBeGreaterThan(0);
  await expect(page.locator('#results-screen')).toBeVisible();
  await expect(page.locator('#results-course')).toHaveText('AQUEDUCT · 3 LAPS');
  const bests = await page.evaluate(() => JSON.parse(localStorage.getItem('pocket-circuit.best.v4') ?? '{}'));
  expect(bests).toEqual({ aqueduct: { '3': { time: route.finishTime, layout: getTrack('aqueduct').def.layoutVersion } } });
  expect(errors).toEqual([]);
});

test('M12-34: AQUEDUCT upper-edge falls respawn before the jump and restore driving within 2 s', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.waitForFunction(() => !!window.__kartDebug);
  await page.locator('#course-select input[value="aqueduct"]').check();
  await page.locator('#start-race').click();
  await page.locator('#pause-race').click();
  const results = await page.evaluate(async () => {
    const debug = window.__kartDebug;
    const { createRace, getTrack, sampleTrack, rollAt, captureRenderSnapshot } = debug.modules;
    const track = getTrack('aqueduct');
    const results = [];
    for (const zone of track.def.surfaces.filter(zone => zone.kind === 'fall')) {
      Object.assign(debug.state, createRace(42, { trackId: 'aqueduct', karts: 1, laps: 1, itemBoxes: false }));
      const state = debug.state;
      state.phase = 'racing';
      const distance = (zone.from + zone.to) / 2;
      const offset = zone.offsetMin! < 0 ? -4 : 4;
      const point = sampleTrack(track, distance);
      Object.assign(state.karts[0], { x: point.x + point.nx * offset, z: point.z + point.nz * offset,
        y: point.y + Math.sin(rollAt(track, distance)) * offset,
        heading: Math.atan2(point.tx, point.tz), trackDistance: distance, lateralOffset: offset,
        speed: 0, steer: 0, airTime: 0, startedLap: true, lapProgress: distance, nextCheckpoint: 0 });
      debug.advance(1, true);
      const kart = state.karts[0];
      const respawn = { fallen: state.events.some(event => event.type === 'fall' && event.kartId === 0),
        distance: kart.trackDistance, offset: kart.lateralOffset, spinTime: kart.spinTime };
      let ticks = 1;
      while (kart.spinTime > 0 && ticks < 600) { debug.advance(1, true); ticks++; }
      debug.advance(30, true);
      const speedAfter = kart.speed;
      const renderer = debug.renderer!;
      const snapshot = captureRenderSnapshot(state);
      renderer.update(state, snapshot, 1, 0, 'title');
      for (let frame = 0; frame < 3; frame++) renderer.update(state, snapshot, 1, 0, 'race');
      const png = renderer.renderer.domElement.toDataURL('image/png').split(',')[1]!;
      let launches = 0;
      let repeatedFalls = 0;
      for (let tick = 0; tick < 60 * 90 && kart.finishTime === null; tick++) {
        const grounded = kart.airTime === 0;
        debug.advance(1, true);
        if (grounded && kart.airTime > 0) launches++;
        repeatedFalls += state.events.filter(event => event.type === 'fall' && event.kartId === 0).length;
      }
      results.push({ side: Math.sign(offset), respawnAt: zone.respawnAt, respawn,
        controlSeconds: ticks / 60, speedAfter, launches, repeatedFalls,
        phase: state.phase, lapTimes: kart.lapTimes, finishTime: kart.finishTime, png });
    }
    return results;
  });
  expect(results).toHaveLength(2);
  await testInfo.attach('aqueduct-fall-recovery', {
    body: JSON.stringify(results.map(({ png: _png, ...result }) => result)), contentType: 'application/json',
  });
  for (const result of results) {
    await testInfo.attach(`aqueduct-after-fall-${result.side}`, { body: Buffer.from(result.png, 'base64'), contentType: 'image/png' });
    expect(result.respawn.fallen).toBe(true);
    expect(result.respawn.distance).toBeCloseTo(result.respawnAt!, 0);
    expect(result.respawnAt).toBeLessThan(getTrack('aqueduct').def.surfaces.find(zone => zone.kind === 'jump')!.from);
    expect(result.respawn.offset).toBe(0);
    expect(result.respawn.spinTime).toBeGreaterThan(0);
    expect(result.controlSeconds).toBeLessThanOrEqual(2);
    expect(result.speedAfter).toBeGreaterThan(0);
    expect(result.launches).toBe(1);
    expect(result.repeatedFalls).toBe(0);
    expect(result.phase).toBe('finished');
    expect(result.lapTimes).toHaveLength(1);
    expect(result.finishTime).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});

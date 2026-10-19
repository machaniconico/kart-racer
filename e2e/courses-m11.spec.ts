import { existsSync } from 'node:fs';
import { test, expect, type TestInfo } from '@playwright/test';
import type { KartDebug } from '../src/main';
import { getTrack } from '../src/sim/tracks';
import { sampleTrack } from '../src/sim/track';
import { findHairpins } from '../src/sim/tracks/shapeMetrics';

declare const window: Window & { __kartDebug: KartDebug };

// M11-10: the four M11 extreme courses, same C-010 flow as e2e/courses.spec.ts (kept in a separate file
// so the two specs never contend for one file lock). Golden gate and thresholds match courses.spec:
// compared when this platform has the golden (or KART_GOLDENS=write), otherwise annotated and skipped.
// Goldens are only <id>-start-grid and <id>-minimap; feature views stay attachments.
const GOLDEN_THRESHOLD = { threshold: 0.2, maxDiffPixels: 0 };
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

// M11-10, Chromium headless on darwin-arm64, 1280x720, DPR 1, seed 127, all 10 grid frames
// (renderer.info.render including shadows). Same values as RENDER_BASELINE in buildCourse.test.ts.
const courses = [
  { id: 'summit', name: 'SUMMIT DROP', drawCalls: 126, triangles: 101_126 },
  { id: 'chasm', name: 'CHASM LEAP', drawCalls: 130, triangles: 72_538 },
  { id: 'velodrome', name: 'WALL BOWL', drawCalls: 125, triangles: 94_122 },
  { id: 'spire', name: 'SKY SPIRE', drawCalls: 133, triangles: 78_424 },
] as const satisfies readonly {
  id: string; name: string; drawCalls: number; triangles: number;
}[];

// Triangle cap by course length: 60 triangles per metre (ribbon, walls, decks) + 30k for scenery.
function trianglesCap(length: number): number {
  return 60 * length + 30_000;
}

for (const { id, name, drawCalls: baselineDrawCalls, triangles: baselineTriangles } of courses) {
  const layout = getTrack(id).def.layoutVersion ?? 1;
  test(`C-010: ${name} selection, three laps, isolated best and draw budget`, async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('./');
    await expect(page.locator('#title-screen')).toBeVisible();
    await page.waitForFunction(() => !!window.__kartDebug);
    expect(await page.evaluate(() => localStorage.getItem('pocket-circuit.best.v3'))).toBeNull();
    // An unbeatable old-layout record must be hidden and replaced on completion.
    await page.evaluate(({ id, layout }) => localStorage.setItem('pocket-circuit.best.v3',
      JSON.stringify({ [id]: { time: 0.001, layout: layout - 1 } })), { id, layout });
    await page.reload();
    await page.waitForFunction(() => !!window.__kartDebug);
    await page.locator(`#course-select input[value="${id}"]`).check();
    await expect(page.locator('#course-name')).toHaveText(name);
    await expect(page.locator('#title-best')).toHaveText('まだ記録はありません');
    await expect.poll(() => page.evaluate(() => ({
      selected: window.__kartDebug.course, rendered: window.__kartDebug.render.trackId,
    }))).toEqual({ selected: id, rendered: id });
    await page.locator('#start-race').click();
    await page.locator('#pause-race').click();
    const track = getTrack(id);
    // Not every M11 course has width keys (THUNDER OVAL is full width) or a hairpin.
    const narrow = (track.def.widthKeys ?? []).reduce<{ distance: number; roadHalfWidth: number } | null>((best, key) =>
      best === null || key.roadHalfWidth < best.roadHalfWidth ? key : best, null);
    const hairpin = findHairpins(track)[0];
    const features = [
      ...(track.def.decks ?? []).slice(0, 1).map(deck => ({ name: 'crossing', distance: deck.from - 30 })),
      ...(track.def.decks ?? []).slice(0, 1).map(deck => {
        const upper = sampleTrack(track, (deck.from + deck.to) / 2);
        const lower = track.samples.filter(point => point.y < upper.y - 10).reduce((best, point) =>
          Math.hypot(point.x - upper.x, point.z - upper.z) < Math.hypot(best.x - upper.x, best.z - upper.z)
            ? point : best);
        return { name: 'crossing-underpass', distance: lower.distance - 30 };
      }),
      ...(track.def.splits ?? []).slice(0, 1).map(split => ({ name: 'island', distance: split.from - 30 })),
      ...track.def.surfaces.filter(zone => zone.kind === 'pit').slice(0, 1)
        .map(zone => ({ name: 'pit', distance: zone.from - 15 })),
      ...(narrow ? [{ name: 'narrow', distance: narrow.distance - 30 }] : []),
      ...(hairpin ? [{ name: 'hairpin', distance: hairpin.from - 30 }] : []),
    ].map(view => ({ ...view, distance: (view.distance + track.length) % track.length }));
    // First deck or split by arc distance, else the narrow passage, else the first feature view.
    const approach = features.filter(view => view.name === 'crossing' || view.name === 'island')
      .sort((a, b) => a.distance - b.distance)[0] ?? features.find(view => view.name === 'narrow') ?? features[0];
    const { views, meshes } = await page.evaluate(async ({ id, features, approachName }) => {
      const { createRace, captureRenderSnapshot, getTrack, sampleTrack } = window.__kartDebug.modules;
      const renderer = window.__kartDebug.renderer!;
      const track = getTrack(id);
      const views = [];
      for (const [index, view] of [{ name: 'start-grid', distance: null as number | null }, ...features].entries()) {
        const state = createRace(127, { trackId: id });
        // GameUI redraws its minimap only on a new tick divisible by four.
        state.tick = (index + 1) * 4;
        if (view.distance !== null) {
          const point = sampleTrack(track, view.distance);
          Object.assign(state.karts[0], { x: point.x, y: point.y, z: point.z,
            heading: Math.atan2(point.tx, point.tz), trackDistance: view.distance,
            lateralOffset: 0, speed: 0, steer: 0 });
        }
        Object.assign(window.__kartDebug.state, state);
        window.__kartDebug.advance(0);
        const minimap = (document.querySelector('#minimap-canvas') as HTMLCanvasElement).toDataURL('image/png').split(',')[1];
        const snapshot = captureRenderSnapshot(state);
        // Pin renderer time so item-box spin/bob cannot change golden pixels.
        (renderer as unknown as { elapsed: number }).elapsed = 0;
        renderer.update(state, snapshot, 1, 0, 'title');
        const samples: { drawCalls: number; triangles: number }[] = [];
        for (let frame = 0; frame < 10; frame++) {
          renderer.update(state, snapshot, 1, 0, 'race');
          const { calls: drawCalls, triangles } = renderer.renderer.info.render;
          samples.push({ drawCalls, triangles });
        }
        const png = renderer.renderer.domElement.toDataURL('image/png').split(',')[1];
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const started = performance.now();
        for (let frame = 0; frame < 30; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          renderer.update(state, snapshot, 1, 0, 'race');
          renderer.renderer.getContext().finish();
        }
        views.push({ ...view, budget: view.name === 'start-grid' || view.name === approachName,
          samples, fps: 30_000 / (performance.now() - started), minimap, png });
      }
      let meshes = 0;
      window.__kartDebug.render.courseGroup!.traverse(object => {
        if (object.type === 'Mesh' || object.type === 'InstancedMesh') meshes++;
      });
      return { views, meshes };
    }, { id, features, approachName: approach?.name ?? null });
    console.info('M11-10 render measurement', JSON.stringify({ id, meshes,
      views: views.map(({ png: _png, minimap: _minimap, ...view }) => view) }));
    for (const view of views) {
      await testInfo.attach(`${id}-${view.name}`, { body: Buffer.from(view.png, 'base64'), contentType: 'image/png' });
      await testInfo.attach(`${id}-${view.name}-minimap`, { body: Buffer.from(view.minimap, 'base64'), contentType: 'image/png' });
      if (view.name === 'start-grid') {
        if (goldenPresent(testInfo, `${id}-start-grid.png`)) {
          expect(Buffer.from(view.png, 'base64')).toMatchSnapshot(`${id}-start-grid.png`, GOLDEN_THRESHOLD);
        }
        if (goldenPresent(testInfo, `${id}-minimap.png`)) {
          expect(Buffer.from(view.minimap, 'base64')).toMatchSnapshot(`${id}-minimap.png`, GOLDEN_THRESHOLD);
        }
      }
      for (const { drawCalls, triangles } of view.samples) {
        if (view.name === 'start-grid') {
          // three's info.render is a CPU-side counter, independent of the GPU, so it matches across platforms.
          expect({ drawCalls, triangles }).toEqual({ drawCalls: baselineDrawCalls, triangles: baselineTriangles });
        }
        expect(drawCalls).toBeGreaterThan(0);
        expect(drawCalls).toBeLessThanOrEqual(200);
        expect(triangles).toBeGreaterThan(0);
        expect(triangles).toBeLessThanOrEqual(trianglesCap(track.length));
        if (view.budget) expect(drawCalls).toBeLessThanOrEqual(baselineDrawCalls + 20);
        if (view.budget) expect(triangles).toBeLessThanOrEqual(baselineTriangles + 15_000);
      }
    }
    await testInfo.attach('draw-calls', {
      body: JSON.stringify({ id, layout, baselineDrawCalls, baselineTriangles, meshes,
        views: views.map(({ png: _png, minimap: _minimap, ...view }) => view) }), contentType: 'application/json',
    });
    await page.evaluate(id => {
      const debug = window.__kartDebug;
      Object.assign(debug.state, debug.modules.createRace(127, { trackId: id }));
      debug.advance(0);
    }, id);
    await page.locator('#resume-race').click();
    await expect(page.locator('#race-screen')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__kartDebug.state.phase), { timeout: 30_000 }).toBe('racing');
    await page.evaluate(() => {
      const debug = window.__kartDebug;
      for (let second = 0; second < 420 && debug.state.phase !== 'finished'; second++) {
        debug.clearItems();
        debug.advance(60, true);
      }
    });
    await expect(page.locator('#results-screen')).toBeVisible();
    await expect(page.locator('#results-course')).toHaveText(`${name} · 3 LAPS`);
    const state = await page.evaluate(() => window.__kartDebug.state);
    expect(state.trackId).toBe(id);
    expect(state.phase).toBe('finished');
    expect(state.karts).toHaveLength(8);
    // Solo results open when the human finishes; trailing CPUs can still be racing.
    expect(state.karts[0].lapTimes).toHaveLength(3);
    expect(state.karts[0].finishTime).toBeGreaterThan(0);
    const bests = await page.evaluate(() => JSON.parse(localStorage.getItem('pocket-circuit.best.v4') ?? '{}'));
    expect(bests).toEqual({ [id]: { '3': { time: state.karts[0].finishTime, layout } } });
    // A fresh document must retain the course-specific record and empty other records.
    await page.reload();
    for (const course of courses) {
      await page.locator(`#course-select input[value="${course.id}"]`).check();
      if (course.id === id) await expect(page.locator('#title-best')).not.toHaveText('まだ記録はありません');
      else await expect(page.locator('#title-best')).toHaveText('まだ記録はありません');
    }
    expect(pageErrors).toEqual([]);
  });
}

test('M11-10: CHASM LEAP fall respawns near respawnAt, renders, and returns control within 2 s', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.waitForFunction(() => !!window.__kartDebug);
  await page.locator('#course-select input[value="chasm"]').check();
  await page.locator('#start-race').click();
  await expect.poll(() => page.evaluate(() => window.__kartDebug.state.phase), { timeout: 30_000 }).toBe('racing');
  const zone = getTrack('chasm').def.surfaces.filter(surface => surface.kind === 'fall')[0]!;
  const result = await page.evaluate(async ({ from, to }) => {
    const debug = window.__kartDebug;
    const { sampleTrack, getTrack } = debug.modules;
    const track = getTrack('chasm');
    const state = debug.state;
    // Plant the player on the ground in the middle of the first ravine at rest.
    const distance = (from + to) / 2;
    const point = sampleTrack(track, distance);
    Object.assign(state.karts[0], { x: point.x, y: point.y, z: point.z,
      heading: Math.atan2(point.tx, point.tz), trackDistance: distance,
      lateralOffset: 0, speed: 0, steer: 0, airTime: 0, finishTime: null });
    debug.clearItems();
    debug.advance(1, true);
    const fallen = state.events.some(event => event.type === 'fall' && event.kartId === 0);
    const kart = state.karts[0];
    const respawn = { fallen, trackDistance: kart.trackDistance, lateralOffset: kart.lateralOffset, spinTime: kart.spinTime };
    // Control returns when the spin-out ends: step until spinTime is 0 and count sim seconds.
    let ticks = 1;
    while (state.karts[0].spinTime > 0 && ticks < 600) { debug.advance(1, true); ticks++; }
    debug.advance(30, true);
    const after = state.karts[0];
    // Render the respawned view and measure that the frame is not black.
    const renderer = debug.renderer!;
    const snapshot = debug.modules.captureRenderSnapshot(state);
    for (let frame = 0; frame < 3; frame++) renderer.update(state, snapshot, 1, 0, 'race');
    const image = new Image();
    image.src = renderer.renderer.domElement.toDataURL('image/png');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 16) {
      const luma = pixels[i]! * 0.3 + pixels[i + 1]! * 0.6 + pixels[i + 2]! * 0.1;
      sum += luma;
      if (luma > 24) lit++;
    }
    const sampled = pixels.length / 16;
    return { respawn, controlSeconds: ticks / 60, speedAfter: after.speed, phase: state.phase,
      meanLuma: sum / sampled, litShare: lit / sampled, png: canvas.toDataURL('image/png').split(',')[1]! };
  }, { from: zone.from, to: zone.to });
  await testInfo.attach('chasm-after-fall', { body: Buffer.from(result.png, 'base64'), contentType: 'image/png' });
  expect(result.respawn.fallen).toBe(true);
  expect(result.respawn.trackDistance).toBeCloseTo(zone.respawnAt!, 0);
  expect(result.respawn.lateralOffset).toBe(0);
  expect(result.respawn.spinTime).toBeGreaterThan(0);
  expect(result.controlSeconds).toBeLessThanOrEqual(2);
  expect(result.phase).toBe('racing');
  expect(result.speedAfter).toBeGreaterThan(0);
  expect(result.meanLuma).toBeGreaterThan(20);
  expect(result.litShare).toBeGreaterThan(0.5);
  expect(errors).toEqual([]);
});

test('M11-10: EXTREME CUP is the fifth cup and runs its four courses', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await expect(page.locator('#title-screen')).toBeVisible();
  await page.waitForFunction(() => !!window.__kartDebug);
  await page.locator('#mode-select input[value="gp"]').check();
  await expect(page.locator('.cup-option')).toHaveCount(5);
  await page.getByRole('radio', { name: /EXTREME CUP/ }).check();
  await page.locator('#laps-select input[value="1"]').check();
  await page.locator('#start-race').click();
  const tracks = ['summit', 'chasm', 'velodrome', 'spire'];
  for (const [index, trackId] of tracks.entries()) {
    await test.step(`Race ${index + 1}: ${trackId}`, async () => {
      await page.waitForFunction(() => window.__kartDebug.state.phase === 'racing');
      expect(await page.evaluate(() => window.__kartDebug.state.trackId)).toBe(trackId);
      await page.evaluate(() => {
        const debug = window.__kartDebug;
        for (let second = 0; second < 420 && debug.state.phase !== 'finished'; second++) {
          debug.clearItems();
          debug.advance(60, true);
        }
      });
      await expect(page.locator('#retry-race')).toHaveText('順位表へ');
      await page.locator('#retry-race').click();
      await expect(page.locator('#standings-screen')).toBeVisible();
      await expect(page.locator('#gp-cup')).toHaveText('EXTREME CUP');
      await expect(page.locator('.standings-row')).toHaveCount(8);
      if (index < tracks.length - 1) {
        await page.locator('#gp-next').click();
      } else {
        await expect(page.locator('.podium > .podium-place')).toHaveCount(3);
        await page.locator('#gp-next').click();
        await expect(page.locator('#title-screen')).toBeVisible();
      }
    });
  }
  expect(errors).toEqual([]);
});

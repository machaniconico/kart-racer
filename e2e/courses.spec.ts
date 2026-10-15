import { test, expect } from '@playwright/test';
import type { KartDebug } from '../src/main';
import { getTrack } from '../src/sim/tracks';
import { sampleTrack } from '../src/sim/track';
import { findHairpins } from '../src/sim/tracks/shapeMetrics';
import { KART_RADIUS, widthAt } from '../src/sim/corridor';

declare const window: Window & { __kartDebug: KartDebug };

// C-010 timing (2026-10-05): npm test, 738 passed, Vitest 4.57 s / wall 4.84 s.
// .omc/baseline-v3.txt records 3 s before C-001; the 6 s budget needs no seed reduction.
// M6-05 / darwin-arm64: all 29 E2E tests passed in 1437.15 s (23.95 min), workers 1.
// courses.spec: 16.9 min; multiplayer.spec: 5.9 min. The M6-00 estimate was 29.6 min.
// Below the 35 min parallelism threshold: retain 300 s/test and the 45 min CI job budget.
// Build ran once; logs, FPS, and visual followups: e2e/__screenshots__/m6-05/.
const courses = [
  // M2.5 re-measured 2026-10-11: Chromium 1280x720, DPR 1, seed 127, 10 stationary frames.
  // M1-04 -> M2.5 (drawCalls / triangles), including shadows:
  // meadow 123 / 41_530 -> 123 / 41_530; canyon 128 / 46_784 -> 129 / 54_564.
  // snowpeak 125 / 41_810 -> 125 / 41_952; neon 125 / 66_080 -> 125 / 62_748.
  // M3-08 re-measured 2026-10-14, same setup: NEON layout 2 -> 3:
  // drawCalls / triangles: 125 / 62_748 -> 126 / 62_812; retain the old budget baseline.
  // M4-06: SNOWPEAK layout 3 retains the layout-2 budget for the elevated/banked road.
  // M5-05 / v15: measured after all four course stories and shared followups, same grid setup.
  // Last values: meadow 123 / 41_530, canyon 129 / 54_564, snowpeak 125 / 41_952, neon 125 / 62_748.
  { id: 'meadow', name: 'MEADOW LOOP', drawCalls: 125, triangles: 107_048 },
  // M6-09: pit clipping/rim paint and tapered island scenery, same measurement setup.
  { id: 'canyon', name: 'SUNSCAR CANYON', drawCalls: 139, triangles: 124_630 },
  { id: 'snowpeak', name: 'FROSTBITE PEAK', drawCalls: 129, triangles: 112_768 },
  { id: 'neon', name: 'NEON NIGHTLINE', drawCalls: 134, triangles: 115_336 },
  // M6-05 / v16: Chromium on darwin-arm64, 1280×720, DPR 1, seed 127, 10 stationary frames.
  { id: 'harbor', name: 'TIDEWATER HARBOR', drawCalls: 129, triangles: 110_460 },
  { id: 'forest', name: 'MOSSWOOD TRAIL', drawCalls: 134, triangles: 133_980 },
  { id: 'volcano', name: 'EMBER CALDERA', drawCalls: 132, triangles: 100_648 },
  { id: 'skyline', name: 'STRATOS CITY', drawCalls: 136, triangles: 90_174 },
] as const satisfies readonly {
  id: string; name: string; drawCalls: number; triangles: number;
}[];

// Triangle cap by course length: 60 triangles per metre (ribbon, walls, decks) + 30k for scenery.
function trianglesCap(length: number): number {
  return 60 * length + 30_000;
}

for (const { id, name, drawCalls: baselineDrawCalls, triangles: baselineTriangles } of courses) {
  // Read from the def so a course story's layoutVersion bump needs no edit here.
  const layout = getTrack(id).def.layoutVersion ?? 1;
  test(`C-010: ${name} selection, three laps, isolated best and draw budget`, async ({ page }, testInfo) => {
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
    // Reproduce the seed-127 baseline: ten stationary frames, including shadows.
    // Synchronous renders avoid CPU movement and wall-clock-dependent culling.
    await page.locator('#start-race').click();
    await page.locator('#pause-race').click();
    const track = getTrack(id);
    const narrow = track.def.widthKeys!.reduce((best, key) =>
      key.roadHalfWidth < best.roadHalfWidth ? key : best);
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
      { name: 'narrow', distance: narrow.distance - 30 },
      { name: 'hairpin', distance: findHairpins(track)[0]!.from - 30 },
    ];
    // First deck or split by arc distance; courses without either use their narrow passage.
    const approach = features.filter(view => view.name === 'crossing' || view.name === 'island')
      .sort((a, b) => a.distance - b.distance)[0] ?? features.find(view => view.name === 'narrow')!;
    const { views, meshes } = await page.evaluate(async ({ id, features, approach }) => {
      const { createRace, captureRenderSnapshot, getTrack, sampleTrack } = window.__kartDebug.modules;
      const renderer = window.__kartDebug.renderer!;
      const track = getTrack(id);
      const views = [];
      for (const [index, view] of [{ name: 'start-grid', distance: null }, ...features].entries()) {
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
        // Item-box spin/bob uses renderer time, independently of the seeded simulation.
        // Pin it before the synchronous capture so load time cannot change golden pixels.
        (renderer as unknown as { elapsed: number }).elapsed = 0;
        renderer.update(state, snapshot, 1, 0, 'title');
        const samples: { drawCalls: number; triangles: number }[] = [];
        for (let frame = 0; frame < 10; frame++) {
          renderer.update(state, snapshot, 1, 0, 'race');
          const { calls: drawCalls, triangles } = renderer.renderer.info.render;
          samples.push({ drawCalls, triangles });
        }
        const png = renderer.renderer.domElement.toDataURL('image/png').split(',')[1];
        // Static, paced frames measure observed browser FPS, including GPU completion.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const started = performance.now();
        for (let frame = 0; frame < 30; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          renderer.update(state, snapshot, 1, 0, 'race');
          renderer.renderer.getContext().finish();
        }
        views.push({ ...view, budget: view.name === 'start-grid' || view.name === approach.name,
          samples, fps: 30_000 / (performance.now() - started), minimap, png });
      }
      let meshes = 0;
      window.__kartDebug.render.courseGroup!.traverse(object => {
        if (object.type === 'Mesh' || object.type === 'InstancedMesh') meshes++;
      });
      return { views, meshes };
    }, { id, features, approach });
    for (const view of views) {
      await testInfo.attach(`${id}-${view.name}`, { body: Buffer.from(view.png, 'base64'), contentType: 'image/png' });
      await testInfo.attach(`${id}-${view.name}-minimap`, { body: Buffer.from(view.minimap, 'base64'), contentType: 'image/png' });
      // Linux goldens are pending-ci (M6-06); never derive them from darwin pixels.
      if (process.platform === 'darwin' && ['harbor', 'forest', 'volcano', 'skyline'].includes(id)) {
        expect(Buffer.from(view.png, 'base64')).toMatchSnapshot(`${id}-${view.name}.png`);
        if (view.name === 'start-grid') {
          expect(Buffer.from(view.minimap, 'base64')).toMatchSnapshot(`${id}-minimap.png`);
        }
      }
      for (const { drawCalls, triangles } of view.samples) {
        if (view.name === 'start-grid') {
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
    console.info('M6-05 render measurement', JSON.stringify({ id, meshes,
      views: views.map(({ png: _png, minimap: _minimap, ...view }) => view) }));
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
    await expect.poll(() => page.evaluate(() => window.__kartDebug.state.phase)).toBe('racing');
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
    for (const other of courses.filter(course => course.id !== id)) {
      expect(bests[other.id] ?? null).toBeNull();
    }
    // A fresh document must retain the course-specific record and empty other records.
    await page.reload();
    for (const course of courses) {
      await page.locator(`#course-select input[value="${course.id}"]`).check();
      if (course.id === id) await expect(page.locator('#title-best')).not.toHaveText('まだ記録はありません');
      else await expect(page.locator('#title-best')).toHaveText('まだ記録はありません');
    }
  });
}

test('C-010: title shows the eight-course picker', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#title-screen')).toBeVisible();
  await expect(page.locator('#course-select input')).toHaveCount(8);
  // Linux golden remains pending-ci until M6-06 captures it on the CI renderer.
  if (process.platform === 'darwin') {
    await page.addStyleTag({ content: 'canvas { visibility: hidden !important; }' });
    await expect(page.locator('#title-screen')).toHaveScreenshot('title-eight-courses.png', {
      animations: 'disabled',
    });
  }
});

test.describe('C-011 solo touch selection', () => {
  test.use({ hasTouch: true });
  test('keeps course, laps and online entry usable in both phone orientations', async ({ page }, testInfo) => {
    await page.goto('./');
    await page.waitForFunction(() => !!window.__kartDebug);
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 360, height: 640 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#course-select input[value="meadow"]').tap();
      for (const laps of [1, 2, 3]) {
        await page.locator(`#laps-select label:has(input[value="${laps}"])`).tap();
        await expect(page.locator(`#laps-select input[value="${laps}"]`)).toBeChecked();
        expect(await page.evaluate(() => window.__kartDebug.state.laps)).toBe(laps);
      }
      const bounds = await page.evaluate(() => ({
        titleBottom: document.querySelector('.title-content')!.getBoundingClientRect().bottom,
        onlineTop: document.querySelector('#online-entry')!.getBoundingClientRect().top,
        courseTop: document.querySelector('.course-strip')!.getBoundingClientRect().top,
      }));
      expect(bounds.titleBottom).toBeLessThanOrEqual(viewport.width < viewport.height ? bounds.onlineTop : bounds.courseTop);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const options = await page.locator('.course-option').all();
      expect(options).toHaveLength(8);
      for (const option of options) {
        const box = await option.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      await testInfo.attach(`solo-touch-${viewport.width}x${viewport.height}`, { body: await page.screenshot(), contentType: 'image/png' });
    }
  });
});

for (const laps of [1, 2]) {
  test(`C-011: solo ${laps} laps selection, HUD, results and isolated best`, async ({ page }, testInfo) => {
    await page.goto('./');
    await page.waitForFunction(() => !!window.__kartDebug);
    await expect(page.locator('#laps-select input[value="3"]')).toBeChecked();
    for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#laps-select input[value="3"]').check();
      await page.locator(`#laps-select input[value="${laps}"]`).check();
      await page.locator('#course-select input[value="meadow"]').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const label of await page.locator('.laps-option').all()) {
        const box = await label.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      await testInfo.attach(`solo-laps-${viewport.width}x${viewport.height}`, {
        body: await page.screenshot(), contentType: 'image/png',
      });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('#course-select input[value="canyon"]').check();
    await page.locator('#course-select input[value="meadow"]').check();
    expect(await page.evaluate(() => window.__kartDebug.state.laps)).toBe(laps);
    await page.locator('#start-race').click();
    await expect(page.locator('#lap-total')).toHaveText(`/ ${laps}`);
    expect(await page.evaluate(() => window.__kartDebug.state.laps)).toBe(laps);
    await page.evaluate(() => {
      for (let second = 0; second < 420 && window.__kartDebug.state.phase !== 'finished'; second++) {
        window.__kartDebug.clearItems();
        window.__kartDebug.advance(60, true);
      }
    });
    await expect(page.locator('#results-course')).toHaveText(`MEADOW LOOP · ${laps} LAPS`);
    await expect(page.locator('#lap-value')).toHaveText(String(laps));
    const state = await page.evaluate(() => window.__kartDebug.state);
    expect(state.karts[0].lapTimes).toHaveLength(laps);
    const bests = await page.evaluate(() => JSON.parse(localStorage.getItem('pocket-circuit.best.v4') ?? '{}'));
    expect(bests.meadow).toEqual({ [laps]: { time: state.karts[0].finishTime, layout: getTrack('meadow').def.layoutVersion } });
    await page.locator('#back-title').click();
    expect(await page.evaluate(() => window.__kartDebug.state.laps)).toBe(laps);
    await expect(page.locator('#title-best')).not.toHaveText('まだ記録はありません');
    await page.locator('#laps-select input[value="3"]').check();
    await expect(page.locator('#title-best')).toHaveText('まだ記録はありません');
    await page.locator(`#laps-select input[value="${laps}"]`).check();
    await expect(page.locator('#title-best')).not.toHaveText('まだ記録はありません');
    await page.locator('#start-race').click();
    await expect(page.locator('#lap-total')).toHaveText(`/ ${laps}`);
    await page.evaluate(() => {
      window.__kartDebug.state.laps = 3;
      window.__kartDebug.advance(0);
    });
    await expect(page.locator('#lap-total')).toHaveText('/ 3');
    await page.evaluate(laps => {
      const state = window.__kartDebug.state;
      state.laps = laps;
      state.karts[0].lap = laps - 1;
      state.karts[0].lapTimes = Array(laps - 1).fill(1);
      state.karts[1].finishTime = 1;
      state.time = 60;
      state.phase = 'finished';
      window.__kartDebug.advance(0);
    }, laps);
    await expect(page.locator('#results-course')).toHaveText(`MEADOW LOOP · ${laps} LAPS`);
    await expect(page.locator('#result-laps')).toContainText(`未完走 · ${laps - 1} / ${laps} 周完了`);
  });
}

test('M3-08: NEON eight CPUs finish three laps and mechanisms keep animating', async ({ page }, testInfo) => {
  await page.goto('./');
  await page.waitForFunction(() => !!window.__kartDebug);
  await page.locator('#course-select input[value="neon"]').check();
  await page.locator('#start-race').click();
  const { screenshots, ...log } = await page.evaluate(() => {
    const { createRace, getTrack, sampleTrack, captureRenderSnapshot } = window.__kartDebug.modules;
    const debug = window.__kartDebug;
    // Reset synchronously to a fixed seed with all eight slots genuinely CPU-controlled.
    Object.assign(debug.state, createRace(127, { trackId: 'neon', racers: debug.state.karts.map(kart => ({
      name: kart.name, color: kart.color, human: false,
    })) }));
    for (let second = 0; second < 420 && debug.state.phase !== 'finished'; second++) {
      debug.clearItems();
      debug.advance(60, true);
    }
    const track = getTrack('neon');
    const renderer = debug.renderer!;
    const group = debug.render.courseGroup!;
    const sweepIndex = track.def.barriers!.findIndex(barrier => barrier.motion?.kind === 'sweep');
    const gateIndex = track.def.barriers!.findIndex(barrier => barrier.motion?.kind === 'gate');
    const spinIndex = track.def.surfaces.findIndex(zone => zone.kind === 'spin');
    const sweep = track.def.barriers![sweepIndex];
    const gate = track.def.barriers![gateIndex];
    const spin = track.def.surfaces[spinIndex];
    const point = sampleTrack(track, (sweep.from + sweep.to) / 2);
    const band = group.getObjectByName(`motion:barrier:${sweepIndex}`)!;
    const disc = group.getObjectByName(`motion:spin:${spinIndex}`)!;
    // Finished simulation time is frozen. Render the completed state at two explicit
    // times, a quarter sweep period apart, to exercise GameRenderer's motion update.
    const motion = [0, sweep.motion!.period / 4].map(time => {
      const state = { ...debug.state, time };
      renderer.update(state, captureRenderSnapshot(state), 1, 0, 'results');
      return { time, lateral: (band.position.x - point.x) * point.nx + (band.position.z - point.z) * point.nz,
        rotationY: disc.rotation.y };
    });
    const gateMotion = gate.motion!;
    // The gate is widest (closed) at phase 0 and narrowest (open) at phase PI.
    const gateTime = (phase: number) => {
      const time = (phase - gateMotion.phase) * gateMotion.period / (2 * Math.PI);
      return ((time % gateMotion.period) + gateMotion.period) % gateMotion.period;
    };
    const screenshots = [
      { name: 'neon-sweep', distance: sweep.from - 10, time: sweep.motion!.period / 4 },
      { name: 'neon-gate-closed', distance: gate.from - 10, time: gateTime(0) },
      { name: 'neon-gate-open', distance: gate.from - 10, time: gateTime(Math.PI) },
      { name: 'neon-spin', distance: spin.from - 10, time: sweep.motion!.period / 4 },
    ].map(({ name, distance, time }) => {
      const point = sampleTrack(track, distance);
      const state = { ...debug.state, time,
        karts: debug.state.karts.map(kart => kart.id === 0 ? { ...kart,
          x: point.x, y: point.y, z: point.z, heading: Math.atan2(point.tx, point.tz),
          trackDistance: distance, lateralOffset: 0, speed: 0, steer: 0,
        } : kart) };
      const snapshot = captureRenderSnapshot(state);
      renderer.update(state, snapshot, 1, 0, 'title');
      renderer.update(state, snapshot, 1, 0, 'race');
      return { name, png: renderer.renderer.domElement.toDataURL('image/png').split(',')[1] };
    });
    return { phase: debug.state.phase, karts: debug.state.karts.map(({ human, lapTimes, finishTime }) => ({
      human, lapTimes, finishTime,
    })), motion, screenshots };
  });
  await testInfo.attach('neon-three-laps-motion', { body: JSON.stringify(log), contentType: 'application/json' });
  const closed = Buffer.from(screenshots.find(shot => shot.name === 'neon-gate-closed')!.png, 'base64');
  const open = Buffer.from(screenshots.find(shot => shot.name === 'neon-gate-open')!.png, 'base64');
  expect(closed.equals(open)).toBe(false);
  for (const { name, png } of screenshots) {
    await testInfo.attach(name, { body: Buffer.from(png, 'base64'), contentType: 'image/png' });
  }
  await expect(page.locator('#results-screen')).toBeVisible();
  expect(log.phase).toBe('finished');
  expect(log.karts).toHaveLength(8);
  for (const kart of log.karts) {
    expect(kart.human).toBe(false);
    expect(kart.lapTimes).toHaveLength(3);
    expect(kart.finishTime).toBeGreaterThan(0);
  }
  expect(Math.abs(log.motion[1].lateral - log.motion[0].lateral)).toBeGreaterThan(0);
  expect(log.motion[1].rotationY).toBeGreaterThan(log.motion[0].rotationY);
});

// A race has eight slots: cover eight CPUs and the human + seven CPUs separately.
for (const human of [true, false]) {
  test(`M4-06: SNOWPEAK ${human ? 'full-throttle assisted player' : 'eight CPUs'} three laps, camera clearance and bank`, async ({ page }, testInfo) => {
    await page.goto('./');
    await page.waitForFunction(() => !!window.__kartDebug);
    await page.locator('#course-select input[value="snowpeak"]').check();
    await page.locator('#assist-title').check();
    await page.locator('#start-race').click();
    await page.keyboard.down('ArrowUp');
    const { screenshots, ...log } = await page.evaluate(human => {
      const { createRace, FIXED_DT, getTrack, rollAt, sampleTrack, slopeAt, captureRenderSnapshot } = window.__kartDebug.modules;
      const debug = window.__kartDebug;
      Object.assign(debug.state, createRace(127, { trackId: 'snowpeak', racers: debug.state.karts.map(kart => ({
        name: kart.name, color: kart.color, human: human && kart.id === 0,
      })) }));
      const track = getTrack('snowpeak');
      const renderer = debug.renderer!;
      const render = (dt: number) => renderer.update(debug.state, captureRenderSnapshot(debug.state), 1, dt, 'race');
      // Reset the camera once; subsequent samples exercise its normal follow blend.
      renderer.update(debug.state, captureRenderSnapshot(debug.state), 1, 0, 'title');
      render(0);
      const samples: { tick: number; d: number; lap: number; cameraPosition: { x: number; y: number; z: number };
        cameraGroundY: number; clearance: number; playerRoll: number }[] = [];
      for (let tick = 0; tick < 60 * 420 && debug.state.phase !== 'finished'; tick += 10) {
        debug.clearItems();
        // The human uses Controls (ArrowUp + assist), never AI autopilot.
        debug.advance(10, !human);
        render(10 * FIXED_DT);
        const cameraPosition = debug.cameraPosition!;
        const cameraGroundY = debug.cameraGroundY!;
        const player = debug.state.karts[0];
        const sample = { tick: debug.state.tick, d: player.trackDistance, lap: player.lap,
          cameraPosition, cameraGroundY, clearance: cameraPosition.y - cameraGroundY, playerRoll: debug.playerRoll };
        samples.push(sample);
        // Preserve the first failing distance and heights for a human decision; do not tune the renderer/course.
        if (!(sample.clearance >= 1)) break;
      }
      const screenshots: { name: string; d: number; slope: number; roll: number; png: string }[] = [];
      if (debug.state.phase === 'finished') {
        // Stage the exact steepest sample segment and the strongest bank, as M3-08 does for mechanisms.
        const steepest = track.samples.reduce((best, point) =>
          Math.abs(slopeAt(track, point.distance)) > Math.abs(slopeAt(track, best.distance)) ? point : best);
        const steepIndex = track.samples.indexOf(steepest);
        const steepEnd = track.samples[steepIndex + 1]?.distance ?? track.length;
        const bank = track.def.bankKeys!.reduce((best, key) => Math.abs(key.roll) > Math.abs(best.roll) ? key : best);
        for (const { name, d } of [
          { name: 'm4-06-snowpeak-steepest', d: (steepest.distance + steepEnd) / 2 },
          { name: 'm4-06-snowpeak-bank', d: bank.distance },
        ]) {
          const point = sampleTrack(track, d);
          const state = { ...debug.state, karts: debug.state.karts.map(kart => kart.id === 0 ? { ...kart,
            x: point.x, y: point.y, z: point.z, heading: Math.atan2(point.tx, point.tz),
            trackDistance: d, lateralOffset: 0, speed: 0, steer: 0,
          } : kart) };
          const snapshot = captureRenderSnapshot(state);
          renderer.update(state, snapshot, 1, 0, 'title');
          renderer.update(state, snapshot, 1, 0, 'race');
          screenshots.push({ name, d, slope: slopeAt(track, d),
            roll: rollAt(track, d),
            png: renderer.renderer.domElement.toDataURL('image/png').split(',')[1] });
        }
      }
      return { trackId: debug.state.trackId, phase: debug.state.phase, samples, screenshots,
        karts: debug.state.karts.map(({ human, lapTimes, finishTime }) => ({ human, lapTimes, finishTime })) };
    }, human);
    await page.keyboard.up('ArrowUp');
    await testInfo.attach('m4-06-snowpeak-three-laps', { body: JSON.stringify(log), contentType: 'application/json' });
    for (const { name, png, ...pose } of screenshots) {
      await testInfo.attach(name, { body: Buffer.from(png, 'base64'), contentType: 'image/png' });
      await testInfo.attach(`${name}-pose`, { body: JSON.stringify(pose), contentType: 'application/json' });
    }
    expect(log.samples.length).toBeGreaterThan(0);
    for (const sample of log.samples) {
      expect(sample.clearance, JSON.stringify(sample)).toBeGreaterThanOrEqual(1);
    }
    expect(log.samples.some(sample => Math.abs(sample.playerRoll) >= 0.2)).toBe(true);
    expect(log.trackId).toBe('snowpeak');
    expect(log.phase).toBe('finished');
    expect(log.karts).toHaveLength(8);
    expect(log.karts.filter(kart => kart.human)).toHaveLength(human ? 1 : 0);
    for (const kart of human ? [log.karts[0]] : log.karts) {
      expect(kart.lapTimes).toHaveLength(3);
      expect(kart.finishTime).toBeGreaterThan(0);
    }
    expect(screenshots).toHaveLength(2);
    await expect(page.locator('#results-screen')).toBeVisible();
  });
}

for (const missedBoost of [false, true]) {
  test(`M2-06: CANYON shortcut ${missedBoost ? 'fails without boost' : 'clears the pit with boost'}`, async ({ page }, testInfo) => {
    await page.goto('./');
    await page.waitForFunction(() => !!window.__kartDebug);
    await page.locator('#course-select input[value="canyon"]').check();
    await page.locator('#assist-title').uncheck();
    await page.locator('#start-race').click();
    await page.waitForFunction(() => window.__kartDebug.state.phase === 'racing');

    const track = getTrack('canyon');
    const split = track.def.splits![0];
    const lane = split.lanes.find(candidate => candidate.risk === 1)!;
    const center = (lane.offsetMin + lane.offsetMax) / 2;
    const start = track.def.widthKeys!.filter(key => key.distance < split.from).at(-1)!.distance;
    const initialOffset = Math.min(center, widthAt(track, start).wallHalfWidth - KART_RADIUS);
    const mergeEnd = track.def.racingLine!.find(point => point.distance > split.to && point.offset === 0)!.distance;
    // Sample the actual course at 10 cm intervals for a lane-centre steering target.
    const points = Array.from({ length: Math.ceil((split.to + 30 - start) * 10) + 1 },
      (_, i) => sampleTrack(track, start + i / 10));
    const boost = track.def.surfaces.find(zone => zone.kind === 'boost' && zone.from >= split.from && zone.to <= split.to)!;
    const jump = track.def.surfaces.find(zone => zone.kind === 'jump' && zone.from >= split.from && zone.to <= split.to)!;
    const { approach, ...log } = await page.evaluate(({ split, center, initialOffset, start, mergeEnd, points, boost, jump, missedBoost }) => {
      const debug = window.__kartDebug;
      const kart = debug.state.karts[0];
      const point = points[0];
      Object.assign(kart, {
        x: point.x + point.nx * initialOffset, y: point.y, z: point.z + point.nz * initialOffset,
        heading: Math.atan2(point.tx, point.tz), trackDistance: start, lateralOffset: initialOffset,
        speed: 0, steer: 0, boostTime: 0, spinTime: 0, airTime: 0,
      });
      const initial = { trackDistance: kart.trackDistance, lateralOffset: kart.lateralOffset, speed: kart.speed };
      const renderer = debug.renderer!;
      const snapshot = { karts: debug.state.karts, entities: new Map() };
      // Switch camera modes to snap to the placed kart, then capture before any sim tick.
      renderer.update(debug.state, snapshot, 1, 0, 'title');
      renderer.update(debug.state, snapshot, 1, 0, 'race');
      const approach = renderer.renderer.domElement.toDataURL('image/png').split(',')[1];
      let axis = 0;
      const originalGamepads = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
      // Feed full throttle and analogue steering through the real Controls path, never autopilot.
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [{
        connected: true, axes: [axis], buttons: Array.from({ length: 16 }, (_, i) => ({ value: i === 7 ? 1 : 0, pressed: i === 7 })),
      }] });
      const ticks: { tick: number; trackDistance: number; lateralOffset: number; speed: number; spinTime: number; airTime: number }[] = [];
      const events: { tick: number; trackDistance: number; type: string; value?: number }[] = [];
      try {
        for (let second = 0; second < 30 && kart.trackDistance <= split.to + 20; second++) {
          debug.clearItems();
          for (let tick = 0; tick < 60 && kart.trackDistance <= split.to + 20; tick++) {
            const distance = kart.trackDistance + 4;
            const target = points[Math.max(0, Math.min(points.length - 1, Math.round((distance - start) * 10)))];
            // Follow the course definition's return to the road centre after the island.
            const offset = center * Math.max(0, Math.min(1, (mergeEnd - distance) / (mergeEnd - split.to)));
            const desired = Math.atan2(target.x + target.nx * offset - kart.x, target.z + target.nz * offset - kart.z);
            const error = Math.atan2(Math.sin(desired - kart.heading), Math.cos(desired - kart.heading));
            const steer = Math.max(-1, Math.min(1, error * 4));
            // Invert playerSteerToSim and the gamepad's 0.14 deadzone.
            axis = steer === 0 ? 0 : -Math.sign(steer) * (0.14 + Math.abs(steer) * 0.86);
            // The pad spans the whole inner lane: a lateral miss would also change the flight line.
            // Use the authorized counterfactual, removing boost through takeoff instead.
            if (missedBoost && kart.trackDistance >= boost.from && kart.trackDistance <= jump.to) kart.boostTime = 0;
            debug.clearItems();
            debug.advance(1);
            ticks.push({ tick: debug.state.tick, trackDistance: kart.trackDistance, lateralOffset: kart.lateralOffset,
              speed: kart.speed, spinTime: kart.spinTime, airTime: kart.airTime });
            for (const event of debug.state.events.filter(event => event.kartId === 0)) {
              events.push({ tick: debug.state.tick, trackDistance: kart.trackDistance, type: event.type, value: event.value });
            }
          }
        }
      } finally {
        if (originalGamepads) Object.defineProperty(navigator, 'getGamepads', originalGamepads);
        else Reflect.deleteProperty(navigator, 'getGamepads');
      }
      return { approach, initial, ticks, events, trackDistance: kart.trackDistance };
    }, { split, center, initialOffset, start, mergeEnd, points, boost, jump, missedBoost });
    await testInfo.attach('canyon-island-approach', { body: Buffer.from(approach, 'base64'), contentType: 'image/png' });
    await testInfo.attach('canyon-shortcut', { body: JSON.stringify(log), contentType: 'application/json' });
    expect(log.initial).toEqual({ trackDistance: start, lateralOffset: initialOffset, speed: 0 });
    expect(log.ticks.some(tick => tick.airTime > 0)).toBe(true);
    const pitHits = log.events.filter(event => event.type === 'hit' && event.value === 2);
    if (missedBoost) {
      expect(pitHits.length).toBeGreaterThanOrEqual(1);
      expect(log.ticks.some(tick => tick.spinTime > 0)).toBe(true);
    } else {
      expect(pitHits).toHaveLength(0);
      expect(log.ticks.every(tick => tick.spinTime === 0)).toBe(true);
      expect(log.events.some(event => event.type === 'boost')).toBe(true);
      expect(log.trackDistance).toBeGreaterThan(split.to + 20);
    }
  });
}

test('C-010: sixteen course switches keep renderer geometry memory bounded', async ({ page }, testInfo) => {
  await page.goto('./');
  await page.waitForFunction(() => !!window.__kartDebug?.rendererInfo);
  // Canyon still has the largest measured geometry count (90); visit all eight courses twice.
  const lap = ['canyon', 'snowpeak', 'neon', 'meadow', 'harbor', 'forest', 'volcano', 'skyline'] as const;
  const sequence = [...lap, ...lap];
  const samples = [];
  for (const id of sequence) {
    const sample = await page.evaluate(async trackId => {
      window.__kartDebug.selectCourse(trackId);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return {
        trackId: window.__kartDebug.render.trackId,
        geometries: window.__kartDebug.rendererInfo!.memory.geometries,
        textures: window.__kartDebug.rendererInfo!.memory.textures,
        programs: window.__kartDebug.render.programCount ?? 0,
      };
    }, id);
    expect(sample.trackId).toBe(id);
    expect(sample.geometries).toBeGreaterThan(0);
    expect(sample.programs).toBeGreaterThan(0);
    samples.push(sample);
  }
  await testInfo.attach('geometry-memory', {
    body: JSON.stringify(samples), contentType: 'application/json',
  });
  console.info('M6-05 geometry memory', JSON.stringify(samples));
  // M8-01: rebuilds reuse one WebGLRenderer (shared info), so a leak shows up as growth here, not as a
  // non-empty old renderer. Lap 2 must match lap 1 exactly: geometry, texture and program counts.
  const maxTextures = Math.max(...samples.slice(0, lap.length).map(sample => sample.textures));
  const maxPrograms = Math.max(...samples.slice(0, lap.length).map(sample => sample.programs));
  for (const [index, sample] of samples.entries()) {
    expect(sample.geometries).toBeLessThanOrEqual(samples[0].geometries);
    expect(sample.textures).toBeLessThanOrEqual(maxTextures);
    expect(sample.programs).toBeLessThanOrEqual(maxPrograms);
    if (index >= lap.length) {
      const previous = samples[index - lap.length];
      expect({ geometries: sample.geometries, textures: sample.textures, programs: sample.programs })
        .toEqual({ geometries: previous.geometries, textures: previous.textures, programs: previous.programs });
    }
  }
  const neonLoads = samples.filter(sample => sample.trackId === 'neon');
  expect(neonLoads).toHaveLength(2);
  expect(neonLoads[1].geometries).toBeLessThanOrEqual(neonLoads[0].geometries);
});

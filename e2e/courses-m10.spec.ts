import { existsSync } from 'node:fs';
import { test, expect, type TestInfo } from '@playwright/test';
import type { KartDebug } from '../src/main';
import { getTrack } from '../src/sim/tracks';
import { sampleTrack } from '../src/sim/track';
import { findHairpins } from '../src/sim/tracks/shapeMetrics';

declare const window: Window & { __kartDebug: KartDebug };

// M10-10: the eight M10 courses, same C-010 flow as e2e/courses.spec.ts (kept in a separate file
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

// M10-10, Chromium headless on darwin-arm64, 1280x720, DPR 1, seed 127, all 10 grid frames
// (renderer.info.render including shadows). Same values as RENDER_BASELINE in buildCourse.test.ts.
// M12-06: item box ring + icosahedron core add 1 draw and 252 triangles per box (24 boxes): +1 / +6_048.
const courses = [
  { id: 'dunes', name: 'SIROCCO DUNES', drawCalls: 127, triangles: 98_058 }, // M12-22: sand zones re-cut (dirt ≤28%), +44 surface-strip triangles
  { id: 'garden', name: 'BLOSSOM GARDEN', drawCalls: 124, triangles: 111_166 },
  { id: 'speedway', name: 'THUNDER OVAL', drawCalls: 126, triangles: 79_356 },
  { id: 'bayou', name: 'MOONLIT BAYOU', drawCalls: 128, triangles: 85_387 },
  { id: 'cavern', name: 'CRYSTAL HOLLOW', drawCalls: 131, triangles: 94_873 },
  { id: 'temple', name: 'SUNKEN TEMPLE', drawCalls: 143, triangles: 104_866 },
  { id: 'serpentine', name: 'SERPENT PASS', drawCalls: 124, triangles: 116_114 },
  { id: 'lunar', name: 'LUNAR BASIN', drawCalls: 141, triangles: 85_878 },
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
    // Not every M10 course has width keys (THUNDER OVAL is full width) or a hairpin.
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
    console.info('M10-10 render measurement', JSON.stringify({ id, meshes,
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
  });
}

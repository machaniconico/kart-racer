import { test, expect } from '@playwright/test';
import type {} from './multiplayer.spec';

// C-010 timing (2026-10-05): npm test, 738 passed, Vitest 4.57 s / wall 4.84 s.
// .omc/baseline-v3.txt records 3 s before C-001; the 6 s budget needs no seed reduction.
const courses = [
  // M1-04 pre-change baseline (10 stationary frames), recorded in buildCourse.test.ts.
  { id: 'meadow', name: 'MEADOW LOOP', layout: 1, drawCalls: 123, triangles: 41_530 },
  { id: 'canyon', name: 'SUNSCAR CANYON', layout: 2, drawCalls: 128, triangles: 46_784 },
  { id: 'snowpeak', name: 'FROSTBITE PEAK', layout: 1, drawCalls: 125, triangles: 41_810 },
  { id: 'neon', name: 'NEON NIGHTLINE', layout: 1, drawCalls: 125, triangles: 66_080 },
] as const;

for (const { id, name, layout, drawCalls: baselineDrawCalls, triangles: baselineTriangles } of courses) {
  test(`C-010: ${name} selection, three laps, isolated best and draw budget`, async ({ page }, testInfo) => {
    await page.goto('./');
    await expect(page.locator('#title-screen')).toBeVisible();
    await page.waitForFunction(() => !!window.__kartDebug);
    expect(await page.evaluate(() => localStorage.getItem('pocket-circuit.best.v3'))).toBeNull();
    await page.locator(`#course-select input[value="${id}"]`).check();
    await expect(page.locator('#course-name')).toHaveText(name);
    await expect.poll(() => page.evaluate(() => ({
      selected: window.__kartDebug.course, rendered: window.__kartDebug.render.trackId,
    }))).toEqual({ selected: id, rendered: id });
    await page.locator('#start-race').click();
    await expect(page.locator('#race-screen')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__kartDebug.state.phase)).toBe('racing');
    // Sample completed WebGL frames while all eight racers are still on the grid.
    const renderSamples = await page.evaluate(async () => {
      const samples: { drawCalls: number; triangles: number }[] = [];
      for (let frame = 0; frame < 5; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const { drawCalls, triangles } = window.__kartDebug.render as typeof window.__kartDebug.render & { triangles: number };
        samples.push({ drawCalls, triangles });
      }
      return samples;
    });
    for (const { drawCalls, triangles } of renderSamples) {
      expect(drawCalls).toBeGreaterThan(0);
      expect(drawCalls).toBeLessThanOrEqual(200);
      expect(drawCalls).toBeLessThanOrEqual(baselineDrawCalls + 20);
      expect(triangles).toBeGreaterThan(0);
      expect(triangles).toBeLessThanOrEqual(baselineTriangles + 15_000);
    }
    await testInfo.attach('draw-calls', {
      body: JSON.stringify({ id, baselineDrawCalls, baselineTriangles, renderSamples }), contentType: 'application/json',
    });
    await page.evaluate(() => window.__kartDebug.advance(60 * 200, true));
    await expect(page.locator('#results-screen')).toBeVisible();
    await expect(page.locator('#results-course')).toHaveText(`${name} · 3 LAPS`);
    const state = await page.evaluate(() => window.__kartDebug.state);
    expect(state.trackId).toBe(id);
    expect(state.phase).toBe('finished');
    expect(state.karts).toHaveLength(8);
    // Solo results open when the human finishes; trailing CPUs can still be racing.
    expect(state.karts[0].lapTimes).toHaveLength(3);
    expect(state.karts[0].finishTime).toBeGreaterThan(0);
    const bests = await page.evaluate(() => JSON.parse(localStorage.getItem('pocket-circuit.best.v3') ?? '{}'));
    expect(bests).toEqual({ [id]: { time: state.karts[0].finishTime, layout } });
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

test('C-010: eight course switches keep renderer geometry memory bounded', async ({ page }, testInfo) => {
  await page.goto('./');
  await page.waitForFunction(() => !!window.__kartDebug?.rendererInfo);
  // Canyon has the largest geometry count (80); visit every course twice.
  const sequence = ['canyon', 'snowpeak', 'neon', 'meadow', 'canyon', 'snowpeak', 'neon', 'meadow'] as const;
  const samples = [];
  for (const id of sequence) {
    const sample = await page.evaluate(async trackId => {
      const oldInfo = window.__kartDebug.rendererInfo!;
      window.__kartDebug.selectCourse(trackId);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return {
        trackId: window.__kartDebug.render.trackId,
        geometries: window.__kartDebug.rendererInfo!.memory.geometries,
        disposedGeometries: oldInfo.memory.geometries,
      };
    }, id);
    expect(sample.trackId).toBe(id);
    expect(sample.geometries).toBeGreaterThan(0);
    expect(sample.disposedGeometries).toBe(0);
    samples.push(sample);
  }
  await testInfo.attach('geometry-memory', {
    body: JSON.stringify(samples), contentType: 'application/json',
  });
  for (const [index, sample] of samples.entries()) {
    expect(sample.geometries).toBeLessThanOrEqual(samples[0].geometries);
    if (index >= 4) expect(sample.geometries).toBe(samples[index - 4].geometries);
  }
});

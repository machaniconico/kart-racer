import { test, expect } from '@playwright/test';
import type {} from './multiplayer.spec';

// C-010 timing (2026-10-05): npm test, 738 passed, Vitest 4.57 s / wall 4.84 s.
// .omc/baseline-v3.txt records 3 s before C-001; the 6 s budget needs no seed reduction.
const courses = [
  { id: 'meadow', name: 'MEADOW LOOP' },
  { id: 'canyon', name: 'SUNSCAR CANYON' },
  { id: 'snowpeak', name: 'FROSTBITE PEAK' },
  { id: 'neon', name: 'NEON NIGHTLINE' },
] as const;

for (const { id, name } of courses) {
  test(`C-010: ${name} selection, three laps, isolated best and draw budget`, async ({ page }, testInfo) => {
    await page.goto('./');
    await expect(page.locator('#title-screen')).toBeVisible();
    await page.waitForFunction(() => !!window.__kartDebug);
    expect(await page.evaluate(() => localStorage.getItem('pocket-circuit.best.v2'))).toBeNull();
    await page.locator(`#course-select input[value="${id}"]`).check();
    await expect(page.locator('#course-name')).toHaveText(name);
    await expect.poll(() => page.evaluate(() => ({
      selected: window.__kartDebug.course, rendered: window.__kartDebug.render.trackId,
    }))).toEqual({ selected: id, rendered: id });
    await page.locator('#start-race').click();
    await expect(page.locator('#race-screen')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__kartDebug.state.phase)).toBe('racing');
    // Sample completed WebGL frames while all eight racers are still on the grid.
    const drawCalls = await page.evaluate(async () => {
      const samples: number[] = [];
      for (let frame = 0; frame < 5; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        samples.push(window.__kartDebug.render.drawCalls);
      }
      return samples;
    });
    for (const calls of drawCalls) {
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThanOrEqual(200);
    }
    await testInfo.attach('draw-calls', {
      body: JSON.stringify({ id, drawCalls }), contentType: 'application/json',
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
    const bests = await page.evaluate(() => JSON.parse(localStorage.getItem('pocket-circuit.best.v2') ?? '{}'));
    expect(bests).toEqual({ [id]: state.karts[0].finishTime });
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

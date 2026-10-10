import { test, expect } from '@playwright/test';
import type {} from './multiplayer.spec';
import { getTrack } from '../src/sim/tracks';
import { sampleTrack } from '../src/sim/track';

// C-010 timing (2026-10-05): npm test, 738 passed, Vitest 4.57 s / wall 4.84 s.
// .omc/baseline-v3.txt records 3 s before C-001; the 6 s budget needs no seed reduction.
const courses = [
  // M1-04 pre-change baseline (10 stationary frames), recorded in buildCourse.test.ts.
  { id: 'meadow', name: 'MEADOW LOOP', layout: 1, drawCalls: 123, triangles: 41_530 },
  { id: 'canyon', name: 'SUNSCAR CANYON', layout: 3, drawCalls: 128, triangles: 46_784 },
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
    await page.evaluate(() => {
      const debug = window.__kartDebug as typeof window.__kartDebug & { clearItems(): void };
      for (let second = 0; second < 200 && debug.state.phase !== 'finished'; second++) {
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
    const start = split.from - 40;
    // Sample the actual course at 10 cm intervals for a lane-centre steering target.
    const points = Array.from({ length: Math.ceil((split.to + 30 - start) * 10) + 1 },
      (_, i) => sampleTrack(track, start + i / 10));
    const boost = track.def.surfaces.find(zone => zone.kind === 'boost')!;
    const jump = track.def.surfaces.find(zone => zone.kind === 'jump' && zone.offsetMin !== undefined)!;
    const log = await page.evaluate(({ split, center, start, points, boost, jump, missedBoost }) => {
      const debug = window.__kartDebug as typeof window.__kartDebug & { clearItems(): void };
      const kart = debug.state.karts[0];
      const point = points[0];
      Object.assign(kart, {
        x: point.x + point.nx * center, y: point.y, z: point.z + point.nz * center,
        heading: Math.atan2(point.tx, point.tz), trackDistance: start, lateralOffset: center,
        speed: 0, steer: 0, boostTime: 0, spinTime: 0, airTime: 0,
      });
      const initial = { trackDistance: kart.trackDistance, lateralOffset: kart.lateralOffset, speed: kart.speed };
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
            // Merge back to the road centre over the 20 m after the island.
            const offset = center * Math.max(0, Math.min(1, (split.to + 20 - distance) / 20));
            const desired = Math.atan2(target.x + target.nx * offset - kart.x, target.z + target.nz * offset - kart.z);
            const error = Math.atan2(Math.sin(desired - kart.heading), Math.cos(desired - kart.heading));
            const steer = Math.max(-1, Math.min(1, error * 4));
            // Invert playerSteerToSim and the gamepad's 0.14 deadzone.
            axis = steer === 0 ? 0 : -Math.sign(steer) * (0.14 + Math.abs(steer) * 0.86);
            // The pad spans the whole lane in M2-05: a 0.5 m lateral miss hits a wall.
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
      return { initial, ticks, events, trackDistance: kart.trackDistance };
    }, { split, center, start, points, boost, jump, missedBoost });
    await testInfo.attach('canyon-shortcut', { body: JSON.stringify(log), contentType: 'application/json' });
    expect(log.initial).toEqual({ trackDistance: start, lateralOffset: center, speed: 0 });
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

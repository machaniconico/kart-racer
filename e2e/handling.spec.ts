import { test, expect, type Page } from '@playwright/test';
import type { KartDebug } from '../src/main';
import { getTrack } from '../src/sim/tracks';
import { widthAt } from '../src/sim/corridor';

declare const window: Window & { __kartDebug: KartDebug };

// Handling v5 (H6). Touch projects steer through Controls with assist on by default; sensitivity is touch-only UI.
// Ticks run synchronously inside page.evaluate (__kartDebug.advance), so the sampling is exact and not timing dependent.
const SENSITIVITY_KEY = 'pocket-circuit.steer-sensitivity.v1';

async function startSolo(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => !!window.__kartDebug);
  await page.locator('#start-race').click();
  await expect(page.locator('#race-screen')).toBeVisible();
  await page.waitForFunction(() => window.__kartDebug.state.phase === 'racing' && window.__kartDebug.state.time > 1);
}

test('M12-24: holding throttle 0.4 s before GO shows ROCKET START and leads by at least 6 m after 2 s', async ({ page }, testInfo) => {
  await page.goto('./');
  await page.waitForFunction(() => !!window.__kartDebug);
  await page.locator('#start-race').click();
  await expect(page.locator('#race-screen')).toBeVisible();
  await page.locator('#game-canvas').focus();

  const log = await page.evaluate(async () => {
    const debug = window.__kartDebug;
    const { createRace, getTrack, FIXED_DT } = debug.modules;
    const key = (type: 'keydown' | 'keyup') => window.dispatchEvent(
      new KeyboardEvent(type, { code: 'ArrowUp', key: 'ArrowUp', cancelable: true }));
    const reset = () => {
      key('keyup');
      Object.assign(debug.state, createRace(3, { trackId: 'meadow', karts: 1, itemBoxes: false }));
      debug.advance(0);
      return debug.state.karts[0];
    };
    const status = document.getElementById('race-status')!;
    const visible = () => !status.hidden && getComputedStyle(status).visibility === 'visible'
      && status.getBoundingClientRect().width > 0;
    const trackLength = getTrack('meadow').length;
    const travelled = (from: number) => (debug.state.karts[0].trackDistance - from + trackLength) % trackLength;

    try {
      // Both runs use the same human kart and Controls input, without CPUs, items or autopilot.
      const plain = reset();
      const plainStart = plain.trackDistance;
      debug.advance(180);
      const plainBoost = plain.boostTime;
      key('keydown');
      debug.advance(120);
      const baseline = { boost: plainBoost, time: debug.state.time, distance: travelled(plainStart) };

      const rocket = reset();
      const rocketStart = rocket.trackDistance;
      // The next input is sampled on tick 156: exactly 24 held ticks (156..179) before GO.
      debug.advance(155);
      const firstHeldTick = debug.state.tick + 1;
      key('keydown');
      debug.advance(24);
      const countdown = { tick: debug.state.tick, heldSeconds: rocket.boostTime, statusVisible: visible() };

      // Let the real frame loop cross GO and deliver its boost event to GameUI.noteEvents.
      // debug.advance alone deliberately does not deliver those events to the HUD.
      const go = await new Promise<{ tick: number; boost: number; text: string | null; visible: boolean }>(resolve => {
        const poll = () => {
          if (debug.state.phase === 'countdown') { requestAnimationFrame(poll); return; }
          resolve({ tick: debug.state.tick, boost: rocket.boostTime + (debug.state.tick - 180) * FIXED_DT,
            text: status.textContent, visible: visible() });
        };
        requestAnimationFrame(poll);
      });
      // Finish at tick 300 even if the GO frame stepped several ticks on a slow machine.
      debug.advance(300 - debug.state.tick);
      return { firstHeldTick, human: rocket.human, countdown, go, baseline,
        boosted: { tick: debug.state.tick, time: debug.state.time, distance: travelled(rocketStart) },
        lead: travelled(rocketStart) - baseline.distance };
    } finally {
      key('keyup');
    }
  });

  await testInfo.attach('rocket-start', { body: JSON.stringify(log), contentType: 'application/json' });
  expect(log.human).toBe(true);
  expect(log.firstHeldTick).toBe(156);
  expect(log.countdown.tick).toBe(179);
  expect(log.countdown.heldSeconds).toBeCloseTo(0.4, 10);
  expect(log.countdown.statusVisible).toBe(false);
  expect(log.baseline.boost).toBe(0);
  expect(log.go.tick).toBeGreaterThanOrEqual(180);
  expect(log.go.tick).toBeLessThan(240);
  expect(log.go.boost).toBeCloseTo(1, 10);
  expect(log.go.text).toBe('ROCKET START!');
  expect(log.go.visible).toBe(true);
  expect(log.baseline.time).toBeCloseTo(2, 10);
  expect(log.boosted.tick).toBe(300);
  expect(log.boosted.time).toBeCloseTo(2, 10);
  expect(log.lead).toBeGreaterThanOrEqual(6);
});

test.describe('touch device', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } });

  test('H6: assist on and no input for 8 s does not pin the kart against the wall', async ({ page }) => {
    await page.goto('./');
    await page.waitForFunction(() => !!window.__kartDebug);
    await expect(page.locator('#assist-title')).toBeChecked();
    await page.locator('#start-race').click();
    await expect(page.locator('#race-screen')).toBeVisible();
    await page.waitForFunction(() => window.__kartDebug.state.phase === 'racing' && window.__kartDebug.state.time > 1);
    const track = getTrack('meadow');
    const log = await page.evaluate(() => {
      const debug = window.__kartDebug;
      const me = debug.state.karts[0];
      const samples: { lat: number; speed: number; distance: number }[] = [];
      for (let tick = 0; tick < 60 * 8; tick++) {
        debug.advance(1);
        samples.push({ lat: me.lateralOffset, speed: me.speed, distance: me.trackDistance });
      }
      return { samples, lapProgress: me.trackDistance, phase: debug.state.phase };
    });
    expect(log.phase).toBe('racing');
    let streak = 0;
    let longest = 0;
    for (const { lat, distance } of log.samples) {
      streak = Math.abs(lat) > widthAt(track, distance).roadHalfWidth ? streak + 1 : 0;
      longest = Math.max(longest, streak);
    }
    // Pinned to the rail would hold |lateralOffset| near wallHalfWidth - KART_RADIUS for the whole run.
    expect(longest).toBeLessThan(60 * 2);
    for (const sample of log.samples) expect(Math.abs(sample.lat)).toBeLessThan(widthAt(track, sample.distance).wallHalfWidth);
    const last = log.samples.slice(-60);
    expect(last.some(s => Math.abs(s.lat) < widthAt(track, s.distance).roadHalfWidth)).toBe(true);
    expect(log.samples[log.samples.length - 1].speed).toBeGreaterThan(5);
  });

  test('H6: sensitivity slider value survives a reload', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('#sens-title')).toBeVisible();
    await expect(page.locator('#sens-title')).toHaveValue('3');
    await page.locator('#sens-title').fill('5');
    await expect(page.locator('#sens-title ~ .sens-value')).toHaveText('5');
    expect(await page.evaluate(key => localStorage.getItem(key), SENSITIVITY_KEY)).toBe('5');
    await page.reload();
    await expect(page.locator('#sens-title')).toHaveValue('5');
    await expect(page.locator('#sens-title ~ .sens-value')).toHaveText('5');
    // The pause dialog's slider is the same setting.
    await page.locator('#start-race').click();
    await expect(page.locator('#race-screen')).toBeVisible();
    expect(await page.locator('#sens-pause').inputValue()).toBe('5');
  });

  test('M1-06: CANYON touch assist clears the narrow section and pillars in 20 s per feature', async ({ page }, testInfo) => {
    // Layout 3 (M2-05) adds the rock island. As in assist.test.ts, a no-input kart may brush its
    // lane wall around the island (at most 2 wall hits within split ± 40 m); bands and the pit stay clean.
    await page.goto('./');
    await page.waitForFunction(() => !!window.__kartDebug);
    await page.locator('#course-select input[value="canyon"]').check();
    await expect(page.locator('#assist-title')).toBeChecked();
    await page.locator('#start-race').click();
    await expect(page.locator('#race-screen')).toBeVisible();
    await expect(page.locator('#auto-accelerate')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForFunction(() => window.__kartDebug.state.phase === 'racing');

    const { widthKeys: allWidthKeys = [], barriers: allBarriers = [], splits = [] } = getTrack('canyon').def;
    const split = splits[0]!;
    const islandWindow = { from: split.from - 40, to: split.to + 40 };
    const outsideIsland = (distance: number) => distance < islandWindow.from || distance > islandWindow.to;
    const widthKeys = allWidthKeys.filter(key => outsideIsland(key.distance)
      && key.roadHalfWidth < getTrack('canyon').def.roadHalfWidth);
    const barriers = allBarriers.filter(barrier => outsideIsland(barrier.from) && outsideIsland(barrier.to));
    expect(widthKeys.length).toBeGreaterThan(0);
    expect(barriers.length).toBeGreaterThan(0);
    const narrow = { from: widthKeys[0].distance, to: widthKeys[widthKeys.length - 1].distance };
    const log = await page.evaluate(({ narrow, barriers, split }) => {
      const debug = window.__kartDebug;
      const { createRace, getTrack, sampleTrack } = debug.modules;
      // Each run approaches one M1-06 feature from 60 m out and counts hits only until 60 m past it;
      // the rest of the 20 s (e.g. the western S bends) is covered by the full-lap assist.test.ts.
      const pillarsTo = Math.max(...barriers.map(barrier => barrier.to));
      const runs = [{ from: Math.max(0, barriers[0].from - 60), to: pillarsTo + 60 },
        { from: split.from - 60, to: split.to + 60 }, { from: narrow.from - 60, to: narrow.to + 60 }];
      let elapsed = 0;
      const distances: number[] = [];
      const hitEvents: { time: number; trackDistance: number; lateralOffset: number; value?: number }[] = [];
      for (const { from: start, to: end } of runs) {
        Object.assign(debug.state, createRace(127, { trackId: 'canyon' }));
        debug.state.phase = 'racing';
        const point = sampleTrack(getTrack('canyon'), start);
        Object.assign(debug.state.karts[0], { x: point.x, y: point.y, z: point.z,
          trackDistance: start, lateralOffset: 0, heading: Math.atan2(point.tx, point.tz) });
        const startTime = debug.state.time;
        for (let tick = 0; tick < 60 * 20; tick++) {
          // This run measures the assist against walls and bands only, so take CPU items out of play:
          // a stray shell or banana spin would otherwise count as a hit and make the result seed-dependent.
          debug.clearItems();
          // Keep Controls' touch assist and auto-accelerate active; no AI autopilot or driver input.
          debug.advance(1);
          // Events are replaced each tick, so count every player hit before advancing again.
          const { trackDistance, lateralOffset } = debug.state.karts[0];
          for (const event of debug.state.events.filter(event => event.type === 'hit' && event.kartId === 0 && trackDistance <= end)) {
            hitEvents.push({ time: debug.state.time, trackDistance, lateralOffset, value: event.value });
          }
          distances.push(trackDistance);
        }
        elapsed += debug.state.time - startTime;
      }
      return {
        hits: hitEvents.length, hitEvents, elapsed, trackId: debug.state.trackId,
        phase: debug.state.phase, trackDistance: debug.state.karts[0].trackDistance,
        enteredNarrow: distances.some(distance => distance >= narrow.from && distance <= narrow.to),
        passedPillars: barriers.map(barrier => distances.some(distance => distance >= barrier.from && distance <= barrier.to)),
      };
    }, { narrow, barriers, split });
    await testInfo.attach('canyon-touch-assist', { body: JSON.stringify(log), contentType: 'application/json' });
    expect(log.trackId).toBe('canyon');
    expect(log.phase).toBe('racing');
    expect(log.elapsed).toBeCloseTo(3 * 20, 6);
    expect(log.enteredNarrow).toBe(true);
    expect(log.passedPillars).toEqual(barriers.map(() => true));
    expect(log.trackDistance).toBeGreaterThan(narrow.to);
    expect(log.trackDistance).toBeGreaterThan(Math.max(...barriers.map(barrier => barrier.to)));
    const inIsland = (hit: { trackDistance: number }) => !outsideIsland(hit.trackDistance);
    expect(log.hitEvents.filter(hit => hit.value !== undefined), JSON.stringify(log)).toEqual([]);
    expect(log.hitEvents.filter(hit => !inIsland(hit)), JSON.stringify(log)).toEqual([]);
    expect(log.hitEvents.filter(inIsland).length, JSON.stringify(log)).toBeLessThanOrEqual(2);
  });
});

// GameRenderer reads prefers-reduced-motion once at construction, so emulate it before the first navigation.
// The renderer's camera look-ahead offset (private `lookAhead`, metres) is read through __kartDebug.renderer.
async function maxLookAhead(page: Page): Promise<number> {
  await startSolo(page);
  return page.evaluate(async () => {
    const debug = window.__kartDebug;
    let peak = 0;
    for (let i = 0; i < 60 * 8; i++) {
      debug.advance(1, true);
      // Let the renderer run its camera blend for this tick.
      if (i % 10 === 0) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const look = (debug.renderer as unknown as { lookAhead: { x: number; z: number } }).lookAhead;
      peak = Math.max(peak, Math.hypot(look.x, look.z));
    }
    return peak;
  });
}

test('H6: camera look-ahead is active normally and exactly zero under reduced motion', async ({ page, browser }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const normal = await maxLookAhead(page);
  // Sanity: the probe can see the offset on a curve (max is LOOK_AHEAD_MAX = 3.5 m).
  expect(normal).toBeGreaterThan(0.3);
  // Stop the first race before the second: two live WebGL races share headless Chromium's GPU,
  // and once frames exceed the 0.1 s step clamp the countdown runs slower than wall-clock time.
  await page.goto('about:blank');

  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 720 } });
  const reduced = await context.newPage();
  try {
    await reduced.emulateMedia({ reducedMotion: 'reduce' });
    expect(await maxLookAhead(reduced)).toBe(0);
  } finally {
    await context.close();
  }
});

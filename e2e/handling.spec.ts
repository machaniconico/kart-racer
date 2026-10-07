import { test, expect, type Page } from '@playwright/test';
import type {} from './multiplayer.spec';
import { getTrack } from '../src/sim/tracks';

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

test.describe('touch device', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } });

  test('H6: assist on and no input for 8 s does not pin the kart against the wall', async ({ page }) => {
    await page.goto('./');
    await page.waitForFunction(() => !!window.__kartDebug);
    await expect(page.locator('#assist-title')).toBeChecked();
    await page.locator('#start-race').click();
    await expect(page.locator('#race-screen')).toBeVisible();
    await page.waitForFunction(() => window.__kartDebug.state.phase === 'racing' && window.__kartDebug.state.time > 1);
    const { roadHalfWidth, wallHalfWidth } = getTrack('meadow').def;
    const log = await page.evaluate(() => {
      const debug = window.__kartDebug;
      const me = debug.state.karts[0];
      const samples: { lat: number; speed: number }[] = [];
      for (let tick = 0; tick < 60 * 8; tick++) {
        debug.advance(1);
        samples.push({ lat: me.lateralOffset, speed: me.speed });
      }
      return { samples, lapProgress: me.trackDistance, phase: debug.state.phase };
    });
    expect(log.phase).toBe('racing');
    let streak = 0;
    let longest = 0;
    for (const { lat } of log.samples) {
      streak = Math.abs(lat) > roadHalfWidth ? streak + 1 : 0;
      longest = Math.max(longest, streak);
    }
    // Pinned to the rail would hold |lateralOffset| near wallHalfWidth - KART_RADIUS for the whole run.
    expect(longest).toBeLessThan(60 * 2);
    expect(Math.max(...log.samples.map(s => Math.abs(s.lat)))).toBeLessThan(wallHalfWidth);
    const last = log.samples.slice(-60);
    expect(Math.min(...last.map(s => Math.abs(s.lat)))).toBeLessThan(roadHalfWidth);
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

  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 720 } });
  const reduced = await context.newPage();
  try {
    await reduced.emulateMedia({ reducedMotion: 'reduce' });
    expect(await maxLookAhead(reduced)).toBe(0);
  } finally {
    await context.close();
  }
});

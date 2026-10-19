import { test, expect, type Locator, type Page } from '@playwright/test';
import type { KartDebug } from '../src/main';
import { GP_POINTS } from '../src/gp/grandPrix';

declare const window: Window & { __kartDebug: KartDebug };

// Results display hundredths; the stored record and ghost below retain exact times.
function resultTime(seconds: number): string {
  const hundredths = Math.floor(seconds * 100);
  const minutes = String(Math.floor(hundredths / 6000)).padStart(2, '0');
  const remainder = String(Math.floor(hundredths / 100) % 60).padStart(2, '0');
  return `${minutes}:${remainder}.${String(hundredths % 100).padStart(2, '0')}`;
}

async function openTitle(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => !!window.__kartDebug);
  await expect(page.locator('#title-screen')).toBeVisible();
}

async function finishRace(page: Page, idleSeconds = 0): Promise<number> {
  await page.waitForFunction(() => window.__kartDebug.state.phase === 'racing');
  // Match courses.spec: one simulated second per batch, at most 420 seconds.
  // Keep the loop synchronous so rendering cannot interleave extra driving inputs.
  await page.evaluate(idleSeconds => {
    const debug = window.__kartDebug;
    for (let second = 0; second < 420 && debug.state.phase !== 'finished'; second++) {
      debug.clearItems();
      debug.advance(60, second >= idleSeconds);
    }
  }, idleSeconds);
  await expect(page.locator('#results-screen')).toBeVisible();
  const state = await page.evaluate(() => window.__kartDebug.state);
  expect(state.phase).toBe('finished');
  expect(state.laps).toBe(1);
  expect(state.karts[0].lapTimes).toHaveLength(1);
  expect(state.karts[0].finishTime).toBeGreaterThan(0);
  return state.karts[0].finishTime!;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { width, viewport } = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth, viewport: window.innerWidth,
  }));
  expect(width).toBeLessThanOrEqual(viewport);
}

async function expectTouchTargets(targets: Locator, count: number): Promise<void> {
  await expect(targets).toHaveCount(count);
  for (const target of await targets.all()) {
    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
}

test('M7-07: CPU difficulty persists through starting a race and reloading', async ({ page }) => {
  await openTitle(page);
  await expect(page.getByRole('radio', { name: 'ふつう', exact: true })).toBeChecked();
  expect(await page.evaluate(() => window.__kartDebug.state.cpuLevel)).toBe('normal');
  await page.getByRole('radio', { name: 'つよい', exact: true }).check();
  await page.locator('#start-race').click();
  await expect(page.locator('#race-screen')).toBeVisible();
  expect(await page.evaluate(() => window.__kartDebug.state.cpuLevel)).toBe('hard');

  await page.reload();
  await page.waitForFunction(() => !!window.__kartDebug);
  await expect(page.locator('#title-screen')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'つよい', exact: true })).toBeChecked();
  expect(await page.evaluate(() => window.__kartDebug.state.cpuLevel)).toBe('hard');
  await page.locator('#start-race').click();
  expect(await page.evaluate(() => window.__kartDebug.state.cpuLevel)).toBe('hard');
});

test('M7-07: SUNRISE CUP runs four races, totals points and shows the podium', async ({ page }) => {
  await openTitle(page);
  await page.locator('#mode-select input[value="gp"]').check();
  await page.getByRole('radio', { name: /SUNRISE CUP/ }).check();
  await page.locator('#laps-select input[value="1"]').check();
  await page.locator('#cpu-select input[value="hard"]').check();
  await page.locator('#start-race').click();

  const tracks = ['meadow', 'canyon', 'snowpeak', 'neon'];
  const pointsPerRace = GP_POINTS.reduce<number>((sum, points) => sum + points, 0);
  for (const [index, trackId] of tracks.entries()) {
    await test.step(`Race ${index + 1}: ${trackId}`, async () => {
      await page.waitForFunction(() => window.__kartDebug.state.phase === 'racing');
      expect(await page.evaluate(() => window.__kartDebug.state.trackId)).toBe(trackId);
      expect(await page.evaluate(() => window.__kartDebug.state.cpuLevel)).toBe('hard');
      await finishRace(page);
      await expect(page.locator('#retry-race')).toHaveText('順位表へ');
      await page.locator('#retry-race').click();
      await expect(page.locator('#standings-screen')).toBeVisible();
      await expect(page.locator('#gp-cup')).toHaveText('SUNRISE CUP');
      await expect(page.locator('.standings-row')).toHaveCount(8);
      const points = (await page.locator('.standings-row .standings-points').allTextContents()).map(text => parseInt(text, 10));
      expect(points.reduce((sum, value) => sum + value, 0)).toBe(pointsPerRace * (index + 1));
      const gp = await page.evaluate(() => window.__kartDebug.gp);
      expect(gp?.raceIndex).toBe(index + 1);
      expect(gp?.standings.map(row => row.points)).toEqual(points);

      if (index < tracks.length - 1) {
        await expect(page.locator('.podium')).toHaveCount(0);
        await expect(page.locator('#gp-next')).toHaveText('次のレースへ');
        await page.locator('#gp-next').click();
        expect(await page.evaluate(() => window.__kartDebug.state.trackId)).toBe(tracks[index + 1]);
      } else {
        await expect(page.locator('.podium > .podium-place')).toHaveCount(3);
        expect(await page.locator('.podium-place').evaluateAll(places => places.map(place => Number((place as HTMLElement).dataset.kartId))))
          .toEqual(gp!.standings.slice(0, 3).map(row => row.kartId));
        await expect(page.locator('#gp-next')).toHaveText('タイトルへ');
        await page.locator('#gp-next').click();
        await expect(page.locator('#title-screen')).toBeVisible();
      }
    });
  }
});

test('M7-07: time attack saves the exact time and replays an identical ghost without replacing a faster best', async ({ page }) => {
  await openTitle(page);
  await page.locator('#mode-select input[value="timeattack"]').check();
  await page.locator('#course-select input[value="meadow"]').check();
  await page.locator('#laps-select input[value="1"]').check();
  expect(await page.evaluate(() => window.__kartDebug.timeAttackRecord('meadow', 1))).toBeNull();
  await page.locator('#start-race').click();
  const grid = await page.evaluate(() => window.__kartDebug.state);
  expect(grid.karts).toHaveLength(1);
  expect(grid.boxes).toHaveLength(0);
  const firstTime = await finishRace(page);
  await expect(page.locator('#finish-time')).toHaveText(resultTime(firstTime));
  const firstRecord = await page.evaluate(() => window.__kartDebug.timeAttackRecord('meadow', 1));
  expect(firstRecord?.time).toBe(firstTime);
  await page.locator('#back-title').click();
  await expect(page.locator('#title-screen')).toBeVisible();
  await expect(page.locator('#title-best')).toContainText('BEST');

  await page.locator('#start-race').click();
  expect(await page.evaluate(() => window.__kartDebug.ghost?.active)).toBe(true);
  await expect(page.locator('#item-display')).toBeHidden();
  // Wait (real frames) until the ghost is moving, then sample its wheel spin 500 ms apart.
  await page.waitForFunction(() => window.__kartDebug.ghost?.active && window.__kartDebug.ghost.speed > 5, undefined, { timeout: 30_000 });
  const spin0 = await page.evaluate(() => window.__kartDebug.render.ghost?.wheelSpin ?? null);
  await page.waitForTimeout(500);
  const spin1 = await page.evaluate(() => window.__kartDebug.render.ghost?.wheelSpin ?? null);
  expect(await page.evaluate(() => window.__kartDebug.ghost?.active && window.__kartDebug.ghost.speed > 5)).toBe(true);
  expect(spin0).not.toBeNull();
  expect(spin1! - spin0!).toBeGreaterThanOrEqual(1);
  // A stationary minute makes the slower-run branch mandatory and lets the ghost finish first.
  const secondTime = await finishRace(page, 60);
  expect(secondTime).toBeGreaterThan(firstTime);
  await expect(page.locator('#finish-time')).toHaveText(resultTime(secondTime));
  const ghost = await page.evaluate(() => window.__kartDebug.ghost);
  expect(ghost?.diverged).toBe(false);
  expect(ghost?.finished).toBe(true);
  expect(ghost?.recordTime).toBe(firstTime);
  expect(ghost?.finishTime).toBe(ghost?.recordTime);
  await page.locator('#back-title').click();
  await expect(page.locator('#title-screen')).toBeVisible();
  expect(await page.evaluate(() => window.__kartDebug.timeAttackRecord('meadow', 1))).toEqual(firstRecord);
});

for (const viewport of [{ width: 360, height: 640 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`M7-07: ${viewport.width}x${viewport.height} mode controls and standings fit and remain clickable`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openTitle(page);
    await page.locator('#laps-select input[value="1"]').check();
    for (const mode of ['race', 'timeattack', 'gp']) {
      await page.locator(`#mode-select input[value="${mode}"]`).check();
      await expectNoHorizontalOverflow(page);
      await expectTouchTargets(page.locator('.mode-option'), 3);
      if (mode === 'timeattack') {
        await expect(page.locator('#cpu-select')).toBeHidden();
      } else {
        await expectTouchTargets(page.locator('.cpu-option'), 3);
      }
      if (mode === 'gp') {
        await expectTouchTargets(page.locator('.cup-option'), 5);
        for (const name of [/ZENITH CUP/, /ECLIPSE CUP/]) {
          await page.getByRole('radio', { name }).check();
          await expect(page.getByRole('radio', { name })).toBeChecked();
        }
        await page.getByRole('radio', { name: /SUNRISE CUP/ }).check();
      }
      // A real click must succeed, including Playwright's normal scrolling into view.
      await page.locator('#start-race').click();
      await expect(page.locator('#race-screen')).toBeVisible();
      expect(await page.evaluate(() => window.__kartDebug.playMode)).toBe(mode);
      if (mode === 'gp') {
        await finishRace(page);
        await page.locator('#retry-race').click();
        await expect(page.locator('#standings-screen')).toBeVisible();
        await expect(page.locator('.standings-row')).toHaveCount(8);
        await expectNoHorizontalOverflow(page);
        await expectTouchTargets(page.locator('#gp-next'), 1);
        await page.locator('#gp-next').click();
        expect(await page.evaluate(() => window.__kartDebug.state.trackId)).toBe('canyon');
      } else {
        await page.locator('#pause-race').click();
        await page.locator('#quit-race').click();
        await expect(page.locator('#title-screen')).toBeVisible();
      }
    }
  });
}

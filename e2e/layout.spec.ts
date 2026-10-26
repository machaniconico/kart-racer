import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

const MIN_TARGET = 44;
const viewports = [
  { width: 360, height: 640, portrait: true },
  { width: 390, height: 844, portrait: true },
  { width: 844, height: 390, portrait: false },
];

type Rect = { top: number; bottom: number; left: number; right: number };
const rectOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el): Rect => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
const intersects = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

async function attach(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await writeFile(path, await page.screenshot());
  await info.attach(name, { path, contentType: 'image/png' });
}

for (const vp of viewports) {
  test(`M9-04 title layout ${vp.width}x${vp.height}`, async ({ page }, info) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('./');
    await expect(page.locator('#title-screen')).toBeVisible();
    await expect(page.locator('#online-entry')).toBeVisible();
    await attach(page, info, `title-${vp.width}x${vp.height}-top`);

    if (vp.portrait) {
      const topbar = await rectOf(page, '.topbar');
      const screen = await rectOf(page, '.title-screen');
      expect(screen.top).toBeGreaterThanOrEqual(topbar.bottom);
    }

    await page.locator('.title-screen').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await attach(page, info, `title-${vp.width}x${vp.height}-bottom`);
    if (vp.portrait) {
      const strip = await rectOf(page, '.course-strip');
      const sheet = await rectOf(page, '#online-entry');
      expect(strip.bottom).toBeLessThanOrEqual(sheet.top);
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const targets = page.locator('.course-option, .mode-option, #start-race');
    expect(await page.locator('.course-option').count()).toBe(21);
    expect(await page.locator('.mode-option').count()).toBe(3);
    expect(await page.locator('#start-race').count()).toBe(1);
    // Scroll each target into view; the title scrolls inside .title-screen on portrait phones.
    for (const handle of await targets.all()) {
      // Measure in-page: Playwright's stability wait never settles under the animated title scene.
      const box = await handle.evaluate(el => {
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height, html: el.outerHTML.slice(0, 80) };
      });
      expect(box.width, box.html).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(box.height, box.html).toBeGreaterThanOrEqual(MIN_TARGET);
    }

    // The twenty-one course options must not overlap each other.
    const rects = await page.locator('.course-option').evaluateAll(els => els.map(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }));
    expect(rects).toHaveLength(21);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const intersects = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        expect(intersects, `course-option ${i} intersects ${j}`).toBe(false);
      }
    }
  });
}

test('M9-04 host notice does not overlap headings at 390x844', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(page.locator('#online-entry')).toBeVisible();
  await page.getByRole('button', { name: 'ルーム作成', exact: true }).click();
  await expect(page.locator('#lobby-screen')).toBeVisible({ timeout: 40_000 });
  const notice = page.locator('#host-notice');
  if (!(await notice.isVisible())) {
    await info.attach('host-notice.txt', { body: '#host-notice not visible at 390x844; nothing to intersect.', contentType: 'text/plain' });
    return;
  }
  await attach(page, info, 'host-notice-390x844');
  const n = await rectOf(page, '#host-notice');
  for (const selector of ['#online-heading', '.course-strip']) {
    const el = page.locator(selector).first();
    if (await el.isVisible()) expect(intersects(n, await rectOf(page, selector)), selector).toBe(false);
  }
});

// M10-09 boundary sizes around the CSS breakpoints (480/481, 700/701, 720, 800/801, 879/880, 959/960, 999/1000).
const boundarySizes = [
  [1280, 480], [1280, 481], [1280, 719], [1280, 720], [1280, 800], [1280, 801], [1280, 879], [1280, 880], [1280, 959], [1280, 960],
  [701, 720], [844, 481], [999, 720], [1000, 720], [999, 960], [1000, 960],
] as const;
for (const [width, height] of boundarySizes) {
  test(`M10-09 twenty-one-course title has no overlap at ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto('./');
    await expect(page.locator('#title-screen')).toBeVisible();
    await expect(page.locator('#online-entry')).toBeVisible();
    await attach(page, info, `title-${width}x${height}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const content = await rectOf(page, '.title-content');
    const strip = await rectOf(page, '.course-strip');
    expect(strip.top, 'strip sits below the title content').toBeGreaterThanOrEqual(content.bottom - 0.5);

    // Every option (and the start button) must be hit-testable at its own centre: nothing, including the online panel, covers it.
    const problems = await page.evaluate(() => {
      const bad: string[] = [];
      const courseOptions = [...document.querySelectorAll<HTMLElement>('.course-option')];
      // Intersections are measured in one snapshot, before any scrolling moves the rects.
      const rects = courseOptions.map(el => el.getBoundingClientRect());
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) bad.push(`option ${i} intersects ${j}`);
        }
      }
      for (const el of [...courseOptions, document.querySelector<HTMLElement>('#start-race')!]) {
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || !(hit === el || el.contains(hit))) bad.push(`${el.id || el.textContent?.trim()} covered by ${hit?.id || hit?.className || hit?.tagName}`);
      }
      return bad;
    });
    expect(problems).toEqual([]);
  });
}

import { test, expect, type Page } from '@playwright/test';
import type {} from './multiplayer.spec';

// The race loop keeps running between Playwright calls, so each scenario runs inside one page.evaluate:
// key events and __kartDebug.advance() are synchronous there, which makes the tick counts exact.
// Solo: kart 0 reads the keyboard through Controls; CPUs use their own AI.
const TICK = 1 / 60;

async function startSolo(page: Page) {
  await page.goto('./');
  await page.waitForFunction(() => !!window.__kartDebug);
  await page.locator('#start-race').click();
  await expect(page.locator('#race-screen')).toBeVisible();
  await page.waitForFunction(() => window.__kartDebug.state.phase === 'racing' && window.__kartDebug.state.time > 1);
}

type Step = { advance: number } | { key: 'down' | 'up' };

// Puts kart 0 on a box, runs one tick to pick it up, swaps in the instant 'dash' item, then plays the steps.
function scenario(page: Page, steps: Step[]) {
  return page.evaluate((plan) => {
    const debug = window.__kartDebug;
    const me = debug.state.karts[0];
    const box = debug.state.boxes[0];
    box.respawnTime = 0;
    me.item = null; me.speed = 0; me.effects.rouletteTime = 0; me.spinTime = 0;
    me.x = box.x; me.z = box.z;
    debug.advance(1);
    const log = [{ step: 'grab', item: me.item, roulette: me.effects.rouletteTime }];
    me.item = 'dash';
    for (const step of plan) {
      if ('key' in step) {
        document.body.dispatchEvent(new KeyboardEvent(step.key === 'down' ? 'keydown' : 'keyup', { code: 'KeyE', bubbles: true, cancelable: true }));
      } else {
        debug.advance(step.advance);
      }
      log.push({ step: JSON.stringify(step), item: me.item, roulette: me.effects.rouletteTime });
    }
    return log;
  }, steps);
}

test('R3: pressing ITEM during the roulette keeps the item, and it is usable after the roulette stops', async ({ page }) => {
  await startSolo(page);
  // Pressed inside the first 0.3 s: ignored, so neither the roulette nor the item changes.
  const log = await scenario(page, [{ advance: 3 }, { key: 'down' }, { advance: 5 }, { key: 'up' }, { advance: 3 }]);
  expect(log[0].roulette).toBeGreaterThan(1.3);
  expect(log[0].roulette).toBeLessThanOrEqual(1.4);
  expect(log[0].item).not.toBeNull();
  for (const entry of log.slice(1)) {
    expect(entry.item).toBe('dash');
    expect(entry.roulette).toBeGreaterThan(1.1);
  }

  const after = await scenario(page, [{ advance: Math.ceil(1.4 / TICK) + 2 }, { key: 'down' }, { advance: 2 }, { key: 'up' }]);
  const stopped = after[1];
  expect(stopped.roulette).toBe(0);
  expect(stopped.item).toBe('dash');
  expect(after[2].item).toBe('dash');
  expect(after[3].item).toBeNull();
});

test('R3: a press after 0.3 s stops the roulette early and the held press does not use the item', async ({ page }) => {
  await startSolo(page);
  const log = await scenario(page, [
    { advance: 20 }, { key: 'down' }, { advance: 1 }, { advance: 30 }, { key: 'up' }, { advance: 2 },
    { key: 'down' }, { advance: 2 }, { key: 'up' },
  ]);
  // Indexes: 1 after 20 ticks, 3 the tick after the press, 4 still held, 6 released, 8 pressed again.
  expect(log[1].roulette).toBeGreaterThan(0);
  expect(log[3].roulette).toBe(0);
  expect(log[3].item).toBe('dash');
  expect(log[4].roulette).toBe(0);
  expect(log[4].item).toBe('dash');
  expect(log[6].item).toBe('dash');
  expect(log[8].item).toBeNull();
});

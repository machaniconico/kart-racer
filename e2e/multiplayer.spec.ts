import { mkdir } from 'node:fs/promises';
import { test as base, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import type { NetPhase, RosterView } from '../src/net/session';
import type { RaceState, TrackId } from '../src/sim/types';

declare global {
  interface Window {
    __kartDebug: {
      screen: 'title' | 'lobby' | 'race' | 'results';
      mode: 'solo' | 'host' | 'guest';
      state: RaceState;
      course: TrackId;
      render: { drawCalls: number; trackId: TrackId | null };
      rendererInfo: { memory: { geometries: number } } | undefined;
      selectCourse(id: TrackId): void;
      net: { phase: NetPhase; slot: number; roster: RosterView | null };
      advance(ticks: number, autopilot?: boolean): void;
    };
  }
}

const CONNECTION_TIMEOUT = 40_000;
const RACE_TIMEOUT = 20_000;
const viewports = [
  { width: 375, height: 667 },
  { width: 667, height: 375 },
  { width: 844, height: 390 },
];

const test = base.extend<{ guest: Page; consoleLogs: void }>({
  guest: async ({ browser, contextOptions }, use) => {
    const context = await browser.newContext(contextOptions);
    try {
      await use(await context.newPage());
    } finally {
      await context.close();
    }
  },
  consoleLogs: [async ({ page, guest }, use, testInfo) => {
    const logs: string[] = [];
    for (const [label, client] of [['host', page], ['guest', guest]] as const) {
      client.on('console', message => logs.push(`[${label}] ${message.type()}: ${message.text()}`));
      client.on('pageerror', error => logs.push(`[${label}] pageerror: ${error.stack ?? error.message}`));
      client.on('requestfailed', request => logs.push(
        `[${label}] requestfailed: ${request.url()} ${request.failure()?.errorText}`,
      ));
    }
    try {
      await use();
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('browser-console.log', {
          body: logs.join('\n') || 'No browser console messages were emitted.',
          contentType: 'text/plain',
        });
        // The second context may already be closed by the disconnect scenario.
        if (!guest.isClosed()) {
          const shot = await guest.screenshot({ timeout: 5_000 }).catch(() => undefined);
          if (shot) await testInfo.attach('guest-failure', { body: shot, contentType: 'image/png' });
        }
      }
    }
  }, { auto: true }],
});

async function connect(host: Page, guest: Page): Promise<void> {
  await Promise.all([host.goto('./'), guest.goto('./')]);
  await Promise.all([host, guest].map(async page => {
    await expect(page.locator('#title-screen')).toBeVisible();
    await expect(page.locator('#online-entry')).toBeVisible();
    await page.waitForFunction(() => !!window.__kartDebug);
  }));
  await host.getByRole('button', { name: 'ルーム作成', exact: true }).click();
  await expect(host.locator('#lobby-screen')).toBeVisible({ timeout: CONNECTION_TIMEOUT });
  // N8 exposes the room output by id, without the proposed room-code test id.
  const room = host.locator('#lobby-code');
  await expect(room).toHaveText(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  const code = (await room.innerText()).trim();
  await guest.locator('#online-code').fill(code);
  await guest.getByRole('button', { name: '参加', exact: true }).click();
  await expect(guest.locator('#lobby-screen')).toBeVisible({ timeout: CONNECTION_TIMEOUT });
  await expect(guest.locator('#lobby-code')).toHaveText(code);
  for (const page of [host, guest]) {
    await expect(page.locator('#lobby-roster li')).toHaveCount(8);
    await expect.poll(() => page.evaluate(() =>
      window.__kartDebug.net.roster?.players.filter(player => player.kind !== 'cpu' && player.connected).length,
    )).toBe(2);
    await expect(page.locator('.lobby-player-tags').filter({ hasText: 'CPU' })).toHaveCount(6);
  }
  expect(await guest.evaluate(() => window.__kartDebug.net.slot)).toBe(1);
}

async function startRace(host: Page, guest: Page, trackId?: TrackId): Promise<void> {
  await test.step('Both clients count down and race within 20 seconds', async () => {
    await host.locator('#lobby-start').click();
    await Promise.all([host, guest].map(async page => {
      await expect.poll(() => page.evaluate(() => window.__kartDebug.net.phase)).toBe('countdown');
      if (trackId) expect(await page.evaluate(() => window.__kartDebug.state.trackId)).toBe(trackId);
      await expect(page.locator('#countdown-display')).toBeVisible();
      await expect(page.locator('#countdown-display')).toHaveText(/^[123]$/);
      await expect.poll(() => page.evaluate(() => ({
        phase: window.__kartDebug.net.phase,
        state: window.__kartDebug.state.phase,
        screen: window.__kartDebug.screen,
      })), { timeout: RACE_TIMEOUT }).toEqual({ phase: 'racing', state: 'racing', screen: 'race' });
      if (trackId) {
        expect(await page.evaluate(() => ({
          state: window.__kartDebug.state.trackId,
          render: window.__kartDebug.render.trackId,
        }))).toEqual({ state: trackId, render: trackId });
      }
    }));
  }, { timeout: RACE_TIMEOUT });
}

test('§8.2 1–4: room, profile, racing inputs, and guest disconnect', async ({ page: host, guest }) => {
  await test.step('Create and join a real PeerJS room with two isolated contexts', async () => {
    await connect(host, guest);
  });

  await test.step('Propagate the guest name and color to the host lobby', async () => {
    await guest.locator('#lobby-name').fill('E2Eゲスト');
    await guest.locator('#lobby-profile-save').click();
    await expect(host.locator('#lobby-roster li').nth(1)).toContainText('E2Eゲスト');
    await guest.getByRole('button', { name: 'ミント', exact: true }).click();
    for (const page of [host, guest]) {
      await expect.poll(() => page.evaluate(() => {
        const player = window.__kartDebug.net.roster?.players.find(player => player.slot === 1);
        return { name: player?.name, color: player?.color };
      })).toEqual({ name: 'E2Eゲスト', color: 0x56d9c1 });
      await expect(page.locator('#lobby-roster li').nth(1).locator('.lobby-color'))
        .toHaveCSS('background-color', 'rgb(86, 217, 193)');
    }
  });

  await test.step('Show both countdowns and deliver guest keyboard input to the host', async () => {
    await startRace(host, guest);
    await guest.bringToFront();
    await guest.locator('#game-canvas').focus();
    await guest.keyboard.down('ArrowUp');
    try {
      // N8 exposes the guest render/prediction view as debug.state, not net.view.
      await Promise.all([host, guest].map(page => expect.poll(() => page.evaluate(() =>
        window.__kartDebug.state.karts[1].speed,
      ), { timeout: 10_000 }).toBeGreaterThan(5)));
      expect(await host.evaluate(() => window.__kartDebug.state.karts[1].human)).toBe(true);
    } finally {
      await guest.keyboard.up('ArrowUp');
    }
  });

  await test.step('Closing the guest context hands slot 1 to the CPU', async () => {
    await guest.context().close();
    await expect.poll(() => host.evaluate(() =>
      window.__kartDebug.net.roster?.players.find(player => player.slot === 1)?.kind,
    ), { timeout: RACE_TIMEOUT }).toBe('cpu');
    await expect.poll(() => host.evaluate(() => window.__kartDebug.state.karts[1].human)).toBe(false);
    await expect(host.locator('#race-screen')).toBeVisible();
  });
});

test('C-010: host course selection reaches the guest within one second and starts neon', async ({ page: host, guest }, testInfo) => {
  await connect(host, guest);
  await expect(guest.locator('#lobby-course-select')).toBeHidden();
  await expect(guest.locator('#lobby-course-name')).toBeVisible();
  // Timestamp the actual change event and guest DOM update in the browsers.
  // Automation actionability waits and protocol round trips are outside the deadline.
  await host.locator('#lobby-course-select').evaluate(select => {
    select.addEventListener('change', () => {
      (select as HTMLElement).dataset.selectedAt = String(performance.timeOrigin + performance.now());
    }, { capture: true, once: true });
  });
  await guest.locator('#lobby-course-name').evaluate(output => {
    const observer = new MutationObserver(() => {
      if (output.textContent !== '04 NEON NIGHTLINE') return;
      (output as HTMLElement).dataset.displayedAt = String(performance.timeOrigin + performance.now());
      observer.disconnect();
    });
    observer.observe(output, { childList: true, characterData: true, subtree: true });
  });
  await host.locator('#lobby-course-select').selectOption('neon');
  await expect(guest.locator('#lobby-course-name')).toHaveText('04 NEON NIGHTLINE');
  const selectedAt = Number(await host.locator('#lobby-course-select').getAttribute('data-selected-at'));
  const displayedAt = Number(await guest.locator('#lobby-course-name').getAttribute('data-displayed-at'));
  expect(selectedAt).toBeGreaterThan(0);
  const elapsedMs = displayedAt - selectedAt;
  expect(elapsedMs).toBeGreaterThanOrEqual(0);
  expect(elapsedMs).toBeLessThanOrEqual(1_000);
  expect(await guest.evaluate(() => window.__kartDebug.course)).toBe('neon');
  await testInfo.attach('course-propagation', {
    body: JSON.stringify({ elapsedMs }), contentType: 'application/json',
  });
  await startRace(host, guest, 'neon');
});

test('§8.2 5: host context loss returns the guest to the title', async ({ page: host, guest }) => {
  await connect(host, guest);
  await startRace(host, guest);
  await host.context().close();
  await expect(guest.locator('#net-dialog')).toBeVisible({ timeout: RACE_TIMEOUT });
  await expect(guest.locator('#net-message')).toContainText('ホストとの接続が切れました');
  await guest.locator('#net-dialog-ok').click();
  await expect(guest.locator('#net-dialog')).toBeHidden();
  await expect(guest.locator('#title-screen')).toBeVisible();
  await expect(guest.locator('#online-entry')).toBeVisible();
  expect(await guest.evaluate(() => window.__kartDebug.mode)).toBe('solo');
});

async function captureLayouts(page: Page, screen: 'lobby' | 'results', testInfo: TestInfo): Promise<void> {
  const screenshotDir = testInfo.outputPath('screenshots');
  await mkdir(screenshotDir, { recursive: true });
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expect(page.locator(`#${screen}-screen`)).toBeVisible();
    await expect(page.locator(screen === 'lobby' ? '#lobby-roster li' : '#leaderboard li')).toHaveCount(8);
    await page.evaluate(() => document.fonts.ready);
    const filename = `${screen}-${viewport.width}x${viewport.height}.png`;
    const path = `${screenshotDir}/${filename}`;
    await page.screenshot({ path, animations: 'disabled' });
    await testInfo.attach(filename, { path, contentType: 'image/png' });
  }
}

test('§8.2 6: lobby and eight-row results at three mobile sizes', async ({ page: host, guest }, testInfo) => {
  await connect(host, guest);
  await captureLayouts(host, 'lobby', testInfo);
  await host.setViewportSize({ width: 1280, height: 720 });
  await startRace(host, guest);
  // Advance only the authoritative host. Yield between batches so real data
  // channels and guest heartbeats keep running while the simulation fast-forwards.
  for (let seconds = 0; seconds < 400; seconds++) {
    const finished = await host.evaluate(() => {
      window.__kartDebug.advance(60, true);
      return window.__kartDebug.state.phase === 'finished';
    });
    if (finished) break;
    await host.waitForTimeout(20);
  }
  await expect(host.locator('#results-screen')).toBeVisible();
  await expect(guest.locator('#results-screen')).toBeVisible();
  await captureLayouts(host, 'results', testInfo);
});

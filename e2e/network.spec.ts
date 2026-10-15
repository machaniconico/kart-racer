import { test as base, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import type { KartDebug } from '../src/main';
import type { TrackId } from '../src/sim/types';
import { TRACK_IDS } from '../src/sim/tracks';

declare const window: Window & { __kartDebug: KartDebug };

const CONNECTION_TIMEOUT = 40_000;
const RACE_TIMEOUT = 20_000;

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

let specStartedAt = 0;
test.beforeAll(() => { specStartedAt = Date.now(); });
test.afterAll(async ({}, testInfo) => {
  const durationMs = Date.now() - specStartedAt;
  console.info(`M8-07 network.spec.ts duration: ${durationMs} ms`);
  await testInfo.attach('network-duration', {
    body: JSON.stringify({ durationMs }), contentType: 'application/json',
  });
});

// Keep evidence of transient disconnects, rather than only inspecting the last frame.
async function monitorSession(page: Page, phase: 'lobby' | 'racing') {
  return page.evaluateHandle(expectedPhase => {
    const startedAt = performance.now();
    const samples: {
      elapsedMs: number; phase: string; dialogVisible: boolean;
      renderDelayMs: number | null; regressions: number | null; stalls: number; speed: number;
    }[] = [];
    const violations: string[] = [];
    const sample = () => {
      const debug = window.__kartDebug;
      const dialog = document.querySelector<HTMLElement>('#net-dialog')!;
      const dialogVisible = !dialog.hidden && getComputedStyle(dialog).display !== 'none';
      const elapsedMs = performance.now() - startedAt;
      samples.push({
        elapsedMs, phase: debug.net.phase, dialogVisible,
        renderDelayMs: debug.net.renderDelayMs, regressions: debug.net.renderTimeRegressions,
        stalls: debug.net.stallCount, speed: debug.state.karts[1].speed,
      });
      if (dialogVisible || debug.net.phase !== expectedPhase) {
        violations.push(`${elapsedMs.toFixed(1)} ms: phase=${debug.net.phase}, dialog=${dialogVisible}`);
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.querySelector('#net-dialog')!, { attributes: true });
    const timer = setInterval(sample, 100);
    sample();
    return {
      stop() {
        clearInterval(timer);
        observer.disconnect();
        sample();
        return { samples, violations };
      },
    };
  }, phase);
}

async function finishMonitor(
  monitor: Awaited<ReturnType<typeof monitorSession>>, label: string, testInfo: TestInfo,
) {
  try {
    const result = await monitor.evaluate(monitor => monitor.stop());
    await testInfo.attach(label, { body: JSON.stringify(result), contentType: 'application/json' });
    expect.soft(result.violations, `${label}: phase stays unchanged and no host_lost dialog`).toEqual([]);
    return result;
  } finally {
    await monitor.dispose();
  }
}

async function programCount(page: Page): Promise<number> {
  const count = await page.evaluate(() => window.__kartDebug.render.programCount);
  expect(count, 'WebGL program count must be available').not.toBeNull();
  return count!;
}

test('M8-07 T1: eight consecutive courses keep the lobby alive and reuse programs', async ({ page: host, guest }, testInfo) => {
  await connect(host, guest);
  expect(await host.evaluate(() => window.__kartDebug.course)).toBe('meadow');
  const p0 = await programCount(host);
  const monitors = await Promise.all([host, guest].map(page => monitorSession(page, 'lobby')));
  const measurements: {
    trackId: TrackId; propagationMs: number; hostFrameGapMs: number; guestFrameGapMs: number;
    hostPrograms: number; programsBefore: number;
  }[] = [];
  try {
    for (const trackId of [...TRACK_IDS.filter(id => id !== 'meadow'), 'meadow'] as TrackId[]) {
      await test.step(`Switch to ${trackId}`, async () => {
        const programsBefore = await programCount(host);
        // Browser timestamps exclude automation round trips and the subsequent render stall.
        await host.locator('#lobby-course-select').evaluate(select => {
          select.addEventListener('change', () => {
            (select as HTMLElement).dataset.selectedAt = String(performance.timeOrigin + performance.now());
          }, { capture: true, once: true });
        });
        await guest.locator('#lobby-course-name').evaluate((output, expected) => {
          delete (output as HTMLElement).dataset.receivedAt;
          const observer = new MutationObserver(() => {
            if (window.__kartDebug.course !== expected) return;
            (output as HTMLElement).dataset.receivedAt = String(performance.timeOrigin + performance.now());
            observer.disconnect();
          });
          observer.observe(output, { childList: true, characterData: true, subtree: true });
        }, trackId);
        await Promise.all([host, guest].map(page => page.evaluate(() => window.__kartDebug.frameGap.reset())));
        await host.locator('#lobby-course-select').selectOption(trackId);
        await expect(guest.locator('#lobby-course-name')).toHaveAttribute('data-received-at', /\d/);
        const selectedAt = Number(await host.locator('#lobby-course-select').getAttribute('data-selected-at'));
        const receivedAt = Number(await guest.locator('#lobby-course-name').getAttribute('data-received-at'));
        expect(await guest.evaluate(() => window.__kartDebug.course)).toBe(trackId);
        await Promise.all([host, guest].map(async page => {
          await expect.poll(() => page.evaluate(() => window.__kartDebug.render.trackId)).toBe(trackId);
          // The next frame records the gap caused by the rebuild; a trackId read alone can be too early.
          await page.evaluate(() => new Promise<void>(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }));
        }));
        const [hostFrameGapMs, guestFrameGapMs] = await Promise.all([host, guest].map(page =>
          page.evaluate(() => window.__kartDebug.frameGap.maxMs),
        ));
        const measurement = {
          trackId, propagationMs: receivedAt - selectedAt, hostFrameGapMs, guestFrameGapMs,
          hostPrograms: await programCount(host), programsBefore,
        };
        measurements.push(measurement);
        await testInfo.attach(`course-${trackId}`, {
          body: JSON.stringify({ p0, ...measurement }), contentType: 'application/json',
        });
        console.info(`M8-07 course ${JSON.stringify(measurement)}`);
        // Soft assertions deliberately collect ALL courses even when neon exceeds its budget.
        expect.soft(measurement.propagationMs, `${trackId}: propagation`).toBeGreaterThanOrEqual(0);
        expect.soft(measurement.propagationMs, `${trackId}: propagation`).toBeLessThanOrEqual(1_000);
        // Coordinator revision (2026-10-15): two headless pages share one GPU.
        // Recorded neon guest gaps: 1,450 ms (focused), 1,833 ms (full suite),
        // up to 1,917 ms (M8-01b trial); previously 3,900–4,300 ms before M8-01.
        // Shader keep-alive did not fix the CPU/native/GPU contention, so allow
        // guest 2,500 ms, host 1,500 ms, both below COURSE_GRACE_MS = 10,000 ms.
        // A cached return to meadow retains the stricter 1,000 ms on both pages.
        const hostBudget = trackId === 'meadow' ? 1_000 : 1_500;
        const guestBudget = trackId === 'meadow' ? 1_000 : 2_500;
        expect.soft(hostFrameGapMs, `${trackId}: host frame gap`).toBeLessThanOrEqual(hostBudget);
        expect.soft(guestFrameGapMs, `${trackId}: guest frame gap`).toBeLessThanOrEqual(guestBudget);
        expect.soft(measurement.hostPrograms, `${trackId}: total programs`).toBeLessThanOrEqual(p0 + 8);
        if (trackId === 'meadow') expect.soft(measurement.hostPrograms).toBe(programsBefore);
        for (const page of [host, guest]) {
          expect.soft(await page.evaluate(() => window.__kartDebug.net.phase)).toBe('lobby');
          await expect.soft(page.locator('#net-dialog')).toBeHidden();
        }
      });
    }
  } finally {
    await testInfo.attach('all-course-measurements', {
      body: JSON.stringify({ p0, measurements }), contentType: 'application/json',
    });
    await Promise.all(monitors.map((monitor, i) => finishMonitor(monitor, ['host-lobby', 'guest-lobby'][i], testInfo)));
  }
  expect(testInfo.errors, 'Stop after collecting all courses when a stability budget fails').toHaveLength(0);
  await startRace(host, guest, 'meadow');
});

test('M8-07 T2: a 4.5 second host stall immediately after course change preserves the lobby', async ({ page: host, guest }, testInfo) => {
  await connect(host, guest);
  const monitor = await monitorSession(guest, 'lobby');
  try {
    await host.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('#lobby-course-select')!;
      select.value = 'canyon';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      window.__kartDebug.net.busyWait(4_500);
    });
    await guest.waitForTimeout(6_000);
    expect(await guest.evaluate(() => window.__kartDebug.net.phase)).toBe('lobby');
    await expect(guest.locator('#net-dialog')).toBeHidden();
    expect(await guest.evaluate(() => window.__kartDebug.course)).toBe('canyon');
  } finally {
    await finishMonitor(monitor, 'guest-busy-wait', testInfo);
  }
  await startRace(host, guest, 'canyon');
});

test('M8-07 T3: racing survives 15 seconds of latency, jitter, loss and bursts', async ({ page: host, guest }, testInfo) => {
  await connect(host, guest);
  await startRace(host, guest, 'meadow');
  await guest.bringToFront();
  await guest.locator('#game-canvas').focus();
  await guest.keyboard.down('ArrowUp');
  try {
    // Measure the baseline in this race while driving, before adding impairment.
    const baselineMonitor = await monitorSession(guest, 'racing');
    await guest.waitForTimeout(5_000);
    await finishMonitor(baselineMonitor, 'guest-baseline-race', testInfo);
    // B is the median of five delay samples taken 100 ms apart while driving, before impairment.
    const baselineSamples: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      baselineSamples.push(await guest.evaluate(() => window.__kartDebug.net.renderDelayMs));
      if (i < 4) await guest.waitForTimeout(100);
    }
    expect(baselineSamples.every(sample => sample !== null), 'Baseline delay samples must be available').toBe(true);
    const baselineDelayMs = [...baselineSamples as number[]].sort((a, b) => a - b)[2];
    const baselineRecoveryLimitMs = Math.max(110, baselineDelayMs + 30);
    await guest.evaluate(async () => {
      await window.__kartDebug.net.impair({
        latencyMs: 120, jitterMs: 50, lossRate: 0.1, seed: 3,
        bursts: { periodMs: 3_000, lengthMs: 400, extraLatencyMs: 200, lossRate: 0.4 },
      });
    });
    const monitors = await Promise.all([host, guest].map(page => monitorSession(page, 'racing')));
    let maxImpairedDelayMs = 0;
    let impairedJitterStats: unknown = null;
    try {
      await guest.waitForTimeout(15_000);
      impairedJitterStats = await guest.evaluate(() => window.__kartDebug.net.jitterStats);
      for (const page of [host, guest]) {
        expect.soft(await page.evaluate(() => window.__kartDebug.net.phase)).toBe('racing');
        await expect.soft(page.locator('#net-dialog')).toBeHidden();
        expect.soft(await page.evaluate(() => window.__kartDebug.state.karts[1].speed)).toBeGreaterThan(5);
      }
    } finally {
      const [, guestResult] = await Promise.all(monitors.map((monitor, i) =>
        finishMonitor(monitor, ['host-impaired-race', 'guest-impaired-race'][i], testInfo),
      ));
      maxImpairedDelayMs = Math.max(...guestResult.samples.map(sample => sample.renderDelayMs ?? -Infinity));
      // Coordinator revision (2026-10-15): delay may fall between bursts (112 ms
      // observed). Requiring every post-5s sample >= 140 would reject the intended
      // recovery. Require the first and peak post-5s values >= 140, and cap ALL
      // samples at 250 so neither a late rise nor a later overshoot is hidden.
      const adapted = guestResult.samples.filter(sample => sample.elapsedMs >= 5_000 && sample.elapsedMs <= 15_000);
      expect.soft(adapted.length, 'Delay samples after the five second adaptation period').toBeGreaterThan(0);
      expect.soft(adapted[0]?.renderDelayMs, 'First post-5s delay').toBeGreaterThanOrEqual(140);
      const maxAdaptedDelayMs = Math.max(...adapted.map(sample => sample.renderDelayMs ?? -Infinity));
      expect.soft(maxAdaptedDelayMs, 'Peak post-5s delay').toBeGreaterThanOrEqual(140);
      expect.soft(maxAdaptedDelayMs, 'Peak post-5s delay').toBeLessThanOrEqual(250);
      expect.soft(guestResult.samples.every(sample =>
        sample.renderDelayMs !== null && sample.renderDelayMs <= 250,
      ), 'Every delay sample is available and <= 250 ms').toBe(true);
      expect.soft(guestResult.samples.every(sample => sample.regressions === 0), 'No render time regressions').toBe(true);
      expect.soft(guestResult.samples.every(sample => sample.stalls === 0), 'No stalls').toBe(true);
    }
    // Coordinator revision: the 3 s jitter window and 5%/s slew, plus baseline
    // jitter from two headless pages, made a fixed 110 ms at 6 s too strict
    // (136 / 123.675 ms observed). Both relative recovery limits must be met
    // by the SAME sample within 10 s of clearing impairment.
    const recovery = await guest.evaluate(async ({ baselineLimit, peak }) => {
      const startedAt = performance.now();
      await window.__kartDebug.net.impair(null);
      const samples: { elapsedMs: number; renderDelayMs: number | null }[] = [];
      let recovered = false;
      do {
        const elapsedMs = performance.now() - startedAt;
        const renderDelayMs = window.__kartDebug.net.renderDelayMs;
        samples.push({ elapsedMs, renderDelayMs });
        recovered = elapsedMs <= 10_000 && renderDelayMs !== null
          && renderDelayMs <= baselineLimit && renderDelayMs <= peak - 50;
        if (recovered || elapsedMs >= 10_000) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(100, 10_000 - elapsedMs)));
      } while (true);
      return { recovered, samples };
    }, { baselineLimit: baselineRecoveryLimitMs, peak: maxImpairedDelayMs });
    const recoveredJitterStats = await guest.evaluate(() => window.__kartDebug.net.jitterStats);
    const evidence = {
      baselineSamples, baselineDelayMs, baselineRecoveryLimitMs, maxImpairedDelayMs,
      impairedJitterStats, recoveredJitterStats, ...recovery,
    };
    await testInfo.attach('recovered-delay', {
      body: JSON.stringify(evidence), contentType: 'application/json',
    });
    console.info(`M8-07 recovery ${JSON.stringify(evidence)}`);
    expect(recovery.recovered, 'Within 10 s: delay <= max(110, B + 30) and <= impaired peak - 50').toBe(true);
  } finally {
    await guest.keyboard.up('ArrowUp');
    await guest.evaluate(async () => { await window.__kartDebug.net.impair(null); });
  }
});

test('M8-07 T4: losing the lobby host shows a dialog within ten seconds and returns to title', async ({ page: host, guest }) => {
  await connect(host, guest);
  const closedAt = Date.now();
  await host.context().close();
  await expect(guest.locator('#net-dialog')).toBeVisible({ timeout: Math.max(1, 10_000 - (Date.now() - closedAt)) });
  expect(Date.now() - closedAt).toBeLessThanOrEqual(10_000);
  await expect(guest.locator('#net-message')).toContainText('ホストとの接続が切れました');
  await guest.locator('#net-dialog-ok').click();
  await expect(guest.locator('#net-dialog')).toBeHidden();
  await expect(guest.locator('#title-screen')).toBeVisible();
  await expect(guest.locator('#online-entry')).toBeVisible();
  expect(await guest.evaluate(() => window.__kartDebug.mode)).toBe('solo');
});

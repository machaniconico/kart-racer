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

test('M8-07 T1: every course in turn keeps the lobby alive and reuse programs', async ({ page: host, guest }, testInfo) => {
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
        const [hostState, guestState] = await Promise.all([host, guest].map(async (page, index) => {
          await expect.poll(() => page.evaluate(() => window.__kartDebug.render.trackId)).toBe(trackId);
          // The next frame records the gap caused by the rebuild; a trackId read alone can be too early.
          // Collect the post-render evidence together, avoiding extra automation round trips
          // between reading the frame gap, programs and session state.
          return page.evaluate(async hostSide => {
            await new Promise<void>(resolve => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            });
            const debug = window.__kartDebug;
            const output = document.getElementById(hostSide ? 'lobby-course-select' : 'lobby-course-name')!;
            return {
              changedAt: Number(output.dataset[hostSide ? 'selectedAt' : 'receivedAt']),
              course: debug.course, programs: debug.render.programCount,
              frameGapMs: debug.frameGap.maxMs, phase: debug.net.phase,
            };
          }, index === 0);
        }));
        expect(guestState.course).toBe(trackId);
        expect(hostState.programs, 'WebGL program count must be available').not.toBeNull();
        const hostFrameGapMs = hostState.frameGapMs;
        const guestFrameGapMs = guestState.frameGapMs;
        const measurement = {
          trackId, propagationMs: guestState.changedAt - hostState.changedAt, hostFrameGapMs, guestFrameGapMs,
          hostPrograms: hostState.programs!, programsBefore,
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
        // A cached return to meadow compiles nothing new. three.js may release the previous course's
        // unique programs (21 courses since M12), so the count can fall but never exceed the pre-switch count,
        // and meadow's own programs from the start (p0) must still be there.
        if (trackId === 'meadow') {
          expect.soft(measurement.hostPrograms, 'meadow return compiles no new programs').toBeLessThanOrEqual(programsBefore);
          expect.soft(measurement.hostPrograms, 'meadow return keeps its own programs').toBeGreaterThanOrEqual(p0);
        }
        for (const [index, page] of [host, guest].entries()) {
          expect.soft([hostState, guestState][index].phase).toBe('lobby');
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
      // Delay can recover between bursts. M12-34 observed 229 ms before 5 s,
      // then 110 ms at the first post-5s sample, and 250 ms on a later burst.
      // Check adaptation within the five-second deadline and again afterward;
      // an arbitrary first post-5s sample depends on the burst phase. Keep the
      // 250 ms cap on ALL samples, plus the existing stall/regression/recovery gates.
      const initialAdaptation = guestResult.samples.filter(sample => sample.elapsedMs <= 5_000);
      expect.soft(initialAdaptation.some(sample => sample.renderDelayMs !== null && sample.renderDelayMs >= 140),
        'Delay adapts within five seconds').toBe(true);
      const adapted = guestResult.samples.filter(sample => sample.elapsedMs >= 5_000 && sample.elapsedMs <= 15_000);
      expect.soft(adapted.length, 'Delay samples after the five second adaptation period').toBeGreaterThan(0);
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

// M12-25 (C1 online): the guest presses when its HUD countdown reads 0.4 s to GO. On a guest that countdown
// follows its input tick (GuestSession), so the press lands on input tick ~156; pressedAt is the next input
// tick read from outgoing INPUT packets.
// The host grants the 1.0 s rocket start at tick 180, and the guest's prediction already holds it: its
// blended prediction offset stays <= 0.6 m, also on an impaired link.
for (const link of ['clean', 'impaired'] as const) {
  test(`M12-25: a guest rocket start from 0.4 s before GO is granted and predicted (${link} link)`, async ({ page: host, guest }, testInfo) => {
    await guest.addInitScript(() => {
      const sink = window as unknown as { __m1225InputTick: number };
      sink.__m1225InputTick = -1;
      const send = RTCDataChannel.prototype.send;
      type SendData = string | Blob | ArrayBuffer | ArrayBufferView;
      RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: SendData) {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
          : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
        // inputBuffer.ts: kind 0x01, slot, raceId, latestTick u32 LE, count, then 3 bytes per frame.
        if (bytes && bytes[0] === 0x01 && bytes.byteLength === 8 + 3 * bytes[7]) {
          sink.__m1225InputTick = Math.max(sink.__m1225InputTick,
            new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(3, true));
        }
        return Reflect.apply(send, this, [data]) as void;
      };
    });
    await connect(host, guest);
    if (link === 'impaired') {
      await guest.evaluate(async () => {
        await window.__kartDebug.net.impair({ latencyMs: 60, jitterMs: 20, lossRate: 0.1, seed: 25 });
      });
    }
    await host.locator('#lobby-start').click();
    await Promise.all([host, guest].map(page =>
      expect.poll(() => page.evaluate(() => window.__kartDebug.net.phase)).toBe('countdown')));
    await guest.bringToFront();
    await guest.locator('#game-canvas').focus();
    const [go, start] = await Promise.all([
      host.evaluate(() => new Promise<{ tick: number; boostTime: number }>(resolve => {
        const poll = () => {
          const state = window.__kartDebug.state;
          if (state.phase !== 'countdown' && state.tick >= 180) resolve({ tick: state.tick, boostTime: state.karts[1].boostTime });
          else requestAnimationFrame(poll);
        };
        poll();
      })),
      guest.evaluate(() => new Promise<{ pressedAt: number; lead: number; maxCorrection: number; samples: number }>(resolve => {
        const net = window.__kartDebug.net;
        const sink = window as unknown as { __m1225InputTick: number };
        let pressedAt = -1;
        let maxCorrection = 0;
        let samples = 0;
        const poll = () => {
          const inputTick = sink.__m1225InputTick;
          const shown = window.__kartDebug.state;
          // Press as a player would: when the HUD countdown reads 0.4 s to GO.
          if (pressedAt < 0 && (shown.phase !== 'countdown' || shown.countdown <= 0.4)) {
            pressedAt = inputTick + 1;
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', key: 'ArrowUp' }));
          }
          if (pressedAt >= 0) {
            maxCorrection = Math.max(maxCorrection, net.correction?.meters ?? 0);
            samples++;
          }
          if (window.__kartDebug.state.tick >= 300) resolve({ pressedAt, lead: net.lead ?? 0, maxCorrection, samples });
          else requestAnimationFrame(poll);
        };
        poll();
      })),
      // The guest HUD shows the rocket start (the host's local value-2 boost event while its kart boosts).
      expect(guest.locator('#race-status', { hasText: 'ROCKET START!' })).toBeVisible({ timeout: RACE_TIMEOUT }),
    ]);
    try {
      await testInfo.attach(`m12-25-${link}`, { body: JSON.stringify({ go, start }), contentType: 'application/json' });
      console.info(`M12-25 ${link}: ${JSON.stringify({ go, start })}`);
      // pressedAt is read where packets leave the impairing layer, which delays them by 40-80 ms (~5 ticks).
      expect(start.pressedAt).toBeGreaterThanOrEqual(link === 'impaired' ? 140 : 155);
      expect(start.pressedAt).toBeLessThanOrEqual(168);
      // Boost decays by one tick per racing tick after GO; reconstruct its value at tick 180.
      expect(go.tick - 180).toBeLessThan(60);
      expect(go.boostTime + (go.tick - 180) / 60).toBeCloseTo(1.0, 6);
      expect(start.samples).toBeGreaterThan(10);
      test.info().annotations.push({ type: 'm12-25-lead', description: String(start.lead) },
        { type: 'm12-25-max-correction-m', description: start.maxCorrection.toFixed(4) });
      // Impaired: only the host's GO boost is asserted. Headless pages here render at about 6 fps, so the
      // impairment's setTimeout delays fire after ~170 ms frames: measured 335-389 ms per ping instead of
      // 60 +/- 20, a 746 ms minimum RTT and a 30-50 tick lead. The <= 0.6 m correction on this link profile
      // is enforced in guestSession.test.ts ('delivers countdown input and predicts the GO rocket start').
      if (link === 'clean') expect(start.maxCorrection).toBeLessThanOrEqual(0.6);
    } finally {
      await guest.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', key: 'ArrowUp' })));
    }
  });
}

test('M12-31: the guest receives hard CPUs, no items and no CPU fill, and races the host to the finish as a compacted kart', async ({ page: host, guest, browser, contextOptions }, testInfo) => {
  await connect(host, guest);
  await expect(guest.locator('#lobby-cpu-level-select')).toBeHidden();
  await expect(guest.locator('#lobby-rules-select')).toBeHidden();
  await expect(guest.locator('#lobby-settings-name')).toHaveText('CPU ふつう · CPU で 8 台 · アイテムあり（ホストが選択）');
  // A third player takes slot 2; once slot 1 leaves, the race without CPU fill compacts it to kart 1.
  const context = await browser.newContext(contextOptions);
  try {
    const third = await context.newPage();
    await third.goto('./');
    // A third WebGL page starts slower than the two connect() pages.
    await third.waitForFunction(() => !!window.__kartDebug, undefined, { timeout: CONNECTION_TIMEOUT });
    await third.locator('#online-code').fill((await host.locator('#lobby-code').innerText()).trim());
    await third.getByRole('button', { name: '参加', exact: true }).click();
    await expect(third.locator('#lobby-screen')).toBeVisible({ timeout: CONNECTION_TIMEOUT });
    await expect.poll(() => third.evaluate(() => window.__kartDebug.net.slot)).toBe(2);
    await guest.locator('#lobby-leave').click();
    await expect(guest.locator('#title-screen')).toBeVisible();
    // The departed client no longer participates; stop its unused WebGL title loop.
    await guest.close();
    await host.locator('input[name="lobby-laps"][value="1"]').check();
    await host.locator('input[name="lobby-cpu-level"][value="hard"]').check();
    await host.locator('#lobby-cpu-fill').uncheck();
    await host.locator('#lobby-items').uncheck();
    await expect(third.locator('#lobby-settings-name')).toHaveText('CPU つよい · プレイヤーのみ · アイテムなし（ホストが選択）');
    // The lobby already rebinds the guest view to kart 1; race_start must not rebuild the renderer.
    await expect.poll(() => third.evaluate(() => window.__kartDebug.net.slot)).toBe(1);
    await third.waitForTimeout(500); // Let a deferred lobby rebuild run before sampling the count.
    const builds = await third.evaluate(() => window.__kartDebug.render.builds);
    await testInfo.attach('settings-lobby-host', { body: await host.screenshot(), contentType: 'image/png' });
    await startRace(host, third);
    expect(await third.evaluate(() => window.__kartDebug.render.builds)).toBe(builds);
    for (const page of [host, third]) {
      const state = await page.evaluate(() => window.__kartDebug.state);
      expect(state.cpuLevel).toBe('hard');
      expect(state.boxes).toHaveLength(0);
      expect(state.karts.map(kart => [kart.id, kart.human])).toEqual([[0, true], [1, true]]);
      await expect(page.locator('#item-display')).toBeHidden();
    }
    expect(await third.evaluate(() => window.__kartDebug.net.slot)).toBe(1);
    for (let seconds = 0; seconds < 420; seconds++) {
      const finished = await host.evaluate(() => {
        window.__kartDebug.advance(60, true);
        return window.__kartDebug.state.phase === 'finished';
      });
      if (finished) break;
      await host.waitForTimeout(20);
    }
    for (const page of [host, third]) {
      await expect(page.locator('#results-screen')).toBeVisible({ timeout: RACE_TIMEOUT });
      const state = await page.evaluate(() => window.__kartDebug.state);
      expect(state.karts).toHaveLength(2);
      expect(state.karts.every(kart => kart.item === null)).toBe(true);
      expect(state.karts.some(kart => kart.finishTime !== null)).toBe(true);
      await expect(page.locator('#leaderboard li')).toHaveCount(2);
    }
    expect(await third.evaluate(() => window.__kartDebug.render.builds)).toBe(builds);
  } finally { await context.close(); }
});

test('M12-25: a solo rocket start from 0.4 s before GO is granted', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => !!window.__kartDebug);
  await page.locator('#start-race').click();
  await expect(page.locator('#race-screen')).toBeVisible();
  await page.locator('#game-canvas').focus();
  const go = await page.evaluate(() => new Promise<{ pressedAt: number; tick: number; boostTime: number }>(resolve => {
    let pressedAt = -1;
    const poll = () => {
      const state = window.__kartDebug.state;
      if (pressedAt < 0 && state.phase === 'countdown' && state.tick >= 156) {
        pressedAt = state.tick;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', key: 'ArrowUp' }));
      }
      if (state.phase !== 'countdown' && state.tick >= 180) resolve({ pressedAt, tick: state.tick, boostTime: state.karts[0].boostTime });
      else requestAnimationFrame(poll);
    };
    poll();
  }));
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', key: 'ArrowUp' })));
  console.info(`M12-25 solo: ${JSON.stringify(go)}`);
  expect(go.pressedAt).toBeGreaterThanOrEqual(156);
  expect(go.pressedAt).toBeLessThan(168);
  expect(go.tick - 180).toBeLessThan(60);
  expect(go.boostTime + (go.tick - 180) / 60).toBeCloseTo(1.0, 6);
});

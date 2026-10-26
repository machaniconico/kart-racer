import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: ['multiplayer.spec.ts', 'courses.spec.ts', 'courses-m10.spec.ts', 'courses-m11.spec.ts', 'courses-m12.spec.ts', 'roulette.spec.ts', 'handling.spec.ts', 'modes.spec.ts', 'network.spec.ts', 'layout.spec.ts'],
  fullyParallel: false,
  // M6-05: 29 tests / 23.95 min on darwin; below the 35 min threshold for workers 2.
  // M10-10: 63 tests / 31.8 min (1911 s wall incl. build) on darwin-arm64, workers 1, retries 0;
  // below the 40 min threshold for workers 2 (and the 45 min threshold for a 60 min CI timeout).
  // M11-10: 73 tests, all passed / 37.1 min (2228 s wall incl. build)
  // on darwin-arm64, workers 1; below the 40 min threshold, so workers stays 1.
  // M12-07: 82 tests, all passed / 41.96 min (2517.50 s wall incl. build)
  // on darwin-arm64, workers 1, retries 0. Above 40 min: switched to workers 2.
  // M12-07 fix pass: 82 passed / 0 skipped / 0 flaky in 32.622 min (1957.292 s wall incl. build),
  // darwin-arm64, workers 2, retries 0. Saves 9.337 min, but exceeds the 32 min goal by 37.292 s.
  // M12-34 fix pass: 89 passed / 0 skipped / 0 flaky in one npx playwright test invocation,
  // 31.291 min (1877.439 s CLI wall incl. build/reporting), darwin-arm64, workers 2, retries 0,
  // all dependency projects included. Below the 32 min target by 42.561 s.
  // Measured 2026-10-24; evidence and command: .omc/research/m12-e2e-final.md.
  // Course-specific frame-gap increases versus M11 are recorded in .omc/research/m12-e2e-phase1.md.
  // Keep lobby frame gaps, adaptive-delay measurements and first-item frame timings isolated.
  workers: 2,
  projects: [
    // Only one multiplayer/network case at a time. Start functional cases alongside solo;
    // the two timing-sensitive network cases run in the isolated project below.
    {
      name: 'network',
      testMatch: ['multiplayer.spec.ts', 'network.spec.ts'],
      grepInvert: /M8-07 T[13]:/,
      workers: 1,
      // These cases assert protocol/UI behavior. Keep their two-page GPU load bounded
      // alongside solo; explicit mobile sizes and the isolated timing viewport stay intact.
      use: { viewport: { width: 640, height: 360 } },
    },
    // Every solo test owns its browser context; distribute individual tests across both workers
    // so the longest course file does not leave a worker idle at the end of this phase.
    { name: 'solo', fullyParallel: true, testMatch: ['courses.spec.ts', 'courses-m10.spec.ts', 'courses-m11.spec.ts', 'courses-m12.spec.ts', 'handling.spec.ts', 'modes.spec.ts', 'layout.spec.ts'] },
    {
      name: 'timing',
      testMatch: ['network.spec.ts', 'roulette.spec.ts'],
      grep: /M8-07 T[13]:|R3:|M12-06:/,
      dependencies: ['network', 'solo'],
      workers: 1,
    },
  ],
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Locally a pass that needed a retry still fails, so flakiness is not hidden behind "3 green runs".
  failOnFlakyTests: !process.env.CI,
  timeout: 300_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4174/kart-racer/',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    // Continuous canvas captures stall WebGL and distort the real-time race.
    trace: { mode: 'retain-on-failure', screenshots: false, snapshots: false },
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    },
  },
  webServer: {
    // One e2e-mode build per run (VITE_KART_DEBUG=1 via .env.e2e); every spec shares that dist.
    command: 'vite build --mode e2e && vite preview --config e2e/vite.e2e.config.ts --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174/kart-racer/',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

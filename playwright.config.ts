import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: ['multiplayer.spec.ts', 'courses.spec.ts'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Locally a pass that needed a retry still fails, so flakiness is not hidden behind "3 green runs".
  failOnFlakyTests: !process.env.CI,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4174/kart-racer/',
    viewport: { width: 1280, height: 720 },
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
    command: 'vite --config e2e/vite.e2e.config.ts --mode development',
    url: 'http://127.0.0.1:4174/kart-racer/',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

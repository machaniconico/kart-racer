import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Sim sweeps take a few seconds locally and 2-3x longer on CI runners; 5 s is too tight.
  test: { include: ['src/**/*.test.ts'], environment: 'node', testTimeout: 60_000 },
});

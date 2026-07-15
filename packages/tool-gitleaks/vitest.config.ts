import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';

export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      // Worker E2E forks the built CLI (and suite-step beforeAll runs
      // `suite add` + `suite run` over that boundary). 60s was enough locally
      // but flaked under release-job load on GHA — match the shared base
      // testTimeout headroom so the hook can finish the real fork path.
      testTimeout: 120_000,
      hookTimeout: 120_000,
      coverage: {
        include: ['src/**'],
        exclude: [
          'src/**/*.test.ts',
          'src/**/__tests__/**',
          // Top-level barrel — re-exports only.
          'src/index.ts',
        ],
        thresholds: {
          statements: 90,
          branches: 85,
          functions: 90,
          lines: 90,
        },
      },
    },
  }),
);

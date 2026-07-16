import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';

export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      coverage: {
        include: ['src/**'],
        exclude: [
          'src/**/*.test.ts',
          'src/**/__tests__/**',
          // Top-level barrel — re-exports only.
          'src/index.ts',
        ],
        // Thinner than the gitleaks reference (no worker-E2E fork here): the
        // remaining gap is the inline binary `versionParse` arrow and a few
        // defensive `?? []` guards. Still a real gate on the parser + arg logic.
        thresholds: {
          statements: 85,
          branches: 68,
          functions: 80,
          lines: 85,
        },
      },
    },
  }),
);

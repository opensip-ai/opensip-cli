import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../../.config/vitest.base.js';
export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      // Phase 1: enter an ambient RunScope carrying fitness.fileCache (= the
      // test-only singleton the run tests prewarm) so file-reading checks resolve
      // a cache (createExecutionContext no longer falls back to a global).
      setupFiles: ['../../test-support/src/vitest-fitness-checks-setup.ts'],
      coverage: {
        include: ['src/**'],
        exclude: [
          'src/**/*.test.ts',
          'src/**/__tests__/**',
          // Pure barrel re-export with no runtime logic.
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

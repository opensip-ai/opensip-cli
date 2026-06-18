import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../../.config/vitest.base.js';
export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      // Phase 1: enter an ambient RunScope carrying fitness.fileCache so the
      // command-mode check's createExecutionContext resolves a cache
      // (it no longer falls back to a module singleton).
      setupFiles: ['../../test-support/src/vitest-fitness-checks-setup.ts'],
      coverage: {
        include: ['src/**'],
        exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/index.ts'],
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

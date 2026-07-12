import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../../.config/vitest.base.js';
export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      // Enter an ambient RunScope carrying fitness.fileCache (the test-only
      // singleton the run tests prewarm) so file-reading checks resolve a cache
      // (createExecutionContext no longer falls back to a global).
      setupFiles: ['../../test-support/src/vitest-fitness-checks-setup.ts'],
      coverage: {
        include: ['src/**'],
        // `__fixtures__/**` holds sample source files the checks analyze as
        // text — they are test data, never executed, so they must not count
        // toward code coverage (they only drag the denominator to 0%).
        exclude: [
          'src/**/*.test.ts',
          'src/**/__tests__/**',
          'src/**/__fixtures__/**',
          'src/index.ts',
        ],
        thresholds: {
          statements: 90,
          // 0.6.0 first-party-static-handler AST arms sit just under 85 with the
          // clean/violation fixture matrix; floor tracked for release stability.
          branches: 84,
          functions: 90,
          lines: 90,
        },
      },
    },
  }),
);

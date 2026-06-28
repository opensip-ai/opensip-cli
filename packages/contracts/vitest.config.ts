import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';
export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      passWithNoTests: true,
      coverage: {
        include: ['src/**'],
        exclude: [
          'src/**/*.test.ts',
          'src/**/__tests__/**',
          'src/**/index.ts',
          'src/types.ts',
          // Pure type / interface declarations — no runtime code.
          'src/graph-catalog.ts',
          'src/cli-program.ts',
          'src/command-outcome.ts',
          'src/command-results.ts',
          'src/command-results-variants/**',
          'src/session-types.ts',
          'src/run-presentation.ts',
          'src/cli-diagnostic.ts',
        ],
        thresholds: {
          statements: 95,
          branches: 85,
          functions: 95,
          lines: 95,
        },
      },
    },
  }),
);

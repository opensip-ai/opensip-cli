import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../../.config/vitest.base.js';
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
          'src/**/__fixtures__/**',
          // Pure barrel — re-exports only, no executable logic.
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

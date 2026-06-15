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
          // Pure re-export barrel + type-only neutral surface.
          'src/index.ts',
          'src/types.ts',
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

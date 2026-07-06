import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';

export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      passWithNoTests: true,
      // Floors set just below measured (95.5/83/100/97.2) with small headroom.
      coverage: {
        thresholds: {
          statements: 93,
          branches: 80,
          functions: 95,
          lines: 95,
        },
      },
    },
  }),
);

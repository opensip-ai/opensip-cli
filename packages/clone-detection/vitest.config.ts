import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';

export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      coverage: {
        thresholds: {
          statements: 91,
          branches: 76,
          functions: 98,
          lines: 96,
        },
      },
    },
  }),
);

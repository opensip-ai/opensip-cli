import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';

export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      coverage: {
        thresholds: {
          statements: 98,
          branches: 96,
          functions: 98,
          lines: 98,
        },
      },
    },
  }),
);

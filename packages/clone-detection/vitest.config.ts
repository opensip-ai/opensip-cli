import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';

export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      coverage: {
        thresholds: {
          // Measured floor after near-duplicate expansion (find-near-duplicates still
          // has intentional untested ranking arms). Raise when branch tests land.
          statements: 86,
          branches: 70,
          functions: 93,
          lines: 90,
        },
      },
    },
  }),
);

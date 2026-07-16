import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';

export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      // Floors sit just below measured coverage (87.30/78.55/93.34/91.13).
      coverage: {
        thresholds: {
          statements: 85,
          branches: 75,
          functions: 90,
          lines: 88,
        },
      },
    },
  }),
);

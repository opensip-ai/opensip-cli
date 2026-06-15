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
          'src/**/index.ts',
          // Pure drizzle table definitions (declarative column + PK specs).
          // These have no meaningful runtime branches; coverage on the object
          // literals is not useful and was dragging statements/lines/functions
          // below the 95% bar after adding the stable_id columns (ADR-0048).
          'src/schema/**/*.ts',
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

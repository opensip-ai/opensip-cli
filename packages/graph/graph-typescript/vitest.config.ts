import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../../.config/vitest.base.js';

// Timeouts (testTimeout/hookTimeout) come from the shared base — the
// inventory-shape-coverage suite builds a real TS catalog in each of its ~13
// `beforeAll` fixtures, and the property/differential suites run hundreds of
// generated cases; both are slow on shared CI runners and rely on the base's
// generous test + hook headroom.
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
          'src/index.ts',
        ],
        thresholds: {
          // 0.6.0 exact-mode semantic collector (~1.1k lines) has many compiler
          // edge arms; fixture suite covers the contract without hermetic
          // enumeration of every TS node form. Raise with fixture expansion.
          statements: 87,
          branches: 83,
          functions: 90,
          lines: 90,
        },
      },
    },
  }),
);

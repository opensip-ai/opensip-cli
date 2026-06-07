import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';
export default mergeConfig(vitestBase, defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/**'],
      // Pure re-export barrel (no logic until Phase 1 lands the composer).
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/**/index.ts'],
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 95,
        lines: 95,
      },
    },
  },
}));

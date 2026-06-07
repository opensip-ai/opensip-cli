import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../../.config/vitest.base.js';
export default mergeConfig(vitestBase, defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
    coverage: {
      include: ['src/**'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/__tests__/**',
        'src/**/index.ts',
        // Pure type modules (only `export type ...`) — no runtime code.
        'src/types/**',
        'src/recipes/types.ts',
        'src/framework/result-types.ts',
        'src/framework/runnable-scenario.ts',
        'src/framework/scenario-executor-result.ts',
        'src/kinds/load/result.ts',
        'src/kinds/chaos/result.ts',
        'src/plugins/types.ts',
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
}));

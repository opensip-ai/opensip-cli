import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';
export default mergeConfig(vitestBase, defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/**'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        // Pure type / re-export barrels — no executable code.
        'src/**/index.ts',
        'src/types/index.ts',
        'src/tools/index.ts',
        'src/tools/types.ts',
        'src/plugins/index.ts',
        'src/plugins/types.ts',
        'src/languages/index.ts',
        'src/languages/adapter.ts',
        'src/languages/generic-types.ts',
      ],
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 95,
        lines: 95,
      },
    },
  },
}));

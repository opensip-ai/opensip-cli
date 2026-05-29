import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // vitest 4 tightened timing accounting; CI hardware
    // needs more headroom than the 5s default for slow-cohort tests.
    testTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      include: ['src/**'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/index.ts',
        'src/types.ts',
        // Pure type / interface declarations — no runtime code.
        'src/graph-catalog.ts',
      ],
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 95,
        lines: 95,
      },
    },
  },
});

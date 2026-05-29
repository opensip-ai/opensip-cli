import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // vitest 4 tightened timing accounting; CI hardware
    // needs more headroom than the 5s default for slow-cohort tests.
    testTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/**'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        // Pure barrel — re-exports only, no executable logic.
        'src/index.ts',
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});

import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Property-based and differential tests
    // (`inventory-property-tests.test.ts`, `inventory-differential.test.ts`)
    // run hundreds of generated cases and reliably finish under 5s on
    // local hardware but hit the vitest-default 5s cap on GitHub
    // Actions runners. 30s headroom keeps them passing on shared CI
    // hardware without masking a genuine hang.
    testTimeout: 30_000,
    coverage: {
      include: ['src/**'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/__fixtures__/**',
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

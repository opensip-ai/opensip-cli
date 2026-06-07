import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Property-based and differential tests
    // (`inventory-property-tests.test.ts`, `inventory-differential.test.ts`)
    // run hundreds of generated cases, and the inventory-shape-coverage suite
    // builds a real TS catalog in each of its ~13 `beforeAll` fixtures. Both
    // finish in a few seconds locally but are far slower on shared GitHub
    // Actions runners — the v2.7.0 release run blew the default 5s test cap
    // (one differential case >30s) AND the default 10s HOOK cap (catalog-building
    // beforeAll). Raise both with generous CI headroom; a genuine hang still
    // trips the job-level timeout. hookTimeout was previously unset (10s default)
    // — that was the actual gap that failed the release.
    testTimeout: 60_000,
    hookTimeout: 30_000,
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

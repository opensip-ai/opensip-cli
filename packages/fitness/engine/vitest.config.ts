import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Loader tests dynamic-import .mjs fixtures that themselves import
    // @opensip-tools/fitness — a chain that resolves quickly on a warm
    // cache (~1s) but can hit 5s+ on cold CI runners. 30s is generous
    // enough to absorb cold-cache import overhead without masking
    // genuinely hung tests (a real hang at 30s is the same CI problem
    // as one at 5s).
    testTimeout: 30_000,
    coverage: {
      include: ['src/**'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/index.ts',
        // Pure type modules
        'src/types/**/*.ts',
        'src/framework/check-types.ts',
        'src/recipes/types.ts',
        'src/recipes/service-types.ts',
        'src/plugins/types.ts',
        'src/signalers/types.ts',
        'src/targets/types.ts',
        // CLI handlers — integration-tested via the e2e suite, not
        // independently unit-testable without re-creating the orchestrator.
        'src/cli/**',
        'src/tool.ts',
      ],
    },
  },
});

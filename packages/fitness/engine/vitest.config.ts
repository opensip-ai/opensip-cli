import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
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

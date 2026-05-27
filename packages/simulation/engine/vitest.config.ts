import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      include: ['src/**'],
      exclude: [
        'src/**/*.test.ts',
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
        'src/kinds/invariant/result.ts',
        'src/kinds/invariant/context.ts',
        'src/kinds/fix-evaluation/result.ts',
        'src/plugins/types.ts',
      ],
    },
  },
});

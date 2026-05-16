import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Catalog builder tests parse multiple TS fixture files via the real
    // ts.createProgram path — slower than a unit-shape test. 30s mirrors
    // the fitness loader testTimeout for cold-cache CI runs.
    testTimeout: 30_000,
    coverage: {
      include: ['src/**'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/index.ts',
        'src/cli/**',
        'src/tool.ts',
      ],
    },
  },
});

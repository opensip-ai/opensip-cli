import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    // Integration tests boot jsdom against the generated dashboard HTML
    // (large vendored document). vitest 4 + vite 7's slower jsdom warm
    // pushed two of these past the 5s default. 20s is generous enough
    // to absorb cold-cache jsdom bootstrap without masking real hangs.
    testTimeout: 20_000,
    coverage: {
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/index.ts'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});

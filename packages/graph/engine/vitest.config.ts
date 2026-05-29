import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // vitest 4 tightened timing accounting; CI hardware
    // needs more headroom than the 5s default for slow-cohort tests.
    testTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    environment: 'node',
    forbidOnly: true,
    // Disallow .skip and .todo per Phase T Group T-E.
    allowOnly: false,
    coverage: {
      include: ['src/**'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        // Pure type-definition files — no executable code.
        'src/**/types.ts',
        // Top-level barrel — re-exports only.
        'src/index.ts',
        // Bootstrap module — registers adapters; entirely side-effect at import-time
        // and tested via the lang-adapter-registry tests.
        'src/bootstrap.ts',
        // Ink/React live view renderer. The state-machine + JSX tree
        // here is integration code that requires a real terminal to
        // render meaningfully; the orchestration logic it wraps
        // (`runGraph` + `buildUnifiedReportLines`) is covered directly
        // by the orchestrate + graph test suites. End-to-end coverage
        // happens at the CLI dispatcher level.
        'src/cli/graph-runner.tsx',
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

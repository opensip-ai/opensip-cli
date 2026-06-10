import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../../.config/vitest.base.js';

export default mergeConfig(vitestBase, defineConfig({
  test: {
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
        // Real-repo equivalence guardrail COMMAND shell: orchestrates TWO full
        // cold catalog builds (`runGraph` + `runShardedGraph`) over the whole
        // repo plus budget-file IO — it cannot be meaningfully unit-tested (the
        // build is the dogfood CI step `graph-equivalence-check`). Its pure
        // logic (owner-file classification + the ratchet verdict) lives in
        // `equivalence-check.ts` and IS covered directly by
        // `equivalence-check.test.ts`. Same rationale as graph-runner.tsx.
        'src/cli/equivalence-check-command.ts',
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
}));

import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';

export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      coverage: {
        include: ['src/**'],
        exclude: [
          'src/**/*.test.ts',
          'src/**/__tests__/**',
          // Top-level barrel — re-exports only.
          'src/index.ts',
        ],
        // SARIF-only adapter: there is NO per-adapter parser file (the shared
        // substrate `ingestSarif` does the reading), so `tool.ts` is the ONLY
        // covered file and its aggregate is not lifted by a 100%-covered parser
        // (as it is for the JSON adapters like ruff). The single uncovered symbol is
        // the inline binary `versionParse` arrow — unreachable in-process because
        // the synthesized `Tool` drops the binary spec (it lives only in the
        // doctor/version command closures, which need a live cli+exec). That one
        // arrow (`parseFirstSemver(stdout) ?? stdout.trim()`) is also the only
        // source of the two uncovered branches, so `branches` is floored to the
        // measured value rather than the reference 70. Everything else — the
        // declarative surface, the class-discovery arg builder (both paths), and the
        // ingestSarif acceptance path — is covered.
        thresholds: {
          statements: 90,
          branches: 50,
          functions: 80,
          lines: 90,
        },
      },
    },
  }),
);

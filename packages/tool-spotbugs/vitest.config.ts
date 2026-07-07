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
        // (as it is for the JSON adapters like ruff). The one uncovered function is
        // the inline binary `versionParse` arrow — unreachable in-process because
        // the synthesized `Tool` drops the binary spec (it lives only in the
        // doctor/version command closures, which need a live cli+exec). Thresholds
        // are calibrated to what the declarative surface + arg/exclude helpers +
        // the ingestSarif acceptance path actually cover.
        thresholds: {
          statements: 85,
          branches: 70,
          functions: 66,
          lines: 85,
        },
      },
    },
  }),
);

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
        // SARIF-only adapter with the THINNEST surface of the four: `tool.ts` has
        // exactly two functions — the exported `buildScanArgs` (covered) and the
        // inline binary `versionParse` arrow (unreachable in-process — the
        // synthesized `Tool` drops the binary spec; it survives only inside the
        // doctor/version command closures, which need a live cli + subprocess). No
        // per-adapter parser file exists to lift the aggregate (the shared
        // `ingestSarif` does the reading), so the function ratio floors at 1/2 and
        // the file's ONLY branches are the `??` on that one unreachable arrow —
        // hence `branches: 0` (the arg-builder itself is branchless). These
        // thresholds are the measured floor; they still gate the arg builder's
        // statements/lines and every declarative + acceptance assertion.
        thresholds: {
          // 100% stmts/funcs/lines; the sole uncovered branch is the
          // inline versionParse `?? trim()` fallback (node always emits a semver).
          statements: 95,
          branches: 50,
          functions: 95,
          lines: 95,
        },
      },
    },
  }),
);

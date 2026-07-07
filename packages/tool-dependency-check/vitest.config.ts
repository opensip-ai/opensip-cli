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
        // SARIF-only adapter: no per-adapter parser file to lift the aggregate (the
        // shared substrate `ingestSarif` does the reading). `tool.ts` covers the arg
        // builder + the `.runtime` exclude builder; the one uncovered function is
        // the inline binary `versionParse` arrow (unreachable in-process — the
        // synthesized `Tool` drops the binary spec). That arrow's `??` is also the
        // file's only branch, so `branches: 0` (the arg + exclude builders are
        // branchless). The SARIF acceptance path exercises CVSS `security-severity`
        // band recovery (critical/high/medium). Thresholds are the measured floor.
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

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
        // synthesized `Tool` drops the binary spec). The SARIF acceptance path
        // exercises CVSS `security-severity` band recovery (critical/high/medium).
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

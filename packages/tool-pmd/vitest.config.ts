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
        // `ingestSarif` does the reading), so the function ratio floors at 1/2.
        // Statements/branches/lines still fully gate the arg builder.
        thresholds: {
          statements: 85,
          branches: 70,
          functions: 50,
          lines: 85,
        },
      },
    },
  }),
);

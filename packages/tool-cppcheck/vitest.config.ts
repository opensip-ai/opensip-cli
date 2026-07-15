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
        // shared substrate `ingestSarif` does the reading). `tool.ts` covers the
        // `projectInput` selector (BOTH branches — plain dir + compile_commands.json),
        // the arg builder, and the `.runtime` exclude; the one uncovered function is
        // the inline binary `versionParse` arrow (unreachable in-process — the
        // synthesized `Tool` drops the binary spec). That arrow's `??` is the only
        // uncovered branch, so `branches` is floored to the measured 50 rather than
        // the reference 70. Thresholds are the measured floor.
        thresholds: {
          statements: 95,
          branches: 50,
          functions: 95,
          lines: 95,
        },
      },
    },
  }),
);

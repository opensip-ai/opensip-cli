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
          // Pure type/interface surfaces — no executable code.
          'src/graph-read-port.ts',
          'src/results-read-port.ts',
          'src/symbol-dto.ts',
          'src/result-dto.ts',
          'src/tools/types.ts',
          // Long-lived stdio transport + blocking command handler: exercised
          // end-to-end by e2e-stdio.test.ts against the real built CLI (a child
          // process the in-process v8 coverage instrument cannot see), never a
          // unit. The pure logic they wrap (ports, tools, freshness) is covered
          // directly.
          'src/server.ts',
          'src/command.ts',
        ],
        thresholds: {
          statements: 90,
          branches: 85,
          functions: 90,
          lines: 90,
        },
      },
    },
  }),
);

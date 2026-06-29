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
          'src/types.ts',
          // The single subprocess/IO boundary (execFile/execFileSync, no shell):
          // `which`, the scanner process runner, and the version probe. These run
          // a real external binary and are exercised end-to-end by each adapter's
          // worker E2E (ADR-0090 D6 Tier 2), never by an in-process unit — the in-
          // process v8 instrument cannot see a child process. The pure logic they
          // feed (binary-resolver decisions, exit modeling, ingest) is covered
          // directly.
          'src/process-exec.ts',
          // The run loop + handler assembly orchestrate the IO boundary above
          // (resolve → execFile → writeArtifact seam → emit). Their decision
          // helpers are unit-covered; the orchestration is an adapter E2E concern.
          'src/run-loop.ts',
          'src/run-context.ts',
          'src/doctor-command.ts',
          'src/version-command.ts',
          'src/define-external-tool-adapter.ts',
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

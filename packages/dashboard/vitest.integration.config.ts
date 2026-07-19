import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';

/**
 * Post-build integration lane for the real CLI -> report -> offline DOM path.
 * The package script never invokes this config directly from the ordinary
 * Turbo test task; the workspace lane first completes a fresh full build.
 */
export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: [
        'src/__tests__/dashboard-graph-offline.integration.test.ts',
        // The end-to-end validation suite: asserts against a generated
        // dogfood report when one exists and reports SKIPPED (never a
        // fabricated pass) when it does not — the dogfood CI job generates
        // the report first, so the assertions run there (plan 09 Phase 4).
        'src/__tests__/dashboard-validation.integration.test.ts',
      ],
      passWithNoTests: false,
    },
  }),
);

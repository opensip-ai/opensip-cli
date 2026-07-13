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
      include: ['src/__tests__/dashboard-graph-offline.integration.test.ts'],
      passWithNoTests: false,
    },
  }),
);

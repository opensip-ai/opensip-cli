import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Shared vitest defaults for every `@opensip-cli/*` package.
 *
 * Timeouts live HERE, once. CI runners (GitHub Actions) are far slower than
 * local hardware, so both the test and the BEFORE/AFTER-hook caps carry generous
 * headroom above vitest's 5s/10s defaults. The v2.7.0 release failed at the
 * pre-publish gate because `hookTimeout` had never been set (10s default) in any
 * of the ~31 copy-pasted per-package configs, and a catalog-building `beforeAll`
 * blew it on a slow runner. Centralizing the timeouts removes that
 * copy-paste-omission class entirely — a per-package config that forgets a
 * timeout simply inherits the safe default.
 *
 * Per-package `vitest.config.ts` files `mergeConfig(vitestBase, …)` and add ONLY
 * their own `include` + `coverage` (thresholds differ per package). They must NOT
 * re-declare `testTimeout`/`hookTimeout`; the `vitest-config-extends-base`
 * fitness check enforces that every config imports this base.
 *
 * A genuine hang is still caught — by the job-level CI timeout — so the generous
 * values do not mask real failures.
 *
 * `testTimeout` is 120s (not 60s): graph-typescript's inventory-differential /
 * property suites build a real TS catalog per case and intermittently crossed a
 * 60s cap on slow CI runners (a boundary-flake — they pass locally and on
 * re-run), wedging unrelated PRs. The job-level timeout still catches true hangs.
 */
export const vitestBase = defineConfig({
  resolve: {
    alias: [
      {
        find: /^@opensip-cli\/core/,
        replacement: join(repoRoot, 'packages/core/src'),
      },
      {
        find: /^@opensip-cli\/fitness/,
        replacement: join(repoRoot, 'packages/fitness/engine/src'),
      },
      {
        find: /^@opensip-cli\/graph(?!-)/,
        replacement: join(repoRoot, 'packages/graph/engine/src'),
      },
      {
        find: /^@opensip-cli\/contracts/,
        replacement: join(repoRoot, 'packages/contracts/src'),
      },
      {
        find: /^@opensip-cli\/cli-live/,
        replacement: join(repoRoot, 'packages/cli-live/src'),
      },
      {
        find: /^@opensip-cli\/cli-ui/,
        replacement: join(repoRoot, 'packages/cli-ui/src'),
      },
      {
        find: /^@opensip-cli\/test-support/,
        replacement: join(repoRoot, 'packages/test-support/src'),
      },
      {
        find: /^@opensip-cli\/tool-test-kit/,
        replacement: join(repoRoot, 'packages/tool-test-kit/src'),
      },
      {
        find: /^@opensip-cli\/datastore/,
        replacement: join(repoRoot, 'packages/datastore/src'),
      },
      {
        find: /^@opensip-cli\/session-store/,
        replacement: join(repoRoot, 'packages/session-store/src'),
      },
      {
        find: /^@opensip-cli\/config/,
        replacement: join(repoRoot, 'packages/config/src'),
      },
      {
        find: /^@opensip-cli\/targeting/,
        replacement: join(repoRoot, 'packages/targeting/src'),
      },
      {
        find: /^@opensip-cli\/output/,
        replacement: join(repoRoot, 'packages/output/src'),
      },
      {
        find: /^@opensip-cli\/simulation/,
        replacement: join(repoRoot, 'packages/simulation/engine/src'),
      },
      {
        find: /^@opensip-cli\/yagni/,
        replacement: join(repoRoot, 'packages/yagni/engine/src'),
      },
    ],
  },
  server: {
    deps: {
      inline: [/^@opensip-cli\//],
    },
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});

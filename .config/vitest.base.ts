import { defineConfig } from 'vitest/config';

/**
 * Shared vitest defaults for every `@opensip-tools/*` package.
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
  test: {
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});

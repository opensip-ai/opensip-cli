import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { readWorkspaceExportMap } = require('../scripts/lib/workspace-export-map.cjs') as {
  readWorkspaceExportMap: (root: string) => {
    entries: readonly {
      specifier: string;
      sourceFile: string;
      relativeSource: string;
    }[];
    diagnostics: readonly string[];
  };
};

/**
 * Build Vitest aliases from declared workspace package exports only.
 * Each specifier maps to its real source entry file — arbitrary suffixes do not
 * fall through to a package `src/` directory (modular boundary Phase 4).
 */
function buildWorkspaceAliases(): { find: RegExp; replacement: string }[] {
  const { entries, diagnostics } = readWorkspaceExportMap(repoRoot);
  if (diagnostics.length > 0) {
    throw new Error(
      `vitest.base: workspace export map has diagnostics:\n${diagnostics.join('\n')}`,
    );
  }
  // Longer specifiers first so `@opensip-cli/graph/read` wins over `@opensip-cli/graph`.
  const sorted = [...entries].sort((a, b) => b.specifier.length - a.specifier.length);
  return sorted.map((entry) => ({
    // Exact specifier only — no prefix fall-through to undeclared subpaths.
    find: new RegExp(`^${entry.specifier.replaceAll('/', String.raw`\/`)}$`),
    replacement: entry.sourceFile,
  }));
}

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
    alias: buildWorkspaceAliases(),
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

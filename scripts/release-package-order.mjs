#!/usr/bin/env node
//
// Single source of truth for the publishable @opensip-tools package set + the
// dependency/publish ORDER. (ADR-0017.)
//
// Every release surface derives from or is verified against this file:
//   - .github/workflows/release.yml — the Preflight, Pack, and Publish loops
//     consume `--print names` / `--print pack` (no hand-maintained second copy).
//   - scripts/bootstrap-publish.sh — its PACKAGES array is read from
//     `--print names`.
//   - scripts/verify-release.mjs — check #10 cross-checks the discovered
//     workspace publishable set against RELEASE_PACKAGE_ORDER (release-time).
//   - packages/cli/src/__tests__/release-package-order-contract.test.ts — a
//     PR-time Vitest contract test asserts EVERY surface (discovered packages,
//     release.yml pack/preflight/publish, bootstrap-publish.sh, RELEASING.md)
//     describes exactly this set/order. Add/remove/rename a package and CI fails
//     until every surface is updated.
//
// Publishable-package definition: a workspace package whose `name` is
// `opensip-tools` OR starts with `@opensip-tools/`, AND is not `private: true`.
//
// The ORDER below is the dependency/publish order — sequential by design;
// downstream packages reference upstream versions resolved by `pnpm pack` at
// pack time. The CLI (unscoped `opensip-tools`) is always LAST.
//
// Usage:
//   node scripts/release-package-order.mjs --print names      # unscoped names, CLI last
//   node scripts/release-package-order.mjs --print pack        # pnpm --filter selectors
//   node scripts/release-package-order.mjs --print publish     # unscoped names (alias of names)
//   node scripts/release-package-order.mjs --print bootstrap   # unscoped names (alias of names)

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCOPE = '@opensip-tools/';

/**
 * The canonical ordered list of publishable package descriptors.
 *
 * Each entry:
 *   - `unscoped`: the tarball segment. Scoped packs pack to
 *     `opensip-tools-<unscoped>-<ver>.tgz`; the CLI packs to
 *     `opensip-tools-<ver>.tgz`. This is the token the release/bootstrap loops
 *     pass to `publish_if_new` / the bootstrap PACKAGES array.
 *   - `name`: the registry / package.json name.
 *   - `dir`: workspace dir (used by the contract test's discovery cross-check).
 *   - `filter`: the `pnpm --filter` selector used by the pack step.
 *   - `layer`: 'cli' marks the unscoped composition root (publishes under the
 *     bare name → `publish_unscoped`); absent for every scoped package.
 */
export const RELEASE_PACKAGE_ORDER = [
  // Layer 1 — kernel
  {
    unscoped: 'core',
    name: '@opensip-tools/core',
    dir: 'packages/core',
    filter: '@opensip-tools/core',
  },
  // Layer 2 — datastore (SQLite + Drizzle persistence)
  {
    unscoped: 'datastore',
    name: '@opensip-tools/datastore',
    dir: 'packages/datastore',
    filter: '@opensip-tools/datastore',
  },
  // Layer 2 — shared CLI contract types
  {
    unscoped: 'contracts',
    name: '@opensip-tools/contracts',
    dir: 'packages/contracts',
    filter: '@opensip-tools/contracts',
  },
  // Layer 2 — session-store + output (extracted from contracts in the 2.1.0 split)
  {
    unscoped: 'session-store',
    name: '@opensip-tools/session-store',
    dir: 'packages/session-store',
    filter: '@opensip-tools/session-store',
  },
  {
    unscoped: 'output',
    name: '@opensip-tools/output',
    dir: 'packages/output',
    filter: '@opensip-tools/output',
  },
  // Layer 2 — capability-configuration layer (config composer + schema registry; depends on core)
  {
    unscoped: 'config',
    name: '@opensip-tools/config',
    dir: 'packages/config',
    filter: '@opensip-tools/config',
  },
  // Layer 2.5 — file-targeting runtime substrate (ADR-0037; depends on core + config)
  {
    unscoped: 'targeting',
    name: '@opensip-tools/targeting',
    dir: 'packages/targeting',
    filter: '@opensip-tools/targeting',
  },
  // Layer 3 — shared Ink/React UI primitives
  {
    unscoped: 'cli-ui',
    name: '@opensip-tools/cli-ui',
    dir: 'packages/cli-ui',
    filter: '@opensip-tools/cli-ui',
  },
  // Layer 3 — tree-sitter parse substrate (ADR-0010)
  {
    unscoped: 'tree-sitter',
    name: '@opensip-tools/tree-sitter',
    dir: 'packages/tree-sitter',
    filter: '@opensip-tools/tree-sitter',
  },
  // Layer 3 — language adapters (lang-typescript first; downstream check packs depend on it)
  {
    unscoped: 'lang-typescript',
    name: '@opensip-tools/lang-typescript',
    dir: 'packages/languages/lang-typescript',
    filter: '@opensip-tools/lang-typescript',
  },
  {
    unscoped: 'lang-rust',
    name: '@opensip-tools/lang-rust',
    dir: 'packages/languages/lang-rust',
    filter: '@opensip-tools/lang-rust',
  },
  {
    unscoped: 'lang-python',
    name: '@opensip-tools/lang-python',
    dir: 'packages/languages/lang-python',
    filter: '@opensip-tools/lang-python',
  },
  {
    unscoped: 'lang-go',
    name: '@opensip-tools/lang-go',
    dir: 'packages/languages/lang-go',
    filter: '@opensip-tools/lang-go',
  },
  {
    unscoped: 'lang-java',
    name: '@opensip-tools/lang-java',
    dir: 'packages/languages/lang-java',
    filter: '@opensip-tools/lang-java',
  },
  {
    unscoped: 'lang-cpp',
    name: '@opensip-tools/lang-cpp',
    dir: 'packages/languages/lang-cpp',
    filter: '@opensip-tools/lang-cpp',
  },
  // Layer 3 — dashboard (depends on core + contracts only; consumed by fitness)
  {
    unscoped: 'dashboard',
    name: '@opensip-tools/dashboard',
    dir: 'packages/dashboard',
    filter: '@opensip-tools/dashboard',
  },
  // Layer 3 — tools
  {
    unscoped: 'fitness',
    name: '@opensip-tools/fitness',
    dir: 'packages/fitness/engine',
    filter: '@opensip-tools/fitness',
  },
  {
    unscoped: 'simulation',
    name: '@opensip-tools/simulation',
    dir: 'packages/simulation/engine',
    filter: '@opensip-tools/simulation',
  },
  {
    unscoped: 'graph',
    name: '@opensip-tools/graph',
    dir: 'packages/graph/engine',
    filter: '@opensip-tools/graph',
  },
  // Layer 3.5 — shared tree-sitter adapter scaffolding (before the 4 tree-sitter packs)
  {
    unscoped: 'graph-adapter-common',
    name: '@opensip-tools/graph-adapter-common',
    dir: 'packages/graph/graph-adapter-common',
    filter: '@opensip-tools/graph-adapter-common',
  },
  // Layer 3.6 — graph adapter packs
  {
    unscoped: 'graph-typescript',
    name: '@opensip-tools/graph-typescript',
    dir: 'packages/graph/graph-typescript',
    filter: '@opensip-tools/graph-typescript',
  },
  {
    unscoped: 'graph-python',
    name: '@opensip-tools/graph-python',
    dir: 'packages/graph/graph-python',
    filter: '@opensip-tools/graph-python',
  },
  {
    unscoped: 'graph-rust',
    name: '@opensip-tools/graph-rust',
    dir: 'packages/graph/graph-rust',
    filter: '@opensip-tools/graph-rust',
  },
  {
    unscoped: 'graph-go',
    name: '@opensip-tools/graph-go',
    dir: 'packages/graph/graph-go',
    filter: '@opensip-tools/graph-go',
  },
  {
    unscoped: 'graph-java',
    name: '@opensip-tools/graph-java',
    dir: 'packages/graph/graph-java',
    filter: '@opensip-tools/graph-java',
  },
  // Layer 4 — check packs
  {
    unscoped: 'checks-universal',
    name: '@opensip-tools/checks-universal',
    dir: 'packages/fitness/checks-universal',
    filter: '@opensip-tools/checks-universal',
  },
  {
    unscoped: 'checks-typescript',
    name: '@opensip-tools/checks-typescript',
    dir: 'packages/fitness/checks-typescript',
    filter: '@opensip-tools/checks-typescript',
  },
  {
    unscoped: 'checks-python',
    name: '@opensip-tools/checks-python',
    dir: 'packages/fitness/checks-python',
    filter: '@opensip-tools/checks-python',
  },
  {
    unscoped: 'checks-go',
    name: '@opensip-tools/checks-go',
    dir: 'packages/fitness/checks-go',
    filter: '@opensip-tools/checks-go',
  },
  {
    unscoped: 'checks-java',
    name: '@opensip-tools/checks-java',
    dir: 'packages/fitness/checks-java',
    filter: '@opensip-tools/checks-java',
  },
  {
    unscoped: 'checks-cpp',
    name: '@opensip-tools/checks-cpp',
    dir: 'packages/fitness/checks-cpp',
    filter: '@opensip-tools/checks-cpp',
  },
  {
    unscoped: 'checks-rust',
    name: '@opensip-tools/checks-rust',
    dir: 'packages/fitness/checks-rust',
    filter: '@opensip-tools/checks-rust',
  },
  // Layer 5 — composition root (unscoped name → opensip-tools-<ver>.tgz)
  {
    unscoped: 'opensip-tools',
    name: 'opensip-tools',
    dir: 'packages/cli',
    filter: 'opensip-tools',
    layer: 'cli',
  },
];

// ---------------------------------------------------------------------
// Workspace discovery (the ONE discovery implementation; verify-release.mjs
// imports this rather than duplicating the walk).
// ---------------------------------------------------------------------

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function maybeAdd(list, pkgPath, dir) {
  if (!(await pathExists(pkgPath))) return;
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  // Publishable = unscoped CLI name or @opensip-tools/* scope, AND not private.
  const isScoped =
    typeof pkg.name === 'string' && (pkg.name === 'opensip-tools' || pkg.name.startsWith(SCOPE));
  if (isScoped && pkg.private !== true) {
    list.push({ name: pkg.name, dir });
  }
}

/**
 * Discover the publishable workspace package SET (unordered) from disk.
 * Returns `{ name, dir }[]`. Used by the contract test and verify-release #10.
 *
 * @param {string} [repoRoot] defaults to this repo's root.
 */
export async function discoverPublishablePackages(repoRoot = REPO_ROOT) {
  const found = [];
  const baseDir = join(repoRoot, 'packages');
  const topEntries = await fs.readdir(baseDir, { withFileTypes: true });

  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    const topRel = join('packages', top.name);
    const topPath = join(repoRoot, topRel);

    // Direct child: packages/<name>/package.json
    await maybeAdd(found, join(topPath, 'package.json'), topRel);

    // One level deeper: packages/<group>/<name>/package.json
    const subEntries = await fs.readdir(topPath, { withFileTypes: true });
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      await maybeAdd(found, join(topPath, sub.name, 'package.json'), join(topRel, sub.name));
    }
  }

  return found;
}

// ---------------------------------------------------------------------
// CLI: emit the order in shapes the workflow / shell can consume.
// ---------------------------------------------------------------------

function printMode(mode) {
  switch (mode) {
    case 'pack': {
      // pnpm --filter selectors, in order.
      return RELEASE_PACKAGE_ORDER.map((p) => p.filter).join('\n');
    }
    case 'names':
    case 'publish':
    case 'bootstrap': {
      // Unscoped tarball-segment names, in order; CLI ('opensip-tools') last.
      return RELEASE_PACKAGE_ORDER.map((p) => p.unscoped).join('\n');
    }
    default: {
      return null;
    }
  }
}

// Run as a script (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const printIdx = args.indexOf('--print');
  if (printIdx === -1) {
    console.error(
      'usage: node scripts/release-package-order.mjs --print <pack|names|publish|bootstrap>',
    );
    process.exit(2);
  }
  const mode = args[printIdx + 1];
  const out = printMode(mode);
  if (out === null) {
    console.error(
      `unknown --print mode: ${mode ?? '<missing>'} (expected pack|names|publish|bootstrap)`,
    );
    process.exit(2);
  }
  console.log(out);
}

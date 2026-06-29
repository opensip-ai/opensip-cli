#!/usr/bin/env node
//
// Single source of truth for the publishable @opensip-cli package set + the
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
// `opensip-cli` OR starts with `@opensip-cli/`, AND is not `private: true`.
//
// The ORDER below is the dependency/publish order — sequential by design;
// downstream packages reference upstream versions resolved by `pnpm pack` at
// pack time. The CLI (unscoped `opensip-cli`) is always LAST.
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
const SCOPE = '@opensip-cli/';

/**
 * The canonical ordered list of publishable package descriptors.
 *
 * Each entry:
 *   - `unscoped`: the tarball segment. Scoped packs pack to
 *     `opensip-cli-<unscoped>-<ver>.tgz`; the CLI packs to
 *     `opensip-cli-<ver>.tgz`. This is the token the release/bootstrap loops
 *     pass to `publish_if_new` / the bootstrap PACKAGES array.
 *   - `name`: the registry / package.json name.
 *   - `dir`: workspace dir (used by the contract test's discovery cross-check).
 *   - `filter`: the `pnpm --filter` selector used by the pack step.
 *   - `publishReason`: why this package earns a distinct npm release unit.
 *   - `layer`: 'cli' marks the unscoped composition root (publishes under the
 *     bare name → `publish_unscoped`); absent for every scoped package.
 */
export const RELEASE_PACKAGE_ORDER = [
  // Layer 1 — kernel
  {
    unscoped: 'core',
    name: '@opensip-cli/core',
    dir: 'packages/core',
    filter: '@opensip-cli/core',
    publishReason: 'Strict kernel: errors, logger, plugin loader, Tool contract, RunScope',
  },
  // Layer 2 — datastore (SQLite + Drizzle persistence)
  {
    unscoped: 'datastore',
    name: '@opensip-cli/datastore',
    dir: 'packages/datastore',
    filter: '@opensip-cli/datastore',
    publishReason: 'SQLite + Drizzle persistence boundary consumed by host and tools',
  },
  // Layer 2 — shared CLI contract types
  {
    unscoped: 'contracts',
    name: '@opensip-cli/contracts',
    dir: 'packages/contracts',
    filter: '@opensip-cli/contracts',
    publishReason: 'Tool↔runner contract facade; breaks cycles between core and tools',
  },
  {
    unscoped: 'tool-test-kit',
    name: '@opensip-cli/tool-test-kit',
    dir: 'packages/tool-test-kit',
    filter: '@opensip-cli/tool-test-kit',
    publishReason: 'Public ToolCliContext test double and command-spec helpers for tool authors',
  },
  // Layer 2 — shared clone-detection substrate (node:crypto only; ADR-0064)
  {
    unscoped: 'clone-detection',
    name: '@opensip-cli/clone-detection',
    dir: 'packages/clone-detection',
    filter: '@opensip-cli/clone-detection',
    publishReason:
      'Single-sourced clone-detection primitives + algorithms consumed by graph and yagni',
  },
  // Layer 2 — session-store + output (extracted from contracts)
  {
    unscoped: 'session-store',
    name: '@opensip-cli/session-store',
    dir: 'packages/session-store',
    filter: '@opensip-cli/session-store',
    publishReason: 'Session SQLite schema and SessionRepo consumed by first-party tools',
  },
  {
    unscoped: 'output',
    name: '@opensip-cli/output',
    dir: 'packages/output',
    filter: '@opensip-cli/output',
    publishReason: 'Signal formatters and sinks consumed by CLI and tool reporting paths',
  },
  // Layer 2 — capability-configuration layer (config composer + schema registry; depends on core)
  {
    unscoped: 'config',
    name: '@opensip-cli/config',
    dir: 'packages/config',
    filter: '@opensip-cli/config',
    publishReason: 'Config composer + Zod schema registry for host and tool config blocks',
  },
  // Layer 2.5 — file-targeting runtime substrate (ADR-0037; depends on core + config)
  {
    unscoped: 'targeting',
    name: '@opensip-cli/targeting',
    dir: 'packages/targeting',
    filter: '@opensip-cli/targeting',
    publishReason: 'Target registry and glob resolution substrate shared by tool engines',
  },
  // Layer 3 — shared Ink/React UI primitives
  {
    unscoped: 'cli-ui',
    name: '@opensip-cli/cli-ui',
    dir: 'packages/cli-ui',
    filter: '@opensip-cli/cli-ui',
    publishReason: 'Shared Ink/React primitives without pulling the CLI dispatcher',
  },
  {
    unscoped: 'cli-live',
    name: '@opensip-cli/cli-live',
    dir: 'packages/cli-live',
    filter: '@opensip-cli/cli-live',
    publishReason: 'Shared live-run runtime (state machine + produce seam) for tool Ink views',
  },
  // Layer 3 — tree-sitter parse substrate (ADR-0010)
  {
    unscoped: 'tree-sitter',
    name: '@opensip-cli/tree-sitter',
    dir: 'packages/tree-sitter',
    filter: '@opensip-cli/tree-sitter',
    publishReason: 'Grammar-agnostic web-tree-sitter substrate shared by lang-* and graph adapters',
  },
  // Layer 3 — language adapters (lang-typescript first; downstream check packs depend on it)
  {
    unscoped: 'lang-typescript',
    name: '@opensip-cli/lang-typescript',
    dir: 'packages/languages/lang-typescript',
    filter: '@opensip-cli/lang-typescript',
    publishReason: 'TypeScript language adapter; shared AST helpers for fit and graph',
  },
  {
    unscoped: 'lang-rust',
    name: '@opensip-cli/lang-rust',
    dir: 'packages/languages/lang-rust',
    filter: '@opensip-cli/lang-rust',
    publishReason: 'Rust language adapter for fitness targeting and graph parsing',
  },
  {
    unscoped: 'lang-python',
    name: '@opensip-cli/lang-python',
    dir: 'packages/languages/lang-python',
    filter: '@opensip-cli/lang-python',
    publishReason: 'Python language adapter for fitness targeting and graph parsing',
  },
  {
    unscoped: 'lang-go',
    name: '@opensip-cli/lang-go',
    dir: 'packages/languages/lang-go',
    filter: '@opensip-cli/lang-go',
    publishReason: 'Go language adapter for fitness targeting and graph parsing',
  },
  {
    unscoped: 'lang-java',
    name: '@opensip-cli/lang-java',
    dir: 'packages/languages/lang-java',
    filter: '@opensip-cli/lang-java',
    publishReason: 'Java language adapter for fitness targeting and graph parsing',
  },
  {
    unscoped: 'lang-cpp',
    name: '@opensip-cli/lang-cpp',
    dir: 'packages/languages/lang-cpp',
    filter: '@opensip-cli/lang-cpp',
    publishReason: 'C/C++ language adapter for fitness targeting and graph parsing',
  },
  // Layer 3 — dashboard (depends on contracts; consumed by CLI report composition)
  {
    unscoped: 'dashboard',
    name: '@opensip-cli/dashboard',
    dir: 'packages/dashboard',
    filter: '@opensip-cli/dashboard',
    publishReason: 'Self-contained HTML dashboard generator consumed by report composition',
  },
  // Layer 3 — External Tool Adapter substrate (ADR-0090; core + contracts only,
  // output devDep). Publishes before any adapter that builds on it; placed with
  // the layer-3 libs (after dashboard), before the tool engines.
  {
    unscoped: 'external-tool-adapter',
    name: '@opensip-cli/external-tool-adapter',
    dir: 'packages/external-tool-adapter',
    filter: '@opensip-cli/external-tool-adapter',
    publishReason:
      'External Tool Adapter substrate: wrap a CLI scanner (gitleaks/osv-scanner/trivy) as a Tool',
  },
  // Layer 3 — tools
  {
    unscoped: 'fitness',
    name: '@opensip-cli/fitness',
    dir: 'packages/fitness/engine',
    filter: '@opensip-cli/fitness',
    publishReason: 'Fitness tool engine; plugin contract + check/recipe framework',
  },
  {
    unscoped: 'simulation',
    name: '@opensip-cli/simulation',
    dir: 'packages/simulation/engine',
    filter: '@opensip-cli/simulation',
    publishReason: 'Simulation tool engine; scenario/recipe plugin contract',
  },
  {
    unscoped: 'graph',
    name: '@opensip-cli/graph',
    dir: 'packages/graph/engine',
    filter: '@opensip-cli/graph',
    publishReason: 'Graph tool engine; static call-graph kernel and CLI commands',
  },
  {
    unscoped: 'yagni',
    name: '@opensip-cli/yagni',
    dir: 'packages/yagni/engine',
    filter: '@opensip-cli/yagni',
    publishReason: 'YAGNI reduction audit tool engine',
  },
  // Layer 3.5 — shared tree-sitter adapter scaffolding (before the 4 tree-sitter packs)
  {
    unscoped: 'graph-adapter-common',
    name: '@opensip-cli/graph-adapter-common',
    dir: 'packages/graph/graph-adapter-common',
    filter: '@opensip-cli/graph-adapter-common',
    publishReason: 'Shared tree-sitter adapter scaffolding for graph language packs',
  },
  // Layer 3.6 — graph adapter packs
  {
    unscoped: 'graph-typescript',
    name: '@opensip-cli/graph-typescript',
    dir: 'packages/graph/graph-typescript',
    filter: '@opensip-cli/graph-typescript',
    publishReason: 'TypeScript graph adapter; largest cross-used graph language pack',
  },
  {
    unscoped: 'graph-python',
    name: '@opensip-cli/graph-python',
    dir: 'packages/graph/graph-python',
    filter: '@opensip-cli/graph-python',
    publishReason: 'Python graph adapter; plugin discovery target',
  },
  {
    unscoped: 'graph-rust',
    name: '@opensip-cli/graph-rust',
    dir: 'packages/graph/graph-rust',
    filter: '@opensip-cli/graph-rust',
    publishReason: 'Rust graph adapter; plugin discovery target',
  },
  {
    unscoped: 'graph-go',
    name: '@opensip-cli/graph-go',
    dir: 'packages/graph/graph-go',
    filter: '@opensip-cli/graph-go',
    publishReason: 'Go graph adapter; plugin discovery target',
  },
  {
    unscoped: 'graph-java',
    name: '@opensip-cli/graph-java',
    dir: 'packages/graph/graph-java',
    filter: '@opensip-cli/graph-java',
    publishReason: 'Java graph adapter; plugin discovery target',
  },
  // Layer 4 — MCP tool engine (depends on graph + session-store; consumed by cli).
  {
    unscoped: 'mcp',
    name: '@opensip-cli/mcp',
    dir: 'packages/mcp',
    filter: '@opensip-cli/mcp',
    publishReason: 'Bundled MCP server tool (ADR-0084); stdio graph/results surface for agents',
  },
  // Layer 4 — external tool adapters (ADR-0090; depend on external-tool-adapter +
  // core/contracts). Opt-in / installed (NOT bundled); published after the
  // substrate, before the CLI.
  {
    unscoped: 'tool-gitleaks',
    name: '@opensip-cli/tool-gitleaks',
    dir: 'packages/tool-gitleaks',
    filter: '@opensip-cli/tool-gitleaks',
    publishReason: 'Gitleaks external tool adapter; secret scanning (opensip gitleaks / secrets)',
  },
  {
    unscoped: 'tool-osv-scanner',
    name: '@opensip-cli/tool-osv-scanner',
    dir: 'packages/tool-osv-scanner',
    filter: '@opensip-cli/tool-osv-scanner',
    publishReason:
      'OSV-Scanner external tool adapter; dependency vulnerability scanning (opensip osv-scanner / osv)',
  },
  {
    unscoped: 'tool-trivy',
    name: '@opensip-cli/tool-trivy',
    dir: 'packages/tool-trivy',
    filter: '@opensip-cli/tool-trivy',
    publishReason:
      'Trivy external tool adapter; SARIF vulnerability + misconfiguration scanning (opensip trivy)',
  },
  // Layer 4 — check packs
  {
    unscoped: 'checks-universal',
    name: '@opensip-cli/checks-universal',
    dir: 'packages/fitness/checks-universal',
    filter: '@opensip-cli/checks-universal',
    publishReason: 'Universal fitness check pack; plugin discovery target',
  },
  {
    unscoped: 'checks-typescript',
    name: '@opensip-cli/checks-typescript',
    dir: 'packages/fitness/checks-typescript',
    filter: '@opensip-cli/checks-typescript',
    publishReason: 'TypeScript AST fitness check pack; plugin discovery target',
  },
  {
    unscoped: 'checks-python',
    name: '@opensip-cli/checks-python',
    dir: 'packages/fitness/checks-python',
    filter: '@opensip-cli/checks-python',
    publishReason: 'Python fitness check pack; plugin discovery target',
  },
  {
    unscoped: 'checks-go',
    name: '@opensip-cli/checks-go',
    dir: 'packages/fitness/checks-go',
    filter: '@opensip-cli/checks-go',
    publishReason: 'Go fitness check pack; plugin discovery target',
  },
  {
    unscoped: 'checks-java',
    name: '@opensip-cli/checks-java',
    dir: 'packages/fitness/checks-java',
    filter: '@opensip-cli/checks-java',
    publishReason: 'Java fitness check pack; plugin discovery target',
  },
  {
    unscoped: 'checks-cpp',
    name: '@opensip-cli/checks-cpp',
    dir: 'packages/fitness/checks-cpp',
    filter: '@opensip-cli/checks-cpp',
    publishReason: 'C/C++ fitness check pack; plugin discovery target',
  },
  {
    unscoped: 'checks-rust',
    name: '@opensip-cli/checks-rust',
    dir: 'packages/fitness/checks-rust',
    filter: '@opensip-cli/checks-rust',
    publishReason: 'Rust fitness check pack; plugin discovery target',
  },
  // Layer 5 — composition root (unscoped name → opensip-cli-<ver>.tgz)
  {
    unscoped: 'opensip-cli',
    name: 'opensip-cli',
    dir: 'packages/cli',
    filter: 'opensip-cli',
    layer: 'cli',
    publishReason: 'Composition root: generic tool dispatcher and host commands',
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
  // Publishable = unscoped CLI name or @opensip-cli/* scope, AND not private.
  const isScoped =
    typeof pkg.name === 'string' && (pkg.name === 'opensip-cli' || pkg.name.startsWith(SCOPE));
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
async function walkWorkspacePackages(repoRoot, onPackage) {
  const baseDir = join(repoRoot, 'packages');
  const topEntries = await fs.readdir(baseDir, { withFileTypes: true });

  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    const topRel = join('packages', top.name);
    const topPath = join(repoRoot, topRel);

    await onPackage(join(topPath, 'package.json'), topRel);

    const subEntries = await fs.readdir(topPath, { withFileTypes: true });
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      await onPackage(join(topPath, sub.name, 'package.json'), join(topRel, sub.name));
    }
  }
}

export async function discoverPublishablePackages(repoRoot = REPO_ROOT) {
  const found = [];
  await walkWorkspacePackages(repoRoot, (pkgPath, dir) => maybeAdd(found, pkgPath, dir));
  return found;
}

/**
 * Every scoped workspace package (publishable or private). Used by verify-release
 * to ensure publishable packages do not depend on private internal packages.
 */
export async function discoverAllScopedPackages(repoRoot = REPO_ROOT) {
  const found = [];
  await walkWorkspacePackages(repoRoot, async (pkgPath, dir) => {
    if (!(await pathExists(pkgPath))) return;
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    if (
      typeof pkg.name === 'string' &&
      (pkg.name === 'opensip-cli' || pkg.name.startsWith(SCOPE))
    ) {
      found.push({
        name: pkg.name,
        dir,
        private: pkg.private === true,
        dependencies: pkg.dependencies ?? {},
      });
    }
  });
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
      // Unscoped tarball-segment names, in order; CLI ('opensip-cli') last.
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

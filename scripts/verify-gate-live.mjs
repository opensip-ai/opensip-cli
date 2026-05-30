#!/usr/bin/env node
//
// verify-gate-live — guard against the dependency-cruiser architecture gate
// silently going INERT.
//
// Background: every cross-package layer rule in .dependency-cruiser.cjs
// matches RESOLVED file paths (e.g. ^packages/fitness/engine/). Those rules
// can only fire if @opensip-tools imports actually resolve into a package's
// src tree and appear as edges in the cruise graph. That resolution depends
// on tsconfig.depcruise.json (the `paths` map) being wired into
// options.tsConfig.fileName. If that wiring breaks — a tsconfig rename, a
// resolver-option change, a dropped paths entry — cross-package edges vanish
// from the graph, every cross-package rule matches nothing, and
// `pnpm depcruise` goes GREEN while enforcing NOTHING. That is exactly the
// bug this gate-activation effort fixed (the gate had been inert since
// inception).
//
// A green depcruise run looks identical whether the rules work or match
// nothing, so depcruise alone cannot detect its own inertness. This script
// closes that gap WITHOUT mutating any source file (CI-safe, working-tree-
// safe): it cruises the workspace and asserts the graph still contains
// resolved cross-package edges. If the resolver breaks, this fails loudly.
//
// Wired into `pnpm lint` so CI catches re-inerting. Rule-FIRING (as opposed
// to edge-resolution) is verified via inject-revert probes documented in
// docs/plans/ready/depcruise-gate-activation/phase-7-verification.md.
//
import { execFileSync } from 'node:child_process';

// Well below the ~390 cross-package edges observed; guards against a
// partial break where only a few stragglers resolve.
const MIN_CROSS_PACKAGE_EDGES = 50;

// Top-level package dir of a packages/... path. Two-segment packages
// (graph/engine, fitness/checks-x, languages/lang-x) key on three path
// parts; one-segment packages (core, cli, dashboard) on two.
function pkgOf(p) {
  if (!p || !p.startsWith('packages/')) return null;
  const parts = p.split('/');
  if (parts.length >= 3 && parts[2] !== 'src') return parts[0] + '/' + parts[1] + '/' + parts[2];
  return parts[0] + '/' + parts[1];
}

function main() {
  let json;
  try {
    const out = execFileSync(
      'npx',
      ['depcruise', '--config', '.dependency-cruiser.cjs', '--no-progress', '--output-type', 'json', 'packages'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    json = JSON.parse(out);
  } catch (err) {
    console.error('verify-gate-live: failed to run/parse depcruise:', err.message);
    process.exit(2);
  }

  const modules = json.modules || [];
  let crossPackageEdges = 0;
  let sawWorkspaceImportResolved = false;

  for (const m of modules) {
    const fromPkg = pkgOf(m.source);
    for (const d of m.dependencies || []) {
      const resolved = d.resolved || '';
      const mod = d.module || '';
      const isWorkspace = mod.startsWith('@opensip-tools/');
      // Signature of a resolved workspace import: @opensip-tools specifier
      // AND resolved into a package src tree.
      if (isWorkspace && resolved.startsWith('packages/')) {
        sawWorkspaceImportResolved = true;
        const toPkg = pkgOf(resolved);
        if (fromPkg && toPkg && fromPkg !== toPkg) crossPackageEdges++;
      }
      // No workspace import should resolve into dist or node_modules — that
      // means the resolver fell back to package exports and the gate is
      // half-broken.
      if (isWorkspace && (resolved.includes('/dist/') || resolved.includes('node_modules'))) {
        console.error('verify-gate-live: @opensip-tools import resolved to built output (gate would be inert): ' + m.source + ' -> ' + resolved);
        process.exit(1);
      }
    }
  }

  if (!sawWorkspaceImportResolved) {
    console.error('verify-gate-live: FAIL — no @opensip-tools import resolved to a package src tree. The dependency-cruiser resolver is broken; every cross-package layer rule is INERT. Check options.tsConfig.fileName -> tsconfig.depcruise.json and its paths map.');
    process.exit(1);
  }
  if (crossPackageEdges < MIN_CROSS_PACKAGE_EDGES) {
    console.error('verify-gate-live: FAIL — only ' + crossPackageEdges + ' cross-package edges resolved (expected >= ' + MIN_CROSS_PACKAGE_EDGES + '). The resolver is likely partially broken; cross-package rules may be inert.');
    process.exit(1);
  }

  console.log('verify-gate-live: OK — ' + crossPackageEdges + ' cross-package edges resolved into package src trees; the architecture gate is live.');
}

main();

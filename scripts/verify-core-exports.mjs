#!/usr/bin/env node
/**
 * verify-core-exports — public-export guard (ADR-0055 + ADR-0151).
 *
 * Locks the exact public export surface of the kernel plus six additional tool
 * surfaces against reviewed allowlists, using the shared TypeScript-AST walker
 * in scripts/lib/public-export-surface.mjs. A public export cannot be added,
 * removed, or change kind (value ⇄ type ⇄ dual class/enum) without an explicit
 * allowlist edit.
 *
 *   - @opensip-cli/core stays on the legacy ADR-0055 flat-name allowlist
 *     (.config/core-export-allowlist.cjs): its value+type union is compared
 *     against the name set, and its `export *` barrel spine against
 *     BARREL_WILDCARDS.
 *   - The six tool surfaces are locked with EXACT value AND type namespaces
 *     (.config/package-export-allowlists.cjs), reported per namespace on drift.
 *
 * No auto-update mode: drift is a reviewed edit, never a silent regeneration.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPORT_ALLOWLIST, BARREL_WILDCARDS } from '../.config/core-export-allowlist.cjs';
import { PACKAGE_EXPORT_ALLOWLISTS } from '../.config/package-export-allowlists.cjs';
import {
  readPublicExportSurface,
  comparePublicExportSurface,
} from './lib/public-export-surface.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_ENTRY = 'packages/core/src/index.ts';

/** @param {string[]} arr */
function bullets(arr) {
  return arr.map((n) => `  - ${n}`).join('\n');
}

/**
 * Validate @opensip-cli/core against the legacy ADR-0055 flat-name allowlist:
 * the union of value+type names must equal the allowlist key set, and the
 * `export *` barrel spine must equal BARREL_WILDCARDS.
 * @returns {{ failed: boolean, summary: string }}
 */
function verifyCore() {
  const surface = readPublicExportSurface(CORE_ENTRY, { repoRoot: ROOT });
  const union = [...new Set([...surface.valueExports, ...surface.typeExports])].sort();
  const allowed = Object.keys(EXPORT_ALLOWLIST);

  // Reuse the pure diff over a single (union) namespace.
  const { missingValues: missing, staleValues: stale } = comparePublicExportSurface(
    { valueExports: union, typeExports: [] },
    { valueExports: allowed, typeExports: [] },
  );

  const allowedBarrels = new Set(BARREL_WILDCARDS);
  const liveBarrels = new Set(surface.wildcards);
  const missingBarrels = surface.wildcards.filter((p) => !allowedBarrels.has(p));
  const staleBarrels = [...allowedBarrels].filter((p) => !liveBarrels.has(p)).sort();

  let failed = false;
  if (missing.length > 0) {
    failed = true;
    console.error('core-export-allowlist: new @opensip-cli/core exports without a sub-boundary entry:');
    console.error(bullets(missing));
    console.error(
      'Add each export to .config/core-export-allowlist.cjs with an ADR-0055 sub-boundary tag.',
    );
  }
  if (stale.length > 0) {
    failed = true;
    console.error('core-export-allowlist: stale entries (no longer exported from index.ts):');
    console.error(bullets(stale.map((n) => `${n} (${EXPORT_ALLOWLIST[n]})`)));
  }
  if (missingBarrels.length > 0) {
    failed = true;
    console.error('core-export-allowlist: unexpected export * barrel(s):', missingBarrels);
  }
  if (staleBarrels.length > 0) {
    failed = true;
    console.error('core-export-allowlist: BARREL_WILDCARDS out of sync:', staleBarrels);
  }

  return {
    failed,
    summary: `@opensip-cli/core: ${union.length} names, ${surface.wildcards.length} barrel wildcard(s)`,
  };
}

/**
 * Validate one tool surface against its exact value/type allowlist.
 * @param {string} spec
 * @param {{ entry: string, valueExports: string[], typeExports: string[] }} expected
 * @returns {{ failed: boolean, summary: string }}
 */
function verifyPackageSurface(spec, expected) {
  const surface = readPublicExportSurface(expected.entry, { repoRoot: ROOT });
  const diff = comparePublicExportSurface(surface, expected);
  let failed = false;

  if (diff.missingValues.length > 0) {
    failed = true;
    console.error(`${spec}: new VALUE exports not in allowlist (add to .config/package-export-allowlists.cjs):`);
    console.error(bullets(diff.missingValues));
  }
  if (diff.staleValues.length > 0) {
    failed = true;
    console.error(`${spec}: stale VALUE allowlist entries (no longer exported):`);
    console.error(bullets(diff.staleValues));
  }
  if (diff.missingTypes.length > 0) {
    failed = true;
    console.error(`${spec}: new TYPE exports not in allowlist (add to .config/package-export-allowlists.cjs):`);
    console.error(bullets(diff.missingTypes));
  }
  if (diff.staleTypes.length > 0) {
    failed = true;
    console.error(`${spec}: stale TYPE allowlist entries (no longer exported):`);
    console.error(bullets(diff.staleTypes));
  }
  if (surface.wildcards.length > 0) {
    failed = true;
    console.error(
      `${spec}: unexpected \`export *\` barrel wildcard(s) on a surface locked by exact namespace:`,
      surface.wildcards,
    );
  }

  return {
    failed,
    summary: `${spec}: ${surface.valueExports.length} value + ${surface.typeExports.length} type`,
  };
}

function main() {
  let failed = false;
  /** @type {string[]} */
  const summaries = [];

  /** @param {string} label @param {() => { failed: boolean, summary: string }} fn */
  const run = (label, fn) => {
    try {
      const result = fn();
      failed = failed || result.failed;
      summaries.push(result.summary);
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${label}: verifier error — ${message}`);
    }
  };

  run('@opensip-cli/core', verifyCore);
  for (const spec of Object.keys(PACKAGE_EXPORT_ALLOWLISTS).sort()) {
    run(spec, () => verifyPackageSurface(spec, PACKAGE_EXPORT_ALLOWLISTS[spec]));
  }

  if (failed) {
    process.exit(1);
  }

  console.log(`public-export-allowlist OK (${summaries.length} surfaces):`);
  for (const summary of summaries) console.log(`  ${summary}`);
}

main();

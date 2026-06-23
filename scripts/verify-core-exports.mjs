#!/usr/bin/env node
/**
 * verify-core-exports — ADR-0055 public-export guard.
 *
 * Every named export reachable from packages/core/src/index.ts (including
 * sub-barrel `export *` chains) must appear in .config/core-export-allowlist.cjs
 * with a documented sub-boundary. New kernel exports require an explicit
 * allowlist entry (and sub-boundary comment in the owning sub-barrel at review
 * time).
 *
 * Permitted `export *` barrel paths are listed in BARREL_WILDCARDS; the script
 * walks the full public re-export graph starting at index.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPORT_ALLOWLIST, BARREL_WILDCARDS } from '../.config/core-export-allowlist.cjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(ROOT, 'packages/core/src/index.ts');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** @returns {Set<string>} */
function extractNamedExports(source) {
  const stripped = stripComments(source);
  const names = new Set();
  for (const match of stripped.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && /^[A-Za-z_$]/.test(name)) {
        names.add(name);
      }
    }
  }
  return names;
}

/** @returns {string[]} */
function extractBarrelWildcards(source) {
  const stripped = stripComments(source);
  const paths = [];
  for (const match of stripped.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)) {
    paths.push(match[1]);
  }
  return paths;
}

/** @param {string} fromFile @param {string} specifier */
function resolveModulePath(fromFile, specifier) {
  const resolved = join(dirname(fromFile), specifier);
  if (resolved.endsWith('.js')) {
    const tsPath = resolved.replace(/\.js$/, '.ts');
    if (existsSync(tsPath)) return tsPath;
  }
  return resolved;
}

/**
 * Walk the public export graph from index.ts, collecting named exports and
 * every `export *` barrel specifier encountered.
 *
 * @param {string} entryPath
 * @param {Set<string>} visited
 * @returns {{ names: Set<string>, barrels: Set<string> }}
 */
function walkPublicExports(entryPath, visited = new Set()) {
  const names = new Set();
  const barrels = new Set();

  if (visited.has(entryPath)) {
    return { names, barrels };
  }
  visited.add(entryPath);

  const source = readFileSync(entryPath, 'utf8');
  for (const name of extractNamedExports(source)) {
    names.add(name);
  }
  for (const barrel of extractBarrelWildcards(source)) {
    barrels.add(barrel);
    const childPath = resolveModulePath(entryPath, barrel);
    const child = walkPublicExports(childPath, visited);
    for (const name of child.names) {
      names.add(name);
    }
    for (const childBarrel of child.barrels) {
      barrels.add(childBarrel);
    }
  }

  return { names, barrels };
}

function main() {
  const { names: liveExports, barrels: liveBarrelSet } = walkPublicExports(INDEX_PATH);
  const liveBarrels = [...liveBarrelSet].sort();
  const allowedBarrels = new Set(BARREL_WILDCARDS);

  const allowed = new Set(Object.keys(EXPORT_ALLOWLIST));
  const missingFromAllowlist = [...liveExports].filter((n) => !allowed.has(n)).sort();
  const staleInAllowlist = [...allowed].filter((n) => !liveExports.has(n)).sort();

  const missingBarrels = liveBarrels.filter((p) => !allowedBarrels.has(p));
  const staleBarrels = [...allowedBarrels].filter((p) => !liveBarrelSet.has(p)).sort();

  let failed = false;

  if (missingFromAllowlist.length > 0) {
    failed = true;
    console.error(
      'core-export-allowlist: new @opensip-cli/core exports without a sub-boundary entry:',
    );
    for (const name of missingFromAllowlist) {
      console.error(`  - ${name}`);
    }
    console.error(
      'Add each export to .config/core-export-allowlist.cjs with an ADR-0055 sub-boundary tag.',
    );
  }

  if (staleInAllowlist.length > 0) {
    failed = true;
    console.error('core-export-allowlist: stale entries (no longer exported from index.ts):');
    for (const name of staleInAllowlist) {
      console.error(`  - ${name} (${EXPORT_ALLOWLIST[name]})`);
    }
  }

  if (missingBarrels.length > 0) {
    failed = true;
    console.error('core-export-allowlist: unexpected export * barrel(s):', missingBarrels);
  }

  if (staleBarrels.length > 0) {
    failed = true;
    console.error('core-export-allowlist: BARREL_WILDCARDS out of sync:', staleBarrels);
  }

  if (failed) {
    process.exit(1);
  }

  console.log(
    `core-export-allowlist OK (${liveExports.size} named exports, ${liveBarrels.length} barrel wildcard(s))`,
  );
}

main();

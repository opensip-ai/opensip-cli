#!/usr/bin/env node
/**
 * verify-core-exports — ADR-0055 public-export guard.
 *
 * Every named export from packages/core/src/index.ts must appear in
 * .config/core-export-allowlist.cjs with a documented sub-boundary. New
 * kernel exports require an explicit allowlist entry (and sub-boundary
 * comment in index.ts at review time).
 *
 * `export * from './languages/index.js'` is the sole permitted barrel
 * re-export wildcard.
 */
import { readFileSync } from 'node:fs';
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

function main() {
  const indexSource = readFileSync(INDEX_PATH, 'utf8');
  const liveExports = extractNamedExports(indexSource);
  const liveBarrels = extractBarrelWildcards(indexSource);

  const allowed = new Set(Object.keys(EXPORT_ALLOWLIST));
  const missingFromAllowlist = [...liveExports].filter((n) => !allowed.has(n)).sort();
  const staleInAllowlist = [...allowed].filter((n) => !liveExports.has(n)).sort();

  const missingBarrels = liveBarrels.filter((p) => !BARREL_WILDCARDS.includes(p));
  const staleBarrels = BARREL_WILDCARDS.filter((p) => !liveBarrels.includes(p));

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

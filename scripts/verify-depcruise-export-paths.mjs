#!/usr/bin/env node
/**
 * verify-depcruise-export-paths — ensure .config/tsconfig.depcruise.json paths
 * cover every declared workspace package export (modular boundary Phase 3).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readWorkspaceExportMap } = require('./lib/workspace-export-map.cjs');

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TSCONFIG_PATH = join(REPO_ROOT, '.config', 'tsconfig.depcruise.json');

const { entries, diagnostics } = readWorkspaceExportMap(REPO_ROOT);
if (diagnostics.length > 0) {
  console.error('export map diagnostics:');
  for (const d of diagnostics) console.error(`  - ${d}`);
  process.exit(1);
}

const tsconfig = JSON.parse(readFileSync(TSCONFIG_PATH, 'utf8'));
const paths = tsconfig.compilerOptions?.paths ?? {};

/** @type {string[]} */
const missing = [];
/** @type {string[]} */
const wrong = [];

for (const entry of entries) {
  const mapped = paths[entry.specifier];
  if (mapped === undefined) {
    missing.push(entry.specifier);
    continue;
  }
  const first = Array.isArray(mapped) ? mapped[0] : mapped;
  // paths are relative to baseUrl ".." (repo root from .config)
  const expected = entry.relativeSource;
  if (first !== expected) {
    wrong.push(`${entry.specifier}: paths has '${first}', expected '${expected}'`);
  }
}

// Stale paths: declared in tsconfig but not a real export (allow comments-only noise).
const expectedSpecifiers = new Set(entries.map((e) => e.specifier));
const extra = Object.keys(paths).filter((k) => !expectedSpecifiers.has(k));

if (missing.length > 0 || wrong.length > 0 || extra.length > 0) {
  if (missing.length > 0) {
    console.error('missing depcruise paths for exports:');
    for (const s of missing.sort()) console.error(`  - ${s}`);
  }
  if (wrong.length > 0) {
    console.error('wrong depcruise path targets:');
    for (const s of wrong.sort()) console.error(`  - ${s}`);
  }
  if (extra.length > 0) {
    console.error('stale depcruise paths (no matching export):');
    for (const s of extra.sort()) console.error(`  - ${s}`);
  }
  process.exit(1);
}

console.error(
  `verify-depcruise-export-paths OK (${entries.length} export(s) mapped)`,
);

#!/usr/bin/env node
/**
 * build-package-keywords — derive and write the `keywords` array into every
 * published workspace package.json (the CLI included).
 *
 * Why: npm weights the `keywords` field in package search. Without it the
 * packages are effectively invisible to anyone browsing npm for "static
 * analysis", "call graph", "fitness functions", etc.
 *
 * Keywords are DERIVED deterministically from each package's identity — a
 * shared base, the `opensipTools.kind` marker, the language suffix in the
 * name, and a small per-package override map — so they stay consistent and a
 * newly added package can't silently ship with none. To tune a package's
 * keywords, edit the derivation below (not the package.json by hand): the
 * `--check` gate treats this script as the source of truth.
 *
 * Writing strategy: a single-line `"keywords": [...]` inserted/replaced right
 * after the `"description"` line, so the diff is one line per file and the
 * existing formatting (some package.json are not JSON.stringify-canonical) is
 * left untouched.
 *
 * Usage:
 *   node scripts/build-package-keywords.mjs           # write keywords
 *   node scripts/build-package-keywords.mjs --check    # exit 1 if any drift
 *
 * Mirrors build-package-readmes.mjs (sibling generator + gate).
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const CHECK_ONLY = process.argv.slice(2).includes('--check');
const CLI_PACKAGE_NAME = 'opensip-tools';

const log = (msg) => console.error(`[build-package-keywords] ${msg}`);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', 'coverage']);

// ---- derivation -----------------------------------------------------------

/** Every package carries these. */
const BASE = ['opensip-tools', 'static-analysis', 'code-quality'];

/** Language keywords keyed by the trailing language token in the package name. */
const LANG_KEYWORDS = {
  typescript: ['typescript', 'javascript'],
  python: ['python'],
  go: ['go', 'golang'],
  java: ['java'],
  rust: ['rust'],
  cpp: ['cpp', 'c++'],
  universal: ['multi-language'],
};

/** Per-package additions for the engines and notable libraries. */
const OVERRIDES = {
  'opensip-tools': [
    'cli',
    'fitness-functions',
    'call-graph',
    'architecture',
    'linting',
    'code-review',
    'devtools',
  ],
  '@opensip-tools/fitness': ['fitness-functions', 'linting', 'architecture', 'code-review'],
  '@opensip-tools/graph': ['call-graph', 'dependency-graph', 'code-analysis', 'architecture'],
  '@opensip-tools/simulation': ['simulation', 'testing'],
  '@opensip-tools/core': ['kernel', 'plugin-system'],
  '@opensip-tools/contracts': ['types', 'contracts'],
  '@opensip-tools/datastore': ['sqlite', 'drizzle', 'persistence'],
  '@opensip-tools/session-store': ['sqlite', 'persistence'],
  '@opensip-tools/reporting': ['sarif', 'reporting'],
  '@opensip-tools/dashboard': ['html-report', 'visualization', 'reporting'],
  '@opensip-tools/cli-ui': ['cli', 'terminal', 'ink', 'react'],
  '@opensip-tools/graph-adapter-common': ['call-graph', 'tree-sitter'],
};

/** Derive the (deduplicated, order-preserving) keyword list for one package. */
function deriveKeywords(pkg) {
  const name = pkg.name;
  const short = name.replace('@opensip-tools/', '');
  const kind = pkg.opensipTools?.kind;
  const out = [...BASE];

  if (kind === 'fit-pack') out.push('fitness-checks', 'linting');
  if (kind === 'graph-adapter') out.push('call-graph', 'dependency-graph');
  if (short.startsWith('lang-')) out.push('parser', 'ast', 'tree-sitter');

  const langKey = Object.keys(LANG_KEYWORDS).find((l) => short === l || short.endsWith(`-${l}`));
  if (langKey) out.push(...LANG_KEYWORDS[langKey]);

  if (OVERRIDES[name]) out.push(...OVERRIDES[name]);

  return [...new Set(out)];
}

// ---- io -------------------------------------------------------------------

function collectPackageJsonPaths(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectPackageJsonPaths(join(dir, entry.name), out);
    } else if (entry.name === 'package.json') {
      out.push(join(dir, entry.name));
    }
  }
}

function isReleasable(pkg) {
  return (
    typeof pkg.name === 'string' &&
    (pkg.name.startsWith('@opensip-tools/') || pkg.name === CLI_PACKAGE_NAME) &&
    pkg.private !== true
  );
}

function serializeKeywords(keywords) {
  return `[${keywords.map((k) => JSON.stringify(k)).join(', ')}]`;
}

/**
 * Return the file text with a single-line `"keywords": [...]` set to `next`.
 * Replaces an existing single-line keywords field if present, otherwise
 * inserts one right after the `"description"` line (same indentation).
 */
function withKeywords(raw, next) {
  const line = serializeKeywords(next);
  const existing = /^(\s*)"keywords":\s*\[[^\]]*\],?\n/m;
  if (existing.test(raw)) {
    return raw.replace(existing, (_m, indent) => `${indent}"keywords": ${line},\n`);
  }
  const desc = /^(\s*)"description":\s*"(?:[^"\\]|\\.)*",?\n/m;
  return raw.replace(desc, (m, indent) => `${m}${indent}"keywords": ${line},\n`);
}

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function main() {
  const paths = [];
  collectPackageJsonPaths(PACKAGES_DIR, paths);
  paths.sort();

  const drift = [];
  let written = 0;
  let considered = 0;

  for (const pjPath of paths) {
    const raw = readFileSync(pjPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (!isReleasable(pkg)) continue;
    considered++;

    const next = deriveKeywords(pkg);
    if (arraysEqual(pkg.keywords, next)) continue;

    if (CHECK_ONLY) {
      drift.push(relative(REPO_ROOT, pjPath));
    } else {
      writeFileSync(pjPath, withKeywords(raw, next), 'utf8');
      written++;
    }
  }

  if (CHECK_ONLY) {
    if (drift.length === 0) {
      log(`all ${considered} package(s) have up-to-date keywords.`);
      return;
    }
    log(`${drift.length} package(s) have stale/missing keywords — run \`pnpm docs:keywords\`:`);
    for (const f of drift) log(`  - ${f}`);
    process.exit(1);
  }

  log(`considered ${considered} package(s); updated keywords on ${written}.`);
}

main();

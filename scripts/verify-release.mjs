#!/usr/bin/env node
//
// Pre-publish consistency check for opensip-tools releases.
//
// Catches the kinds of cross-cutting drift that have produced bad
// releases in the past: half-bumped package versions, tags that
// disagree with package.json, missing CHANGELOG entries, stale
// generated docs, cross-package deps pointing at the wrong version.
//
// Nine checks (all run; any failure exits 1):
//
//   1. All @opensip-tools/* packages share the same `version`.
//   2. Tag matches the package version (CI: --expected-version $TAG).
//   3. CHANGELOG.md top entry is `## [<consensus version>]`.
//   4. docs/web-generated/ is in sync with docs/public/ (delegates to
//      scripts/build-web-docs.mjs --check).
//   5. Cross-package dependencies use `workspace:*` or pin the
//      consensus version — no stale version ranges.
//   6. CHANGELOG.md top entry has a valid ISO date (YYYY-MM-DD).
//   7. Per-package READMEs are in sync (version-pinned links — a bump
//      staled these and 4 did not cover them). build-package-readmes --check.
//   8. Package keywords are in sync. build-package-keywords --check.
//   9. The checks index is in sync. extract-checks-metadata | build-checks-index --check.
//
// Usage:
//   node scripts/verify-release.mjs                     # local pre-flight
//   node scripts/verify-release.mjs --expected-version v1.0.10
//
// The `v` prefix on --expected-version is stripped. In CI:
//   node scripts/verify-release.mjs --expected-version "$GITHUB_REF_NAME"
//

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCOPE = '@opensip-tools/';

// ---------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------

let expectedVersion = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--expected-version') {
    expectedVersion = args[++i];
  }
}

// ---------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------

const passes = [];
const failures = [];
const skips = [];

const pass = (id, msg) => passes.push({ id, msg });
const fail = (id, msg) => failures.push({ id, msg });
const skip = (id, msg) => skips.push({ id, msg });

// ---------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function findScopedPackages() {
  const found = [];
  const baseDir = join(REPO_ROOT, 'packages');
  const topEntries = await fs.readdir(baseDir, { withFileTypes: true });

  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    const topPath = join(baseDir, top.name);

    // Direct child: packages/<name>/package.json
    await maybeAdd(found, join(topPath, 'package.json'));

    // One level deeper: packages/<group>/<name>/package.json
    const subEntries = await fs.readdir(topPath, { withFileTypes: true });
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      await maybeAdd(found, join(topPath, sub.name, 'package.json'));
    }
  }

  return found;
}

async function maybeAdd(list, pkgPath) {
  if (!(await pathExists(pkgPath))) return;
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  // The CLI publishes under the unscoped name `opensip-tools` (the one package
  // end-users install directly); everything else is `@opensip-tools/*`. Both
  // must share the consensus version, so include the unscoped name here.
  if (typeof pkg.name === 'string' && (pkg.name === 'opensip-tools' || pkg.name.startsWith(SCOPE))) {
    list.push({
      path: pkgPath,
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
    });
  }
}

// ---------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------

const pkgs = await findScopedPackages();
if (pkgs.length === 0) {
  fail('discover', 'No @opensip-tools/* packages found under packages/.');
  printResults();
  process.exit(1);
}

// 1 — Version consistency
const versions = new Set(pkgs.map(p => p.version));
let consensusVersion;
if (versions.size === 1) {
  consensusVersion = pkgs[0].version;
  pass(1, `all ${pkgs.length} @opensip-tools/* packages at ${consensusVersion}.`);
} else {
  const grouped = {};
  for (const p of pkgs) {
    grouped[p.version] ??= [];
    grouped[p.version].push(p.name);
  }
  const detail = Object.entries(grouped)
    .map(([v, names]) => `    ${v}: ${names.join(', ')}`)
    .join('\n');
  fail(1, `packages disagree on version:\n${detail}`);
  // Pick the most common version so downstream checks still produce useful output.
  consensusVersion = Object.entries(grouped).sort((a, b) => b[1].length - a[1].length)[0][0];
}

// 2 — Tag vs package version
if (expectedVersion === null) {
  skip(2, `tag check skipped — pass --expected-version <vX.Y.Z> to enable (used by CI).`);
} else {
  const normalized = expectedVersion.startsWith('v') ? expectedVersion.slice(1) : expectedVersion;
  if (normalized === consensusVersion) {
    pass(2, `tag ${expectedVersion} matches package version ${consensusVersion}.`);
  } else {
    fail(2, `tag ${expectedVersion} (→ ${normalized}) does not match package version ${consensusVersion}.`);
  }
}

// 3 + 6 — CHANGELOG entry
const changelogPath = join(REPO_ROOT, 'CHANGELOG.md');
const changelog = await fs.readFile(changelogPath, 'utf8');
const topEntry = changelog.match(/^## \[([^\]]+)\]\s*[—-]\s*(\S+)/m);
if (topEntry === null) {
  fail(3, 'no top-level entry matching `## [X.Y.Z] — YYYY-MM-DD` found in CHANGELOG.md.');
  fail(6, 'cannot validate date — no parseable CHANGELOG entry.');
} else {
  const [, entryVersion, entryDate] = topEntry;
  if (entryVersion === consensusVersion) {
    pass(3, `CHANGELOG.md top entry is for ${consensusVersion}.`);
  } else {
    fail(3, `CHANGELOG.md top entry is for ${entryVersion}, but packages are at ${consensusVersion}.`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    pass(6, `CHANGELOG.md entry date is a valid ISO date (${entryDate}).`);
  } else {
    fail(6, `CHANGELOG.md entry date "${entryDate}" is not in YYYY-MM-DD format.`);
  }
}

// 4 — docs/web-generated/ is in sync
try {
  execFileSync('node', ['scripts/build-web-docs.mjs', '--check'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  pass(4, 'docs/web-generated/ is in sync with docs/public/.');
} catch (error) {
  const stderr = error.stderr?.toString() ?? '';
  const stdout = error.stdout?.toString() ?? '';
  fail(4, `docs/web-generated/ is stale. Run \`pnpm docs:build\` to regenerate.\n${stdout.trim() || stderr.trim() || error.message}`);
}

// 5 — Cross-package deps consistent
const crossPkgIssues = [];
for (const p of pkgs) {
  const allDeps = { ...p.dependencies, ...p.devDependencies };
  for (const [depName, depRange] of Object.entries(allDeps)) {
    if (!depName.startsWith(SCOPE)) continue;
    if (depRange.startsWith('workspace:')) continue;
    const cleaned = depRange.replace(/^[\^~>=<\s]+/, '').trim();
    if (cleaned !== consensusVersion) {
      crossPkgIssues.push(`${p.name} → ${depName}@${depRange} (consensus: ${consensusVersion})`);
    }
  }
}
if (crossPkgIssues.length === 0) {
  pass(5, `cross-package deps consistent (all using workspace:* or pinned to ${consensusVersion}).`);
} else {
  fail(5, `${crossPkgIssues.length} stale cross-package dep range(s):\n    ${crossPkgIssues.join('\n    ')}`);
}

// 7/8/9 — the other generated artifacts must be in sync too. A version bump
// re-pins README source links, so these are exactly the staleness check #4
// (web docs) does not cover.
function delegateGenerator(id, scriptArgs, okMsg, fixMsg, input) {
  try {
    execFileSync('node', scriptArgs, { cwd: REPO_ROOT, stdio: 'pipe', ...(input ? { input } : {}) });
    pass(id, okMsg);
  } catch (error) {
    const out = (error.stdout?.toString() || error.stderr?.toString() || error.message || '').trim();
    fail(id, `${fixMsg}\n${out}`);
  }
}

delegateGenerator(
  7,
  ['scripts/build-package-readmes.mjs', '--check'],
  'per-package READMEs are in sync.',
  'Per-package READMEs are stale (likely version-pinned links). Run `pnpm docs:readmes`.',
);
delegateGenerator(
  8,
  ['scripts/build-package-keywords.mjs', '--check'],
  'package keywords are in sync.',
  'Package keywords are stale. Run `pnpm docs:keywords`.',
);
// Checks index is a pipe (extract → build --check); feed the metadata via stdin.
try {
  const meta = execFileSync('node', ['scripts/extract-checks-metadata.mjs'], { cwd: REPO_ROOT });
  delegateGenerator(
    9,
    ['scripts/build-checks-index.mjs', '-', '--check'],
    'checks index is in sync.',
    'Checks index is stale. Run `pnpm docs:checks-index`.',
    meta,
  );
} catch (error) {
  fail(9, `could not run the checks-index check: ${error.message}`);
}

// ---------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------

printResults();
process.exit(failures.length === 0 ? 0 : 1);

function printResults() {
  console.log(`[verify-release] consensus version: ${consensusVersion ?? '<unknown>'}`);
  for (const r of passes) console.log(`  ✓ ${r.id}: ${r.msg}`);
  for (const r of skips) console.log(`  - ${r.id}: ${r.msg}`);
  for (const r of failures) console.error(`  ✗ ${r.id}: ${r.msg}`);

  if (failures.length === 0) {
    console.log(`\n[verify-release] all checks passed.`);
  } else {
    console.error(`\n[verify-release] ${failures.length} check(s) failed.`);
  }
}

#!/usr/bin/env node
/**
 * verify-published-artifacts — gate production tarballs to runtime bytes only
 * (ADR-0150).
 *
 * For every package in RELEASE_PACKAGE_ORDER this inspects BOTH the real clean
 * `dist/` tree and the actual `pnpm pack --dry-run --json` packlist, and rejects
 * any test/spec/fixture/coverage path. Compiler `exclude` policy prevents bad
 * emit; this script proves what each publishable package would actually SHIP.
 *
 * MUST run after a clean build (`pnpm clean && node scripts/build-ci.mjs`) — a
 * cached/incremental build is not valid packaging evidence.
 *
 * Path/packlist classification lives in scripts/lib/release-governance-surface.mjs
 * (pure, unit-tested). This file owns the filesystem + pnpm process boundary.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELEASE_PACKAGE_ORDER } from './release-package-order.mjs';
import {
  classifyPublishedArtifactPath,
  collectPublishedArtifactProblems,
} from './lib/release-governance-surface.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const log = (msg) => console.error(`[verify-published-artifacts] ${msg}`);

// Repository-tooling bounds (not public flags). Raising one requires a measured
// fixture and a reviewed change; disabling a bound is not an option.
const MAX_ENTRIES_PER_PACKAGE = 250_000;
const PACK_TIMEOUT_MS = 120_000;
const PACK_MAX_BUFFER = 64 * 1024 * 1024;
const FORBIDDEN_PACK_HOOKS = ['prepack', 'prepare', 'postpack'];

/** Default command runner (injectable for tests). */
function defaultRunner(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    shell: false,
    timeout: PACK_TIMEOUT_MS,
    maxBuffer: PACK_MAX_BUFFER,
    encoding: 'utf8',
  });
}

/** Package-relative paths of every file in a real dist tree, without following escaping symlinks. */
export function scanBuiltTree(pkgRootReal, distDir) {
  const files = [];
  const stack = [distDir];
  while (stack.length > 0) {
    if (files.length > MAX_ENTRIES_PER_PACKAGE) {
      throw new Error(`dist tree exceeds ${MAX_ENTRIES_PER_PACKAGE} entries: ${distDir}`);
    }
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      let real;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }
      // Never follow a link (or entry) that escapes the package root. Compare and
      // record the REALPATH-relative path consistently, so a symlinked ancestor
      // (e.g. macOS /var -> /private/var) can't masquerade as a traversal path.
      const rel = relative(pkgRootReal, real);
      if (rel.startsWith('..') || rel.startsWith(sep) || resolve(pkgRootReal, rel) !== real) {
        throw new Error(`built path escapes package root: ${full}`);
      }
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(rel.split(sep).join('/'));
      }
    }
  }
  return files;
}

/** Publish lifecycle hooks declared by a manifest (must be rejected before pack). */
export function forbiddenPackHooks(manifest) {
  const scripts = manifest && typeof manifest === 'object' ? manifest.scripts : undefined;
  if (!scripts || typeof scripts !== 'object') return [];
  return FORBIDDEN_PACK_HOOKS.filter((h) => typeof scripts[h] === 'string');
}

/** Parse a `pnpm pack --dry-run --json` result into package-relative file paths. */
export function parsePacklist(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`malformed pack JSON: ${error instanceof Error ? error.message : error}`);
  }
  const files = parsed?.files;
  if (!Array.isArray(files)) throw new Error('pack JSON missing files[] array');
  if (files.length > MAX_ENTRIES_PER_PACKAGE) {
    throw new Error(`packlist exceeds ${MAX_ENTRIES_PER_PACKAGE} entries`);
  }
  return files.map((f) => {
    if (!f || typeof f.path !== 'string') throw new Error('pack JSON files[] entry missing path');
    return f.path;
  });
}

/** Verify one release-order package. Returns { problems, builtCount, packedCount }. */
export function verifyPackage(entry, { runner = defaultRunner, repoRoot = REPO_ROOT } = {}) {
  const problems = [];
  const pkgRoot = join(repoRoot, entry.dir);
  if (!existsSync(pkgRoot)) {
    return { problems: [`${entry.name}: package dir missing: ${entry.dir}`], builtCount: 0, packedCount: 0 };
  }
  const pkgRootReal = realpathSync(pkgRoot);

  const manifestPath = join(pkgRoot, 'package.json');
  if (!existsSync(manifestPath)) {
    return { problems: [`${entry.name}: package.json missing`], builtCount: 0, packedCount: 0 };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const hooks = forbiddenPackHooks(manifest);
  if (hooks.length > 0) {
    problems.push(`${entry.name}: publishable manifest declares forbidden pack hook(s): ${hooks.join(', ')}`);
  }

  // 1) Real built tree.
  const distDir = join(pkgRoot, 'dist');
  let builtCount = 0;
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    problems.push(`${entry.name}: dist/ is absent — run a clean build before verifying`);
  } else {
    const built = scanBuiltTree(pkgRootReal, distDir);
    builtCount = built.length;
    problems.push(...collectPublishedArtifactProblems(entry.name, built, 'dist'));
  }

  // 2) Real packlist (only if no pack hook — never spawn pnpm on a hooked manifest).
  let packedCount = 0;
  if (hooks.length === 0) {
    const result = runner('pnpm', ['--filter', entry.filter, 'pack', '--dry-run', '--json']);
    if (result.error) {
      problems.push(`${entry.name}: pack failed to spawn: ${result.error.message}`);
    } else if (result.signal) {
      problems.push(`${entry.name}: pack killed by signal ${result.signal}`);
    } else if (result.status !== 0) {
      problems.push(`${entry.name}: pack exited ${result.status}: ${String(result.stderr).slice(0, 500)}`);
    } else {
      try {
        const packed = parsePacklist(result.stdout);
        packedCount = packed.length;
        problems.push(...collectPublishedArtifactProblems(entry.name, packed, 'packlist'));
      } catch (error) {
        problems.push(`${entry.name}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  return { problems, builtCount, packedCount };
}

function main() {
  const problems = [];
  let builtTotal = 0;
  let packedTotal = 0;
  for (const entry of RELEASE_PACKAGE_ORDER) {
    const r = verifyPackage(entry);
    problems.push(...r.problems);
    builtTotal += r.builtCount;
    packedTotal += r.packedCount;
  }

  if (problems.length > 0) {
    for (const p of problems) log(p);
    log(
      `FAIL — ${problems.length} problem(s) across ${RELEASE_PACKAGE_ORDER.length} package(s); production tarballs must ship runtime artifacts only`,
    );
    process.exit(1);
  }
  log(
    `ok — ${RELEASE_PACKAGE_ORDER.length} packages inspected, ${builtTotal} built path(s) and ${packedTotal} packed path(s), 0 forbidden`,
  );
}

// Only run when invoked directly (tests import the pure helpers).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}

export { classifyPublishedArtifactPath };

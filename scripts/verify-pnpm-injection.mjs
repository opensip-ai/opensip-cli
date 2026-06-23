#!/usr/bin/env node
/**
 * verify-pnpm-injection — assert workspace injection is both CONFIGURED and
 * MATERIALIZED, so the dogfood discovery walker (and every cross-package
 * workspace dep) loads the real, built tool runtimes.
 *
 * Two failure modes this guards, learned the hard way:
 *
 *  1. CONFIG — `injectWorkspacePackages: true` must be set in
 *     pnpm-workspace.yaml. Without it the discovery walker finds 0 bundled
 *     check packs and `pnpm fit` silently runs nothing.
 *
 *  2. CONTENT — with injection ON, pnpm hard-copies each first-party
 *     workspace dependency into the virtual store
 *     (node_modules/.pnpm/@opensip-cli+<pkg>@.../node_modules/@opensip-cli/<pkg>),
 *     snapshotting the package's `files` glob and caching the packed result in
 *     the global pnpm store. The copy is taken at INSTALL time and is NOT
 *     re-synced by a later `pnpm build`. So a buildable package that was not
 *     yet built when `pnpm install` ran (e.g. a brand-new package, or a fresh
 *     CI checkout with a cold store cache) leaves consumers resolving a
 *     dist-less copy → "Cannot find module .../dist/index.js" → the bundled
 *     tool fails to load → `fit`/`graph`/`yagni` report "0 Errors" and the
 *     dogfood gate passes SILENTLY with reduced or zero checks.
 *
 *     This check resolves each injected copy's declared entry point
 *     (`exports["."]` or `main`) and asserts the file actually exists, turning
 *     that silent degradation into a loud, actionable failure.
 *
 * Remedy when CONTENT fails: build, then force a re-injection so pnpm re-packs
 * the injected copies from the freshly built source:
 *
 *     pnpm build
 *     rm -f node_modules/.pnpm-workspace-state-v1.json && pnpm install
 *
 * (Plain `pnpm install` / `pnpm install --force` short-circuit via that
 * workspace-state cache and will NOT re-sync content.)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = join(REPO_ROOT, 'pnpm-workspace.yaml');
const PNPM_DIR = join(REPO_ROOT, 'node_modules', '.pnpm');

const log = (msg) => console.error(`[verify-pnpm-injection] ${msg}`);

/** Assert `injectWorkspacePackages: true` in pnpm-workspace.yaml. */
function verifyConfig() {
  const text = readFileSync(WORKSPACE, 'utf8');
  const match = text.match(/^injectWorkspacePackages:\s*(\S+)/m);
  if (!match) {
    log('CONFIG: MISSING injectWorkspacePackages in pnpm-workspace.yaml');
    return false;
  }
  if (match[1] !== 'true') {
    log(`CONFIG: injectWorkspacePackages must be true (found: ${match[1]})`);
    return false;
  }
  return true;
}

/**
 * Resolve the file a consumer imports for a package — `exports["."]` (string
 * or conditional object) falling back to `main`. Returns the package-relative
 * entry path, or null when the package declares no entry to verify.
 * @param {Record<string, unknown>} pkg
 * @returns {string | null}
 */
function entryFor(pkg) {
  const dot = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports['.'] : undefined;
  if (typeof dot === 'string') return dot;
  if (dot && typeof dot === 'object') {
    const cond = dot.import ?? dot.default ?? dot.require ?? dot.node;
    if (typeof cond === 'string') return cond;
  }
  if (typeof pkg.exports === 'string') return pkg.exports;
  if (typeof pkg.main === 'string') return pkg.main;
  return null;
}

/**
 * Walk every injected first-party copy and assert its entry point exists.
 * @returns {{ checked: number; missing: Array<{ pkg: string; entry: string }> }}
 */
function verifyInjectedContent() {
  const missing = [];
  let checked = 0;

  if (!existsSync(PNPM_DIR)) {
    log('CONTENT: node_modules/.pnpm not found — run `pnpm install` first');
    return { checked, missing: [{ pkg: '(node_modules/.pnpm)', entry: '' }] };
  }

  // Injected copies live at: .pnpm/@opensip-cli+<pkg>@<peers>/node_modules/@opensip-cli/<pkg>
  const stores = readdirSync(PNPM_DIR).filter((name) => name.startsWith('@opensip-cli+'));
  for (const store of stores) {
    const scopeDir = join(PNPM_DIR, store, 'node_modules', '@opensip-cli');
    if (!existsSync(scopeDir)) continue;
    for (const pkgName of readdirSync(scopeDir)) {
      const copyDir = join(scopeDir, pkgName);
      const pkgJsonPath = join(copyDir, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      } catch {
        continue;
      }
      const entry = entryFor(pkg);
      if (!entry) continue; // nothing to verify (e.g. types-only / no entry)
      checked += 1;
      if (!existsSync(join(copyDir, entry))) {
        missing.push({ pkg: `@opensip-cli/${pkgName}`, entry });
      }
    }
  }
  return { checked, missing };
}

function main() {
  let failed = false;

  if (!verifyConfig()) {
    failed = true;
  }

  const { checked, missing } = verifyInjectedContent();
  if (missing.length > 0) {
    failed = true;
    // Dedupe the report by package name — the same package is injected under
    // many consumers; one line per package is enough to act on.
    const byPkg = new Map();
    for (const m of missing) {
      if (!byPkg.has(m.pkg)) byPkg.set(m.pkg, m.entry);
    }
    log('CONTENT: injected workspace copies are missing their entry point:');
    for (const [pkg, entry] of byPkg) {
      log(`  - ${pkg} → ${entry} (not present in injected copy)`);
    }
    log('Injected copies were snapshotted before the package was built (or the');
    log('pnpm store cache is cold). `pnpm build` alone does NOT re-sync them.');
    log('Remedy:');
    log('  pnpm build');
    log('  rm -f node_modules/.pnpm-workspace-state-v1.json && pnpm install');
  }

  if (failed) {
    process.exit(1);
  }

  log(`OK — injectWorkspacePackages: true; ${checked} injected entry points resolve`);
}

main();

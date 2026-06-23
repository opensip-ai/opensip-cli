#!/usr/bin/env node
/**
 * verify-pnpm-injection — assert workspace injection is both CONFIGURED and
 * MATERIALIZED, so the dogfood discovery walker (and every cross-package
 * workspace dep) loads the real, built tool runtimes.
 *
 * Failure modes this guards, learned the hard way:
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
 *     Phase 0 (ADR-0060) compares each injected copy against its workspace
 *     source under packages/: top-level entry, deep export targets, the full
 *     dist/ file set, and package.json#opensipTools when present.
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
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const PNPM_DIR = join(REPO_ROOT, 'node_modules', '.pnpm');

const SKIP_PACKAGE_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', 'coverage']);

export const REMEDY_LINES = [
  'pnpm build',
  'rm -f node_modules/.pnpm-workspace-state-v1.json && pnpm install',
];

const log = (msg) => console.error(`[verify-pnpm-injection] ${msg}`);

/** Assert `injectWorkspacePackages: true` in pnpm-workspace.yaml text. */
export function verifyConfigFromText(text) {
  const match = text.match(/^injectWorkspacePackages:\s*(\S+)/m);
  if (!match) {
    return { ok: false, reason: 'MISSING injectWorkspacePackages in pnpm-workspace.yaml' };
  }
  if (match[1] !== 'true') {
    return { ok: false, reason: `injectWorkspacePackages must be true (found: ${match[1]})` };
  }
  return { ok: true };
}

/** Assert `injectWorkspacePackages: true` in pnpm-workspace.yaml. */
function verifyConfig() {
  const text = readFileSync(WORKSPACE, 'utf8');
  const result = verifyConfigFromText(text);
  if (!result.ok) {
    log(`CONFIG: ${result.reason}`);
    return false;
  }
  return true;
}

/**
 * Resolve one export-map target (string or conditional object).
 * @param {unknown} value
 * @returns {string | null}
 */
export function resolveExportTarget(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const cond = value.import ?? value.default ?? value.require ?? value.node;
    if (typeof cond === 'string') return cond;
  }
  return null;
}

/**
 * Resolve the file a consumer imports for a package — `exports["."]` (string
 * or conditional object) falling back to `main`. Returns the package-relative
 * entry path, or null when the package declares no entry to verify.
 * @param {Record<string, unknown>} pkg
 * @returns {string | null}
 */
export function entryFor(pkg) {
  const dot = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports['.'] : undefined;
  const fromDot = resolveExportTarget(dot);
  if (fromDot) return fromDot;
  if (typeof pkg.exports === 'string') return pkg.exports;
  if (typeof pkg.main === 'string') return pkg.main;
  return null;
}

/**
 * Collect explicit export subpaths beyond "." and their on-disk targets.
 * Pattern exports (e.g. "./*") are skipped — they need runtime glob expansion.
 * @param {Record<string, unknown>} pkg
 * @returns {Array<{ subpath: string; file: string }>}
 */
export function exportPathsBeyondDot(pkg) {
  const exportsField = pkg.exports;
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    return [];
  }

  const paths = [];
  for (const [key, value] of Object.entries(exportsField)) {
    if (key === '.' || key.includes('*')) continue;
    const file = resolveExportTarget(value);
    if (!file || file.endsWith('/')) continue;
    paths.push({ subpath: key, file });
  }
  return paths;
}

/**
 * Recursively list files under a directory, relative to that directory.
 * @param {string} dir
 * @returns {Set<string>}
 */
export function listDistFiles(dir) {
  const files = new Set();
  if (!existsSync(dir)) return files;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const nested of listDistFiles(child)) {
        files.add(`${entry.name}/${nested}`);
      }
    } else if (entry.isFile()) {
      files.add(entry.name);
    }
  }
  return files;
}

/**
 * Compare two dist/ file sets (paths relative to dist/).
 * @param {Set<string>} sourceFiles
 * @param {Set<string>} injectedFiles
 */
export function compareDistFileSets(sourceFiles, injectedFiles) {
  const missing = [...sourceFiles].filter((file) => !injectedFiles.has(file)).sort();
  const extra = [...injectedFiles].filter((file) => !sourceFiles.has(file)).sort();
  return { missing, extra };
}

/** Deep-sort object keys for stable JSON comparison. */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

/** Compare package.json#opensipTools blocks. */
export function opensipToolsEqual(sourceTools, injectedTools) {
  if (sourceTools === undefined && injectedTools === undefined) return true;
  if (sourceTools === undefined || injectedTools === undefined) return false;
  return (
    JSON.stringify(sortKeysDeep(sourceTools)) === JSON.stringify(sortKeysDeep(injectedTools))
  );
}

/** Recursively collect every package.json path under packages/. */
export function collectPackageJsonPaths(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_PACKAGE_DIRS.has(entry.name)) continue;
      collectPackageJsonPaths(join(dir, entry.name), out);
    } else if (entry.name === 'package.json') {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Index workspace source packages by npm name.
 * @param {string} packagesDir
 * @returns {Map<string, { sourceDir: string; pkg: Record<string, unknown> }>}
 */
export function collectSourcePackages(packagesDir) {
  const byName = new Map();
  for (const pkgJsonPath of collectPackageJsonPaths(packagesDir)) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      continue;
    }
    if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@opensip-cli/')) continue;
    byName.set(pkg.name, { sourceDir: dirname(pkgJsonPath), pkg });
  }
  return byName;
}

/**
 * Discover one injected copy per first-party package name.
 * @param {string} pnpmDir
 * @returns {Map<string, { copyDir: string; pkg: Record<string, unknown> }>}
 */
export function collectInjectedPackages(pnpmDir) {
  const byName = new Map();
  if (!existsSync(pnpmDir)) return byName;

  const stores = readdirSync(pnpmDir).filter((name) => name.startsWith('@opensip-cli+'));
  for (const store of stores) {
    const scopeDir = join(pnpmDir, store, 'node_modules', '@opensip-cli');
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
      const fullName = typeof pkg.name === 'string' ? pkg.name : `@opensip-cli/${pkgName}`;
      if (!byName.has(fullName)) {
        byName.set(fullName, { copyDir, pkg });
      }
    }
  }
  return byName;
}

/**
 * Compare one injected copy against its workspace source.
 * @param {{ sourceDir: string; pkg: Record<string, unknown> }} source
 * @param {{ copyDir: string; pkg: Record<string, unknown> }} injected
 */
export function verifyPackageFreshness(source, injected) {
  /** @type {Array<Record<string, unknown>>} */
  const issues = [];

  const manifest = source?.pkg ?? injected.pkg;

  const entry = entryFor(manifest);
  if (entry && !existsSync(join(injected.copyDir, entry))) {
    issues.push({ kind: 'entry', entry });
  }

  for (const { subpath, file } of exportPathsBeyondDot(manifest)) {
    if (!existsSync(join(injected.copyDir, file))) {
      issues.push({ kind: 'export', subpath, file });
    }
  }

  if (source) {
    const sourceDist = join(source.sourceDir, 'dist');
    const injectedDist = join(injected.copyDir, 'dist');
    if (existsSync(sourceDist)) {
      const sourceFiles = listDistFiles(sourceDist);
      const injectedFiles = existsSync(injectedDist) ? listDistFiles(injectedDist) : new Set();
      const { missing, extra } = compareDistFileSets(sourceFiles, injectedFiles);
      if (missing.length > 0) {
        issues.push({ kind: 'dist-missing', files: missing });
      }
      if (extra.length > 0) {
        issues.push({ kind: 'dist-extra', files: extra });
      }
    }

    if (source.pkg.opensipTools !== undefined && !opensipToolsEqual(source.pkg.opensipTools, injected.pkg.opensipTools)) {
      issues.push({ kind: 'opensipTools' });
    }
  }

  return issues;
}

/**
 * Walk every injected first-party copy and assert it matches workspace source.
 * @param {{ repoRoot?: string; pnpmDir?: string; packagesDir?: string }} [options]
 * @returns {{ checked: number; issuesByPkg: Map<string, Array<Record<string, unknown>>> }}
 */
export function verifyInjectedContent(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const pnpmDir = options.pnpmDir ?? join(repoRoot, 'node_modules', '.pnpm');
  const packagesDir = options.packagesDir ?? join(repoRoot, 'packages');

  const sourceByName = collectSourcePackages(packagesDir);
  const injectedByName = collectInjectedPackages(pnpmDir);
  const issuesByPkg = new Map();
  let checked = 0;

  if (!existsSync(pnpmDir)) {
    issuesByPkg.set('(node_modules/.pnpm)', [{ kind: 'pnpm-missing' }]);
    return { checked, issuesByPkg };
  }

  for (const [pkgName, injected] of injectedByName) {
    const source = sourceByName.get(pkgName);
    const manifest = source?.pkg ?? injected.pkg;
    const entry = entryFor(manifest);
    const deepExports = exportPathsBeyondDot(manifest);
    const hasOpensipTools = source?.pkg.opensipTools !== undefined;
    const hasDist = source ? existsSync(join(source.sourceDir, 'dist')) : false;

    if (!entry && deepExports.length === 0 && !hasOpensipTools && !hasDist) {
      continue;
    }

    checked += 1;
    const issues = verifyPackageFreshness(source, injected);
    if (issues.length > 0) {
      issuesByPkg.set(pkgName, issues);
    }
  }

  return { checked, issuesByPkg };
}

/** @param {Map<string, Array<Record<string, unknown>>>} issuesByPkg */
export function formatContentFailures(issuesByPkg) {
  const lines = [];
  lines.push('CONTENT: injected workspace copies are stale vs source:');
  for (const [pkg, issues] of [...issuesByPkg.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  - ${pkg}:`);
    for (const issue of issues) {
      switch (issue.kind) {
        case 'pnpm-missing':
          lines.push('      node_modules/.pnpm not found — run `pnpm install` first');
          break;
        case 'entry':
          lines.push(`      missing entry → ${issue.entry}`);
          break;
        case 'export':
          lines.push(`      missing export ${issue.subpath} → ${issue.file}`);
          break;
        case 'dist-missing':
          lines.push(
            `      dist/ missing ${issue.files.length} file(s): ${issue.files.map((f) => `dist/${f}`).join(', ')}`,
          );
          break;
        case 'dist-extra':
          lines.push(
            `      dist/ has ${issue.files.length} stale file(s): ${issue.files.map((f) => `dist/${f}`).join(', ')}`,
          );
          break;
        case 'opensipTools':
          lines.push('      package.json#opensipTools differs from source');
          break;
        default:
          break;
      }
    }
  }
  lines.push('Injected copies were snapshotted before the package was built (or the');
  lines.push('pnpm store cache is cold). `pnpm build` alone does NOT re-sync them.');
  lines.push('Remedy:');
  for (const step of REMEDY_LINES) {
    lines.push(`  ${step}`);
  }
  return lines;
}

function main() {
  let failed = false;

  if (!verifyConfig()) {
    failed = true;
  }

  const { checked, issuesByPkg } = verifyInjectedContent();
  if (issuesByPkg.size > 0) {
    failed = true;
    for (const line of formatContentFailures(issuesByPkg)) {
      log(line);
    }
  }

  if (failed) {
    process.exit(1);
  }

  log(`OK — injectWorkspacePackages: true; ${checked} injected packages match source`);
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main();
}
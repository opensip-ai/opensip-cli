// @fitness-ignore-file unbounded-memory -- reads small text files (package.json, src/index.ts barrels) for public-API surface computation; per-file memory bounded by standard config/barrel shape.
/**
 * @fileoverview Public-API reachability graph — shared kernel helper.
 *
 * Computes the set of source files reachable from a package's
 * `package.json#exports` entry barrels via `export ... from` re-exports.
 * Extracted from checks-universal for reuse by YAGNI and fitness checks.
 *
 * Computes the set of source files reachable from a package's
 * `package.json#exports` entry barrels via `export ... from` re-exports.
 *
 * Why re-exports only (not plain `import`): a file imported by a public
 * file is internal to that file — its exports are not part of the
 * package's published surface. Only `export ... from './foo.js'`
 * re-makes `./foo.ts`'s exports visible to consumers.
 *
 * Used by `public-api-jsdoc` to scope JSDoc requirements to the actual
 * npm-published API surface, not every `export` in every internal file.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Cached computation result: the set of absolute file paths whose
 * exports are reachable from the package's `exports` map. `null`
 * indicates "could not determine package root" — caller treats every
 * file as public (the original, broad behavior).
 */
interface PackagePublicSurface {
  readonly packageRoot: string;
  readonly publicFiles: ReadonlySet<string>;
}

const surfaceCache = new Map<string, PackagePublicSurface | null>();

// Match `export { x }` / `export type { x }` / `export *` /
// `export * as ns` followed by `from '...'`. Split into two simpler
// alternatives to keep regex-complexity below the lint threshold and
// avoid catastrophic backtracking on pathological `{...}` blocks.
// Both patterns are anchored to line boundaries (gm) and use bounded
// character classes — no nested quantifiers — so they run in linear
// time over input.
/* eslint-disable sonarjs/slow-regex -- both patterns are linear: anchored to line start with `^` under the gm flag, and use negated character classes (`[^}\n]*`, `[^'"]+`) rather than nested quantifiers, so they cannot backtrack catastrophically */
const RE_EXPORT_NAMED_FROM = /^\s*export\s+(?:type\s+)?\{[^}\n]*\}\s+from\s+['"]([^'"]+)['"]/gm;
const RE_EXPORT_STAR_FROM = /^\s*export\s+\*(?:\s+as\s+\w+)?\s+from\s+['"]([^'"]+)['"]/gm;
/* eslint-enable sonarjs/slow-regex */

/**
 * Reset all memoized state. Intended for tests.
 */
export function _resetPublicApiGraphCache(): void {
  surfaceCache.clear();
}

/**
 * Walk upward from `filePath` to find the nearest `package.json`.
 * Returns the package root directory (the directory containing
 * `package.json`), or `undefined` if none found before the filesystem
 * root.
 */
function findPackageRoot(filePath: string): string | undefined {
  let dir = dirname(filePath);
  // Bound the walk to avoid pathological loops on weird mounts.
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Determine whether `filePath` is part of the package's public API
 * surface — i.e., reachable from the package's `exports` entries via
 * `export ... from` re-export chains.
 *
 * Returns `true` if reachable; `false` if not. Returns `true` (open
 * fail) when the package surface cannot be determined (no
 * package.json, no `exports`, etc.) so the check degrades to its
 * historical broad behavior rather than silently passing.
 */
export function isInPublicApiSurface(filePath: string): boolean {
  const surface = getPackagePublicSurface(filePath);
  if (!surface) return true;
  return surface.publicFiles.has(filePath);
}

/**
 * Compute (and memoize) the public-API surface for the package
 * containing `filePath`.
 */
function getPackagePublicSurface(filePath: string): PackagePublicSurface | null {
  const packageRoot = findPackageRoot(filePath);
  if (!packageRoot) return null;

  const cached = surfaceCache.get(packageRoot);
  if (cached !== undefined) return cached;

  const surface = computePackagePublicSurface(packageRoot);
  surfaceCache.set(packageRoot, surface);
  return surface;
}

function computePackagePublicSurface(packageRoot: string): PackagePublicSurface | null {
  const pkg = readPackageJson(join(packageRoot, 'package.json'));
  if (!pkg) return null;

  if (isBinaryOnlyPackage(pkg)) {
    return { packageRoot, publicFiles: new Set<string>() };
  }

  const entryPaths = collectExportEntries(pkg, packageRoot);
  if (entryPaths.length === 0) return null;

  const publicFiles = seedPublicFiles(entryPaths, packageRoot);
  walkReExportGraph(publicFiles);
  return { packageRoot, publicFiles };
}

/**
 * Read and parse a `package.json` file. Returns `null` if the file
 * cannot be read or does not contain a JSON object.
 */
function readPackageJson(pkgJsonPath: string): Record<string, unknown> | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- malformed/unreadable package.json deliberately surfaces via null return; caller treats absence as "no public-API surface info available" and falls back to broad scanning.
    return null;
  }
  if (typeof pkg !== 'object' || pkg === null) return null;
  return pkg as Record<string, unknown>;
}

/**
 * A binary-only package (CLI executable with no library exports) has
 * no public API surface at all — every source file is internal. The
 * caller treats this as "empty public surface" rather than "unknown
 * surface" so the check correctly skips every file in the package.
 */
function isBinaryOnlyPackage(pkg: Record<string, unknown>): boolean {
  return (
    pkg.exports === undefined &&
    pkg.main === undefined &&
    pkg.module === undefined &&
    pkg.bin !== undefined
  );
}

/**
 * Map each package.json entry to a source file path and return the
 * initial set seeded for the re-export BFS walk.
 */
function seedPublicFiles(entryPaths: readonly string[], packageRoot: string): Set<string> {
  const publicFiles = new Set<string>();
  for (const entry of entryPaths) {
    const sourceFile = mapDistToSource(entry, packageRoot);
    if (sourceFile) publicFiles.add(sourceFile);
  }
  return publicFiles;
}

/**
 * BFS the `export ... from` re-export graph starting from the seeded
 * `publicFiles` set, adding every reached file to the same set.
 */
function walkReExportGraph(publicFiles: Set<string>): void {
  const queue: string[] = [...publicFiles];
  while (queue.length > 0) {
    const file = queue.shift();
    /* v8 ignore next -- queue.shift() returns undefined only when empty, which the while condition prevents */
    if (file === undefined) continue;
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    enqueueLocalReExports(content, dirname(file), publicFiles, queue);
  }
}

/**
 * Scan a file's content for relative `export ... from` re-exports and
 * push any newly-discovered files into both `publicFiles` and `queue`.
 */
function enqueueLocalReExports(
  content: string,
  fileDir: string,
  publicFiles: Set<string>,
  queue: string[],
): void {
  for (const regex of [RE_EXPORT_NAMED_FROM, RE_EXPORT_STAR_FROM]) {
    for (const match of content.matchAll(regex)) {
      const spec = match[1];
      // Only follow relative imports — bare-package re-exports cross
      // the package boundary and are out of scope for this package's
      // surface.
      if (!spec?.startsWith('.')) continue;
      const resolved = resolveLocalSpecifier(fileDir, spec);
      if (resolved !== undefined && !publicFiles.has(resolved)) {
        publicFiles.add(resolved);
        queue.push(resolved);
      }
    }
  }
}

/**
 * Extract a flat list of file targets from a package.json `exports`
 * field. Handles string, conditional, and subpath patterns. Patterns
 * with `*` are not expanded — they are skipped (and the file falls
 * through to the "no entries → open fail" path if no concrete entries
 * remain).
 *
 * Falls back to `main` / `module` when `exports` is absent.
 */
function collectExportEntries(pkg: Record<string, unknown>, packageRoot: string): string[] {
  const out: string[] = [];
  const exports_ = pkg.exports;
  if (exports_ === undefined) {
    for (const field of ['module', 'main'] as const) {
      const v = pkg[field];
      if (typeof v === 'string') out.push(resolveExportTarget(v, packageRoot));
    }
  } else {
    collectFromExportNode(exports_, packageRoot, out);
  }
  return out;
}

function collectFromExportNode(node: unknown, packageRoot: string, out: string[]): void {
  if (typeof node === 'string') {
    // Skip wildcard patterns — we can't enumerate them without a
    // directory scan, and conservatively treating the whole tree as
    // public would re-introduce the false-positive flood.
    if (node.includes('*')) return;
    out.push(resolveExportTarget(node, packageRoot));
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectFromExportNode(item, packageRoot, out);
    return;
  }
  if (typeof node === 'object' && node !== null) {
    for (const value of Object.values(node)) {
      collectFromExportNode(value, packageRoot, out);
    }
  }
}

function resolveExportTarget(target: string, packageRoot: string): string {
  const trimmed = target.startsWith('./') ? target.slice(2) : target;
  return resolve(packageRoot, trimmed);
}

/**
 * Map a built artifact path (typically `./dist/foo.js`) back to its
 * TypeScript source path (typically `./src/foo.ts`). Returns
 * `undefined` if no source file can be located.
 *
 * Honors common build layouts: `dist/` → `src/`, `dist/esm/` → `src/`,
 * `build/` → `src/`. Also passes through already-source paths.
 */
function mapDistToSource(absPath: string, packageRoot: string): string | undefined {
  const rel = absPath.startsWith(packageRoot + sep)
    ? absPath.slice(packageRoot.length + 1)
    : absPath;
  const candidates: string[] = [];

  // dist/foo.js → src/foo.ts (and .tsx)
  const distMatch = /^(dist|build)([\\/].*)?$/.exec(rel);
  if (distMatch) {
    const remainder = rel.slice(distMatch[1].length);
    const inSrc = 'src' + remainder;
    candidates.push(inSrc);
  } else {
    candidates.push(rel);
  }

  for (const cand of candidates) {
    const abs = isAbsolute(cand) ? cand : join(packageRoot, cand);
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      const swapped = abs.replace(/\.(js|mjs|cjs)$/, ext);
      if (swapped !== abs && fileExists(swapped)) return swapped;
    }
    if (fileExists(abs)) return abs;
  }
  return undefined;
}

/**
 * Resolve a relative module specifier to an absolute source file path.
 * Tries the literal target plus common extension swaps (`.js` → `.ts`,
 * `.js` → `.tsx`), and `index.ts` fallback for directory imports.
 */
function resolveLocalSpecifier(fromDir: string, spec: string): string | undefined {
  const base = resolve(fromDir, spec);

  const tries: string[] = [];
  // Direct extension swap (the Node16 ESM `.js` import convention).
  if (/\.(js|mjs|cjs)$/.test(base)) {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      tries.push(base.replace(/\.(js|mjs|cjs)$/, ext));
    }
  }
  tries.push(base);
  for (const ext of ['.ts', '.tsx', '.mts', '.cts']) tries.push(base + ext);
  // Directory imports (`./foo` → `./foo/index.ts`)
  for (const ext of ['.ts', '.tsx', '.mts', '.cts']) tries.push(join(base, 'index' + ext));

  for (const candidate of tries) {
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- filesystem probe; exception → false is the function's contract (missing path or permission denied means "not a file", same as truly absent).
    return false;
  }
}

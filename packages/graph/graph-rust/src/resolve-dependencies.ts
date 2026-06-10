/**
 * @fileoverview Rust `use`-path → dependency-edge resolution.
 *
 * Extracted from `resolve.ts` so the call-site resolver and the
 * dependency resolver each live in a focused module. This file owns the
 * Rust-specific module-path logic (Cargo.toml lookup, `crate`/`self`/
 * `super`/`<pkg-name>` rewriting, file-path → module-path mapping).
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Catalog, DependencyEdge, DependencySiteRecord } from '@opensip-tools/graph';

export function resolveDependencies(
  sites: readonly DependencySiteRecord[],
  catalog: Catalog,
  projectDirAbs: string,
): ReadonlyMap<string, readonly DependencyEdge[]> {
  const packageName = readCargoPackageName(projectDirAbs);
  const { moduleInitByModulePath, modulePathByFilePath } = buildCrateModuleIndex(catalog);

  const out = new Map<string, DependencyEdge[]>();
  for (const site of sites) {
    const importerModulePath = lookupImporterModulePath(
      catalog,
      modulePathByFilePath,
      site.ownerHash,
    );
    const edge = buildDependencyEdge(site, packageName, importerModulePath, moduleInitByModulePath);
    appendDependencyEdge(out, site.ownerHash, edge);
  }
  return out;
}

/**
 * Walk the catalog once to derive the two indices used during `use`-path
 * resolution: `modulePath → moduleInit bodyHash` (for forward lookup) and
 * `filePath → modulePath` (used to rewrite `super::` / `self::` paths
 * relative to the importer's own module).
 */
function buildCrateModuleIndex(catalog: Catalog): {
  readonly moduleInitByModulePath: ReadonlyMap<string, string>;
  readonly modulePathByFilePath: ReadonlyMap<string, string>;
} {
  const moduleInitByModulePath = new Map<string, string>();
  const modulePathByFilePath = new Map<string, string>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      if (o.kind !== 'module-init') continue;
      const modulePath = filePathToRustModulePath(o.filePath);
      if (modulePath === null) continue;
      moduleInitByModulePath.set(modulePath, o.bodyHash);
      modulePathByFilePath.set(o.filePath, modulePath);
    }
  }
  return { moduleInitByModulePath, modulePathByFilePath };
}

/**
 * Resolve the importer's module path (e.g. `crate::foo::bar`) from its
 * `ownerHash`. Returns `null` when the owner isn't a recognizable crate
 * module — `super::` / `self::` rewriting is then impossible.
 */
function lookupImporterModulePath(
  catalog: Catalog,
  modulePathByFilePath: ReadonlyMap<string, string>,
  ownerHash: string,
): string | null {
  const importerFilePath = filePathOfOwner(catalog, ownerHash);
  if (importerFilePath === null) return null;
  return modulePathByFilePath.get(importerFilePath) ?? null;
}

/** Build a single `DependencyEdge` for one dependency site. */
function buildDependencyEdge(
  site: DependencySiteRecord,
  packageName: string | null,
  importerModulePath: string | null,
  moduleInitByModulePath: ReadonlyMap<string, string>,
): DependencyEdge {
  const to = resolveRustUseSpecifier(
    site.specifier,
    packageName,
    importerModulePath,
    moduleInitByModulePath,
  );
  return {
    to,
    line: site.line,
    column: site.column,
    specifier: site.specifier,
  };
}

/** Append a dependency edge to the per-owner bucket, creating the bucket on first write. */
function appendDependencyEdge(
  out: Map<string, DependencyEdge[]>,
  ownerHash: string,
  edge: DependencyEdge,
): void {
  const existing = out.get(ownerHash);
  if (existing === undefined) {
    out.set(ownerHash, [edge]);
    return;
  }
  existing.push(edge);
}

/**
 * Look up the importer's filePath from the catalog via owner bodyHash.
 * Needed for `super::` / `self::` rewriting since the catalog already
 * carries the project-relative filePath.
 */
function filePathOfOwner(catalog: Catalog, ownerHash: string): string | null {
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      if (o.bodyHash === ownerHash) return o.filePath;
    }
  }
  /* v8 ignore next */
  return null;
}

/**
 * Extract the package name from `Cargo.toml`'s `[package]` section.
 * Strategy: line-grep for `name = "<value>"` inside the `[package]`
 * section header. We intentionally do NOT pull in a TOML parser — this
 * is a v1 limitation. Returns `null` when `Cargo.toml` is missing,
 * unparseable, or has no `[package] name = …`.
 *
 * Edge cases NOT handled (deferred):
 *   - `[workspace]`-only roots without a `[package]` (Cargo workspace
 *     virtual-manifest); we'd need to recurse into `members = […]`.
 *   - `[package] name = 'single-quoted'` (TOML allows this; rare).
 *   - Multi-line table arrays / nested tables that re-open `[package]`.
 *   - Dev-dependencies / feature flags — irrelevant to resolution.
 */
function readCargoPackageName(projectDirAbs: string): string | null {
  let content: string;
  try {
    content = readFileSync(join(projectDirAbs, 'Cargo.toml'), 'utf8');
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- missing/unreadable Cargo.toml is the expected "no package name" signal for projects that aren't a Cargo crate; caller treats null as "skip package-name resolution".
    return null;
  }
  let inPackage = false;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      // New section header — `[package]` enters, anything else exits.
      inPackage = /^\[package\]\s*$/.test(line);
      continue;
    }
    if (!inPackage) continue;
    const match = /^name\s*=\s*"([^"]+)"\s*$/.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * Map a project-relative POSIX filePath to its Rust crate module path.
 * Returns `null` when the file isn't recognizable as a crate module
 * (e.g. lives outside `src/`, or doesn't follow the canonical layout).
 *
 * Conventions handled:
 *   - `src/lib.rs`           → `crate`
 *   - `src/main.rs`          → `crate`
 *   - `src/<n>.rs`           → `crate::<n>`
 *   - `src/<n>/mod.rs`       → `crate::<n>`
 *   - `src/<a>/<b>.rs`       → `crate::<a>::<b>`
 *   - `src/<a>/<b>/mod.rs`   → `crate::<a>::<b>`
 *
 * Files outside `src/` (e.g. `tests/it.rs`, `examples/foo.rs`,
 * `benches/bench.rs`) return `null` — they're separate compilation
 * units, not part of the library/binary crate's module tree.
 */
function filePathToRustModulePath(filePath: string): string | null {
  if (!filePath.endsWith('.rs')) return null;
  if (!filePath.startsWith('src/') && filePath !== 'src.rs') return null;
  // Strip `src/` prefix.
  const rel = filePath.slice('src/'.length);
  if (rel === 'lib.rs' || rel === 'main.rs') return 'crate';
  // Strip trailing `.rs`.
  const noExt = rel.slice(0, -'.rs'.length);
  // Treat `…/mod` (from `…/mod.rs`) as the parent directory itself.
  const segments = noExt.split('/');
  if (segments.at(-1) === 'mod') segments.pop();
  if (segments.length === 0) return 'crate';
  return ['crate', ...segments].join('::');
}

/**
 * Resolve one Rust `use`-specifier to its target module-init
 * bodyHash(es). Returns `[]` for stdlib, third-party, globs, and
 * unresolvable relative paths.
 *
 * Multi-target: at v1 every match is a single module (Rust modules
 * aren't directory-spanning the way Go packages are), so the returned
 * array is either `[]` or a single hash. The `readonly string[]` shape
 * is kept for engine-model symmetry.
 */
function resolveRustUseSpecifier(
  specifier: string,
  packageName: string | null,
  importerModulePath: string | null,
  moduleInitByModulePath: ReadonlyMap<string, string>,
): readonly string[] {
  // Glob — documented v1 limitation. Skip resolution.
  if (specifier.endsWith('::*') || specifier === '*') return [];

  const segments = specifier.split('::');
  if (segments.length === 0 || segments[0] === undefined) return [];

  // Rewrite the head segment into an absolute `crate::…` path.
  const absolute = rewriteToAbsoluteModulePath(segments, packageName, importerModulePath);
  if (absolute === null) return [];

  return lookupRustModule(absolute, moduleInitByModulePath);
}

/**
 * Rewrite a `use`-path's segments into the absolute `crate::…` form
 * suitable for catalog lookup. Returns `null` when the path is external
 * (stdlib, third-party crate other than the host package).
 */
function rewriteToAbsoluteModulePath(
  segments: readonly string[],
  packageName: string | null,
  importerModulePath: string | null,
): readonly string[] | null {
  const head = segments[0];
  if (head === undefined) /* v8 ignore next */ return null;
  if (head === 'crate') {
    return segments;
  }
  if (head === 'self') {
    // `self::x::y` — current module + remainder.
    if (importerModulePath === null) return null;
    const current = importerModulePath.split('::');
    return [...current, ...segments.slice(1)];
  }
  if (head === 'super') {
    // Count consecutive leading `super` segments and walk up that many.
    if (importerModulePath === null) return null;
    let supers = 0;
    while (segments[supers] === 'super') supers++;
    const current = importerModulePath.split('::');
    // Strip `supers` trailing module segments from the current path.
    // Note: `current` always starts with `crate`, so we must not strip
    // past index 1.
    const remaining = current.slice(0, Math.max(1, current.length - supers));
    return [...remaining, ...segments.slice(supers)];
  }
  // External crate reference, possibly the host package referring to
  // itself by name (`<package-name>::foo` ≡ `crate::foo`).
  if (packageName !== null && head === toRustIdent(packageName)) {
    return ['crate', ...segments.slice(1)];
  }
  return null;
}

/**
 * Look up a fully-qualified Rust module path against the catalog. The
 * specifier may name a module OR an item inside a module (a type, fn,
 * const, etc.). Tree-sitter can't distinguish the two, so we walk from
 * the longest module-prefix match toward `crate`, returning the first
 * hit.
 */
function lookupRustModule(
  segments: readonly string[],
  moduleInitByModulePath: ReadonlyMap<string, string>,
): readonly string[] {
  const cur = [...segments];
  while (cur.length > 0) {
    const key = cur.join('::');
    const hash = moduleInitByModulePath.get(key);
    if (hash !== undefined) return [hash];
    cur.pop();
  }
  return [];
}

/**
 * Cargo package names allow `-` but Rust identifiers don't — Cargo
 * substitutes `-` → `_` when synthesizing the crate's Rust-visible
 * name. Mirror that.
 */
function toRustIdent(packageName: string): string {
  return packageName.replaceAll('-', '_');
}

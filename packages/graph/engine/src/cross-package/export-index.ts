/**
 * Linker data structures for semantic cross-shard resolution (plan #2, Phase 1).
 *
 * Two pure "symbol tables" the boundary resolver (Phase 2) links against —
 * derivable entirely from data already present in a merged catalog plus the
 * resolved `Shard[]`:
 *
 *   1. {@link ExportIndex} — per-package map of exported function name →
 *      occurrences (`visibility === 'exported'`). The export symbol table:
 *      "given a package and a callee name, which exported occurrences match?"
 *   2. {@link PackageManifestIndex} — package `name` → its on-disk manifest
 *      (`name`, dir, `exports` map). Lets {@link resolveSpecifierToPackage}
 *      turn a bare import specifier (`@scope/pkg[/subpath]`) into the package
 *      group the {@link ExportIndex} is keyed by.
 *
 * Engine-layer and language-agnostic: no TypeScript parser, no AST. The only
 * effect is reading each package's `package.json` from disk in
 * {@link buildPackageManifestIndex}; everything else is plain map/path/JSON
 * math. These structures are UNUSED by resolution logic in Phase 1 — Phase 2
 * wires them into `resolveCrossBoundaryCalls`.
 *
 * Package-key alignment (the linchpin Phase 2 depends on): the boundary
 * resolver buckets occurrences by `packageOf(occ.filePath)` — the path segment
 * under `packages/` (e.g. `core`, `graph`, `languages`), NOT the package.json
 * `name`. So {@link buildExportIndex} keys by exactly that, and
 * {@link resolveSpecifierToPackage} returns a `packageGroup` derived by running
 * `packageOf` over the manifest's project-relative dir — so a specifier's
 * resolved group matches the `ExportIndex` keys verbatim.
 */

import { readFileSync } from 'node:fs';
import { posix, relative } from 'node:path';

import { logger } from '@opensip-tools/core';

import { packageOf } from '../resolve-callee.js';

import { toPosixPath } from './posix-path.js';

import type { Shard } from '../cli/orchestrate/shard-model.js';
import type { Catalog, FunctionOccurrence, ReExportRecord } from '../types.js';

// ── Task 1.1: per-package export symbol index ─────────────────────

/**
 * Per-package export symbol table: `package` → (`name` → exported occurrences).
 *
 * The outer key is `packageOf(filePath)` (the `packages/<segment>` group),
 * matching the bucketing the boundary resolver uses; the inner key is a
 * function's `simpleName`. Only `visibility === 'exported'` occurrences are
 * present — module-local and private occurrences are excluded, since an import
 * specifier can only reach a package's exports.
 *
 * Insertion order follows catalog iteration. Consumers MUST match by name, not
 * order; the inner arrays are the deterministic candidate set for a name.
 */
export type ExportIndex = ReadonlyMap<
  string /* package */,
  ReadonlyMap<string /* name */, readonly FunctionOccurrence[]>
>;

/**
 * Bucket every exported occurrence in `catalog` by its package group then by
 * its simple name. Deterministic and allocation-lean: one pass over
 * `catalog.functions`, no sorting (matching is by name, not order).
 *
 * The package key is `packageOf(occ.filePath)` — identical to what the
 * cross-shard resolver buckets by — so Phase 2 can look up
 * `exportIndex.get(packageGroup)` where `packageGroup` comes from
 * {@link resolveSpecifierToPackage}.
 */
export function buildExportIndex(
  catalog: Catalog,
  manifestIndex?: PackageManifestIndex,
): ExportIndex {
  const index = new Map<string, Map<string, FunctionOccurrence[]>>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const occ of occs) {
      if (occ.visibility !== 'exported') continue;
      const pkg = packageOf(occ.filePath);
      const byName: Map<string, FunctionOccurrence[]> = getOrCreateMap(index, pkg);
      const bucket = byName.get(occ.simpleName);
      if (bucket) bucket.push(occ);
      else byName.set(occ.simpleName, [occ]);
    }
  }
  // Re-export following: make a name reachable under the package that RE-EXPORTS
  // it (not just its defining package). Needs the manifest index to turn a
  // workspace specifier into a package group; callers without one get the
  // base (defining-package-only) index — back-compatible.
  if (manifestIndex !== undefined && catalog.reExports && catalog.reExports.length > 0) {
    applyReExports(index, catalog.reExports, manifestIndex);
  }
  return index;
}

/**
 * Fold re-export facts into the export index: for each `(reExportingPackage,
 * exportedName)`, point at the SOURCE occurrence the name is defined as in the
 * package the specifier resolves to. Runs to a FIXPOINT so chains resolve (A
 * re-exports from B which re-exports from C). Decline-beats-guess: a name already
 * present in the re-exporting package's bucket (a local definition, or an earlier
 * deterministic re-export) is never overwritten; an unresolvable specifier
 * (external npm) or absent source name is skipped.
 *
 * Relative specifiers (`'./x'`) resolve within the SAME package — the name is
 * already an occurrence there — so they are effectively no-ops; the load-bearing
 * case is a WORKSPACE specifier (`'@scope/pkg'`) crossing a package boundary.
 */
function applyReExports(
  index: Map<string, Map<string, FunctionOccurrence[]>>,
  reExports: readonly ReExportRecord[],
  manifestIndex: PackageManifestIndex,
): void {
  // Each (pkg, name) is added at most once (never overwritten), so the total
  // number of additions is bounded and the fixpoint terminates; the cap is a
  // belt-and-braces guard against a pathological re-export cycle.
  const MAX_PASSES = 16;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    for (const r of reExports) {
      if (applyOneReExport(index, r, manifestIndex)) changed = true;
    }
    if (!changed) break;
  }
}

/** Apply one re-export fact; returns whether it added any new index entry. */
function applyOneReExport(
  index: Map<string, Map<string, FunctionOccurrence[]>>,
  r: ReExportRecord,
  manifestIndex: PackageManifestIndex,
): boolean {
  // Relative re-export stays in-package (already indexed); workspace specifier
  // resolves to its package group. External / untracked → skip.
  const sourcePkg = r.specifier.startsWith('.')
    ? packageOf(r.fromFile)
    : resolveSpecifierToPackage(r.specifier, manifestIndex)?.packageGroup;
  if (sourcePkg === undefined) return false; // @silent-ok — external/untracked specifier; decline
  const sourceBucket = index.get(sourcePkg);
  if (sourceBucket === undefined) return false; // @silent-ok — source package has no indexed exports
  const fromBucket = getOrCreateMap(index, packageOf(r.fromFile));
  return r.exportedName === '*'
    ? expandStarReExport(sourceBucket, fromBucket)
    : addNamedReExport(r, sourceBucket, fromBucket);
}

/** `export * from src` — expose every source export the re-exporting package
 *  does not already own. Returns whether anything was added. */
function expandStarReExport(
  sourceBucket: ReadonlyMap<string, FunctionOccurrence[]>,
  fromBucket: Map<string, FunctionOccurrence[]>,
): boolean {
  let changed = false;
  for (const [name, occs] of sourceBucket) {
    if (!fromBucket.has(name)) {
      fromBucket.set(name, occs);
      changed = true;
    }
  }
  return changed;
}

/** `export { sourceName as exportedName } from src` — point the re-exporting
 *  package's bucket at the source occurrence (never overriding a local def /
 *  earlier re-export). Returns whether it was added. */
function addNamedReExport(
  r: ReExportRecord,
  sourceBucket: ReadonlyMap<string, FunctionOccurrence[]>,
  fromBucket: Map<string, FunctionOccurrence[]>,
): boolean {
  if (fromBucket.has(r.exportedName)) return false; // @silent-ok — local def / earlier re-export wins
  const occs = sourceBucket.get(r.sourceName);
  if (occs === undefined || occs.length === 0) return false; // @silent-ok — name not exported by source pkg
  fromBucket.set(r.exportedName, occs);
  return true;
}

/**
 * Get `outer.get(key)`, creating + inserting a fresh inner `Map` when absent.
 * A pure single-threaded grouping helper over a local in-memory `Map` (no shared
 * state) — extracted so the get-then-insert lives behind one typed-`Map`
 * parameter rather than inline in {@link buildExportIndex}.
 */
function getOrCreateMap<K, IK, IV>(outer: Map<K, Map<IK, IV>>, key: K): Map<IK, IV> {
  const existing = outer.get(key);
  if (existing !== undefined) return existing;
  const created = new Map<IK, IV>();
  outer.set(key, created);
  return created;
}

// ── Task 1.2: package-name → package(+exports) manifest index ─────

/**
 * One workspace package's manifest facts the specifier resolver needs.
 *
 * `dir` is the package's PROJECT-RELATIVE root (e.g. `packages/core`) — the
 * form `packageOf` expects — derived from the shard's absolute `rootDir`
 * against the common project root. `exportsMap` is the raw `exports` field
 * (when an object), used to gate subpath resolution.
 */
export interface PackageManifest {
  readonly name: string;
  readonly dir: string;
  readonly exportsMap?: Record<string, unknown>;
}

/** Package `name` → its {@link PackageManifest}. */
export type PackageManifestIndex = ReadonlyMap<string /* package name */, PackageManifest>;

/**
 * Read each shard's `package.json` (`name`, `exports`) and index it by package
 * name. Reuses the already-resolved `Shard[]` (no re-discovery); a shard whose
 * `rootDir` has no readable/parseable `package.json`, or whose manifest has no
 * string `name`, is skipped (it simply won't be specifier-resolvable).
 *
 * `projectRoot` is the common root all shard file paths are relativized
 * against, so each manifest's `dir` is in the same project-relative form
 * `packageOf` consumes.
 */
export function buildPackageManifestIndex(
  shards: readonly Shard[],
  projectRoot: string,
): PackageManifestIndex {
  return buildPackageManifestIndexFromRoots(
    shards.map((s) => s.rootDir),
    projectRoot,
  );
}

/**
 * Build a {@link PackageManifestIndex} from a bare list of package ROOT dirs
 * (absolute), reading each `<rootDir>/package.json`. The `Shard`-free entry the
 * single-program (exact) engine uses: it has no `Shard[]` to hand the shard
 * overload, only the package roots it derived from the catalog. Same best-effort
 * semantics — a root with no readable/parseable manifest, or a manifest with no
 * string `name`, is skipped (it won't be specifier-resolvable). First write
 * wins on a duplicate `name`.
 */
export function buildPackageManifestIndexFromRoots(
  rootDirs: readonly string[],
  projectRoot: string,
): PackageManifestIndex {
  const index = new Map<string, PackageManifest>();
  for (const rootDir of rootDirs) {
    const manifest = readManifest(rootDir, projectRoot);
    if (manifest && !index.has(manifest.name)) index.set(manifest.name, manifest);
  }
  return index;
}

/** Read + parse one package's `package.json`; `undefined` on any failure. */
function readManifest(rootDirAbs: string, projectRoot: string): PackageManifest | undefined {
  const manifestPath = posix.join(toPosixPath(rootDirAbs), 'package.json');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    // Best-effort: a shard without a readable package.json is simply not
    // specifier-resolvable. Note the skip so the swallow isn't silent.
    logger.debug({
      evt: 'graph.export_index.manifest_read_skipped',
      module: 'graph:export-index',
      manifestPath,
      err: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Best-effort: an unparseable package.json is not specifier-resolvable.
    // Note the skip so the swallow isn't silent.
    logger.debug({
      evt: 'graph.export_index.manifest_parse_skipped',
      module: 'graph:export-index',
      manifestPath,
      err: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const exportsField = record.exports;
  const exportsMap =
    typeof exportsField === 'object' && exportsField !== null
      ? (exportsField as Record<string, unknown>)
      : undefined;
  return { name, dir: relativeDir(rootDirAbs, projectRoot), exportsMap };
}

/** Project-relative POSIX dir for a shard's absolute rootDir (the `packageOf` form). */
function relativeDir(rootDirAbs: string, projectRoot: string): string {
  return toPosixPath(relative(projectRoot, rootDirAbs));
}

/** The outcome of resolving a bare import specifier to a workspace package. */
export interface ResolvedSpecifier {
  /** The `packageOf`-aligned group key — looks up into an {@link ExportIndex}. */
  readonly packageGroup: string;
  /** The `exports` subpath (`./errors`) when the specifier addressed one. */
  readonly subpath?: string;
}

/**
 * Resolve a bare import specifier (`@scope/pkg` or `@scope/pkg/subpath`, or the
 * unscoped `pkg` / `pkg/subpath`) to the package group an {@link ExportIndex}
 * is keyed by, plus the addressed `exports` subpath when present.
 *
 * Returns `undefined` (→ Phase 2 declines, emits no edge) when:
 *   - the specifier is relative (`./x`) or empty — not a bare package import;
 *   - the package name is not in `manifestIndex` (external / untracked dep);
 *   - a subpath is present but is NOT declared in the package's `exports` map.
 *
 * **V1 subpath scope (open question decided here):** resolve the package ROOT
 * export and only those subpaths LITERALLY declared as keys in `exports`
 * (`./errors`, `./languages/parse-cache.js`). Glob/conditional `exports`
 * resolution is deferred. A package with no object `exports` is treated as
 * exposing only its root — any subpath against it is unmappable → `undefined`.
 * The returned `packageGroup` is the same for root and subpath (the subpath
 * lives inside the same package); Phase 2 narrows by name within that group.
 */
export function resolveSpecifierToPackage(
  specifier: string,
  manifestIndex: PackageManifestIndex,
): ResolvedSpecifier | undefined {
  if (specifier.length === 0 || specifier.startsWith('.')) return undefined;
  const { packageName, subpath } = splitSpecifier(specifier);
  if (packageName === undefined) return undefined;

  const manifest = manifestIndex.get(packageName);
  if (manifest === undefined) return undefined;

  if (subpath !== undefined && !exportsDeclares(manifest.exportsMap, subpath)) {
    return undefined; // unmappable subpath → decline
  }

  const packageGroup = packageOf(`${manifest.dir}/`);
  return subpath === undefined ? { packageGroup } : { packageGroup, subpath };
}

/**
 * Split a bare specifier into its package name (`@scope/pkg` or `pkg`) and the
 * remaining `exports`-style subpath (`./rest`), or `undefined` subpath for a
 * bare root import. Returns `packageName: undefined` for an unparseable
 * specifier (e.g. a lone `@scope` with no package segment).
 */
function splitSpecifier(specifier: string): {
  readonly packageName: string | undefined;
  readonly subpath: string | undefined;
} {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    // Scoped: @scope/pkg[/...rest]
    if (parts.length < 2 || parts[0] === undefined || parts[1] === undefined) {
      return { packageName: undefined, subpath: undefined };
    }
    const packageName = `${parts[0]}/${parts[1]}`;
    const rest = parts.slice(2);
    return { packageName, subpath: rest.length > 0 ? `./${rest.join('/')}` : undefined };
  }
  // Unscoped: pkg[/...rest]
  const packageName = parts[0];
  if (packageName === undefined || packageName.length === 0) {
    return { packageName: undefined, subpath: undefined };
  }
  const rest = parts.slice(1);
  return { packageName, subpath: rest.length > 0 ? `./${rest.join('/')}` : undefined };
}

/** True when `exports` literally declares `subpath` as a key (v1 — no globs). */
function exportsDeclares(
  exportsMap: Record<string, unknown> | undefined,
  subpath: string,
): boolean {
  return exportsMap !== undefined && Object.prototype.hasOwnProperty.call(exportsMap, subpath);
}

/**
 * Cross-package resolution context for the EXACT (single-program) engine.
 *
 * The sharded engine links a `@scope/pkg` call to its target by looking the
 * (import specifier + callee name) up in the imported package's export symbol
 * table ({@link buildExportIndex}) — never by following the type-checker alias
 * into the package's built `dist/*.d.ts` (which is bodiless, so its hash never
 * matches the SOURCE body in the catalog). The exact engine now resolves
 * cross-package calls the SAME way, through {@link resolveCrossPackageCall}; this
 * module assembles the two indexes that resolver needs from the data the exact
 * resolve stage already has — the merged catalog + the project root.
 *
 *   - {@link ExportIndex}        — built directly from the catalog (one pass).
 *   - {@link PackageManifestIndex} — built by deriving each workspace package's
 *     root (the nearest ancestor dir of a cataloged file that has a
 *     `package.json`) and reading its manifest. Single-program builds have no
 *     `Shard[]` to hand to `buildPackageManifestIndex`, so we synthesize one
 *     shard per discovered package root; manifest reads that fail are skipped
 *     (the package simply won't be specifier-resolvable), identical to the
 *     sharded path's best-effort behavior.
 */

import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import {
  buildExportIndex,
  buildPackageManifestIndexFromRoots,
  type Catalog,
  type ExportIndex,
  type PackageManifestIndex,
} from '@opensip-cli/graph';

/** The two indexes the shared {@link resolveCrossPackageCall} resolver links against. */
export interface CrossPackageContext {
  readonly exportIndex: ExportIndex;
  readonly manifestIndex: PackageManifestIndex;
}

/**
 * Assemble the exact engine's cross-package resolution context from the catalog
 * and the absolute project root. Built once per resolve stage and threaded onto
 * every resolver's {@link ResolverContext}.
 */
export function buildCrossPackageContext(
  catalog: Catalog,
  projectDirAbs: string,
): CrossPackageContext {
  const manifestIndex = buildPackageManifestIndexFromRoots(
    derivePackageRoots(catalog, projectDirAbs),
    projectDirAbs,
  );
  return {
    // Pass the manifest index so the export index can follow re-export chains
    // (a name re-exported by package A from package B resolves under A).
    exportIndex: buildExportIndex(catalog, manifestIndex),
    manifestIndex,
  };
}

/**
 * Derive each workspace package ROOT (absolute) present in the catalog. A
 * package root is the nearest ancestor directory of a cataloged file that
 * contains a `package.json`. Probing walks UP from each file's directory and
 * stops at the first `package.json` (or the project root) — so a monorepo with
 * `packages/<ns>/<pkg>/package.json` resolves each leaf package, not the
 * workspace root. Deduped by root dir.
 */
function derivePackageRoots(catalog: Catalog, projectDirAbs: string): string[] {
  const rootDirs = new Set<string>();
  const projectRootAbs = normalizeDir(projectDirAbs);

  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const occ of occs) {
      const fileDirAbs = dirname(join(projectDirAbs, occ.filePath));
      const root = findPackageRoot(fileDirAbs, projectRootAbs);
      if (root !== undefined) rootDirs.add(root);
    }
  }
  return [...rootDirs];
}

/**
 * Walk up from `startDirAbs` to the first ancestor (inclusive, up to and
 * including `projectRootAbs`) that contains a `package.json`. Returns
 * `undefined` when no manifest is found up to the project root.
 */
function findPackageRoot(startDirAbs: string, projectRootAbs: string): string | undefined {
  let dir = normalizeDir(startDirAbs);
  for (;;) {
    if (hasManifest(dir)) return dir;
    if (dir === projectRootAbs) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // filesystem root — give up
    dir = parent;
  }
}

const MANIFEST_DIRS = new Set<string>();
const NON_MANIFEST_DIRS = new Set<string>();

/** Memoized `<dir>/package.json` existence probe (process-lifetime cache —
 *  package.json presence is stable within a run). */
function hasManifest(dirAbs: string): boolean {
  if (MANIFEST_DIRS.has(dirAbs)) return true;
  if (NON_MANIFEST_DIRS.has(dirAbs)) return false;
  const present = existsSync(join(dirAbs, 'package.json'));
  (present ? MANIFEST_DIRS : NON_MANIFEST_DIRS).add(dirAbs);
  return present;
}

/** Strip a trailing path separator so dir comparisons are stable. */
function normalizeDir(dirAbs: string): string {
  return dirAbs.endsWith(sep) && dirAbs.length > 1 ? dirAbs.slice(0, -1) : dirAbs;
}

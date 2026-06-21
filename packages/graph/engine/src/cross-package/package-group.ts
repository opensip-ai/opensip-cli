/**
 * Layout-agnostic package attribution for cross-package resolution.
 *
 * One key function — {@link packageGroupOf} — and the manifest types it reads.
 * Both the export symbol index (`buildExportIndex`) and the specifier resolver
 * (`resolveSpecifierToPackage`) bucket by this SAME function with the SAME
 * manifest, so a resolved specifier's group keys straight into the export index
 * on ANY repo layout — the linchpin the cross-shard linker depends on.
 *
 * With a {@link PackageManifestIndex} (the production path — every real caller
 * passes one) the group key is the OWNING package's `name`, found by the longest
 * manifest-`dir` prefix of the file path. That is genuinely layout-agnostic: a
 * package under `apps/web`, `libs/util`, `crates/x`, nested
 * `packages/<group>/<leaf>`, or the repo root (single-package, `dir === ''`) all
 * resolve to their real `package.json` `name`. Without a manifest (legacy /
 * unit-test callers only) it falls back to the historical `packages/<segment>`
 * path heuristic ({@link packageOf}).
 *
 * Extracted from `export-index.ts` so the (cohesive) package-attribution logic +
 * its manifest types live in one focused module; `export-index.ts` re-exports the
 * types for back-compatible import paths.
 */

import { packageOf } from '../resolve-callee.js';

/**
 * One workspace package's manifest facts the specifier resolver needs.
 *
 * `dir` is the package's PROJECT-RELATIVE root (e.g. `packages/core`, `apps/web`,
 * or `''` for a single-package repo rooted at the project) — derived from the
 * shard's absolute `rootDir` against the common project root. It is the prefix
 * {@link packageGroupOf} matches file paths against. `exportsMap` is the raw
 * `exports` field (when an object), used to gate subpath resolution.
 */
export interface PackageManifest {
  readonly name: string;
  readonly dir: string;
  readonly exportsMap?: Record<string, unknown>;
}

/** Package `name` → its {@link PackageManifest}. */
export type PackageManifestIndex = ReadonlyMap<string /* package name */, PackageManifest>;

/**
 * The package-group key for a project-relative POSIX `filePath` — the SINGLE key
 * function the export index and the specifier resolver both bucket by, so they
 * align on any repo layout.
 *
 *  - WITH a {@link PackageManifestIndex} (the production path): the `name` of the
 *    OWNING package — the manifest whose project-relative `dir` is the longest
 *    path-segment prefix of `filePath`. Falls through to the path heuristic only
 *    when NO manifest dir is a prefix (a file outside every tracked package).
 *  - WITHOUT a manifest (legacy / unit-test callers): the `packages/<segment>`
 *    path heuristic ({@link packageOf}).
 */
export function packageGroupOf(filePath: string, manifestIndex?: PackageManifestIndex): string {
  if (manifestIndex !== undefined) {
    const owner = longestDirPrefixOwner(filePath, manifestIndex);
    if (owner !== undefined) return owner;
  }
  return packageOf(filePath);
}

/**
 * The `name` of the manifest whose project-relative `dir` is the longest
 * path-segment prefix of `filePath`, or `undefined` when none matches. A package
 * at the repo root (`dir === ''`) owns every file no deeper package claims (the
 * single-package-repo case). Matching is on whole path segments so `apps/web`
 * never spuriously prefixes `apps/website/...`.
 */
function longestDirPrefixOwner(
  filePath: string,
  manifestIndex: PackageManifestIndex,
): string | undefined {
  let bestName: string | undefined;
  let bestLen = -1;
  for (const manifest of manifestIndex.values()) {
    const dir = manifest.dir;
    const isPrefix = dir === '' || filePath === dir || filePath.startsWith(`${dir}/`);
    if (isPrefix && dir.length > bestLen) {
      bestLen = dir.length;
      bestName = manifest.name;
    }
  }
  return bestName;
}

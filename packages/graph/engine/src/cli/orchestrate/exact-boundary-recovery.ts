/**
 * Exact-engine boundary recovery (Phase 3, Option A — "exact = the 1-shard case").
 *
 * The single-program (exact) catalog IS the whole/merged catalog, so the cross-
 * package call sites its type-checker-driven inline pass captures inconsistently
 * (it only fires where `getSymbolAtLocation` succeeds and the reference kind
 * dispatches) are recovered by running the SAME post-merge linker the sharded
 * engine runs — `resolveCrossBoundaryCalls` — over the syntactic boundary calls
 * the exact build emitted. The extractor already skips sites resolved inline, so
 * a recovered edge never double-counts. This is what converges the two engines.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { buildPackageManifestIndexFromRoots } from '../../cross-package/export-index.js';

import { resolveCrossBoundaryCalls } from './cross-shard-resolve.js';

import type { Catalog, CrossBoundaryCall } from '../../types.js';

/**
 * Link the syntactic boundary calls the exact build emitted against its own
 * (whole-program) catalog via the shared cross-shard linker. No-op when nothing
 * was emitted (e.g. an incremental rebuild that touched no cross-package site).
 */
export function recoverExactBoundaryEdges(
  built: {
    readonly catalog: Catalog;
    readonly boundaryCalls?: readonly CrossBoundaryCall[];
  },
  files: readonly string[],
  projectRoot: string,
): Catalog {
  if (built.boundaryCalls === undefined || built.boundaryCalls.length === 0) return built.catalog;
  const manifestIndex = buildPackageManifestIndexFromRoots(
    derivePackageRoots(files, projectRoot),
    projectRoot,
  );
  return resolveCrossBoundaryCalls(built.catalog, built.boundaryCalls, manifestIndex).catalog;
}

/**
 * The distinct workspace package ROOTS (absolute) the source files belong to —
 * each file's nearest ancestor dir containing a `package.json`, up to the project
 * root. Feeds `buildPackageManifestIndexFromRoots` so the exact engine resolves a
 * `@scope/pkg` specifier to its package group exactly as the sharded engine does
 * (which derives the same set from its `Shard[]`). Memoized per directory.
 */
export function derivePackageRoots(files: readonly string[], projectRoot: string): string[] {
  const roots = new Set<string>();
  const dirToRoot = new Map<string, string | null>();
  for (const file of files) {
    const start = dirname(file);
    let root = dirToRoot.get(start);
    if (root === undefined) {
      root = findPackageRoot(start, projectRoot);
      dirToRoot.set(start, root);
    }
    if (root !== null) roots.add(root);
  }
  return [...roots];
}

/** Nearest ancestor dir of `startDir` (inclusive) containing a `package.json`,
 *  up to `projectRoot`; `null` if none. */
export function findPackageRoot(startDir: string, projectRoot: string): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (dir === projectRoot || parent === dir) return null;
    dir = parent;
  }
}

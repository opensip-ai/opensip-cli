/**
 * Cache hit/miss/incremental routing.
 *
 * Consults the on-disk catalog cache and dispatches to the right
 * rebuild path per `classifyCatalog`'s verdict:
 *   - 'valid'        → reuse the cached catalog wholesale
 *   - 'incremental'  → re-walk only changed files + their dependents
 *   - 'invalid'      → full rebuild
 */

import { stampEngineVersion } from '../../cache/engine-version.js';
import { classifyCatalog, computeFilesFingerprint } from '../../cache/invalidate.js';
import { buildAgainstStableFiles } from '../../cache/stable-files-build.js';

import { catalogBuildCoverage } from './catalog-build-coverage.js';
import {
  buildAndResolveCatalog,
  buildAndResolveCatalogIncremental,
  type RunStage,
} from './catalog-builder.js';
import { stampAndConstrainPackages } from './cross-shard-resolve.js';
import { recoverExactBoundaryEdges } from './exact-boundary-recovery.js';

import type { GraphProgressCallback } from './types.js';
import type { DiscoverOutput, GraphLanguageAdapter } from '../../lang-adapter/types.js';
import type { CatalogRepo } from '../../persistence/catalog-repo.js';
import type {
  AdapterSelectionEvidence,
  Catalog,
  ResolutionMode,
  ResolutionStats,
} from '../../types.js';
import type { PressureMonitor } from '../pressure-monitor.js';

export interface ObtainCatalogInput {
  readonly runStage: RunStage;
  readonly adapter: GraphLanguageAdapter;
  /** Provenance from the same GraphAdapterSelector pick that chose `adapter`. */
  readonly adapterSelection: AdapterSelectionEvidence;
  readonly discovery: DiscoverOutput;
  readonly catalogRepo: CatalogRepo | null;
  readonly useCache: boolean;
  /** Active resolution tier. Folded into the cacheKey so fast/exact
   *  catalogs never collide, and forwarded into the build path. */
  readonly resolutionMode: ResolutionMode;
  /** Absolute project root — used to stamp each occurrence's package via its
   *  nearest `package.json` (see `assignPackages`). */
  readonly projectRoot: string;
  readonly onProgress?: GraphProgressCallback;
  readonly monitor?: PressureMonitor;
  /** Host cancellation/deadline signal threaded into every adapter stage. */
  readonly signal?: AbortSignal;
}

export interface ObtainCatalogOutput {
  readonly catalog: Catalog;
  readonly cacheHit: boolean;
  readonly resolutionStats: ResolutionStats | null;
}

/**
 * Resolve the catalog for this run by consulting the on-disk cache,
 * dispatching to the right rebuild path (full vs Wave 4 incremental
 * vs cache hit) per `classifyCatalog`'s verdict.
 */
export async function obtainCatalog(input: ObtainCatalogInput): Promise<ObtainCatalogOutput> {
  const cachedCatalog: Catalog | null =
    input.useCache && input.catalogRepo ? input.catalogRepo.loadFullCatalog() : null;
  const currentCacheKey = stampEngineVersion(
    await input.adapter.cacheKey({
      projectDirAbs: input.discovery.projectDirAbs,
      configPathAbs: input.discovery.configPathAbs,
      compilerOptions: input.discovery.compilerOptions,
      resolutionMode: input.resolutionMode,
      signal: input.signal,
    }),
  );
  const initialFilesFingerprint = computeFilesFingerprint(input.discovery.files);
  const verdict = cachedCatalog
    ? classifyCatalog(cachedCatalog, {
        currentLanguage: input.adapter.id,
        currentCacheKey,
        currentFiles: input.discovery.files,
        currentFilesFingerprint: initialFilesFingerprint,
      })
    : ({ kind: 'invalid', reason: 'no-cache' } as const);

  if (verdict.kind === 'valid' && cachedCatalog) {
    // Parse/walk/resolve are skipped wholesale. Tell the view so it can
    // render those stages as "(cached)" rather than leaving them pending.
    for (const stage of ['parse', 'walk', 'resolve'] as const) {
      input.onProgress?.({ type: 'stage-cached', stage });
    }
    return { catalog: cachedCatalog, cacheHit: true, resolutionStats: null };
  }
  const stableBuild = await buildAgainstStableFiles({
    files: input.discovery.files,
    initialFingerprint: initialFilesFingerprint,
    build: async (attempt) => {
      const useIncremental =
        attempt === 0 && verdict.kind === 'incremental' && cachedCatalog !== null;
      const built = useIncremental
        ? await buildAndResolveCatalogIncremental({
            runStage: input.runStage,
            adapter: input.adapter,
            discovery: input.discovery,
            cachedCatalog,
            changedFilesAbs: verdict.changedFiles,
            resolutionMode: input.resolutionMode,
            onProgress: input.onProgress,
            monitor: input.monitor,
            emitBoundaryCalls: true,
            signal: input.signal,
          })
        : await buildAndResolveCatalog({
            runStage: input.runStage,
            adapter: input.adapter,
            discovery: input.discovery,
            resolutionMode: input.resolutionMode,
            onProgress: input.onProgress,
            monitor: input.monitor,
            emitBoundaryCalls: true,
            signal: input.signal,
          });

      // ONE resolution model (Phase 3, Option A): the single-program (exact)
      // catalog IS the whole/merged catalog, so run the SAME cross-shard linker
      // the sharded engine runs post-merge over its syntactic boundary calls.
      const recovered = recoverExactBoundaryEdges(built, input.discovery.files, input.projectRoot);
      return { built, recovered };
    },
  });
  const { built, recovered } = stableBuild.value;

  // Stamp packages (nearest package.json), then drop name-guessed edges that
  // contradict the import graph. Order matters: the constraint reads the
  // stamped `occurrence.package`.
  const catalog: Catalog = stampAndConstrainPackages(
    {
      ...recovered,
      filesFingerprint: stableBuild.filesFingerprint,
      // Provenance for freshness verification — only stamped on actual rebuilds;
      // legacy cache hits above return byte-unchanged.
      adapterSelection: input.adapterSelection,
      engineMode: 'exact',
      buildCoverage: catalogBuildCoverage({
        projectRoot: input.projectRoot,
        files: input.discovery.files,
        parseErrors: built.parseErrors,
        // Wave 4 incremental rebuild is byte-identical to a `--no-cache` full
        // rebuild (see `buildAndResolveCatalogIncremental`'s correctness note
        // and docs/public/40-graph/01-stages-and-catalog.md#incremental-rebuild):
        // every file whose cached edges might point at a stale hash is itself
        // re-walked, so no cached edge dangles. `catalogBuildCoverage` below
        // still independently degrades this to 'partial' if it hits a
        // malformed/unparseable path, so the incremental path isn't hard-coding
        // false completeness — it's just no longer penalized for being
        // incremental in the first place.
        status: 'complete',
      }),
    },
    input.projectRoot,
  );
  if (input.useCache && input.catalogRepo) {
    try {
      input.catalogRepo.replaceAll(catalog);
    } catch {
      /* v8 ignore next */
      // Cache write failure is non-fatal — already logged.
    }
  }
  return { catalog, cacheHit: false, resolutionStats: built.resolutionStats };
}

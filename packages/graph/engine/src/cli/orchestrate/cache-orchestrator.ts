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
import type { Catalog, ResolutionMode, ResolutionStats } from '../../types.js';
import type { PressureMonitor } from '../pressure-monitor.js';

export interface ObtainCatalogInput {
  readonly runStage: RunStage;
  readonly adapter: GraphLanguageAdapter;
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
    input.adapter.cacheKey({
      projectDirAbs: input.discovery.projectDirAbs,
      configPathAbs: input.discovery.configPathAbs,
      compilerOptions: input.discovery.compilerOptions,
      resolutionMode: input.resolutionMode,
    }),
  );
  const verdict = cachedCatalog
    ? classifyCatalog(cachedCatalog, {
        currentLanguage: input.adapter.id,
        currentCacheKey,
        currentFiles: input.discovery.files,
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
  const built =
    verdict.kind === 'incremental' && cachedCatalog
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
        })
      : await buildAndResolveCatalog({
          runStage: input.runStage,
          adapter: input.adapter,
          discovery: input.discovery,
          resolutionMode: input.resolutionMode,
          onProgress: input.onProgress,
          monitor: input.monitor,
          emitBoundaryCalls: true,
        });

  // ONE resolution model (Phase 3, Option A): the single-program (exact) catalog
  // IS the whole/merged catalog, so run the SAME cross-shard linker the sharded
  // engine runs post-merge over its syntactic boundary calls. This converges the
  // two engines — exact is the 1-shard case — resolving the cross-package call
  // sites exact's type-checker-driven inline pass captures inconsistently (it
  // only fires where `getSymbolAtLocation` succeeds and the reference kind
  // dispatches; the syntactic boundary extractor captures every imported call
  // site). The extractor already skips sites resolved inline, so no double edge.
  const recovered = recoverExactBoundaryEdges(built, input.discovery.files, input.projectRoot);

  // Stamp packages (nearest package.json), then drop name-guessed edges that
  // contradict the import graph. Order matters: the constraint reads the
  // stamped `occurrence.package`.
  const catalog: Catalog = stampAndConstrainPackages(
    {
      ...recovered,
      filesFingerprint: computeFilesFingerprint(input.discovery.files),
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

// @fitness-ignore-file error-handling-quality -- catalogRepo.replaceAll write failure is non-fatal and already logged inside the repo (see inline comment at the catch); the orchestrator returns the freshly-built catalog regardless so the run never hangs on cache persistence.
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
import {
  classifyCatalog,
  computeFilesFingerprint,
} from '../../cache/invalidate.js';
import { assignPackages } from '../../pipeline/assign-packages.js';
import { constrainCrossPackageEdges } from '../../pipeline/constrain-edges.js';

import {
  buildAndResolveCatalog,
  buildAndResolveCatalogIncremental,
  type RunStage,
} from './catalog-builder.js';

import type { GraphProgressCallback } from './types.js';
import type {
  DiscoverOutput,
  GraphLanguageAdapter,
} from '../../lang-adapter/types.js';
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
  const built = verdict.kind === 'incremental' && cachedCatalog
    ? await buildAndResolveCatalogIncremental({
        runStage: input.runStage,
        adapter: input.adapter,
        discovery: input.discovery,
        cachedCatalog,
        changedFilesAbs: verdict.changedFiles,
        resolutionMode: input.resolutionMode,
        onProgress: input.onProgress,
        monitor: input.monitor,
      })
    : await buildAndResolveCatalog({
        runStage: input.runStage,
        adapter: input.adapter,
        discovery: input.discovery,
        resolutionMode: input.resolutionMode,
        onProgress: input.onProgress,
        monitor: input.monitor,
      });

  // Stamp packages (nearest package.json), then drop name-guessed edges that
  // contradict the import graph. Order matters: the constraint reads the
  // stamped `occurrence.package`.
  const stamped = assignPackages(
    {
      ...built.catalog,
      filesFingerprint: computeFilesFingerprint(input.discovery.files),
    },
    input.projectRoot,
  );
  const catalog: Catalog = constrainCrossPackageEdges(stamped);
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

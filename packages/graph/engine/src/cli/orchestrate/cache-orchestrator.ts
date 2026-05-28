/**
 * Cache hit/miss/incremental routing.
 *
 * Consults the on-disk catalog cache and dispatches to the right
 * rebuild path per `classifyCatalog`'s verdict:
 *   - 'valid'        → reuse the cached catalog wholesale
 *   - 'incremental'  → re-walk only changed files + their dependents
 *   - 'invalid'      → full rebuild
 */

import {
  classifyCatalog,
  computeFilesFingerprint,
} from '../../cache/invalidate.js';

import {
  buildAndResolveCatalog,
  buildAndResolveCatalogIncremental,
  type RunStage,
} from './catalog-builder.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
} from '../../lang-adapter/types.js';
import type { CatalogRepo } from '../../persistence/catalog-repo.js';
import type { Catalog, ResolutionStats } from '../../types.js';
import type { GraphProgressCallback } from '../orchestrate.js';
import type { PressureMonitor } from '../pressure-monitor.js';

export interface ObtainCatalogInput {
  readonly runStage: RunStage;
  readonly adapter: GraphLanguageAdapter;
  readonly discovery: DiscoverOutput;
  readonly catalogRepo: CatalogRepo | null;
  readonly useCache: boolean;
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
export function obtainCatalog(input: ObtainCatalogInput): ObtainCatalogOutput {
  const cachedCatalog: Catalog | null =
    input.useCache && input.catalogRepo ? input.catalogRepo.loadFullCatalog() : null;
  const currentCacheKey = input.adapter.cacheKey({
    projectDirAbs: input.discovery.projectDirAbs,
    configPathAbs: input.discovery.configPathAbs,
    compilerOptions: input.discovery.compilerOptions,
  });
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
    ? buildAndResolveCatalogIncremental(
        input.runStage,
        input.adapter,
        input.discovery,
        cachedCatalog,
        verdict.changedFiles,
        input.onProgress,
        input.monitor,
      )
    : buildAndResolveCatalog(
        input.runStage,
        input.adapter,
        input.discovery,
        input.onProgress,
        input.monitor,
      );

  const catalog: Catalog = {
    ...built.catalog,
    filesFingerprint: computeFilesFingerprint(input.discovery.files),
  };
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

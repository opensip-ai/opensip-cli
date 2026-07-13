/** Immutable catalog generation identity and derived-index construction. */

import {
  buildComputeImpactIndex,
  ComputeImpactCancelledError,
  type ComputeImpactIndex,
} from '@opensip-cli/contracts';
import {
  buildGraphReadIndexes,
  catalogGenerationKey,
  type Catalog,
  type CatalogIdentity,
  type FeatureTable,
  type Indexes,
} from '@opensip-cli/graph/read';

export type GenerationSource = 'initial-load' | 'persisted-auto-swap' | 'refresh-rebuild';

export { catalogGenerationKey } from '@opensip-cli/graph/read';

/** One immutable in-memory snapshot of the served catalog plus derived indexes. */
export interface CatalogGeneration {
  readonly key: string;
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  readonly builtAt: string;
  readonly loadedAt: string;
  readonly source: GenerationSource;
  readonly derived: {
    features?: FeatureTable;
    impactIndex?: ComputeImpactIndex;
    impactIndexBuild?: Promise<ComputeImpactIndex>;
  };
}

function waitForImpactIndex(
  flight: Promise<ComputeImpactIndex>,
  signal: AbortSignal | undefined,
): Promise<ComputeImpactIndex> {
  if (signal === undefined) return flight;
  if (signal.aborted) return Promise.reject(new ComputeImpactCancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(new ComputeImpactCancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void flight.then(
      (index) => {
        signal.removeEventListener('abort', onAbort);
        resolve(index);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Impact index construction failed.'));
      },
    );
  });
}

/** Build an immutable generation's impact index once; requester cancellation never poisons it. */
export function generationImpactIndex(
  generation: CatalogGeneration,
  signal?: AbortSignal,
): Promise<ComputeImpactIndex> {
  if (signal?.aborted === true) return Promise.reject(new ComputeImpactCancelledError());
  if (generation.derived.impactIndex !== undefined) {
    return Promise.resolve(generation.derived.impactIndex);
  }
  let flight = generation.derived.impactIndexBuild;
  if (flight === undefined) {
    flight = buildComputeImpactIndex(generation.catalog)
      .then((index) => {
        generation.derived.impactIndex = index;
        return index;
      })
      .catch((error: unknown) => {
        generation.derived.impactIndexBuild = undefined;
        throw error;
      });
    generation.derived.impactIndexBuild = flight;
  }
  return waitForImpactIndex(flight, signal);
}

export function createGeneration(
  catalog: Catalog,
  source: GenerationSource,
  identity?: CatalogIdentity,
): CatalogGeneration {
  const generationIdentity: CatalogIdentity = identity ?? {
    language: catalog.language,
    cacheKey: catalog.cacheKey,
    filesFingerprint: catalog.filesFingerprint ?? '',
    builtAt: catalog.builtAt,
  };
  return {
    key: catalogGenerationKey(generationIdentity),
    catalog,
    indexes: buildGraphReadIndexes(catalog),
    builtAt: catalog.builtAt,
    loadedAt: new Date().toISOString(),
    source,
    derived: {},
  };
}

export interface RefreshOutcome {
  readonly action: 'no-op' | 'reloaded' | 'rebuilt';
  readonly generation: CatalogGeneration;
  readonly durationMs: number;
  readonly priorGenerationAvailable: boolean;
}

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

interface ImpactIndexBuildFlight {
  readonly controller: AbortController;
  readonly promise: Promise<ComputeImpactIndex>;
  waiters: number;
  settled: boolean;
}

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
    impactIndexBuild?: ImpactIndexBuildFlight;
  };
}

function releaseImpactIndexWaiter(
  generation: CatalogGeneration,
  flight: ImpactIndexBuildFlight,
  waiterCancelled: boolean,
): void {
  flight.waiters = Math.max(0, flight.waiters - 1);
  if (!waiterCancelled || flight.waiters > 0 || flight.settled) return;
  flight.controller.abort();
  if (generation.derived.impactIndexBuild === flight) {
    generation.derived.impactIndexBuild = undefined;
  }
}

function waitForImpactIndex(
  generation: CatalogGeneration,
  flight: ImpactIndexBuildFlight,
  signal: AbortSignal | undefined,
): Promise<ComputeImpactIndex> {
  flight.waiters += 1;
  return new Promise((resolve, reject) => {
    let waiterSettled = false;
    const settleWaiter = (waiterCancelled: boolean): boolean => {
      if (waiterSettled) return false;
      waiterSettled = true;
      signal?.removeEventListener('abort', onAbort);
      releaseImpactIndexWaiter(generation, flight, waiterCancelled);
      return true;
    };
    const onAbort = (): void => {
      if (settleWaiter(true)) reject(new ComputeImpactCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    void flight.promise.then(
      (index) => {
        const waiterCancelled = signal?.aborted === true;
        if (!settleWaiter(waiterCancelled)) return;
        if (waiterCancelled) reject(new ComputeImpactCancelledError());
        else resolve(index);
      },
      (error: unknown) => {
        const waiterCancelled = signal?.aborted === true;
        if (!settleWaiter(waiterCancelled)) return;
        if (waiterCancelled) reject(new ComputeImpactCancelledError());
        else {
          reject(error instanceof Error ? error : new Error('Impact index construction failed.'));
        }
      },
    );
    if (signal?.aborted === true) onAbort();
  });
}

function startImpactIndexBuild(generation: CatalogGeneration): ImpactIndexBuildFlight {
  const controller = new AbortController();
  const flight: ImpactIndexBuildFlight = {
    controller,
    waiters: 0,
    settled: false,
    promise: buildComputeImpactIndex(generation.catalog, controller.signal).then(
      (index) => {
        flight.settled = true;
        if (!controller.signal.aborted && generation.derived.impactIndexBuild === flight) {
          generation.derived.impactIndex = index;
          generation.derived.impactIndexBuild = undefined;
        }
        return index;
      },
      (error: unknown) => {
        flight.settled = true;
        if (generation.derived.impactIndexBuild === flight) {
          generation.derived.impactIndexBuild = undefined;
        }
        throw error;
      },
    ),
  };
  generation.derived.impactIndexBuild = flight;
  return flight;
}

/** Build one shared impact index; abort its work only after the final waiter cancels. */
export function generationImpactIndex(
  generation: CatalogGeneration,
  signal?: AbortSignal,
): Promise<ComputeImpactIndex> {
  if (signal?.aborted === true) return Promise.reject(new ComputeImpactCancelledError());
  if (generation.derived.impactIndex !== undefined) {
    return Promise.resolve(generation.derived.impactIndex);
  }
  const flight = generation.derived.impactIndexBuild ?? startImpactIndexBuild(generation);
  return waitForImpactIndex(generation, flight, signal);
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

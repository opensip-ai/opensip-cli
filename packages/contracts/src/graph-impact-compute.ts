import { computeImpactSynchronousEngine } from './graph-impact-sync.js';

import type { GraphCatalog } from './graph-catalog.js';
import type { ComputeImpactOptions, ImpactComputation } from './graph-impact-model.js';

/**
 * Pure changed-to-impact compute over the GraphCatalog contract (ADR-0085).
 *
 * The public surface remains here while synchronous projection, cooperative
 * traversal, and reusable generation indexing live in focused modules.
 */
export { computeImpactAsync } from './graph-impact-async.js';
export {
  buildComputeImpactIndex,
  computeImpactCatalogGenerationIdentity,
  computeImpactIndexMatchesCatalog,
} from './graph-impact-index.js';
export {
  ComputeImpactCancelledError,
  ComputeImpactIndexGenerationMismatchError,
} from './graph-impact-model.js';

/** Stable public definition; the bounded synchronous engine lives in its focused module. */
export function computeImpact(
  catalog: GraphCatalog,
  changedFiles: readonly string[],
  options?: ComputeImpactOptions,
): ImpactComputation {
  return computeImpactSynchronousEngine(catalog, changedFiles, options);
}

export type {
  ComputeImpactAsyncOptions,
  ComputeImpactChangedFileEntry,
  ComputeImpactIndex,
  ComputeImpactOptions,
  ImpactComputation,
  ImpactFunction,
  ImpactPackage,
} from './graph-impact-model.js';

import { computeImpactSynchronousEngine } from './graph-impact-sync.js';

import type { ComputeImpactOptions, GraphCatalog, ImpactComputation } from '@opensip-cli/contracts';

/**
 * Pure changed-to-impact compute over the GraphCatalog contract (ADR-0085).
 *
 * The public surface remains here while synchronous projection, cooperative
 * traversal, and reusable generation indexing live in focused modules. The
 * impact model types and the cancellation/mismatch error classes stay in
 * `@opensip-cli/contracts` — this package owns only the runtime.
 */
export { computeImpactAsync } from './graph-impact-async.js';
export {
  buildComputeImpactIndex,
  computeImpactCatalogGenerationIdentity,
  computeImpactIndexMatchesCatalog,
} from './graph-impact-index.js';

/** Stable public definition; the bounded synchronous engine lives in its focused module. */
export function computeImpact(
  catalog: GraphCatalog,
  changedFiles: readonly string[],
  options?: ComputeImpactOptions,
): ImpactComputation {
  return computeImpactSynchronousEngine(catalog, changedFiles, options);
}

/**
 * Failure funnel for decoded catalog / shard-fragment / semantic-fact integrity.
 *
 * WHY A LEAF MODULE
 * Validators in `catalog-repo.ts` and `semantic-fact-payload.ts` must raise the same
 * definition without importing each other (or importing the policy that consumes the
 * catalog). Both depend only on this module + the catalog, so the graph stays acyclic
 * — the same shape as `runtime-promotion-journal-error.ts` in the host.
 */

import { SystemError } from '@opensip-cli/core';

import { graphErrorCatalog } from './graph-error-catalog.js';

const CATALOG_UNREADABLE = graphErrorCatalog.require('GRAPH.CATALOG.UNREADABLE');

/**
 * Closed condition set for catalog payload integrity failures.
 *
 * Required so every call site names a branch the compiler can exhaust, and so the
 * allowlisted `metadata.condition` is never a free-form string that drifts from the
 * catalog's public projection contract.
 */
export type CatalogPayloadCondition =
  | 'adapter-selection-provenance'
  | 'engine-mode-provenance'
  | 'shard-cache-provenance'
  | 'build-coverage'
  | 'payload-shape'
  | 'function-container'
  | 'function-container-bound'
  | 'shard-fragment-identity'
  | 'shard-fragment-payload'
  | 'semantic-bundle'
  | 'semantic-reference-scope'
  | 'semantic-bound-exceeded'
  | 'semantic-duplicate-id'
  | 'semantic-declaration'
  | 'semantic-declaration-fields'
  | 'semantic-reference'
  | 'semantic-reference-fields'
  | 'semantic-inconsistent'
  | 'semantic-coverage'
  | 'semantic-coverage-status'
  | 'semantic-coverage-fields'
  | 'semantic-coverage-counts'
  | 'semantic-coverage-counters';

/**
 * Raise a definition-backed integrity failure for a decoded catalog payload branch.
 *
 * One registered code (`GRAPH.CATALOG.UNREADABLE`) covers every decode refusal (D9);
 * `condition` names the branch in public metadata.
 */
export function catalogPayloadError(
  condition: CatalogPayloadCondition,
  message: string,
  cause?: unknown,
): SystemError {
  return new SystemError(message, {
    code: CATALOG_UNREADABLE.code,
    definition: CATALOG_UNREADABLE,
    metadata: { condition },
    ...(cause === undefined ? {} : { cause }),
  });
}

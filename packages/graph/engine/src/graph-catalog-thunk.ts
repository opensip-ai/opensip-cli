/**
 * Host-wired graph catalog thunk factory (ADR-0085).
 *
 * Exported on the public barrel so the CLI bootstrap can populate
 * `RunScope.graphCatalog` without importing `@opensip-cli/graph/internal`.
 */
import { CatalogRepo } from './persistence/catalog-repo.js';

import type { DataStore } from '@opensip-cli/datastore';

/** Lazy catalog reader the CLI bootstrap wires onto `RunScope.graphCatalog`. */
export type GraphCatalogThunk = () => unknown;

export function createGraphCatalogThunk(datastore: () => unknown): GraphCatalogThunk {
  return () => {
    const ds = datastore() as DataStore | undefined;
    if (!ds) return null;
    return new CatalogRepo(ds).loadCatalogContract();
  };
}

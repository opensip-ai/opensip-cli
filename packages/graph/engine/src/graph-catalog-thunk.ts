/**
 * Graph catalog thunk factory (ADR-0085).
 *
 * Graph installs this onto `RunScope.graphCatalog` from its OWN
 * `contributeScope()` hook (the IoC seam every tool subscope uses) — NOT a host
 * static import, which install-source independence forbids (ADR-0009/0027/0029).
 * The thunk reads the per-run datastore lazily from `currentScope()` at call
 * time (the scope is always entered by the time fitness reads the catalog), so
 * the factory needs no constructor wiring.
 */
import { currentScope } from '@opensip-cli/core';

import { CatalogRepo } from './persistence/catalog-repo.js';

import type { DataStore } from '@opensip-cli/datastore';

/** Lazy catalog reader the graph tool installs onto `RunScope.graphCatalog`. */
export type GraphCatalogThunk = () => unknown;

/** Read the persisted catalog contract from the current run's datastore (or null). */
function loadGraphCatalogFromScope(): unknown {
  const ds = currentScope()?.datastore?.() as DataStore | undefined;
  if (!ds) return null;
  return new CatalogRepo(ds).loadCatalogContract();
}

export function createGraphCatalogThunk(): GraphCatalogThunk {
  return loadGraphCatalogFromScope;
}

/**
 * Public catalog identity and generation reads over an opaque DataStore.
 */

import { err, ok, type Result } from '@opensip-cli/core';

import { CatalogRepo } from '../persistence/catalog-repo.js';

import type { Catalog, CatalogIdentity, GraphReadError } from './types.js';
import type { DataStore } from '@opensip-cli/datastore';

/** Structural RunScope seam used by graph-owned context producer commands. */
export interface ContextCatalogAccessor {
  load(): Result<Catalog | null, GraphReadError>;
  generationIdentity(): Result<string | null, GraphReadError>;
  replace(catalog: Catalog): Result<void, GraphReadError>;
}

function readError(
  code: string,
  operation: GraphReadError['operation'],
  message: string,
): GraphReadError {
  const truncated = message.length > 160 ? message.slice(0, 157) + '...' : message;
  return { code, operation, message: truncated };
}

/**
 * Read lifted identity columns for the single catalog row without payload.
 * Missing catalog ⇒ ok(null). Storage failures ⇒ err.
 */
export function readCatalogIdentity(
  store: DataStore,
): Result<CatalogIdentity | null, GraphReadError> {
  try {
    const identity = new CatalogRepo(store).readIdentity();
    return ok(identity);
  } catch {
    return err(
      readError(
        'GRAPH.READ.CATALOG_IDENTITY',
        'catalog-identity',
        'Failed to read graph catalog identity',
      ),
    );
  }
}

/**
 * Load the full catalog generation (or null when missing). Storage failures ⇒ err.
 * Retains graph.catalog.read hit|miss|error events via CatalogRepo.
 */
export function loadCatalogGeneration(store: DataStore): Result<Catalog | null, GraphReadError> {
  try {
    const catalog = new CatalogRepo(store).loadFullCatalog();
    return ok(catalog);
  } catch {
    return err(
      readError(
        'GRAPH.READ.CATALOG_GENERATION',
        'catalog-generation',
        'Failed to load graph catalog generation',
      ),
    );
  }
}

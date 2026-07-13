/** Lazy graph-catalog persistence seam for internal context producers. */

import { currentScope, err, ok, type Result } from '@opensip-cli/core';

import { catalogGenerationKey } from '../read/catalog-generation-key.js';

import { CatalogRepo } from './catalog-repo.js';

import type { ContextCatalogAccessor } from '../read/catalog.js';
import type { GraphReadError } from '../read/types.js';
import type { Catalog } from '../types.js';
import type { DataStore } from '@opensip-cli/datastore';

function accessError(code: string, message: string): GraphReadError {
  return { code, operation: 'catalog-generation', message };
}

function currentRepo(): Result<CatalogRepo, GraphReadError> {
  const datastore = currentScope()?.datastore() as DataStore | undefined;
  if (datastore === undefined) {
    return err(
      accessError(
        'GRAPH.CONTEXT_CATALOG.DATASTORE_REQUIRED',
        'Graph context requires an entered project datastore.',
      ),
    );
  }
  return ok(new CatalogRepo(datastore));
}

function withCurrentRepo<T>(
  operation: (repo: CatalogRepo) => T,
  failureCode: string,
  failureMessage: string,
): Result<T, GraphReadError> {
  const repo = currentRepo();
  if (!repo.ok) return repo;
  try {
    return ok(operation(repo.value));
  } catch {
    return err(accessError(failureCode, failureMessage));
  }
}

/** Concrete datastore resolution stays behind the graph RunScope accessor. */
export function createContextCatalogAccessor(): ContextCatalogAccessor {
  return Object.freeze({
    load: () =>
      withCurrentRepo(
        (repo) => repo.loadFullCatalog(),
        'GRAPH.CONTEXT_CATALOG.LOAD_FAILED',
        'Failed to load the graph context catalog.',
      ),
    generationIdentity: () =>
      withCurrentRepo(
        (repo) => {
          const identity = repo.readIdentity();
          return identity === null ? null : catalogGenerationKey(identity);
        },
        'GRAPH.CONTEXT_CATALOG.IDENTITY_FAILED',
        'Failed to read the graph context catalog identity.',
      ),
    replace: (catalog: Catalog) =>
      withCurrentRepo(
        (repo) => repo.replaceAll(catalog),
        'GRAPH.CONTEXT_CATALOG.REPLACE_FAILED',
        'Failed to replace the graph context catalog.',
      ),
  });
}

/** Lazy graph-catalog persistence seam for internal context producers. */

import {
  createToolError,
  currentLogger,
  currentScope,
  err,
  normalizeFailure,
  ok,
  toOperatorFailureProjection,
  type Result,
} from '@opensip-cli/core';

import { graphErrorCatalog } from '../errors/graph-error-catalog.js';
import { catalogGenerationKey } from '../read/catalog-generation-key.js';

import { CatalogRepo } from './catalog-repo.js';

import type { ContextCatalogAccessor } from '../read/catalog.js';
import type { GraphReadError, GraphReadReason } from '../read/types.js';
import type { Catalog } from '../types.js';
import type { DataStore } from '@opensip-cli/datastore';

const CONTEXT_CATALOG_OPERATION_FAILED = graphErrorCatalog.require(
  'GRAPH.CONTEXT_CATALOG.OPERATION_FAILED',
);
const MODULE_NAME = 'graph:context-catalog-accessor';

type ContextCatalogFailureCondition =
  'datastore-resolution' | 'catalog-load' | 'catalog-identity' | 'catalog-replace';

function accessError(code: GraphReadReason, message: string): GraphReadError {
  return { code, operation: 'catalog-generation', message };
}

function operationFailure(
  cause: unknown,
  condition: ContextCatalogFailureCondition,
  failureCode: GraphReadReason,
  failureMessage: string,
): Result<never, GraphReadError> {
  const original = normalizeFailure(cause);
  const boundary = createToolError(CONTEXT_CATALOG_OPERATION_FAILED, failureMessage, {
    cause,
    metadata: { condition },
  });
  const failure = original.known === 'known' ? original : normalizeFailure(boundary);

  currentLogger().error({
    evt: 'graph.context-catalog.operation-failed',
    module: MODULE_NAME,
    code: failure.code,
    boundaryCode: CONTEXT_CATALOG_OPERATION_FAILED.code,
    condition,
    failure: toOperatorFailureProjection(failure),
  });

  return err(accessError(failureCode, failureMessage));
}

function withCurrentRepo<T>(
  operation: (repo: CatalogRepo) => T,
  condition: Exclude<ContextCatalogFailureCondition, 'datastore-resolution'>,
  failureCode: GraphReadReason,
  failureMessage: string,
): Result<T, GraphReadError> {
  let datastore: DataStore | undefined;
  try {
    datastore = currentScope()?.datastore() as DataStore | undefined;
  } catch (error) {
    return operationFailure(error, 'datastore-resolution', failureCode, failureMessage);
  }

  if (datastore === undefined) {
    return err(
      accessError(
        'context-catalog-datastore-required',
        'Graph context requires an entered project datastore.',
      ),
    );
  }

  try {
    return ok(operation(new CatalogRepo(datastore)));
  } catch (error) {
    return operationFailure(error, condition, failureCode, failureMessage);
  }
}

/** Concrete datastore resolution stays behind the graph RunScope accessor. */
export function createContextCatalogAccessor(): ContextCatalogAccessor {
  return Object.freeze({
    load: () =>
      withCurrentRepo(
        (repo) => repo.loadFullCatalog(),
        'catalog-load',
        'context-catalog-load-failed',
        'Failed to load the graph context catalog.',
      ),
    generationIdentity: () =>
      withCurrentRepo(
        (repo) => {
          const identity = repo.readIdentity();
          return identity === null ? null : catalogGenerationKey(identity);
        },
        'catalog-identity',
        'context-catalog-identity-failed',
        'Failed to read the graph context catalog identity.',
      ),
    replace: (catalog: Catalog) =>
      withCurrentRepo(
        (repo) => repo.replaceAll(catalog),
        'catalog-replace',
        'context-catalog-replace-failed',
        'Failed to replace the graph context catalog.',
      ),
  });
}

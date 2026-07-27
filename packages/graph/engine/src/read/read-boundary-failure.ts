/** Shared fail-loud boundary for plain-data graph read Results. */

import {
  createToolError,
  currentLogger,
  err,
  normalizeFailure,
  toOperatorFailureProjection,
  type ErrorDefinition,
  type Result,
} from '@opensip-cli/core';

import { graphErrorCatalog } from '../errors/graph-error-catalog.js';

import type { GraphReadError, GraphReadReason } from './types.js';

const READ_INFRASTRUCTURE_FAILED = graphErrorCatalog.require('GRAPH.READ.INFRASTRUCTURE_FAILED');
const READ_PROJECTION_FAILED = graphErrorCatalog.require('GRAPH.READ.PROJECTION_FAILED');
const READ_REQUEST_INVALID = graphErrorCatalog.require('GRAPH.READ.QUERY_INVALID');

export type GraphReadFailureCondition =
  | 'adapter-selection'
  | 'architecture-projection'
  | 'catalog-generation'
  | 'catalog-identity'
  | 'catalog-persistence'
  | 'catalog-rebuild'
  | 'catalog-verification'
  | 'context-snapshot'
  | 'declaration-references'
  | 'declaration-search'
  | 'entity-detail'
  | 'impact-projection'
  | 'occurrence-call-view'
  | 'package-evidence'
  | 'package-scc'
  | 'source-role-glob'
  | 'symbol-search'
  | 'test-selection';

export interface GraphReadBoundaryFailureInput {
  readonly boundary: 'infrastructure' | 'projection' | 'request';
  readonly condition: GraphReadFailureCondition;
  readonly module: string;
  readonly reason: GraphReadReason;
  readonly operation: GraphReadError['operation'];
  /** Fixed public message. Never interpolate caught data into this field. */
  readonly message: string;
}

function definitionFor(boundary: GraphReadBoundaryFailureInput['boundary']): ErrorDefinition {
  if (boundary === 'infrastructure') return READ_INFRASTRUCTURE_FAILED;
  if (boundary === 'request') return READ_REQUEST_INVALID;
  return READ_PROJECTION_FAILED;
}

/**
 * Preserve operator evidence while returning the deliberately cause-free ADR-0147 DTO.
 * Definition-backed causes remain primary; only unknown values receive the enclosing boundary.
 */
export function reportGraphReadFailure(
  error: unknown,
  input: GraphReadBoundaryFailureInput,
): GraphReadError {
  const definition = definitionFor(input.boundary);
  const original = normalizeFailure(error);
  const boundaryError = createToolError(definition, input.message, {
    cause: error,
    metadata: { condition: input.condition },
  });
  const failure = original.known === 'known' ? original : normalizeFailure(boundaryError);

  currentLogger().error({
    evt: 'graph.read.failed',
    module: input.module,
    code: failure.code,
    boundaryCode: definition.code,
    operation: input.operation,
    reason: input.reason,
    condition: input.condition,
    failure: toOperatorFailureProjection(failure),
  });

  const message = input.message.length > 160 ? `${input.message.slice(0, 157)}...` : input.message;
  return { code: input.reason, operation: input.operation, message };
}

/** Return the operator-reported failure on the plain-data Result channel. */
export function failGraphRead(
  error: unknown,
  input: GraphReadBoundaryFailureInput,
): Result<never, GraphReadError> {
  return err(reportGraphReadFailure(error, input));
}

/**
 * Failure funnel for graph build / config precondition refusals outside catalogs.
 */

import { SystemError, ValidationError } from '@opensip-cli/core';

import { graphErrorCatalog } from './graph-error-catalog.js';

const BUILD_INVARIANT = graphErrorCatalog.require('GRAPH.BUILD.INVARIANT');
const CONFIG_INVALID = graphErrorCatalog.require('GRAPH.CONFIG.INVALID');
const SOURCE_TOO_LARGE = graphErrorCatalog.require('GRAPH.SOURCE.FILE_TOO_LARGE');

export type GraphBuildCondition =
  | 'chunk-size'
  | 'chunk-depth'
  | 'path-not-project-relative'
  | 'shard-discovery-verification'
  | 'equivalence-no-exact-catalog'
  | 'equivalence-no-cli-script'
  | 'equivalence-not-shardable'
  | 'equivalence-budget-invalid';

export type GraphSourceCondition = 'stat-size' | 'read-size';

/** Internal build precondition that the tool author must fix. */
export function graphBuildError(condition: GraphBuildCondition, message: string): SystemError {
  return new SystemError(message, {
    code: BUILD_INVARIANT.code,
    definition: BUILD_INVARIANT,
    metadata: { condition },
  });
}

/** User-correctable graph CLI / budget / target configuration failure. */
export function graphConfigError(condition: GraphBuildCondition, message: string): ValidationError {
  return new ValidationError(message, {
    code: CONFIG_INVALID.code,
    definition: CONFIG_INVALID,
    metadata: { condition },
  });
}

/** Oversized source file refused by the shared size guard. */
export function graphSourceTooLargeError(
  condition: GraphSourceCondition,
  message: string,
  maxBytes: number,
): SystemError {
  return new SystemError(message, {
    code: SOURCE_TOO_LARGE.code,
    definition: SOURCE_TOO_LARGE,
    metadata: { condition, maxBytes },
  });
}

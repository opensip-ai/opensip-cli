/**
 * Failure funnel for graph RunScope / subscope guards.
 *
 * Shared by rules, recipes, lang-adapter, and context producers so every "no
 * scope" refusal carries one code and a closed condition rather than a bare Error
 * that redacts to "The operation failed."
 */

import { SystemError } from '@opensip-cli/core';

import { graphErrorCatalog } from './graph-error-catalog.js';

const SCOPE_MISSING = graphErrorCatalog.require('GRAPH.SCOPE.MISSING');

/** Whether the active RunScope is absent, or present without the graph subscope. */
export type GraphScopeCondition = 'not-entered' | 'subscope-missing';

/** Raise a definition-backed graph scope wiring failure. */
export function graphScopeError(condition: GraphScopeCondition, message: string): SystemError {
  return new SystemError(message, {
    code: SCOPE_MISSING.code,
    definition: SCOPE_MISSING,
    metadata: { condition },
  });
}

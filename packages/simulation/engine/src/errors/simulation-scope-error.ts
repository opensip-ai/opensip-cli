/**
 * Failure funnel for simulation RunScope / subscope guards.
 */

import { SystemError } from '@opensip-cli/core';

import { simulationErrorCatalog } from './simulation-error-catalog.js';

const SCOPE_MISSING = simulationErrorCatalog.require('SIMULATION.SCOPE.MISSING');

export type SimulationScopeCondition = 'not-entered' | 'subscope-missing';

/** Raise a definition-backed simulation scope wiring failure. */
export function simulationScopeError(
  condition: SimulationScopeCondition,
  message: string,
): SystemError {
  return new SystemError(message, {
    code: SCOPE_MISSING.code,
    definition: SCOPE_MISSING,
    metadata: { condition },
  });
}

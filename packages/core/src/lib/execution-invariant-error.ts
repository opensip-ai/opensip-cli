/**
 * Failure funnel for execution-scheduler internal invariants.
 */

import { coreErrorCatalog } from './errors/core-error-catalog.js';
import { SystemError } from './errors.js';

const INVARIANT = coreErrorCatalog.require('CORE.EXECUTION.INVARIANT');
const INVALID_MODE = coreErrorCatalog.require('CORE.EXECUTION.INVALID_MODE');

export type ExecutionInvariantCondition =
  'with-retry-no-attempts' | 'map-concurrency-empty-slot' | 'select-best-empty';

/** Unreachable / internal execution-control failure. */
export function executionInvariantError(
  condition: ExecutionInvariantCondition,
  message: string,
): SystemError {
  return new SystemError(message, {
    code: INVARIANT.code,
    definition: INVARIANT,
    metadata: { condition },
  });
}

/** Unsupported scheduleUnits mode value. */
export function executionInvalidModeError(message: string, value: unknown): SystemError {
  return new SystemError(message, {
    code: INVALID_MODE.code,
    definition: INVALID_MODE,
    metadata: { value: String(value) },
  });
}

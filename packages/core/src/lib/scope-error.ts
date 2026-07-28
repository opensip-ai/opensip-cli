/**
 * Failure funnel for RunScope entry / capabilities-wiring guards.
 *
 * Leaf module: only catalog + SystemError. Callers in plugins/, languages/, and
 * lib/ share these codes without importing each other.
 */

import { coreErrorCatalog } from './errors/core-error-catalog.js';
import { SystemError } from './errors.js';

const NOT_ENTERED = coreErrorCatalog.require('CORE.SCOPE.NOT_ENTERED');
const CAPABILITIES_MISSING = coreErrorCatalog.require('CORE.SCOPE.CAPABILITIES_MISSING');

/** Why a scope accessor refused. Required so every call site names the branch. */
export type ScopeFailureCondition = 'not-entered' | 'capabilities-missing';

/** Raise a definition-backed scope wiring failure. */
export function scopeError(condition: ScopeFailureCondition, message: string): SystemError {
  const def = condition === 'not-entered' ? NOT_ENTERED : CAPABILITIES_MISSING;
  return new SystemError(message, {
    code: def.code,
    definition: def,
  });
}

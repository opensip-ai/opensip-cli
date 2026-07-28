/**
 * Failure funnel for fitness RunScope / engine-state guards.
 */

import { SystemError } from '@opensip-cli/core';

import { fitnessErrorCatalog } from './fitness-error-catalog.js';

const ENGINE_STATE_INVALID = fitnessErrorCatalog.require('FIT.FITNESS.ENGINE_STATE_INVALID');

export type FitnessScopeCondition =
  'scope-not-entered' | 'recipe-selection-invariant' | 'plugin-loader-scope-missing';

/** Raise a definition-backed fitness engine-state / scope failure. */
export function fitnessScopeError(condition: FitnessScopeCondition, message: string): SystemError {
  return new SystemError(message, {
    code: ENGINE_STATE_INVALID.code,
    definition: ENGINE_STATE_INVALID,
    metadata: { condition },
  });
}

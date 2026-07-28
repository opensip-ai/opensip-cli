/**
 * Failure funnel for the compatibility-policy completeness guard.
 */

import { coreErrorCatalog } from './errors/core-error-catalog.js';
import { SystemError } from './errors.js';

const INVALID = coreErrorCatalog.require('CORE.COMPATIBILITY.POLICY_INVALID');

export type CompatibilityPolicyCondition =
  | 'unknown-class'
  | 'duplicate-class'
  | 'empty-breaking-change-gate'
  | 'empty-docs-path'
  | 'missing-classes';

/** Raise a definition-backed compatibility policy table failure. */
export function compatibilityPolicyError(
  condition: CompatibilityPolicyCondition,
  message: string,
  className?: string,
): SystemError {
  return new SystemError(message, {
    code: INVALID.code,
    definition: INVALID,
    metadata: {
      condition,
      ...(className === undefined ? {} : { className }),
    },
  });
}

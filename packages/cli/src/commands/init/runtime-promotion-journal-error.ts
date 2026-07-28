/**
 * The error vocabulary for runtime-promotion journal failures.
 *
 * WHY THIS IS A SEPARATE MODULE
 * `runtime-promotion-journal-controller-validation.ts` owns the journal *policy* and imports the
 * codec from `runtime-promotion-journal-schema.ts`. The codec also needs to raise these failures,
 * so keeping the factories in the validation module would close an import cycle
 * (schema → validation → schema). This module imports nothing from either, so both can depend on
 * it and the graph stays acyclic — the same shape used for the error kernel in `@opensip-cli/core`.
 */

import { SystemError } from '@opensip-cli/core';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

const JOURNAL_INVALID = hostErrorCatalog.require('CLI.INIT.PROMOTION_JOURNAL_INVALID');
const RECOVERY_REQUIRED = hostErrorCatalog.require('CLI.INIT.PROMOTION_RECOVERY_REQUIRED');

/**
 * Exported so the recovery path branches on the same identity this module throws with, rather
 * than on a second copy of the literal that can drift out of sync with it.
 */
export const JOURNAL_ERROR_CODE = JOURNAL_INVALID.code;

/**
 * The machine-readable reason a promotion journal could not be trusted.
 *
 * This exists because the recovery path used to recover it by SUBSTRING-MATCHING the message
 * (`message.includes('exceeds its bounded size')`). That made every one of these strings load
 * bearing: rewording a user-facing sentence silently reclassified the failure, and a translated
 * or reworded message would classify as `state-ambiguous` — the most conservative and least
 * actionable arm. The condition now travels in allowlisted metadata (D9), where it is part of
 * the contract rather than an accident of prose.
 */
export type JournalFailureCondition =
  | 'journal-oversize'
  | 'journal-key-mismatch'
  | 'journal-malformed'
  | 'journal-absent'
  | 'journal-digest-mismatch'
  | 'journal-phase-invalid';

export function journalError(
  message: string,
  cause?: unknown,
  condition?: JournalFailureCondition,
): SystemError {
  return new SystemError(message, {
    code: JOURNAL_INVALID.code,
    definition: JOURNAL_INVALID,
    ...(condition === undefined ? {} : { metadata: { condition } }),
    ...(cause === undefined ? {} : { cause }),
  });
}

export function recoveryRequired(
  message: string,
  cause?: unknown,
  condition?: JournalFailureCondition,
): SystemError {
  return new SystemError(message, {
    code: RECOVERY_REQUIRED.code,
    definition: RECOVERY_REQUIRED,
    ...(condition === undefined ? {} : { metadata: { condition } }),
    ...(cause === undefined ? {} : { cause }),
  });
}

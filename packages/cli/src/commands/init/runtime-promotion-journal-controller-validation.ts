import { RUNTIME_RECOVERY_RECORD_MAX_BYTES, SystemError } from '@opensip-cli/core';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

import {
  encodeRuntimePromotionJournal,
  parseRuntimePromotionJournal,
  type RuntimePromotionJournal,
} from './runtime-promotion-journal-schema.js';

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

/** @throws {SystemError} When journal content is invalid or not canonically encoded. */
export function parseCanonicalRecord(content: string): RuntimePromotionJournal {
  if (Buffer.byteLength(content, 'utf8') > RUNTIME_RECOVERY_RECORD_MAX_BYTES) {
    throw recoveryRequired(
      'The promotion journal exceeds its bounded size.',
      undefined,
      'journal-oversize',
    );
  }
  try {
    const parsed = parseRuntimePromotionJournal(content);
    if (encodeRuntimePromotionJournal(parsed) !== content) {
      throw journalError(
        'The promotion journal is not canonically encoded.',
        undefined,
        'journal-malformed',
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof SystemError) throw error;
    throw recoveryRequired('The promotion journal is malformed.', error, 'journal-malformed');
  }
}

/** @throws {SystemError} When a desired journal record changes immutable operation identity. */
export function assertDesiredIdentity(
  current: RuntimePromotionJournal,
  desired: RuntimePromotionJournal,
): void {
  if (
    desired.coordinationKey !== current.coordinationKey ||
    desired.operationId !== current.operationId
  ) {
    throw journalError('A journal transition changed immutable receipt identity.');
  }
}

export function isTerminalSeal(
  desired: RuntimePromotionJournal,
  outcome: 'committed' | 'rolled-back',
): boolean {
  return desired.state === 'open' && desired.terminal?.outcome === outcome;
}

import { RUNTIME_RECOVERY_RECORD_MAX_BYTES, SystemError } from '@opensip-cli/core';

import { journalError, recoveryRequired } from './runtime-promotion-journal-error.js';
import {
  encodeRuntimePromotionJournal,
  parseRuntimePromotionJournal,
  type RuntimePromotionJournal,
} from './runtime-promotion-journal-schema.js';

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

export {
  JOURNAL_ERROR_CODE,
  type JournalFailureCondition,
  journalError,
  recoveryRequired,
} from './runtime-promotion-journal-error.js';

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

export function journalError(message: string, cause?: unknown): SystemError {
  return new SystemError(message, {
    code: JOURNAL_INVALID.code,
    definition: JOURNAL_INVALID,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function recoveryRequired(message: string, cause?: unknown): SystemError {
  return new SystemError(message, {
    code: RECOVERY_REQUIRED.code,
    definition: RECOVERY_REQUIRED,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** @throws {SystemError} When journal content is invalid or not canonically encoded. */
export function parseCanonicalRecord(content: string): RuntimePromotionJournal {
  if (Buffer.byteLength(content, 'utf8') > RUNTIME_RECOVERY_RECORD_MAX_BYTES) {
    throw recoveryRequired('The promotion journal exceeds its bounded size.');
  }
  try {
    const parsed = parseRuntimePromotionJournal(content);
    if (encodeRuntimePromotionJournal(parsed) !== content) {
      throw journalError('The promotion journal is not canonically encoded.');
    }
    return parsed;
  } catch (error) {
    if (error instanceof SystemError) throw error;
    throw recoveryRequired('The promotion journal is malformed.', error);
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

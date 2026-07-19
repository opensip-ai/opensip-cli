import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
  DurablePromotionJournal,
  PromotionJournalReceiptExpectation,
} from './runtime-promotion-journal-controller-internal.js';
import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';

type JournalErrorFactory = (message: string) => Error;

function ownedBasename(
  record: RuntimePromotionJournal,
  slot: keyof RuntimePromotionJournal['owned'],
): string {
  return record.owned[slot].basename;
}

export function hasRuntimeStageIntent(record: RuntimePromotionJournal): boolean {
  const pending = record.progress.pendingIntent;
  return (
    record.state === 'open' &&
    record.progress.direction === 'forward' &&
    pending?.kind === 'runtime-stage-create' &&
    pending.slot === 'runtimeStage'
  );
}

/** Pending slots remain visible recovery work and keep the receipt. */
export function hasCompleteOwnedCleanup(record: RuntimePromotionJournal): boolean {
  return (
    record.progress.pendingIntent === null &&
    Object.values(record.cleanup).every(
      (state) => state === 'unmaterialized' || state === 'removed',
    )
  );
}

/** @throws {SystemError} When the durable journal does not satisfy the requested expectation. */
export function assertExpectation(
  record: RuntimePromotionJournal,
  expectation: PromotionJournalReceiptExpectation | undefined,
  journalError: JournalErrorFactory,
): void {
  if (expectation?.state !== undefined && record.state !== expectation.state) {
    throw journalError('The promotion journal is not in the required state.');
  }
  if (
    expectation?.allowedPhases !== undefined &&
    !expectation.allowedPhases.includes(record.progress.phase)
  ) {
    throw journalError('The promotion journal is not in an allowed phase.');
  }
  if (
    expectation?.ownedSlot !== undefined &&
    ownedBasename(record, expectation.ownedSlot.name) !== expectation.ownedSlot.basename
  ) {
    throw journalError('The promotion journal does not own the requested artifact.');
  }
}

/** @throws {SystemError} When a durable journal receipt is not open. */
export function asOpen(
  receipt: DurablePromotionJournal,
  journalError: JournalErrorFactory,
): DurableOpenPromotionJournal {
  if (receipt.state !== 'open') {
    throw journalError('The transition did not leave an open promotion journal.');
  }
  return receipt;
}

/** @throws {SystemError} When a durable journal receipt is not closed. */
export function asClosed(
  receipt: DurablePromotionJournal,
  journalError: JournalErrorFactory,
): DurableClosedPromotionJournal {
  if (receipt.state !== 'closed') {
    throw journalError('The transition did not close the promotion journal.');
  }
  return receipt;
}

export function isIntentTransition(
  current: RuntimePromotionJournal,
  desired: RuntimePromotionJournal,
): boolean {
  return current.progress.pendingIntent === null && desired.progress.pendingIntent !== null;
}

export function isPostconditionTransition(
  current: RuntimePromotionJournal,
  desired: RuntimePromotionJournal,
): boolean {
  return (
    current.progress.pendingIntent !== null &&
    desired.progress.pendingIntent === null &&
    desired.progress.lastPostcondition !== null
  );
}

export function isRollbackTransition(
  current: RuntimePromotionJournal,
  desired: RuntimePromotionJournal,
): boolean {
  return current.progress.direction === 'forward' && desired.progress.direction === 'rollback';
}

export function isRecoveryOwnerHandoff(
  current: RuntimePromotionJournal,
  desired: RuntimePromotionJournal,
): boolean {
  return (
    desired.recoveryOwnerToken !== current.recoveryOwnerToken &&
    desired.recoveryAttempt === current.recoveryAttempt + 1
  );
}

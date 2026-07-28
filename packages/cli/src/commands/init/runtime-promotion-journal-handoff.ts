import {
  type DurablePromotionJournal,
  type RuntimePromotionJournalController,
} from './runtime-promotion-journal-controller-internal.js';
import { journalError } from './runtime-promotion-journal-error.js';
import { asClosed, asOpen } from './runtime-promotion-journal-transition-guards.js';

export function handoffRuntimePromotionRecoveryOwner<Receipt extends DurablePromotionJournal>(
  controller: RuntimePromotionJournalController,
  receipt: Receipt,
): Promise<Receipt>;
export async function handoffRuntimePromotionRecoveryOwner(
  controller: RuntimePromotionJournalController,
  receipt: DurablePromotionJournal,
): Promise<DurablePromotionJournal> {
  const previousState = receipt.state;
  const next = await controller.handoffRecoveryOwner(receipt, (current, identity) => ({
    ...current,
    revision: current.revision + 1,
    recoveryOwnerToken: identity.recoveryOwnerToken,
    recoveryAttempt: current.recoveryAttempt + 1,
    timestamps: {
      ...current.timestamps,
      updatedAt: identity.claimedAt,
    },
  }));
  return previousState === 'open'
    ? asOpen(next, (message) => journalError(message))
    : asClosed(next, (message) => journalError(message));
}

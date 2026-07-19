import {
  canonicalRuntimePromotionJournal,
  type RuntimePromotionJournal,
  type RuntimePromotionOwnedSlotName,
  type RuntimePromotionPostconditionOutcome,
} from './runtime-promotion-journal-schema.js';

import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
  RuntimePromotionJournalController,
} from './runtime-promotion-journal.js';

function transitionTime(record: RuntimePromotionJournal, now: () => number): number {
  return Math.max(record.timestamps.updatedAt, now());
}

export async function recordOpenIntent(
  controller: RuntimePromotionJournalController,
  receipt: DurableOpenPromotionJournal,
  kind: 'authored-prepare' | 'authored-target-commit' | 'authored-target-rollback',
  slot: RuntimePromotionOwnedSlotName,
  cursor: number | null,
  now: () => number,
): Promise<DurableOpenPromotionJournal> {
  const current = await controller.verifyOpen(receipt);
  const recordedAt = transitionTime(current, now);
  const desired = canonicalRuntimePromotionJournal({
    ...current,
    revision: current.revision + 1,
    progress: {
      ...current.progress,
      pendingIntent: {
        sequence: current.counts.intentCount + 1,
        kind,
        slot,
        cursor,
        recordedAt,
      },
    },
    counts: {
      ...current.counts,
      intentCount: current.counts.intentCount + 1,
    },
    timestamps: {
      ...current.timestamps,
      updatedAt: recordedAt,
    },
  });
  return controller.recordIntent(receipt, desired);
}

interface AuthoredPostconditionInput {
  readonly phase: RuntimePromotionJournal['progress']['phase'];
  readonly outcome: RuntimePromotionPostconditionOutcome;
  readonly authoredDelta?: 0 | 1;
  readonly rollbackDelta?: 0 | 1;
  readonly prepareArtifacts?: boolean;
}

/** @throws {Error} When no durable authored intent is pending. */
export async function recordOpenPostcondition(
  controller: RuntimePromotionJournalController,
  receipt: DurableOpenPromotionJournal,
  input: AuthoredPostconditionInput,
  now: () => number,
): Promise<DurableOpenPromotionJournal> {
  const current = await controller.verifyOpen(receipt);
  const pending = current.progress.pendingIntent;
  if (pending === null) throw new Error('Authored postcondition requires a pending intent');
  const recordedAt = transitionTime(current, now);
  const authoredDelta = input.authoredDelta ?? 0;
  const rollbackDelta = input.rollbackDelta ?? 0;
  const desired = canonicalRuntimePromotionJournal({
    ...current,
    revision: current.revision + 1,
    progress: {
      ...current.progress,
      phase: input.phase,
      authoredCursor: current.progress.authoredCursor + authoredDelta,
      rollbackCursor: current.progress.rollbackCursor + rollbackDelta,
      pendingIntent: null,
      lastPostcondition: {
        ...pending,
        outcome: input.outcome,
        recordedAt,
      },
    },
    cleanup: input.prepareArtifacts
      ? {
          ...current.cleanup,
          authoredStage: 'pending',
          authoredBackup: 'pending',
          replayManifest: 'pending',
        }
      : current.cleanup,
    counts: {
      ...current.counts,
      postconditionCount: current.counts.postconditionCount + 1,
      authoredCompleted: current.counts.authoredCompleted + authoredDelta,
      authoredRolledBack: current.counts.authoredRolledBack + rollbackDelta,
    },
    timestamps: {
      ...current.timestamps,
      updatedAt: recordedAt,
    },
  });
  return controller.recordPostcondition(receipt, desired);
}

export async function beginAuthoredRollback(
  controller: RuntimePromotionJournalController,
  receipt: DurableOpenPromotionJournal,
  now: () => number,
): Promise<DurableOpenPromotionJournal> {
  const current = await controller.verifyOpen(receipt);
  const recordedAt = transitionTime(current, now);
  const desired = canonicalRuntimePromotionJournal({
    ...current,
    revision: current.revision + 1,
    progress: {
      ...current.progress,
      direction: 'rollback',
      phase: 'rollback-started',
    },
    timestamps: {
      ...current.timestamps,
      updatedAt: recordedAt,
    },
  });
  return controller.beginRollback(receipt, desired);
}

export async function advanceAuthoredPhase(
  controller: RuntimePromotionJournalController,
  receipt: DurableOpenPromotionJournal,
  phase: 'authored-committed' | 'authored-rolled-back',
  now: () => number,
): Promise<DurableOpenPromotionJournal> {
  const current = await controller.verifyOpen(receipt);
  const recordedAt = transitionTime(current, now);
  const desired = canonicalRuntimePromotionJournal({
    ...current,
    revision: current.revision + 1,
    progress: {
      ...current.progress,
      phase,
    },
    timestamps: {
      ...current.timestamps,
      updatedAt: recordedAt,
    },
  });
  return (await controller.replace(receipt, desired)) as DurableOpenPromotionJournal;
}

export async function recordCleanupIntent(
  controller: RuntimePromotionJournalController,
  receipt: DurableClosedPromotionJournal,
  slot: 'authoredStage' | 'authoredBackup' | 'replayManifest',
  now: () => number,
): Promise<DurableClosedPromotionJournal> {
  const current = await controller.verifyReceipt(receipt, { state: 'closed' });
  const recordedAt = transitionTime(current, now);
  const desired = canonicalRuntimePromotionJournal({
    ...current,
    revision: current.revision + 1,
    progress: {
      ...current.progress,
      pendingIntent: {
        sequence: current.counts.intentCount + 1,
        kind: 'owned-slot-cleanup',
        slot,
        cursor: null,
        recordedAt,
      },
    },
    counts: {
      ...current.counts,
      intentCount: current.counts.intentCount + 1,
    },
    timestamps: {
      ...current.timestamps,
      updatedAt: recordedAt,
    },
  });
  return controller.recordCleanupIntent(receipt, desired);
}

/** @throws {Error} When the exact owned-slot cleanup intent is not pending. */
export async function recordCleanupPostcondition(
  controller: RuntimePromotionJournalController,
  receipt: DurableClosedPromotionJournal,
  outcome: RuntimePromotionPostconditionOutcome,
  now: () => number,
): Promise<DurableClosedPromotionJournal> {
  const current = await controller.verifyReceipt(receipt, { state: 'closed' });
  const pending = current.progress.pendingIntent;
  if (pending?.kind !== 'owned-slot-cleanup' || pending.slot === null) {
    throw new Error('Authored cleanup postcondition requires its exact pending intent');
  }
  const recordedAt = transitionTime(current, now);
  const desired = canonicalRuntimePromotionJournal({
    ...current,
    revision: current.revision + 1,
    progress: {
      ...current.progress,
      phase: 'cleanup',
      pendingIntent: null,
      lastPostcondition: {
        ...pending,
        outcome,
        recordedAt,
      },
    },
    cleanup: {
      ...current.cleanup,
      [pending.slot]: 'removed',
    },
    counts: {
      ...current.counts,
      postconditionCount: current.counts.postconditionCount + 1,
      cleanupCompleted: current.counts.cleanupCompleted + 1,
    },
    timestamps: {
      ...current.timestamps,
      updatedAt: recordedAt,
    },
  });
  return controller.recordCleanupPostcondition(receipt, desired);
}

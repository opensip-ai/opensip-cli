/** Terminal-owned artifact history and exact cleanup accounting. */

import type {
  RuntimePromotionJournal,
  RuntimePromotionOwnedSlotName,
} from './runtime-promotion-journal-types.js';

const AUTHORED_SLOTS = ['authoredStage', 'authoredBackup', 'replayManifest'] as const;

function slotsMaterialized(
  journal: RuntimePromotionJournal,
  slots: readonly RuntimePromotionOwnedSlotName[],
): boolean {
  return slots.every((slot) => journal.cleanup[slot] !== 'unmaterialized');
}

function committedSlotHistoryAllowed(journal: RuntimePromotionJournal): boolean {
  if (!slotsMaterialized(journal, AUTHORED_SLOTS)) return false;
  if (
    journal.source.classification !== 'none' &&
    (journal.manifests.source === null || journal.cleanup.sourceTombstone === 'unmaterialized')
  ) {
    return false;
  }
  if (journal.route !== 'promote-cache') {
    return journal.progress.runtimeInstallState === 'not-installed';
  }
  const backupPreserved =
    !journal.destinationRuntimePreexisting ||
    journal.cleanup.destinationBackup !== 'unmaterialized';
  const parentResolved =
    journal.destinationParentPreexisting || journal.cleanup.destinationParent !== 'unmaterialized';
  return (
    journal.progress.runtimeInstallState === 'installed' &&
    journal.cleanup.runtimeStage === 'removed' &&
    backupPreserved &&
    parentResolved
  );
}

function rolledBackSlotHistoryAllowed(journal: RuntimePromotionJournal): boolean {
  if (journal.progress.runtimeInstallState === 'installed') return false;
  if (journal.cleanup.sourceTombstone !== 'unmaterialized') return false;
  const authoredUnmaterialized = AUTHORED_SLOTS.every(
    (slot) => journal.cleanup[slot] === 'unmaterialized',
  );
  const noAuthoredProgress =
    journal.progress.authoredCursor === 0 && journal.progress.rollbackCursor === 0;
  return (
    (authoredUnmaterialized && noAuthoredProgress) || slotsMaterialized(journal, AUTHORED_SLOTS)
  );
}

function operationConsumedRemovedSlots(
  journal: RuntimePromotionJournal,
): readonly RuntimePromotionOwnedSlotName[] {
  if (journal.progress.runtimeInstallState === 'not-installed') return [];
  const consumed: RuntimePromotionOwnedSlotName[] = [];
  if (journal.manifests.runtimeStage !== null && journal.cleanup.runtimeStage === 'removed') {
    consumed.push('runtimeStage');
  }
  if (
    journal.terminal?.outcome === 'rolled-back' &&
    journal.progress.runtimeInstallState === 'rolled-back' &&
    !journal.destinationParentPreexisting &&
    journal.progress.authoredCursor === 0 &&
    journal.cleanup.destinationParent === 'removed'
  ) {
    consumed.push('destinationParent');
  }
  if (
    ['rolled-back', 'backup-restored'].includes(journal.progress.runtimeInstallState) &&
    journal.destinationRuntimePreexisting &&
    journal.cleanup.destinationBackup === 'removed'
  ) {
    consumed.push('destinationBackup');
  }
  return consumed;
}

function cleanupCountAllowed(journal: RuntimePromotionJournal): boolean {
  if (journal.state === 'open') return journal.counts.cleanupCompleted === 0;
  const removedCount = Object.values(journal.cleanup).filter((state) => state === 'removed').length;
  const operationConsumed = operationConsumedRemovedSlots(journal).length;
  const countMatches = journal.counts.cleanupCompleted === removedCount - operationConsumed;
  const last = journal.progress.lastPostcondition;
  const cleanupHistoryMatches =
    journal.counts.cleanupCompleted > 0 === (last?.kind === 'owned-slot-cleanup');
  return countMatches && cleanupHistoryMatches;
}

export function runtimePromotionClosedEvidenceAllowed(journal: RuntimePromotionJournal): boolean {
  if (!cleanupCountAllowed(journal)) return false;
  if (journal.state !== 'closed' || journal.terminal === null) return true;
  return journal.terminal.outcome === 'committed'
    ? committedSlotHistoryAllowed(journal)
    : rolledBackSlotHistoryAllowed(journal);
}

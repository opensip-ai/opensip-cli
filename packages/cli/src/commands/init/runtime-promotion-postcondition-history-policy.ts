/** Standalone compatibility policy for the most recent durable postcondition. */

import {
  forwardPhaseAtLeast,
  rollbackPhaseAtLeast,
  runtimePromotionRouteAllows,
} from './runtime-promotion-intent-policy.js';

import type {
  RuntimePromotionIntentKind,
  RuntimePromotionJournal,
  RuntimePromotionPostcondition,
} from './runtime-promotion-journal-types.js';

function authoredHistoryArtifactsAllowed(journal: RuntimePromotionJournal): boolean {
  const statuses = [
    journal.cleanup.authoredStage,
    journal.cleanup.authoredBackup,
    journal.cleanup.replayManifest,
  ];
  return journal.state === 'open'
    ? statuses.every((status) => status === 'pending')
    : statuses.every((status) => status !== 'unmaterialized');
}

function abortedAuthoredPreparationAllowed(
  journal: RuntimePromotionJournal,
  post: RuntimePromotionPostcondition,
): boolean {
  const authoredUnmaterialized = [
    journal.cleanup.authoredStage,
    journal.cleanup.authoredBackup,
    journal.cleanup.replayManifest,
  ].every((status) => status === 'unmaterialized');
  const laterMutationSlotsUnmaterialized = [
    journal.cleanup.destinationParent,
    journal.cleanup.runtimeStage,
    journal.cleanup.destinationBackup,
    journal.cleanup.sourceTombstone,
  ].every((status) => status === 'unmaterialized');
  if (
    post.kind !== 'authored-prepare' ||
    post.slot !== 'authoredStage' ||
    post.cursor !== null ||
    !authoredUnmaterialized ||
    !laterMutationSlotsUnmaterialized ||
    journal.manifests.runtimeStage !== null ||
    journal.counts.intentCount !== 1 ||
    journal.counts.postconditionCount !== 1 ||
    post.sequence !== 1 ||
    journal.progress.authoredCursor !== 0 ||
    journal.progress.rollbackCursor !== 0 ||
    journal.counts.authoredCompleted !== 0 ||
    journal.counts.authoredRolledBack !== 0 ||
    journal.counts.cleanupCompleted !== 0 ||
    journal.progress.runtimeInstallState !== 'not-installed'
  ) {
    return false;
  }
  if (journal.state === 'closed') {
    return journal.terminal?.outcome === 'rolled-back';
  }
  if (journal.progress.direction === 'rollback') return true;
  const requiredPhase = journal.route === 'authored-only' ? 'prepared' : 'destination-verified';
  return journal.progress.direction === 'forward' && journal.progress.phase === requiredPhase;
}

function rollbackHistoricalForwardPostAllowed(
  journal: RuntimePromotionJournal,
  kind: RuntimePromotionIntentKind,
): boolean {
  switch (kind) {
    case 'destination-parent-create': {
      return journal.cleanup.destinationParent !== 'unmaterialized';
    }
    case 'runtime-stage-create': {
      return (
        journal.manifests.runtimeStage !== null && journal.cleanup.runtimeStage !== 'unmaterialized'
      );
    }
    case 'destination-backup-create': {
      return journal.cleanup.destinationBackup !== 'unmaterialized';
    }
    case 'destination-install': {
      return (
        journal.manifests.runtimeStage !== null &&
        journal.cleanup.runtimeStage === 'removed' &&
        journal.progress.runtimeInstallState !== 'not-installed'
      );
    }
    case 'authored-prepare': {
      return authoredHistoryArtifactsAllowed(journal);
    }
    default: {
      return false;
    }
  }
}

/** Fail-closed check for the last completed intent in a standalone current record. */
export function runtimePromotionLastPostconditionCompatible(
  journal: RuntimePromotionJournal,
): boolean {
  const post = journal.progress.lastPostcondition;
  if (post === null || !runtimePromotionRouteAllows(journal, post.kind)) return post === null;
  if (post.outcome === 'aborted') {
    return abortedAuthoredPreparationAllowed(journal, post);
  }
  if (post.kind === 'authored-target-commit') {
    return (
      post.cursor === journal.progress.authoredCursor - 1 &&
      (journal.progress.direction !== 'rollback' || authoredHistoryArtifactsAllowed(journal))
    );
  }
  if (post.kind === 'authored-target-rollback') {
    return (
      post.cursor === journal.progress.authoredCursor - journal.progress.rollbackCursor &&
      authoredHistoryArtifactsAllowed(journal)
    );
  }
  if (post.kind === 'runtime-rollback') {
    return (
      ['rolled-back', 'backup-restored'].includes(journal.progress.runtimeInstallState) &&
      ((journal.progress.direction === 'rollback' &&
        rollbackPhaseAtLeast(journal.progress.phase, 'runtime-rolled-back')) ||
        (journal.state === 'closed' && journal.terminal?.outcome === 'rolled-back'))
    );
  }
  if (journal.state === 'closed' && post.kind !== 'owned-slot-cleanup') return true;
  if (journal.progress.direction === 'rollback') {
    return rollbackHistoricalForwardPostAllowed(journal, post.kind);
  }
  switch (post.kind) {
    case 'destination-parent-create': {
      return forwardPhaseAtLeast(journal.progress.phase, 'destination-ready');
    }
    case 'runtime-stage-create': {
      return (
        journal.manifests.runtimeStage !== null &&
        forwardPhaseAtLeast(journal.progress.phase, 'runtime-staged')
      );
    }
    case 'destination-backup-create': {
      return forwardPhaseAtLeast(journal.progress.phase, 'destination-backed-up');
    }
    case 'destination-install': {
      return forwardPhaseAtLeast(journal.progress.phase, 'runtime-installed');
    }
    case 'authored-prepare': {
      return forwardPhaseAtLeast(journal.progress.phase, 'authored-prepared');
    }
    case 'source-retire': {
      return forwardPhaseAtLeast(journal.progress.phase, 'source-retired');
    }
    case 'owned-slot-cleanup': {
      return (
        journal.state === 'closed' && post.slot !== null && journal.cleanup[post.slot] === 'removed'
      );
    }
  }
}

/** Shared current-state and transition policy for every write-ahead mutation kind. */
/* eslint-disable sonarjs/no-duplicate-string -- repeated closed-union literals make the route/phase matrix auditable */

import type {
  RuntimePromotionIntentKind,
  RuntimePromotionJournal,
  RuntimePromotionOwnedSlotName,
  RuntimePromotionPendingIntent,
  RuntimePromotionPostcondition,
} from './runtime-promotion-journal-types.js';

const FORWARD_PHASES = [
  'prepared',
  'source-verified',
  'destination-verified',
  'authored-prepared',
  'destination-ready',
  'runtime-staged',
  'destination-backed-up',
  'runtime-installed',
  'authored-committed',
  'source-retired',
  'authority-verified',
  'committed',
] as const;

const ROLLBACK_PHASES = [
  'rollback-started',
  'runtime-rolled-back',
  'authored-rolled-back',
  'rolled-back',
] as const;

function forwardPhaseAtLeast(
  actual: RuntimePromotionJournal['progress']['phase'],
  minimum: (typeof FORWARD_PHASES)[number],
): boolean {
  return (
    FORWARD_PHASES.indexOf(actual as (typeof FORWARD_PHASES)[number]) >=
    FORWARD_PHASES.indexOf(minimum)
  );
}

function rollbackPhaseAtLeast(
  actual: RuntimePromotionJournal['progress']['phase'],
  minimum: (typeof ROLLBACK_PHASES)[number],
): boolean {
  return (
    ROLLBACK_PHASES.indexOf(actual as (typeof ROLLBACK_PHASES)[number]) >=
    ROLLBACK_PHASES.indexOf(minimum)
  );
}

export function runtimePromotionDestinationParentReady(journal: RuntimePromotionJournal): boolean {
  if (journal.state !== 'open' || journal.progress.direction !== 'forward') return true;
  if (!forwardPhaseAtLeast(journal.progress.phase, 'destination-ready')) return true;
  if (journal.route !== 'promote-cache') return true;
  if (journal.destinationParentPreexisting) {
    return journal.cleanup.destinationParent === 'unmaterialized';
  }
  if (forwardPhaseAtLeast(journal.progress.phase, 'runtime-installed')) {
    return journal.cleanup.destinationParent === 'removed';
  }
  return journal.cleanup.destinationParent === 'pending';
}

function rollbackPhaseEvidenceAllowed(journal: RuntimePromotionJournal): boolean {
  return (
    !rollbackPhaseAtLeast(journal.progress.phase, 'authored-rolled-back') ||
    journal.progress.rollbackCursor === journal.progress.authoredCursor
  );
}

function forwardRoutePhaseAllowed(journal: RuntimePromotionJournal): boolean {
  const runtimeOnlyPhase = [
    'runtime-staged',
    'destination-backed-up',
    'runtime-installed',
  ].includes(journal.progress.phase);
  return (
    (!runtimeOnlyPhase || journal.route === 'promote-cache') &&
    (journal.progress.phase !== 'destination-backed-up' || journal.destinationRuntimePreexisting) &&
    (journal.progress.phase !== 'source-retired' || journal.source.classification !== 'none')
  );
}

function authoredPreparationEvidenceAllowed(journal: RuntimePromotionJournal): boolean {
  if (!forwardPhaseAtLeast(journal.progress.phase, 'authored-prepared')) return true;
  return (
    journal.cleanup.authoredStage === 'pending' &&
    journal.cleanup.authoredBackup === 'pending' &&
    journal.cleanup.replayManifest === 'pending'
  );
}

function runtimeStageEvidenceAllowed(journal: RuntimePromotionJournal): boolean {
  if (
    journal.route !== 'promote-cache' ||
    !forwardPhaseAtLeast(journal.progress.phase, 'runtime-staged')
  ) {
    return true;
  }
  const expectedCleanup = forwardPhaseAtLeast(journal.progress.phase, 'runtime-installed')
    ? 'removed'
    : 'pending';
  return (
    journal.manifests.runtimeStage !== null && journal.cleanup.runtimeStage === expectedCleanup
  );
}

function destinationBackupEvidenceAllowed(journal: RuntimePromotionJournal): boolean {
  if (
    journal.route !== 'promote-cache' ||
    !forwardPhaseAtLeast(journal.progress.phase, 'destination-backed-up')
  ) {
    return true;
  }
  if (!journal.destinationRuntimePreexisting) {
    return journal.progress.phase !== 'destination-backed-up';
  }
  return journal.manifests.destination !== null && journal.cleanup.destinationBackup === 'pending';
}

function completedForwardEvidenceAllowed(journal: RuntimePromotionJournal): boolean {
  const authoredComplete =
    !forwardPhaseAtLeast(journal.progress.phase, 'authored-committed') ||
    journal.progress.authoredCursor === journal.plan.mutationCount;
  const sourceRetired =
    !forwardPhaseAtLeast(journal.progress.phase, 'source-retired') ||
    journal.source.classification === 'none' ||
    journal.cleanup.sourceTombstone === 'pending';
  return authoredComplete && sourceRetired;
}

/** Static phase evidence makes a standalone canonical receipt fail closed. */
export function runtimePromotionPhaseEvidenceAllowed(journal: RuntimePromotionJournal): boolean {
  if (journal.state !== 'open') return true;
  if (journal.progress.direction === 'rollback') {
    return rollbackPhaseEvidenceAllowed(journal);
  }
  if (journal.progress.direction !== 'forward') return true;
  return (
    forwardRoutePhaseAllowed(journal) &&
    runtimePromotionDestinationParentReady(journal) &&
    authoredPreparationEvidenceAllowed(journal) &&
    runtimeStageEvidenceAllowed(journal) &&
    destinationBackupEvidenceAllowed(journal) &&
    completedForwardEvidenceAllowed(journal)
  );
}

function routeAllows(journal: RuntimePromotionJournal, kind: RuntimePromotionIntentKind): boolean {
  if (
    kind === 'destination-parent-create' &&
    (journal.destinationParentPreexisting || journal.route !== 'promote-cache')
  ) {
    return false;
  }
  if (
    (kind === 'runtime-stage-create' ||
      kind === 'destination-install' ||
      kind === 'runtime-rollback') &&
    journal.route !== 'promote-cache'
  ) {
    return false;
  }
  if (
    kind === 'destination-backup-create' &&
    (journal.route !== 'promote-cache' || !journal.destinationRuntimePreexisting)
  ) {
    return false;
  }
  return (
    kind !== 'source-retire' ||
    (journal.source.classification !== 'none' &&
      ['promote-cache', 'keep-project', 'deduplicate-cache'].includes(journal.route))
  );
}

function creationSlots(kind: RuntimePromotionIntentKind): readonly RuntimePromotionOwnedSlotName[] {
  switch (kind) {
    case 'destination-parent-create': {
      return ['destinationParent'];
    }
    case 'runtime-stage-create': {
      return ['runtimeStage'];
    }
    case 'destination-backup-create': {
      return ['destinationBackup'];
    }
    case 'authored-prepare': {
      return ['authoredStage', 'authoredBackup', 'replayManifest'];
    }
    case 'source-retire': {
      return ['sourceTombstone'];
    }
    default: {
      return [];
    }
  }
}

function forwardIntentAllowed(
  journal: RuntimePromotionJournal,
  intent: RuntimePromotionPendingIntent,
): boolean {
  const openForward = journal.state === 'open' && journal.progress.direction === 'forward';
  switch (intent.kind) {
    case 'destination-parent-create': {
      return openForward && journal.progress.phase === 'authored-prepared';
    }
    case 'runtime-stage-create': {
      return (
        openForward &&
        journal.progress.phase === 'destination-ready' &&
        (journal.destinationParentPreexisting ||
          journal.cleanup.destinationParent !== 'unmaterialized')
      );
    }
    case 'destination-backup-create': {
      return (
        openForward &&
        journal.progress.phase === 'runtime-staged' &&
        journal.destinationRuntimePreexisting &&
        journal.manifests.destination !== null
      );
    }
    case 'destination-install': {
      return (
        openForward &&
        journal.progress.phase ===
          (journal.destinationRuntimePreexisting ? 'destination-backed-up' : 'runtime-staged') &&
        journal.progress.runtimeInstallState === 'not-installed'
      );
    }
    case 'authored-prepare': {
      const requiredPhase = journal.route === 'authored-only' ? 'prepared' : 'destination-verified';
      return openForward && journal.progress.phase === requiredPhase;
    }
    case 'authored-target-commit': {
      const phaseAllowed =
        journal.route === 'promote-cache'
          ? journal.progress.phase === 'runtime-installed'
          : journal.progress.phase === 'authored-prepared';
      return openForward && phaseAllowed && intent.cursor === journal.progress.authoredCursor;
    }
    case 'source-retire': {
      return openForward && journal.progress.phase === 'authored-committed';
    }
    default: {
      return false;
    }
  }
}

function rollbackIntentAllowed(
  journal: RuntimePromotionJournal,
  intent: RuntimePromotionPendingIntent,
): boolean {
  const openRollback = journal.state === 'open' && journal.progress.direction === 'rollback';
  switch (intent.kind) {
    case 'runtime-rollback': {
      const restoringBeforeInstall =
        journal.progress.runtimeInstallState === 'not-installed' &&
        journal.destinationRuntimePreexisting &&
        journal.manifests.destination !== null &&
        journal.manifests.runtimeStage !== null &&
        journal.cleanup.destinationBackup === 'pending' &&
        journal.cleanup.runtimeStage === 'pending' &&
        journal.progress.lastPostcondition?.kind === 'destination-backup-create';
      return (
        openRollback &&
        journal.progress.phase === 'rollback-started' &&
        (journal.progress.runtimeInstallState === 'installed' || restoringBeforeInstall)
      );
    }
    case 'authored-target-rollback': {
      return (
        openRollback &&
        ['rollback-started', 'runtime-rolled-back'].includes(journal.progress.phase) &&
        journal.progress.runtimeInstallState !== 'installed' &&
        journal.cleanup.destinationBackup !== 'pending' &&
        intent.cursor === journal.progress.authoredCursor - journal.progress.rollbackCursor - 1
      );
    }
    default: {
      return false;
    }
  }
}

function cleanupIntentAllowed(
  journal: RuntimePromotionJournal,
  intent: RuntimePromotionPendingIntent,
): boolean {
  return (
    intent.kind === 'owned-slot-cleanup' &&
    journal.state === 'closed' &&
    journal.progress.direction === 'cleanup' &&
    ['closed', 'cleanup'].includes(journal.progress.phase) &&
    intent.slot !== null &&
    journal.cleanup[intent.slot] === 'pending'
  );
}

/** A freshly durable intent must describe a legal current phase and no performed create. */
export function runtimePromotionPendingIntentAllowed(
  journal: RuntimePromotionJournal,
  intent: RuntimePromotionPendingIntent,
): boolean {
  if (!routeAllows(journal, intent.kind)) return false;
  if (creationSlots(intent.kind).some((slot) => journal.cleanup[slot] !== 'unmaterialized')) {
    return false;
  }
  if (intent.kind === 'runtime-rollback' || intent.kind === 'authored-target-rollback') {
    return rollbackIntentAllowed(journal, intent);
  }
  if (intent.kind === 'owned-slot-cleanup') {
    return cleanupIntentAllowed(journal, intent);
  }
  return forwardIntentAllowed(journal, intent);
}

/** Exact phase that the matching postcondition must publish. */
export function runtimePromotionPostconditionPhaseAllowed(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
  intent: RuntimePromotionPendingIntent,
): boolean {
  switch (intent.kind) {
    case 'destination-parent-create': {
      return next.progress.phase === 'destination-ready';
    }
    case 'runtime-stage-create': {
      return next.progress.phase === 'runtime-staged' && next.manifests.runtimeStage !== null;
    }
    case 'destination-backup-create': {
      return next.progress.phase === 'destination-backed-up';
    }
    case 'destination-install': {
      return next.progress.phase === 'runtime-installed';
    }
    case 'authored-prepare': {
      if (next.progress.lastPostcondition?.outcome === 'aborted') {
        return next.progress.phase === previous.progress.phase;
      }
      return next.progress.phase === 'authored-prepared';
    }
    case 'authored-target-commit': {
      return next.progress.authoredCursor === next.plan.mutationCount
        ? next.progress.phase === 'authored-committed'
        : next.progress.phase === previous.progress.phase;
    }
    case 'source-retire': {
      return next.progress.phase === 'source-retired';
    }
    case 'runtime-rollback': {
      return next.progress.phase === 'runtime-rolled-back';
    }
    case 'authored-target-rollback': {
      return next.progress.rollbackCursor === next.progress.authoredCursor
        ? next.progress.phase === 'authored-rolled-back'
        : next.progress.phase === previous.progress.phase;
    }
    case 'owned-slot-cleanup': {
      return next.progress.phase === 'cleanup';
    }
  }
}

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
  if (post === null || !routeAllows(journal, post.kind)) return post === null;
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

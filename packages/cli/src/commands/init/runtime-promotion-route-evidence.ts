/** Route-bound manifest and owned-artifact facts for standalone journal validation. */
/* eslint-disable sonarjs/no-duplicate-string -- closed route, phase, and cleanup literals make evidence windows explicit */

import type { RuntimePromotionJournal } from './runtime-promotion-journal-types.js';

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

const SOURCE_ROUTES = ['promote-cache', 'keep-project', 'deduplicate-cache'] as const;

function forwardPhaseAtLeast(
  actual: RuntimePromotionJournal['progress']['phase'],
  minimum: (typeof FORWARD_PHASES)[number],
): boolean {
  return (
    FORWARD_PHASES.indexOf(actual as (typeof FORWARD_PHASES)[number]) >=
    FORWARD_PHASES.indexOf(minimum)
  );
}

function isSourceRoute(journal: RuntimePromotionJournal): boolean {
  return SOURCE_ROUTES.includes(journal.route as (typeof SOURCE_ROUTES)[number]);
}

function materializationState(
  materialized: boolean,
  removed: boolean,
): RuntimePromotionJournal['cleanup']['runtimeStage'] {
  if (!materialized) return 'unmaterialized';
  return removed ? 'removed' : 'pending';
}

function routeManifestSlotsAllowed(journal: RuntimePromotionJournal): boolean {
  if (journal.source.classification === 'none' && journal.manifests.source !== null) return false;
  if (journal.route !== 'promote-cache' && journal.manifests.runtimeStage !== null) return false;
  if (journal.route === 'authored-only' && journal.manifests.destination !== null) return false;
  if (
    journal.state === 'closed' &&
    (journal.manifests.destination !== null) !== journal.destinationRuntimePreexisting
  ) {
    return false;
  }
  return true;
}

function forwardManifestEvidenceAllowed(journal: RuntimePromotionJournal): boolean {
  if (journal.state !== 'open' || journal.progress.direction !== 'forward') return true;
  const sourceRequired =
    isSourceRoute(journal) && forwardPhaseAtLeast(journal.progress.phase, 'source-verified');
  const destinationVerified = forwardPhaseAtLeast(journal.progress.phase, 'destination-verified');
  const destinationPresent = journal.manifests.destination !== null;
  const earlySourceManifest =
    journal.manifests.source !== null &&
    !forwardPhaseAtLeast(journal.progress.phase, 'source-verified');
  const destinationEvidenceAllowed = destinationVerified
    ? destinationPresent === journal.destinationRuntimePreexisting
    : !destinationPresent;
  const earlyRuntimeStage =
    journal.manifests.runtimeStage !== null &&
    !forwardPhaseAtLeast(journal.progress.phase, 'runtime-staged');
  return (
    (!sourceRequired || journal.manifests.source !== null) &&
    destinationEvidenceAllowed &&
    !earlySourceManifest &&
    !earlyRuntimeStage
  );
}

function rollbackManifestEvidenceAllowed(journal: RuntimePromotionJournal): boolean {
  if (journal.state !== 'open' || journal.progress.direction !== 'rollback') return true;
  if (journal.route === 'authored-only') {
    return journal.manifests.source === null && journal.manifests.destination === null;
  }
  const sourceAllowed = !isSourceRoute(journal) || journal.manifests.source !== null;
  const destinationPresent = journal.manifests.destination !== null;
  return sourceAllowed && destinationPresent === journal.destinationRuntimePreexisting;
}

function routeCleanupSlotsAllowed(journal: RuntimePromotionJournal): boolean {
  const runtimeSlotsAllowed =
    journal.route === 'promote-cache' ||
    (journal.cleanup.runtimeStage === 'unmaterialized' &&
      journal.cleanup.destinationBackup === 'unmaterialized');
  const sourceSlotAllowed =
    journal.source.classification !== 'none' ||
    journal.cleanup.sourceTombstone === 'unmaterialized';
  const destinationParentApplicable =
    !journal.destinationParentPreexisting && journal.route === 'promote-cache';
  const destinationParentAllowed =
    destinationParentApplicable || journal.cleanup.destinationParent === 'unmaterialized';
  const absentBackupAllowed =
    journal.route !== 'promote-cache' ||
    journal.destinationRuntimePreexisting ||
    journal.cleanup.destinationBackup === 'unmaterialized';
  return (
    runtimeSlotsAllowed && sourceSlotAllowed && destinationParentAllowed && absentBackupAllowed
  );
}

function runtimeStageOwnershipAllowed(journal: RuntimePromotionJournal): boolean {
  if (journal.route !== 'promote-cache') return true;
  const stageIdentityMatchesCleanup =
    (journal.manifests.runtimeStage === null &&
      journal.cleanup.runtimeStage === 'unmaterialized') ||
    (journal.manifests.runtimeStage !== null && journal.cleanup.runtimeStage !== 'unmaterialized');
  const createdParentSupportsStage =
    journal.destinationParentPreexisting ||
    journal.manifests.runtimeStage === null ||
    journal.cleanup.destinationParent !== 'unmaterialized';
  return stageIdentityMatchesCleanup && createdParentSupportsStage;
}

function exactForwardOwnedWindowsAllowed(journal: RuntimePromotionJournal): boolean {
  if (journal.state !== 'open' || journal.progress.direction !== 'forward') return true;
  const authoredPrepared = forwardPhaseAtLeast(journal.progress.phase, 'authored-prepared');
  const authoredExpected = authoredPrepared ? 'pending' : 'unmaterialized';
  const authoredAllowed = [
    journal.cleanup.authoredStage,
    journal.cleanup.authoredBackup,
    journal.cleanup.replayManifest,
  ].every((state) => state === authoredExpected);

  const runtimeStaged = forwardPhaseAtLeast(journal.progress.phase, 'runtime-staged');
  const runtimeInstalled = forwardPhaseAtLeast(journal.progress.phase, 'runtime-installed');
  const runtimeExpected = materializationState(runtimeStaged, runtimeInstalled);
  const runtimeAllowed =
    journal.route !== 'promote-cache' || journal.cleanup.runtimeStage === runtimeExpected;

  const parentReady = forwardPhaseAtLeast(journal.progress.phase, 'destination-ready');
  const parentExpected = materializationState(parentReady, runtimeInstalled);
  const parentAllowed =
    journal.route !== 'promote-cache' ||
    journal.destinationParentPreexisting ||
    journal.cleanup.destinationParent === parentExpected;

  const backupReady = forwardPhaseAtLeast(journal.progress.phase, 'destination-backed-up');
  const backupExpected =
    journal.route === 'promote-cache' && journal.destinationRuntimePreexisting && backupReady
      ? 'pending'
      : 'unmaterialized';
  const backupAllowed = journal.cleanup.destinationBackup === backupExpected;

  const sourceRetired = forwardPhaseAtLeast(journal.progress.phase, 'source-retired');
  const sourceExpected =
    journal.source.classification !== 'none' && sourceRetired ? 'pending' : 'unmaterialized';
  return (
    authoredAllowed &&
    runtimeAllowed &&
    parentAllowed &&
    backupAllowed &&
    journal.cleanup.sourceTombstone === sourceExpected
  );
}

function runtimeInstallStateAllowed(journal: RuntimePromotionJournal): boolean {
  if (journal.route !== 'promote-cache') {
    return journal.progress.runtimeInstallState === 'not-installed';
  }
  if (journal.progress.runtimeInstallState === 'not-installed') return true;
  if (journal.progress.runtimeInstallState === 'backup-restored') {
    return (
      journal.destinationRuntimePreexisting &&
      journal.manifests.runtimeStage !== null &&
      journal.cleanup.runtimeStage === 'pending' &&
      journal.cleanup.destinationBackup === 'removed'
    );
  }
  const runtimeOwned =
    journal.manifests.runtimeStage !== null && journal.cleanup.runtimeStage === 'removed';
  const parentResolved =
    journal.destinationParentPreexisting || journal.cleanup.destinationParent === 'removed';
  const backupResolved =
    journal.progress.runtimeInstallState !== 'rolled-back' ||
    !journal.destinationRuntimePreexisting ||
    journal.cleanup.destinationBackup === 'removed';
  return runtimeOwned && parentResolved && backupResolved;
}

function forwardRuntimeInstallStateAllowed(journal: RuntimePromotionJournal): boolean {
  if (
    journal.state !== 'open' ||
    journal.progress.direction !== 'forward' ||
    journal.route !== 'promote-cache'
  ) {
    return true;
  }
  const installedPhase = forwardPhaseAtLeast(journal.progress.phase, 'runtime-installed');
  return installedPhase
    ? journal.progress.runtimeInstallState === 'installed'
    : journal.progress.runtimeInstallState === 'not-installed';
}

function rollbackRuntimeInstallStateAllowed(journal: RuntimePromotionJournal): boolean {
  if (journal.state !== 'open' || journal.progress.direction !== 'rollback') return true;
  if (
    journal.progress.phase !== 'rollback-started' &&
    journal.cleanup.destinationBackup === 'pending'
  ) {
    return false;
  }
  if (journal.progress.phase === 'rollback-started') {
    return !['rolled-back', 'backup-restored'].includes(journal.progress.runtimeInstallState);
  }
  if (journal.progress.phase === 'runtime-rolled-back') {
    return ['rolled-back', 'backup-restored'].includes(journal.progress.runtimeInstallState);
  }
  return journal.progress.runtimeInstallState !== 'installed';
}

function openRollbackAuthoredEvidenceAllowed(journal: RuntimePromotionJournal): boolean {
  if (journal.state !== 'open' || journal.progress.direction !== 'rollback') return true;
  const authored = [
    journal.cleanup.authoredStage,
    journal.cleanup.authoredBackup,
    journal.cleanup.replayManifest,
  ];
  const allPending = authored.every((state) => state === 'pending');
  const allUnmaterialized = authored.every((state) => state === 'unmaterialized');
  const noAuthoredProgress =
    journal.progress.authoredCursor === 0 && journal.progress.rollbackCursor === 0;
  return allPending || (noAuthoredProgress && allUnmaterialized);
}

function rollbackParentWindowAllowed(
  journal: RuntimePromotionJournal,
  stageOrBackupExists: boolean,
): boolean {
  if (journal.destinationParentPreexisting) {
    return journal.cleanup.destinationParent === 'unmaterialized';
  }
  if (journal.progress.runtimeInstallState !== 'not-installed') {
    return journal.cleanup.destinationParent === 'removed';
  }
  return (
    journal.cleanup.destinationParent === 'pending' ||
    (!stageOrBackupExists && journal.cleanup.destinationParent === 'unmaterialized')
  );
}

function rollbackBackupWindowAllowed(journal: RuntimePromotionJournal): boolean {
  if (!journal.destinationRuntimePreexisting) {
    return journal.cleanup.destinationBackup === 'unmaterialized';
  }
  if (journal.progress.runtimeInstallState === 'installed') {
    return journal.cleanup.destinationBackup === 'pending';
  }
  if (['rolled-back', 'backup-restored'].includes(journal.progress.runtimeInstallState)) {
    return journal.cleanup.destinationBackup === 'removed';
  }
  return (
    ['unmaterialized', 'pending'].includes(journal.cleanup.destinationBackup) &&
    (journal.cleanup.destinationBackup === 'unmaterialized' ||
      journal.manifests.runtimeStage !== null)
  );
}

function openRollbackRuntimeWindowsAllowed(journal: RuntimePromotionJournal): boolean {
  if (
    journal.state !== 'open' ||
    journal.progress.direction !== 'rollback' ||
    journal.route !== 'promote-cache'
  ) {
    return true;
  }
  const runtimeRemoved = ['installed', 'rolled-back'].includes(
    journal.progress.runtimeInstallState,
  );
  const stageExpected = materializationState(
    journal.manifests.runtimeStage !== null,
    runtimeRemoved,
  );
  const stageOrBackupExists =
    journal.manifests.runtimeStage !== null ||
    journal.cleanup.destinationBackup !== 'unmaterialized';
  return (
    journal.cleanup.runtimeStage === stageExpected &&
    rollbackParentWindowAllowed(journal, stageOrBackupExists) &&
    rollbackBackupWindowAllowed(journal)
  );
}

function rollbackSourceStateAllowed(journal: RuntimePromotionJournal): boolean {
  const rolledBack =
    journal.progress.direction === 'rollback' || journal.terminal?.outcome === 'rolled-back';
  return !rolledBack || journal.cleanup.sourceTombstone === 'unmaterialized';
}

export function runtimePromotionRouteEvidenceAllowed(journal: RuntimePromotionJournal): boolean {
  return (
    routeManifestSlotsAllowed(journal) &&
    forwardManifestEvidenceAllowed(journal) &&
    rollbackManifestEvidenceAllowed(journal) &&
    routeCleanupSlotsAllowed(journal) &&
    runtimeStageOwnershipAllowed(journal) &&
    exactForwardOwnedWindowsAllowed(journal) &&
    runtimeInstallStateAllowed(journal) &&
    forwardRuntimeInstallStateAllowed(journal) &&
    rollbackRuntimeInstallStateAllowed(journal) &&
    openRollbackAuthoredEvidenceAllowed(journal) &&
    openRollbackRuntimeWindowsAllowed(journal) &&
    rollbackSourceStateAllowed(journal)
  );
}

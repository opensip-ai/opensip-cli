import {
  assertOpenForward,
  recordOpenIntent,
  recordOpenPostcondition,
  replaceOpen,
  sameManifest,
  transitionFailure,
  type RuntimeMutationOutcome,
  type RuntimePromotionTransitionContext,
} from './runtime-promotion-transitions-common.js';

import type {
  RuntimeManifestIdentity,
  RuntimePromotionJournal,
} from './runtime-promotion-journal-schema.js';
import type { DurableOpenPromotionJournal } from './runtime-promotion-journal.js';

export async function verifyPromotionSource(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  manifest: RuntimeManifestIdentity,
): Promise<DurableOpenPromotionJournal> {
  return replaceOpen(context, receipt, (current, recordedAt) => {
    assertOpenForward(current, 'prepared');
    if (current.source.classification === 'none' || current.manifests.source !== null) {
      transitionFailure('source verification requires one unverified selected cache source');
    }
    return {
      ...current,
      revision: current.revision + 1,
      manifests: { ...current.manifests, source: manifest },
      progress: { ...current.progress, phase: 'source-verified' },
      timestamps: { ...current.timestamps, updatedAt: recordedAt },
    };
  });
}

export async function verifyPromotionDestination(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  manifest: RuntimeManifestIdentity | null,
): Promise<DurableOpenPromotionJournal> {
  return replaceOpen(context, receipt, (current, recordedAt) => {
    const requiredPhase = current.source.classification === 'none' ? 'prepared' : 'source-verified';
    assertOpenForward(current, requiredPhase);
    if (
      current.route === 'authored-only' ||
      current.manifests.destination !== null ||
      (manifest !== null) !== current.destinationRuntimePreexisting
    ) {
      transitionFailure('destination verification does not match immutable route evidence');
    }
    return {
      ...current,
      revision: current.revision + 1,
      manifests: { ...current.manifests, destination: manifest },
      progress: { ...current.progress, phase: 'destination-verified' },
      timestamps: { ...current.timestamps, updatedAt: recordedAt },
    };
  });
}

export function recordDestinationParentCreateIntent(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  return recordOpenIntent(context, receipt, {
    kind: 'destination-parent-create',
    slot: 'destinationParent',
  });
}

export function recordDestinationReady(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  outcome: RuntimeMutationOutcome,
): Promise<DurableOpenPromotionJournal> {
  return recordOpenPostcondition(
    context,
    receipt,
    {
      kind: 'destination-parent-create',
      slot: 'destinationParent',
      outcome,
    },
    (current) => ({
      manifests: current.manifests,
      progress: { ...current.progress, phase: 'destination-ready' },
      cleanup: { ...current.cleanup, destinationParent: 'pending' },
    }),
  );
}

export async function advancePreexistingDestinationReady(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  return replaceOpen(context, receipt, (current, recordedAt) => {
    assertOpenForward(current, 'authored-prepared');
    if (
      current.route !== 'promote-cache' ||
      !current.destinationParentPreexisting ||
      current.cleanup.destinationParent !== 'unmaterialized'
    ) {
      transitionFailure('direct destination readiness requires its preexisting parent');
    }
    return {
      ...current,
      revision: current.revision + 1,
      progress: { ...current.progress, phase: 'destination-ready' },
      timestamps: { ...current.timestamps, updatedAt: recordedAt },
    };
  });
}

export function recordRuntimeStageCreateIntent(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  return recordOpenIntent(context, receipt, {
    kind: 'runtime-stage-create',
    slot: 'runtimeStage',
  });
}

export function recordRuntimeStaged(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  outcome: RuntimeMutationOutcome,
  manifest: RuntimeManifestIdentity,
): Promise<DurableOpenPromotionJournal> {
  return recordOpenPostcondition(
    context,
    receipt,
    {
      kind: 'runtime-stage-create',
      slot: 'runtimeStage',
      outcome,
    },
    (current) => {
      if (current.manifests.source === null || !sameManifest(current.manifests.source, manifest)) {
        transitionFailure('the verified runtime stage must exactly match its selected source');
      }
      return {
        manifests: { ...current.manifests, runtimeStage: manifest },
        progress: { ...current.progress, phase: 'runtime-staged' },
        cleanup: { ...current.cleanup, runtimeStage: 'pending' },
      };
    },
  );
}

export function recordDestinationBackupCreateIntent(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  return recordOpenIntent(context, receipt, {
    kind: 'destination-backup-create',
    slot: 'destinationBackup',
  });
}

export function recordDestinationBackedUp(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  outcome: RuntimeMutationOutcome,
): Promise<DurableOpenPromotionJournal> {
  return recordOpenPostcondition(
    context,
    receipt,
    {
      kind: 'destination-backup-create',
      slot: 'destinationBackup',
      outcome,
    },
    (current) => ({
      manifests: current.manifests,
      progress: { ...current.progress, phase: 'destination-backed-up' },
      cleanup: { ...current.cleanup, destinationBackup: 'pending' },
    }),
  );
}

export function recordDestinationInstallIntent(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  return recordOpenIntent(context, receipt, {
    kind: 'destination-install',
    slot: 'destinationParent',
  });
}

export function recordRuntimeInstalled(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  outcome: RuntimeMutationOutcome,
): Promise<DurableOpenPromotionJournal> {
  return recordOpenPostcondition(
    context,
    receipt,
    {
      kind: 'destination-install',
      slot: 'destinationParent',
      outcome,
    },
    (current) => ({
      manifests: current.manifests,
      progress: {
        ...current.progress,
        phase: 'runtime-installed',
        runtimeInstallState: 'installed',
      },
      cleanup: {
        ...current.cleanup,
        destinationParent: current.destinationParentPreexisting ? 'unmaterialized' : 'pending',
        runtimeStage: 'removed',
      },
    }),
  );
}

export function recordSourceRetireIntent(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  return recordOpenIntent(context, receipt, {
    kind: 'source-retire',
    slot: 'sourceTombstone',
  });
}

export function recordSourceRetired(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  outcome: RuntimeMutationOutcome,
): Promise<DurableOpenPromotionJournal> {
  return recordOpenPostcondition(
    context,
    receipt,
    {
      kind: 'source-retire',
      slot: 'sourceTombstone',
      outcome,
    },
    (current) => ({
      manifests: current.manifests,
      progress: { ...current.progress, phase: 'source-retired' },
      cleanup: { ...current.cleanup, sourceTombstone: 'pending' },
    }),
  );
}

export async function beginRuntimePromotionRollback(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  const current = await context.controller.verifyOpen(receipt);
  if (current.progress.pendingIntent !== null || current.progress.direction !== 'forward') {
    transitionFailure('rollback requires one idle forward receipt');
  }
  const recordedAt = Math.max(current.timestamps.updatedAt, context.now());
  const desired: RuntimePromotionJournal = {
    ...current,
    revision: current.revision + 1,
    progress: {
      ...current.progress,
      phase: 'rollback-started',
      direction: 'rollback',
    },
    timestamps: { ...current.timestamps, updatedAt: recordedAt },
  };
  return context.controller.beginRollback(receipt, desired);
}

export function recordRuntimeRollbackIntent(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  return recordOpenIntent(context, receipt, {
    kind: 'runtime-rollback',
    slot: 'destinationBackup',
  });
}

export function recordRuntimeRolledBack(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  outcome: RuntimeMutationOutcome,
): Promise<DurableOpenPromotionJournal> {
  return recordOpenPostcondition(
    context,
    receipt,
    {
      kind: 'runtime-rollback',
      slot: 'destinationBackup',
      outcome,
    },
    (current) => {
      assertOpenRollbackWithPendingRuntimeIntent(current);
      const beforeInstall = current.progress.runtimeInstallState === 'not-installed';
      const removesCreatedParent =
        !current.destinationParentPreexisting &&
        (beforeInstall || current.progress.authoredCursor === 0);
      return {
        manifests: current.manifests,
        progress: {
          ...current.progress,
          phase: 'runtime-rolled-back',
          runtimeInstallState:
            beforeInstall && current.destinationRuntimePreexisting
              ? 'backup-restored'
              : 'rolled-back',
        },
        cleanup: {
          ...current.cleanup,
          destinationParent: removesCreatedParent ? 'removed' : current.cleanup.destinationParent,
          runtimeStage:
            (removesCreatedParent || beforeInstall) && current.cleanup.runtimeStage === 'pending'
              ? 'removed'
              : current.cleanup.runtimeStage,
          destinationBackup:
            current.cleanup.destinationBackup === 'pending'
              ? 'removed'
              : current.cleanup.destinationBackup,
        },
      };
    },
  );
}

function assertOpenRollbackWithPendingRuntimeIntent(current: RuntimePromotionJournal): void {
  if (
    current.state !== 'open' ||
    current.progress.direction !== 'rollback' ||
    current.progress.phase !== 'rollback-started' ||
    current.progress.pendingIntent?.kind !== 'runtime-rollback'
  ) {
    transitionFailure('runtime rollback completion requires its rollback-started intent');
  }
}

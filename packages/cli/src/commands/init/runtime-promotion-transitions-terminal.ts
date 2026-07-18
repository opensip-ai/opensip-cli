import { canonicalRuntimePromotionJournal } from './runtime-promotion-journal-schema.js';
import {
  assertOpenForward,
  assertOpenRollback,
  recordClosedCleanupIntent,
  recordClosedCleanupPostcondition,
  replaceOpen,
  sameManifest,
  transitionFailure,
  transitionTime,
  type RuntimeMutationOutcome,
  type RuntimePromotionTransitionContext,
} from './runtime-promotion-transitions-common.js';

import type {
  RuntimeManifestIdentity,
  RuntimePromotionJournal,
  RuntimePromotionOwnedSlotName,
  RuntimePromotionTerminal,
} from './runtime-promotion-journal-schema.js';
import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
} from './runtime-promotion-journal.js';

function committedRuntimeManifest(
  current: RuntimePromotionJournal,
): RuntimeManifestIdentity | null {
  if (current.route === 'authored-only') return null;
  if (current.route === 'promote-cache') return current.manifests.runtimeStage;
  return current.manifests.destination;
}

function rolledBackRuntimeManifest(
  current: RuntimePromotionJournal,
): RuntimeManifestIdentity | null {
  if (
    current.route === 'project-authority' ||
    current.route === 'keep-project' ||
    current.route === 'deduplicate-cache' ||
    (current.route === 'promote-cache' && current.destinationRuntimePreexisting)
  ) {
    return current.manifests.destination;
  }
  return current.route === 'promote-cache' ? current.manifests.source : null;
}

function rolledBackAuthority(
  current: RuntimePromotionJournal,
): RuntimePromotionTerminal['authority'] {
  if (current.route === 'authored-only') return 'none';
  if (current.route === 'promote-cache' && !current.destinationRuntimePreexisting) return 'cache';
  return 'project';
}

function assertObservedAuthority(
  expected: RuntimeManifestIdentity | null,
  observed: RuntimeManifestIdentity | null,
): void {
  if (!sameManifest(expected, observed)) {
    transitionFailure('the observed runtime authority does not match durable route evidence');
  }
}

async function bindExactAuthoredPhase(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  phase: 'authored-prepared' | 'authored-committed' | 'authored-rolled-back',
): Promise<DurableOpenPromotionJournal> {
  const current = await context.controller.verifyOpen(receipt);
  if (current.progress.phase !== phase || current.progress.pendingIntent !== null) {
    transitionFailure(`the authored transaction did not return an idle ${phase} receipt`);
  }
  if (
    phase === 'authored-committed' &&
    (current.progress.direction !== 'forward' ||
      current.progress.authoredCursor !== current.plan.mutationCount)
  ) {
    transitionFailure('the authored commit receipt has incomplete mutation evidence');
  }
  if (
    phase === 'authored-rolled-back' &&
    (current.progress.direction !== 'rollback' ||
      current.progress.rollbackCursor !== current.progress.authoredCursor ||
      current.progress.runtimeInstallState === 'installed' ||
      current.cleanup.destinationBackup === 'pending' ||
      (!current.destinationParentPreexisting &&
        current.cleanup.destinationParent === 'pending' &&
        !(
          current.progress.runtimeInstallState === 'rolled-back' &&
          current.progress.authoredCursor > 0
        )))
  ) {
    transitionFailure('the authored rollback receipt lacks exact restored authority');
  }
  return receipt;
}

export function bindAuthoredPreparedReceipt(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  return bindExactAuthoredPhase(context, receipt, 'authored-prepared');
}

export function bindAuthoredCommittedReceipt(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  return bindExactAuthoredPhase(context, receipt, 'authored-committed');
}

export function bindAuthoredRolledBackReceipt(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  return bindExactAuthoredPhase(context, receipt, 'authored-rolled-back');
}

export async function recordUnmaterializedAuthoredStateRolledBack(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  return replaceOpen(context, receipt, (current, recordedAt) => {
    assertOpenRollback(current);
    const authoredSlots = [
      current.cleanup.authoredStage,
      current.cleanup.authoredBackup,
      current.cleanup.replayManifest,
    ];
    if (
      !['rollback-started', 'runtime-rolled-back'].includes(current.progress.phase) ||
      current.progress.authoredCursor !== 0 ||
      current.progress.rollbackCursor !== 0 ||
      authoredSlots.some((state) => state !== 'unmaterialized') ||
      current.progress.runtimeInstallState === 'installed' ||
      current.cleanup.destinationBackup === 'pending' ||
      (!current.destinationParentPreexisting && current.cleanup.destinationParent === 'pending')
    ) {
      transitionFailure('unmaterialized authored rollback lacks exact restored authority');
    }
    return {
      ...current,
      revision: current.revision + 1,
      progress: { ...current.progress, phase: 'authored-rolled-back' },
      timestamps: { ...current.timestamps, updatedAt: recordedAt },
    };
  });
}

export async function recordAuthorityVerified(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  observedRuntimeManifest: RuntimeManifestIdentity | null,
): Promise<DurableOpenPromotionJournal> {
  return replaceOpen(context, receipt, (current, recordedAt) => {
    const requiredPhase =
      current.source.classification === 'none' ? 'authored-committed' : 'source-retired';
    assertOpenForward(current, requiredPhase);
    if (current.progress.authoredCursor !== current.plan.mutationCount) {
      transitionFailure('runtime authority cannot seal before every authored mutation');
    }
    assertObservedAuthority(committedRuntimeManifest(current), observedRuntimeManifest);
    return {
      ...current,
      revision: current.revision + 1,
      progress: { ...current.progress, phase: 'authority-verified' },
      timestamps: { ...current.timestamps, updatedAt: recordedAt },
    };
  });
}

export async function sealRuntimePromotionCommitted(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  const current = await context.controller.verifyOpen(receipt);
  assertOpenForward(current, 'authority-verified');
  const recordedAt = transitionTime(current, context);
  const runtimeManifest = committedRuntimeManifest(current);
  const desired = canonicalRuntimePromotionJournal({
    ...current,
    revision: current.revision + 1,
    progress: { ...current.progress, phase: 'committed' },
    terminal: {
      outcome: 'committed',
      authority: current.route === 'authored-only' ? 'none' : 'project',
      runtimeManifest,
      authoredVerified: true,
      sourcePreserved: false,
      verifiedAt: recordedAt,
    },
    timestamps: { ...current.timestamps, updatedAt: recordedAt },
  });
  return context.controller.sealCommitted(receipt, desired);
}

export async function sealRuntimePromotionRolledBack(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  observedRuntimeManifest: RuntimeManifestIdentity | null,
): Promise<DurableOpenPromotionJournal> {
  const current = await context.controller.verifyOpen(receipt);
  assertOpenRollback(current, 'authored-rolled-back');
  const runtimeManifest = rolledBackRuntimeManifest(current);
  assertObservedAuthority(runtimeManifest, observedRuntimeManifest);
  const recordedAt = transitionTime(current, context);
  const desired = canonicalRuntimePromotionJournal({
    ...current,
    revision: current.revision + 1,
    progress: { ...current.progress, phase: 'rolled-back' },
    terminal: {
      outcome: 'rolled-back',
      authority: rolledBackAuthority(current),
      runtimeManifest,
      authoredVerified: true,
      sourcePreserved: current.source.classification !== 'none',
      verifiedAt: recordedAt,
    },
    timestamps: { ...current.timestamps, updatedAt: recordedAt },
  });
  return context.controller.sealRolledBack(receipt, desired);
}

export async function closeRuntimePromotion(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableClosedPromotionJournal> {
  const current = await context.controller.verifyOpen(receipt);
  if (
    current.progress.pendingIntent !== null ||
    current.terminal === null ||
    !['committed', 'rolled-back'].includes(current.progress.phase)
  ) {
    transitionFailure('only an idle terminal receipt can close');
  }
  const closedAt = transitionTime(current, context);
  const desired = canonicalRuntimePromotionJournal({
    ...current,
    state: 'closed',
    revision: current.revision + 1,
    progress: {
      ...current.progress,
      phase: 'closed',
      direction: 'cleanup',
    },
    timestamps: {
      ...current.timestamps,
      updatedAt: closedAt,
      closedAt,
    },
  });
  return context.controller.close(receipt, desired);
}

export function recordOwnedCleanupIntent(
  context: RuntimePromotionTransitionContext,
  receipt: DurableClosedPromotionJournal,
  slot: RuntimePromotionOwnedSlotName,
): Promise<DurableClosedPromotionJournal> {
  return recordClosedCleanupIntent(context, receipt, slot);
}

export function recordOwnedCleanupPostcondition(
  context: RuntimePromotionTransitionContext,
  receipt: DurableClosedPromotionJournal,
  slot: RuntimePromotionOwnedSlotName,
  outcome: RuntimeMutationOutcome,
): Promise<DurableClosedPromotionJournal> {
  return recordClosedCleanupPostcondition(context, receipt, slot, outcome);
}

export async function unlinkCleanRuntimePromotion(
  context: RuntimePromotionTransitionContext,
  receipt: DurableClosedPromotionJournal,
): Promise<void> {
  await context.controller.verifyReceipt(receipt, { state: 'closed' });
  return context.controller.unlinkClosed(receipt);
}

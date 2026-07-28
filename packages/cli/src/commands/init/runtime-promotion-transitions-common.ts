import { isDeepStrictEqual } from 'node:util';

import { journalError } from './runtime-promotion-journal-error.js';
import {
  canonicalRuntimePromotionJournal,
  type RuntimeManifestIdentity,
  type RuntimePromotionIntentKind,
  type RuntimePromotionJournal,
  type RuntimePromotionOwnedSlotName,
  type RuntimePromotionPostconditionOutcome,
} from './runtime-promotion-journal-schema.js';

import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
  RuntimePromotionJournalController,
} from './runtime-promotion-journal.js';

export type RuntimeMutationOutcome = Exclude<RuntimePromotionPostconditionOutcome, 'aborted'>;

export interface RuntimePromotionTransitionContext {
  readonly controller: RuntimePromotionJournalController;
  readonly now: () => number;
}

export function runtimePromotionMutationOutcome(status: string): RuntimeMutationOutcome {
  return status.startsWith('already-') ? 'already-satisfied' : 'applied';
}

interface OpenIntentIdentity {
  readonly kind: RuntimePromotionIntentKind;
  readonly slot: RuntimePromotionOwnedSlotName;
}

interface OpenPostconditionIdentity extends OpenIntentIdentity {
  readonly outcome: RuntimeMutationOutcome;
}

/** @throws {SystemError} Always; the requested runtime promotion transition is invalid. */
export function transitionFailure(message: string): never {
  throw journalError(
    `Invalid runtime promotion transition request: ${message}`,
    undefined,
    'journal-phase-invalid',
  );
}

export function transitionTime(
  current: RuntimePromotionJournal,
  context: RuntimePromotionTransitionContext,
): number {
  return Math.max(current.timestamps.updatedAt, context.now());
}

export function sameManifest(
  left: RuntimeManifestIdentity | null,
  right: RuntimeManifestIdentity | null,
): boolean {
  return isDeepStrictEqual(left, right);
}

export function assertOpenForward(
  current: RuntimePromotionJournal,
  phase?: RuntimePromotionJournal['progress']['phase'],
): void {
  if (
    current.state !== 'open' ||
    current.progress.direction !== 'forward' ||
    (phase !== undefined && current.progress.phase !== phase) ||
    current.progress.pendingIntent !== null
  ) {
    transitionFailure(
      phase === undefined
        ? 'the journal is not an idle forward receipt'
        : `the journal is not an idle forward ${phase} receipt`,
    );
  }
}

export function assertOpenRollback(
  current: RuntimePromotionJournal,
  phase?: RuntimePromotionJournal['progress']['phase'],
): void {
  if (
    current.state !== 'open' ||
    current.progress.direction !== 'rollback' ||
    (phase !== undefined && current.progress.phase !== phase) ||
    current.progress.pendingIntent !== null
  ) {
    transitionFailure(
      phase === undefined
        ? 'the journal is not an idle rollback receipt'
        : `the journal is not an idle rollback ${phase} receipt`,
    );
  }
}

export async function replaceOpen(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  build: (current: RuntimePromotionJournal, recordedAt: number) => RuntimePromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  const current = await context.controller.verifyOpen(receipt);
  const desired = canonicalRuntimePromotionJournal(
    build(current, transitionTime(current, context)),
  );
  const next = await context.controller.replace(receipt, desired);
  if (next.state !== 'open') transitionFailure('an open transition unexpectedly closed');
  return next;
}

export async function recordOpenIntent(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  identity: OpenIntentIdentity,
): Promise<DurableOpenPromotionJournal> {
  const current = await context.controller.verifyOpen(receipt);
  if (current.progress.pendingIntent !== null) {
    transitionFailure('a write-ahead intent is already unresolved');
  }
  const recordedAt = transitionTime(current, context);
  const desired = canonicalRuntimePromotionJournal({
    ...current,
    revision: current.revision + 1,
    progress: {
      ...current.progress,
      pendingIntent: {
        sequence: current.counts.intentCount + 1,
        kind: identity.kind,
        slot: identity.slot,
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
  return context.controller.recordIntent(receipt, desired);
}

export async function recordOpenPostcondition(
  context: RuntimePromotionTransitionContext,
  receipt: DurableOpenPromotionJournal,
  identity: OpenPostconditionIdentity,
  effects: (
    current: RuntimePromotionJournal,
  ) => Pick<RuntimePromotionJournal, 'progress' | 'manifests' | 'cleanup'>,
): Promise<DurableOpenPromotionJournal> {
  const current = await context.controller.verifyOpen(receipt);
  const pending = current.progress.pendingIntent;
  if (
    pending?.kind !== identity.kind ||
    pending.slot !== identity.slot ||
    pending.cursor !== null
  ) {
    transitionFailure(`the ${identity.kind} postcondition has no exact pending intent`);
  }
  const recordedAt = transitionTime(current, context);
  const updated = effects(current);
  const desired = canonicalRuntimePromotionJournal({
    ...current,
    revision: current.revision + 1,
    manifests: updated.manifests,
    progress: {
      ...updated.progress,
      pendingIntent: null,
      lastPostcondition: {
        ...pending,
        outcome: identity.outcome,
        recordedAt,
      },
    },
    cleanup: updated.cleanup,
    counts: {
      ...current.counts,
      postconditionCount: current.counts.postconditionCount + 1,
    },
    timestamps: {
      ...current.timestamps,
      updatedAt: recordedAt,
    },
  });
  return context.controller.recordPostcondition(receipt, desired);
}

export async function recordClosedCleanupIntent(
  context: RuntimePromotionTransitionContext,
  receipt: DurableClosedPromotionJournal,
  slot: RuntimePromotionOwnedSlotName,
): Promise<DurableClosedPromotionJournal> {
  const current = await context.controller.verifyReceipt(receipt, {
    state: 'closed',
  });
  if (current.progress.pendingIntent !== null || current.cleanup[slot] !== 'pending') {
    transitionFailure(`the ${slot} cleanup slot is not an idle pending artifact`);
  }
  const recordedAt = transitionTime(current, context);
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
  return context.controller.recordCleanupIntent(receipt, desired);
}

export async function recordClosedCleanupPostcondition(
  context: RuntimePromotionTransitionContext,
  receipt: DurableClosedPromotionJournal,
  slot: RuntimePromotionOwnedSlotName,
  outcome: RuntimeMutationOutcome,
): Promise<DurableClosedPromotionJournal> {
  const current = await context.controller.verifyReceipt(receipt, {
    state: 'closed',
  });
  const pending = current.progress.pendingIntent;
  if (
    pending?.kind !== 'owned-slot-cleanup' ||
    pending.slot !== slot ||
    pending.cursor !== null ||
    current.cleanup[slot] !== 'pending'
  ) {
    transitionFailure(`the ${slot} cleanup postcondition has no exact pending intent`);
  }
  const recordedAt = transitionTime(current, context);
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
      [slot]: 'removed',
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
  return context.controller.recordCleanupPostcondition(receipt, desired);
}

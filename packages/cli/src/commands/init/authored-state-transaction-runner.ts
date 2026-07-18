import { validateAuthoredArtifacts } from './authored-state-transaction-artifacts.js';
import {
  assertAuthoredArtifactAbsent,
  assertAuthoredArtifactPathAbsent,
  finalizeAuthoredCleanupEvidence,
  removeAuthoredArtifact,
} from './authored-state-transaction-cleanup.js';
import {
  authoredBlobAvailability,
  reconcileAuthoredMutation,
  verifyEveryAuthoredTarget,
} from './authored-state-transaction-execution.js';
import {
  assertStableAuthoredRoot,
  authoredTransactionFailure,
  observeAuthoredPath,
  sameAuthoredPathState,
  transactionAuthoredRoot,
} from './authored-state-transaction-fs.js';
import {
  advanceAuthoredPhase,
  beginAuthoredRollback,
  recordCleanupIntent,
  recordCleanupPostcondition,
  recordOpenIntent,
  recordOpenPostcondition,
} from './authored-state-transaction-journal.js';
import {
  manifestBytesFor,
  manifestFor,
  stateFor,
  summaryFor,
} from './authored-state-transaction-registry.js';

import type {
  AuthoredStateCleanupResult,
  AuthoredStateCheckpoint,
  AuthoredStateSummary,
  AuthoredStateTransitionResult,
  AuthoredTransactionState,
  InitAuthoredTransaction,
} from './authored-state-transaction-types.js';
import type { InitAuthoredMutation } from './init-authored-plan.js';
import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';
import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
} from './runtime-promotion-journal.js';

type AuthoredDirection = 'commit' | 'rollback';

function directionDone(
  direction: AuthoredDirection,
  journal: RuntimePromotionJournal,
  mutationCount: number,
): boolean {
  if (direction === 'commit') {
    return journal.progress.authoredCursor === mutationCount;
  }
  return journal.progress.rollbackCursor === journal.progress.authoredCursor;
}

function directionCursor(direction: AuthoredDirection, journal: RuntimePromotionJournal): number {
  if (direction === 'commit') return journal.progress.authoredCursor;
  return journal.progress.authoredCursor - journal.progress.rollbackCursor - 1;
}

function directionIntentKind(
  direction: AuthoredDirection,
): 'authored-target-commit' | 'authored-target-rollback' {
  return direction === 'commit' ? 'authored-target-commit' : 'authored-target-rollback';
}

function directionCompletedPhase(
  direction: AuthoredDirection,
): 'authored-committed' | 'authored-rolled-back' {
  return direction === 'commit' ? 'authored-committed' : 'authored-rolled-back';
}

function isFinalDirectionTarget(
  direction: AuthoredDirection,
  journal: RuntimePromotionJournal,
  mutationCount: number,
): boolean {
  if (direction === 'commit') {
    return journal.progress.authoredCursor + 1 === mutationCount;
  }
  return journal.progress.rollbackCursor + 1 === journal.progress.authoredCursor;
}

function postconditionPhase(
  direction: AuthoredDirection,
  journal: RuntimePromotionJournal,
  mutationCount: number,
): RuntimePromotionJournal['progress']['phase'] {
  return isFinalDirectionTarget(direction, journal, mutationCount)
    ? directionCompletedPhase(direction)
    : journal.progress.phase;
}

function verificationState(direction: AuthoredDirection): 'desired' | 'preimage' {
  return direction === 'commit' ? 'desired' : 'preimage';
}

function assertPreMutationState(
  state: AuthoredTransactionState,
  mutation: InitAuthoredMutation,
  direction: AuthoredDirection,
  journal: RuntimePromotionJournal,
): void {
  const expected = direction === 'commit' ? mutation.preimage : mutation.desired;
  const observed = observeAuthoredPath(transactionAuthoredRoot(state.root), mutation.path);
  if (sameAuthoredPathState(observed, expected)) return;
  const journalInstalledAuthoredParent =
    direction === 'commit' &&
    mutation.path === 'opensip-cli' &&
    mutation.action === 'create' &&
    mutation.targetType === 'directory' &&
    !mutation.preimage.exists &&
    mutation.desired.exists &&
    mutation.desired.type === 'directory' &&
    journal.route === 'promote-cache' &&
    !journal.destinationParentPreexisting &&
    journal.progress.phase === 'runtime-installed' &&
    journal.progress.runtimeInstallState === 'installed' &&
    journal.cleanup.destinationParent === 'pending' &&
    journal.manifests.runtimeStage !== null &&
    sameAuthoredPathState(observed, mutation.desired);
  if (!journalInstalledAuthoredParent) {
    authoredTransactionFailure('a target changed before its write-ahead intent');
  }
}

function assertMutationPostcondition(
  state: AuthoredTransactionState,
  mutation: InitAuthoredMutation,
  direction: AuthoredDirection,
): void {
  const expected = direction === 'commit' ? mutation.desired : mutation.preimage;
  const observed = observeAuthoredPath(transactionAuthoredRoot(state.root), mutation.path);
  if (!sameAuthoredPathState(observed, expected)) {
    authoredTransactionFailure('a target changed before its durable postcondition');
  }
}

async function executeAuthoredDirection(
  transaction: InitAuthoredTransaction,
  direction: AuthoredDirection,
): Promise<AuthoredStateTransitionResult> {
  const state = stateFor(transaction);
  state.controller.assertBoundLease(state.lease);
  let receipt = state.receipt as DurableOpenPromotionJournal;
  let journal = await state.controller.verifyOpen(receipt);
  const root = transactionAuthoredRoot(state.root);
  const manifest = manifestFor(state);
  validateAuthoredArtifacts(
    root,
    journal,
    manifest,
    manifestBytesFor(state),
    state.paths,
    authoredBlobAvailability(journal, state.executionOrder),
  );
  while (!directionDone(direction, journal, state.executionOrder.length)) {
    const cursor = directionCursor(direction, journal);
    const mutation = state.executionOrder[cursor];
    if (mutation === undefined) authoredTransactionFailure('the journal cursor is out of range');
    const expectedKind = directionIntentKind(direction);
    let pending = journal.progress.pendingIntent;
    if (pending === null) {
      assertPreMutationState(state, mutation, direction, journal);
      state.dependencies.checkpoint('before-target-intent', cursor);
      receipt = await recordOpenIntent(
        state.controller,
        receipt,
        expectedKind,
        'replayManifest',
        cursor,
        state.dependencies.now,
      );
      state.receipt = receipt;
      state.dependencies.checkpoint('after-target-intent', cursor);
      journal = await state.controller.verifyOpen(receipt);
      pending = journal.progress.pendingIntent;
    }
    if (pending?.kind !== expectedKind || pending.cursor !== cursor) {
      authoredTransactionFailure('the pending authored intent does not match its cursor');
    }
    state.dependencies.checkpoint('before-target-mutation', cursor);
    const outcome = reconcileAuthoredMutation(root, mutation, state.paths, direction, true);
    assertMutationPostcondition(state, mutation, direction);
    state.dependencies.checkpoint('after-target-mutation', cursor);
    assertMutationPostcondition(state, mutation, direction);
    state.dependencies.checkpoint('before-target-postcondition', cursor);
    assertMutationPostcondition(state, mutation, direction);
    receipt = await recordOpenPostcondition(
      state.controller,
      receipt,
      {
        phase: postconditionPhase(direction, journal, state.executionOrder.length),
        outcome,
        authoredDelta: direction === 'commit' ? 1 : 0,
        rollbackDelta: direction === 'rollback' ? 1 : 0,
      },
      state.dependencies.now,
    );
    state.receipt = receipt;
    assertMutationPostcondition(state, mutation, direction);
    state.dependencies.checkpoint('after-target-postcondition', cursor);
    assertMutationPostcondition(state, mutation, direction);
    journal = await state.controller.verifyOpen(receipt);
    assertMutationPostcondition(state, mutation, direction);
  }
  const completedPhase = directionCompletedPhase(direction);
  if (journal.progress.phase !== completedPhase) {
    receipt = await advanceAuthoredPhase(
      state.controller,
      receipt,
      completedPhase,
      state.dependencies.now,
    );
    state.receipt = receipt;
    journal = await state.controller.verifyOpen(receipt);
  }
  verifyEveryAuthoredTarget(root, manifest, verificationState(direction));
  return { receipt, summary: summaryFor(state, journal, true) };
}

export async function commitAuthoredState(
  transaction: InitAuthoredTransaction,
): Promise<AuthoredStateTransitionResult> {
  return executeAuthoredDirection(transaction, 'commit');
}

export async function rollbackAuthoredState(
  transaction: InitAuthoredTransaction,
): Promise<AuthoredStateTransitionResult> {
  const state = stateFor(transaction);
  state.dependencies.checkpoint('before-rollback');
  let receipt = state.receipt as DurableOpenPromotionJournal;
  let journal = await state.controller.verifyOpen(receipt);
  if (journal.progress.runtimeInstallState === 'installed') {
    authoredTransactionFailure('runtime authority must be rolled back before authored state');
  }
  if (journal.progress.direction === 'forward') {
    receipt = await beginAuthoredRollback(state.controller, receipt, state.dependencies.now);
    state.receipt = receipt;
    journal = await state.controller.verifyOpen(receipt);
  }
  if (journal.progress.direction !== 'rollback') {
    authoredTransactionFailure('the journal is not in rollback direction');
  }
  const result = await executeAuthoredDirection(transaction, 'rollback');
  state.dependencies.checkpoint('after-rollback');
  return result;
}

export async function verifyAuthoredState(
  transaction: InitAuthoredTransaction,
  expected: 'desired' | 'preimage' = 'desired',
): Promise<AuthoredStateSummary> {
  const state = stateFor(transaction);
  state.dependencies.checkpoint('before-verify');
  const journal = await state.controller.verifyReceipt(state.receipt);
  const root = transactionAuthoredRoot(state.root);
  const manifest = manifestFor(state);
  validateAuthoredArtifacts(
    root,
    journal,
    manifest,
    manifestBytesFor(state),
    state.paths,
    authoredBlobAvailability(journal, state.executionOrder),
  );
  verifyEveryAuthoredTarget(root, manifest, expected);
  state.dependencies.checkpoint('after-verify');
  assertStableAuthoredRoot(root);
  const finalJournal = await state.controller.verifyReceipt(state.receipt);
  validateAuthoredArtifacts(
    root,
    finalJournal,
    manifest,
    manifestBytesFor(state),
    state.paths,
    authoredBlobAvailability(finalJournal, state.executionOrder),
  );
  verifyEveryAuthoredTarget(root, manifest, expected);
  assertStableAuthoredRoot(root);
  return summaryFor(state, finalJournal, true);
}

export async function cleanupAuthoredState(
  transaction: InitAuthoredTransaction,
  closedReceipt: DurableClosedPromotionJournal,
): Promise<AuthoredStateCleanupResult> {
  const state = stateFor(transaction);
  state.controller.assertBoundLease(state.lease);
  const root = transactionAuthoredRoot(state.root);
  const checkpoint = (value: AuthoredStateCheckpoint): void => {
    assertStableAuthoredRoot(root);
    try {
      state.dependencies.checkpoint(value);
    } finally {
      assertStableAuthoredRoot(root);
    }
  };
  const withStableRoot = async <T>(action: () => Promise<T>): Promise<T> => {
    assertStableAuthoredRoot(root);
    try {
      return await action();
    } finally {
      assertStableAuthoredRoot(root);
    }
  };
  let receipt = closedReceipt;
  let journal = await withStableRoot(() =>
    state.controller.verifyReceipt(receipt, {
      state: 'closed',
    }),
  );
  if (journal.operationId !== transaction.operationId) {
    authoredTransactionFailure('the cleanup receipt belongs to another operation');
  }
  for (const slot of ['authoredStage', 'authoredBackup', 'replayManifest'] as const) {
    assertStableAuthoredRoot(root);
    if (journal.cleanup[slot] === 'removed' || journal.cleanup[slot] === 'unmaterialized') {
      assertAuthoredArtifactPathAbsent(root, state.paths, slot);
      finalizeAuthoredCleanupEvidence(root, journal, state.paths, slot, checkpoint);
      assertAuthoredArtifactAbsent(root, journal, state.paths, slot);
      continue;
    }
    const pending = journal.progress.pendingIntent;
    if (pending === null) {
      checkpoint('before-cleanup-intent');
      receipt = await withStableRoot(() =>
        recordCleanupIntent(state.controller, receipt, slot, state.dependencies.now),
      );
      checkpoint('after-cleanup-intent');
      journal = await withStableRoot(() =>
        state.controller.verifyReceipt(receipt, {
          state: 'closed',
        }),
      );
    } else if (pending.kind !== 'owned-slot-cleanup' || pending.slot !== slot) {
      authoredTransactionFailure('another cleanup intent is unresolved');
    }
    checkpoint('before-cleanup-mutation');
    const manifest =
      slot === 'replayManifest' && state.manifest === null ? null : manifestFor(state);
    const outcome = removeAuthoredArtifact(root, journal, manifest, state.paths, slot, checkpoint);
    assertAuthoredArtifactPathAbsent(root, state.paths, slot);
    checkpoint('after-cleanup-mutation');
    assertAuthoredArtifactPathAbsent(root, state.paths, slot);
    checkpoint('before-cleanup-postcondition');
    assertAuthoredArtifactPathAbsent(root, state.paths, slot);
    receipt = await withStableRoot(() =>
      recordCleanupPostcondition(
        state.controller,
        receipt,
        outcome === 'absent' ? 'already-satisfied' : 'applied',
        state.dependencies.now,
      ),
    );
    assertAuthoredArtifactPathAbsent(root, state.paths, slot);
    checkpoint('after-cleanup-postcondition');
    assertAuthoredArtifactPathAbsent(root, state.paths, slot);
    journal = await withStableRoot(() =>
      state.controller.verifyReceipt(receipt, {
        state: 'closed',
      }),
    );
    assertAuthoredArtifactPathAbsent(root, state.paths, slot);
    finalizeAuthoredCleanupEvidence(root, journal, state.paths, slot, checkpoint);
    assertAuthoredArtifactAbsent(root, journal, state.paths, slot);
  }
  assertStableAuthoredRoot(root);
  return { receipt, summary: summaryFor(state, journal, true) };
}

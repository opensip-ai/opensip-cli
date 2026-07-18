import { lstatSync } from 'node:fs';

import {
  publishAuthoredReplayManifest,
  settleAuthoredReplayPublication,
} from './authored-state-replay-publication.js';
import { resetIncompleteAuthoredArtifacts } from './authored-state-transaction-artifact-recovery.js';
import {
  authoredArtifactPaths,
  loadAuthoredReplayManifest,
  validateAuthoredArtifacts,
} from './authored-state-transaction-artifacts.js';
import {
  authoredBlobAvailability,
  authoredExecutionOrder,
  executionIndex,
} from './authored-state-transaction-execution.js';
import {
  authoredTransactionFailure,
  openStableAuthoredRoot,
} from './authored-state-transaction-fs.js';
import { recordOpenIntent, recordOpenPostcondition } from './authored-state-transaction-journal.js';
import { materializeAuthoredBlobRoots } from './authored-state-transaction-materialization.js';
import {
  authoredDependencies,
  issueTransaction,
  stateFor,
  summaryFor,
} from './authored-state-transaction-registry.js';

import type {
  AuthoredTransactionState,
  InitAuthoredTransaction,
  LoadAuthoredStateInput,
  LoadClosedAuthoredStateInput,
  PrepareAuthoredStateInput,
  PreparedAuthoredState,
} from './authored-state-transaction-types.js';
import type { InitAuthoredPlan } from './init-authored-plan.js';
import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';
import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
} from './runtime-promotion-journal.js';

function assertPlanMatchesJournal(plan: InitAuthoredPlan, journal: RuntimePromotionJournal): void {
  if (
    plan.digest !== journal.plan.authoredDigest ||
    plan.replayManifestDigest !== journal.plan.replayDigest ||
    plan.mutations.length !== journal.plan.mutationCount ||
    plan.replayManifestBytes !== JSON.stringify(plan.replayManifest)
  ) {
    authoredTransactionFailure('the in-memory authored plan does not match the durable journal');
  }
}

function artifactPresence(paths: AuthoredTransactionState['paths']): readonly boolean[] {
  return [paths.stageRoot, paths.backupRoot, paths.replayManifest].map((path) => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  });
}

function buildState(
  input: LoadAuthoredStateInput | LoadClosedAuthoredStateInput,
  receipt: DurableOpenPromotionJournal | DurableClosedPromotionJournal,
  journal: RuntimePromotionJournal,
): AuthoredTransactionState {
  const root = openStableAuthoredRoot(input.projectRoot);
  const paths = authoredArtifactPaths(root, journal);
  settleAuthoredReplayPublication(root, journal, paths);
  const presence = artifactPresence(paths);
  const replayCleanupPending =
    journal.state === 'closed' &&
    journal.progress.pendingIntent?.kind === 'owned-slot-cleanup' &&
    journal.progress.pendingIntent.slot === 'replayManifest';
  const cleanupOnlyWithoutReplay =
    journal.state === 'closed' &&
    !presence[2] &&
    journal.cleanup.authoredStage === 'removed' &&
    journal.cleanup.authoredBackup === 'removed' &&
    (journal.cleanup.replayManifest === 'removed' || replayCleanupPending);
  if (cleanupOnlyWithoutReplay) {
    return {
      projectRoot: root.path,
      lease: input.lease,
      controller: input.controller,
      manifest: null,
      manifestBytes: null,
      executionOrder: [],
      executionIndexBySequence: new Map(),
      mutationCount: journal.plan.mutationCount,
      paths,
      dependencies: authoredDependencies(input.dependencies),
      receipt,
    };
  }
  const replay = loadAuthoredReplayManifest(root, journal, paths);
  const order = authoredExecutionOrder(replay.manifest);
  validateAuthoredArtifacts(
    root,
    journal,
    replay.manifest,
    replay.bytes,
    paths,
    authoredBlobAvailability(journal, order),
  );
  return {
    projectRoot: root.path,
    lease: input.lease,
    controller: input.controller,
    manifest: replay.manifest,
    manifestBytes: replay.bytes,
    executionOrder: order,
    executionIndexBySequence: executionIndex(order),
    mutationCount: journal.plan.mutationCount,
    paths,
    dependencies: authoredDependencies(input.dependencies),
    receipt,
  };
}

function freshState(
  input: PrepareAuthoredStateInput,
  receipt: DurableOpenPromotionJournal,
  journal: RuntimePromotionJournal,
): AuthoredTransactionState {
  const root = openStableAuthoredRoot(input.projectRoot);
  const paths = authoredArtifactPaths(root, journal);
  const order = authoredExecutionOrder(input.plan.replayManifest);
  return {
    projectRoot: root.path,
    lease: input.lease,
    controller: input.controller,
    manifest: input.plan.replayManifest,
    manifestBytes: input.plan.replayManifestBytes,
    executionOrder: order,
    executionIndexBySequence: executionIndex(order),
    mutationCount: journal.plan.mutationCount,
    paths,
    dependencies: authoredDependencies(input.dependencies),
    receipt,
  };
}

async function finishPrepare(
  state: AuthoredTransactionState,
  plan: InitAuthoredPlan,
): Promise<DurableOpenPromotionJournal> {
  const receipt = state.receipt as DurableOpenPromotionJournal;
  const current = await state.controller.verifyOpen(receipt);
  const root = openStableAuthoredRoot(state.projectRoot);
  const authority = await state.controller.authorizeAuthoredState(receipt, state.lease);
  state.controller.assertAuthoredStateAuthority(authority, {
    authoredStage: current.owned.authoredStage.basename,
    authoredBackup: current.owned.authoredBackup.basename,
    replayManifest: current.owned.replayManifest.basename,
  });
  state.dependencies.checkpoint('before-manifest-materialization');
  const manifest = state.manifest;
  const manifestBytes = state.manifestBytes;
  if (manifest === null || manifestBytes === null) {
    authoredTransactionFailure('fresh preparation requires its exact replay manifest');
  }
  const replayOutcome = publishAuthoredReplayManifest(
    root,
    current,
    state.paths,
    plan.replayManifestBytes,
  );
  state.dependencies.checkpoint('after-replay-materialization');
  let outcome: 'applied' | 'already-satisfied';
  const [stagePresent, backupPresent] = artifactPresence(state.paths);
  if (stagePresent || backupPresent) {
    try {
      validateAuthoredArtifacts(root, current, manifest, manifestBytes, state.paths, {
        desiredConsumed: new Set(),
        preimageConsumed: new Set(),
      });
      outcome = replayOutcome;
    } catch {
      resetIncompleteAuthoredArtifacts(root, current, manifest, manifestBytes, state.paths);
      publishAuthoredReplayManifest(root, current, state.paths, plan.replayManifestBytes);
      state.dependencies.checkpoint('after-replay-materialization');
      materializeAuthoredBlobRoots(root, current, plan, state.paths, state.dependencies.checkpoint);
      outcome = 'applied';
    }
  } else {
    materializeAuthoredBlobRoots(root, current, plan, state.paths, state.dependencies.checkpoint);
    outcome = 'applied';
  }
  validateAuthoredArtifacts(root, current, manifest, manifestBytes, state.paths, {
    desiredConsumed: new Set(),
    preimageConsumed: new Set(),
  });
  state.dependencies.checkpoint('after-manifest-materialization');
  state.dependencies.checkpoint('before-prepare-postcondition');
  const next = await recordOpenPostcondition(
    state.controller,
    receipt,
    { phase: 'authored-prepared', outcome, prepareArtifacts: true },
    state.dependencies.now,
  );
  state.receipt = next;
  state.dependencies.checkpoint('after-prepare-postcondition');
  return next;
}

export async function prepareAuthoredState(
  input: PrepareAuthoredStateInput,
): Promise<PreparedAuthoredState> {
  input.controller.assertBoundLease(input.lease);
  let journal = await input.controller.verifyOpen(input.receipt);
  assertPlanMatchesJournal(input.plan, journal);
  if (journal.progress.pendingIntent === null && journal.progress.phase === 'authored-prepared') {
    const state = buildState(input, input.receipt, journal);
    return {
      transaction: issueTransaction(state),
      receipt: input.receipt,
      summary: summaryFor(state, journal, false),
    };
  }
  let receipt = input.receipt;
  if (journal.progress.pendingIntent === null) {
    if (
      journal.progress.direction !== 'forward' ||
      !['prepared', 'destination-verified'].includes(journal.progress.phase)
    ) {
      authoredTransactionFailure('the journal is not ready for authored preparation');
    }
    const localDependencies = authoredDependencies(input.dependencies);
    localDependencies.checkpoint('before-prepare-intent');
    receipt = await recordOpenIntent(
      input.controller,
      receipt,
      'authored-prepare',
      'authoredStage',
      null,
      localDependencies.now,
    );
    localDependencies.checkpoint('after-prepare-intent');
    journal = await input.controller.verifyOpen(receipt);
  } else if (journal.progress.pendingIntent.kind !== 'authored-prepare') {
    authoredTransactionFailure('another promotion intent is unresolved');
  }
  const state = freshState(input, receipt, journal);
  receipt = await finishPrepare(state, input.plan);
  journal = await input.controller.verifyOpen(receipt);
  return {
    transaction: issueTransaction(state),
    receipt,
    summary: summaryFor(state, journal, false),
  };
}

export async function loadAuthoredState(
  input: LoadAuthoredStateInput,
): Promise<PreparedAuthoredState> {
  input.controller.assertBoundLease(input.lease);
  const journal = await input.controller.verifyOpen(input.receipt);
  if (
    journal.progress.pendingIntent?.kind === 'authored-prepare' ||
    journal.cleanup.replayManifest !== 'pending'
  ) {
    authoredTransactionFailure('the authored replay state is not durably prepared');
  }
  const state = buildState(input, input.receipt, journal);
  return {
    transaction: issueTransaction(state),
    receipt: input.receipt,
    summary: summaryFor(state, journal, false),
  };
}

export async function loadClosedAuthoredState(
  input: LoadClosedAuthoredStateInput,
): Promise<InitAuthoredTransaction> {
  input.controller.assertBoundLease(input.lease);
  const journal = await input.controller.verifyReceipt(input.receipt, {
    state: 'closed',
  });
  return issueTransaction(buildState(input, input.receipt, journal));
}

export async function bindAuthoredStateReceipt(
  transaction: InitAuthoredTransaction,
  receipt: DurableOpenPromotionJournal,
): Promise<void> {
  const state = stateFor(transaction);
  state.controller.assertBoundLease(state.lease);
  const journal = await state.controller.verifyOpen(receipt);
  if (journal.operationId !== transaction.operationId) {
    authoredTransactionFailure('the replacement receipt belongs to another operation');
  }
  state.receipt = receipt;
}

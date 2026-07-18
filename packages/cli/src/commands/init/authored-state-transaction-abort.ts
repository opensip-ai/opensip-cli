import { settleAuthoredReplayPublication } from "./authored-state-replay-publication.js";
import {
  discardIncompleteAuthoredArtifacts,
  validateIncompleteAuthoredArtifacts,
} from "./authored-state-transaction-artifact-recovery.js";
import {
  authoredArtifactPaths,
  loadAuthoredReplayManifest,
} from "./authored-state-transaction-artifacts.js";
import {
  authoredExecutionOrder,
  executionIndex,
  verifyEveryAuthoredTarget,
} from "./authored-state-transaction-execution.js";
import {
  authoredTransactionFailure,
  openStableAuthoredRoot,
} from "./authored-state-transaction-fs.js";
import {
  advanceAuthoredPhase,
  beginAuthoredRollback,
  recordOpenPostcondition,
} from "./authored-state-transaction-journal.js";
import {
  authoredDependencies,
  issueTransaction,
  summaryFor,
} from "./authored-state-transaction-registry.js";

import type {
  AbortPendingAuthoredPreparationInput,
  AuthoredTransactionState,
  PreparedAuthoredState,
} from "./authored-state-transaction-types.js";
import type { AuthoredReplayManifest } from "./init-authored-plan.js";
import type { RuntimePromotionJournal } from "./runtime-promotion-journal-schema.js";
import type { DurableOpenPromotionJournal } from "./runtime-promotion-journal.js";

function assertZeroAuthoredProgress(journal: RuntimePromotionJournal): void {
  if (
    journal.progress.authoredCursor !== 0 ||
    journal.progress.rollbackCursor !== 0 ||
    journal.counts.authoredCompleted !== 0 ||
    journal.counts.authoredRolledBack !== 0 ||
    journal.progress.runtimeInstallState === "installed"
  ) {
    authoredTransactionFailure(
      "authored preparation can no longer be aborted safely",
    );
  }
}

function storedReplay(
  projectRoot: string,
  journal: RuntimePromotionJournal,
): {
  readonly root: ReturnType<typeof openStableAuthoredRoot>;
  readonly paths: ReturnType<typeof authoredArtifactPaths>;
  readonly manifest: AuthoredReplayManifest | null;
  readonly bytes: string | null;
} {
  const root = openStableAuthoredRoot(projectRoot);
  const paths = authoredArtifactPaths(root, journal);
  const replayState = settleAuthoredReplayPublication(root, journal, paths);
  if (replayState.status === "absent") {
    return { root, paths, manifest: null, bytes: null };
  }
  const replay = loadAuthoredReplayManifest(root, journal, paths);
  return { root, paths, manifest: replay.manifest, bytes: replay.bytes };
}

function abortState(
  input: AbortPendingAuthoredPreparationInput,
  receipt: DurableOpenPromotionJournal,
  journal: RuntimePromotionJournal,
  replay: ReturnType<typeof storedReplay>,
): AuthoredTransactionState {
  const order =
    replay.manifest === null ? [] : authoredExecutionOrder(replay.manifest);
  return {
    projectRoot: replay.root.path,
    lease: input.lease,
    controller: input.controller,
    manifest: replay.manifest,
    manifestBytes: replay.bytes,
    executionOrder: order,
    executionIndexBySequence: executionIndex(order),
    mutationCount: journal.plan.mutationCount,
    paths: replay.paths,
    dependencies: authoredDependencies(input.dependencies),
    receipt,
  };
}

function isAbortedPreparation(journal: RuntimePromotionJournal): boolean {
  return (
    journal.progress.pendingIntent === null &&
    journal.progress.lastPostcondition?.kind === "authored-prepare" &&
    journal.progress.lastPostcondition.outcome === "aborted"
  );
}

export async function abortPendingAuthoredPreparation(
  input: AbortPendingAuthoredPreparationInput,
): Promise<PreparedAuthoredState> {
  input.controller.assertBoundLease(input.lease);
  let receipt = input.receipt;
  let journal = await input.controller.verifyOpen(receipt);
  assertZeroAuthoredProgress(journal);
  const replay = storedReplay(input.projectRoot, journal);
  const state = abortState(input, receipt, journal, replay);
  const pendingPrepare =
    journal.progress.pendingIntent?.kind === "authored-prepare";
  if (pendingPrepare) {
    validateIncompleteAuthoredArtifacts(
      replay.root,
      journal,
      replay.manifest,
      replay.bytes,
      replay.paths,
    );
    state.dependencies.checkpoint("before-abort-cleanup");
    discardIncompleteAuthoredArtifacts(
      replay.root,
      journal,
      replay.manifest,
      replay.bytes,
      replay.paths,
    );
    state.dependencies.checkpoint("after-abort-cleanup");
    state.dependencies.checkpoint("before-abort-postcondition");
    receipt = await recordOpenPostcondition(
      input.controller,
      receipt,
      {
        phase: journal.progress.phase,
        outcome: "aborted",
      },
      state.dependencies.now,
    );
    state.receipt = receipt;
    state.dependencies.checkpoint("after-abort-postcondition");
    journal = await input.controller.verifyOpen(receipt);
  } else if (
    !isAbortedPreparation(journal) &&
    journal.progress.direction === "forward"
  ) {
    authoredTransactionFailure(
      "the journal has no abortable authored preparation",
    );
  }
  if (journal.progress.direction === "forward") {
    receipt = await beginAuthoredRollback(
      input.controller,
      receipt,
      state.dependencies.now,
    );
    state.receipt = receipt;
    journal = await input.controller.verifyOpen(receipt);
  }
  if (
    journal.progress.direction !== "rollback" ||
    !["rollback-started", "authored-rolled-back"].includes(
      journal.progress.phase,
    )
  ) {
    authoredTransactionFailure(
      "the aborted authored preparation has invalid rollback state",
    );
  }
  if (replay.manifest !== null) {
    verifyEveryAuthoredTarget(replay.root, replay.manifest, "preimage");
  }
  if (journal.progress.phase === "rollback-started") {
    receipt = await advanceAuthoredPhase(
      input.controller,
      receipt,
      "authored-rolled-back",
      state.dependencies.now,
    );
    state.receipt = receipt;
    journal = await input.controller.verifyOpen(receipt);
  }
  return {
    transaction: issueTransaction(state),
    receipt,
    summary: summaryFor(state, journal, true),
  };
}

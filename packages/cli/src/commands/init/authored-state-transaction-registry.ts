import { summarizeAuthoredState } from "./authored-state-transaction-execution.js";
import { authoredTransactionFailure } from "./authored-state-transaction-fs.js";

import type {
  AuthoredStateSummary,
  AuthoredStateTransactionDependencies,
  AuthoredTransactionState,
  InitAuthoredTransaction,
} from "./authored-state-transaction-types.js";
import type { AuthoredReplayManifest } from "./init-authored-plan.js";
import type { RuntimePromotionJournal } from "./runtime-promotion-journal-schema.js";

const TRANSACTIONS = new WeakMap<
  InitAuthoredTransaction,
  AuthoredTransactionState
>();

function ignoreCheckpoint(): void {
  // The production default deliberately has no observation side effect.
}

export function authoredDependencies(
  value: AuthoredStateTransactionDependencies | undefined,
): Required<AuthoredStateTransactionDependencies> {
  return {
    now: value?.now ?? Date.now,
    checkpoint: value?.checkpoint ?? ignoreCheckpoint,
  };
}

export function stateFor(
  transaction: InitAuthoredTransaction,
): AuthoredTransactionState {
  const state = TRANSACTIONS.get(transaction);
  if (state === undefined)
    authoredTransactionFailure("the transaction handle is stale or foreign");
  return state;
}

export function manifestFor(
  state: AuthoredTransactionState,
): AuthoredReplayManifest {
  if (state.manifest === null || state.manifestBytes === null) {
    authoredTransactionFailure(
      "the replay manifest was already durably cleaned",
    );
  }
  return state.manifest;
}

export function manifestBytesFor(state: AuthoredTransactionState): string {
  manifestFor(state);
  const bytes = state.manifestBytes;
  if (bytes === null) {
    authoredTransactionFailure(
      "the replay manifest was already durably cleaned",
    );
  }
  return bytes;
}

export function summaryFor(
  state: AuthoredTransactionState,
  journal: RuntimePromotionJournal,
  verified: boolean,
): AuthoredStateSummary {
  if (state.manifest !== null) {
    return summarizeAuthoredState(state.manifest, journal, verified);
  }
  return {
    total: journal.plan.mutationCount,
    created: 0,
    replaced: 0,
    deleted: 0,
    preserved: 0,
    completed: journal.progress.authoredCursor,
    rolledBack: journal.progress.rollbackCursor,
    verified,
    actionsKnown: false,
  };
}

export function issueTransaction(
  state: AuthoredTransactionState,
): InitAuthoredTransaction {
  const transaction = Object.freeze({
    operationId: state.receipt.operationId,
    mutationCount: state.mutationCount,
  }) as InitAuthoredTransaction;
  TRANSACTIONS.set(transaction, state);
  return transaction;
}

/**
 * Replayable transaction for Init-owned project files.
 *
 * Fresh planning is accepted only while its digest matches the journal-first
 * barrier. Recovery loads the canonical replay manifest and blobs from the
 * journal-owned artifacts; it never invokes a renderer or current default.
 */

export {
  bindAuthoredStateReceipt,
  loadAuthoredState,
  loadClosedAuthoredState,
  prepareAuthoredState,
} from './authored-state-transaction-prepare.js';
export { abortPendingAuthoredPreparation } from './authored-state-transaction-abort.js';
export {
  cleanupAuthoredState,
  commitAuthoredState,
  rollbackAuthoredState,
  verifyAuthoredState,
} from './authored-state-transaction-runner.js';
export type {
  AuthoredStateCheckpoint,
  AbortPendingAuthoredPreparationInput,
  AuthoredStateCleanupResult,
  AuthoredStateSummary,
  AuthoredStateTransactionDependencies,
  AuthoredStateTransitionResult,
  InitAuthoredTransaction,
  LoadAuthoredStateInput,
  LoadClosedAuthoredStateInput,
  PrepareAuthoredStateInput,
  PreparedAuthoredState,
} from './authored-state-transaction-types.js';

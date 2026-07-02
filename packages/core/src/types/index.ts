export type {
  Signal,
  SignalSeverity,
  SignalCategory,
  CreateSignalInput,
  FixHint,
  SignalRepair,
  SignalRepairAction,
  SignalRepairActionTarget,
  SignalRepairVerification,
} from './signal.js';
export { createSignal } from './signal.js';
export type {
  SignalBatch,
  RepoIdentity,
  BuildSignalBatchInput,
  SignalBatchAttestationStatus,
  SignalBatchAuthorityTier,
  SignalBatchEvidence,
} from './signal-batch.js';
export {
  buildSignalBatch,
  MAX_SIGNALS_PER_BATCH,
  SIGNAL_BATCH_DIVERGENCE_CONTRACT_VERSION,
  SIGNAL_BATCH_EVIDENCE_CONTRACT_VERSION,
} from './signal-batch.js';

// Types — internal signal (shared across tools)
export type {
  Signal,
  SignalSeverity,
  SignalCategory,
  CreateSignalInput,
  FixHint,
} from './types/signal.js';
export { createSignal, isErrorSeverity, isErrorSignal } from './types/signal.js';

// Severity & Signal policy (north-star §5.9, launch). One home for
// author→wire severity mapping + the override clamp + the gate's error/warning
// predicate, plus the generic identity-stamping factory `createSignalFromViolation`
// (so tools stamp source/ruleId/severity instead of retyping them).
export { SeverityPolicy } from './lib/severity-policy.js';
export type { AuthorSeverity } from './lib/severity-policy.js';
// Host-owned findings verdict policy (ADR-0035): the reserved
// failOnErrors/failOnWarnings gate, its pure predicate, and the per-tool resolver.
export {
  HOST_VERDICT_POLICY_FALLBACK,
  policyPasses,
  resolveVerdictPolicy,
  DEFAULT_FAIL_ON_DEGRADED,
  resolveFailOnDegraded,
} from './lib/verdict-policy.js';
export type { VerdictPolicy } from './lib/verdict-policy.js';
// Host-owned baseline/ratchet plane (ADR-0036): the per-tool fingerprint
// strategy primitive, the host default identity, and the stamp helper.
export {
  contentHashFallbackFingerprintStrategy,
  defaultFingerprintStrategy,
  defineFingerprintStrategy,
  fileLevelFingerprintStrategy,
  stampFingerprints,
} from './baseline/fingerprint-strategy.js';
export type {
  DefineFingerprintStrategyInput,
  FingerprintStrategy,
  FingerprintStrategyDescriptor,
} from './baseline/fingerprint-strategy.js';
export {
  BASELINE_FORMAT_VERSION,
  formatBaselineIdentityMismatch,
  isBaselineIdentityCompatible,
  toBaselineIdentityMetadata,
} from './baseline/baseline-identity.js';
export type { BaselineIdentity, BaselineIdentityMetadata } from './baseline/baseline-identity.js';
export { createSignalFromViolation } from './signals/create-signal-from-violation.js';
export type { ViolationInput } from './signals/create-signal-from-violation.js';
// Cloud signal egress envelope (ADR-0008)
export type { SignalBatch, RepoIdentity, BuildSignalBatchInput } from './types/signal-batch.js';
export { buildSignalBatch, MAX_SIGNALS_PER_BATCH } from './types/signal-batch.js';
// Cloud signal sink seam (ADR-0008)
export type { SignalSink, EmitResult } from './signals/signal-sink.js';
export { noopSignalSink } from './signals/signal-sink.js';
// Inline suppression primitive (ADR-0014) — shared `@x-ignore-*` machinery
export { filterSignalsBySuppressions, scanSuppressionDirectives } from './signals/suppress.js';
export type {
  SuppressionKeywords,
  SuppressionLocation,
  SuppressionRequest,
  SuppressionMatch,
  SuppressionResult,
  SuppressionScan,
} from './signals/suppress.js';
export { COMMENT_OPENERS, stripCommentOpener } from './signals/comment-openers.js';

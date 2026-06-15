/**
 * @opensip-cli/output — the tool-run output layer.
 *
 * Renamed from `@opensip-cli/reporting` (Phase 2, ADR-0011): the package no
 * longer just reports to cloud — it owns all machine formatting + delivery.
 * It depends on core + contracts only.
 */

// --- format/ — pure (envelope) => string formatters (no IO) ---
export type { Formatter } from './format/types.js';
export { formatSignalJson } from './format/signal-json.js';
export { formatSignalSarif, buildOpenSipSarif, type SarifDriver } from './format/signal-sarif.js';
// Pure baseline diff — the generic net-new ratchet (ADR-0036).
export { diffBaseline } from './format/baseline-diff.js';
export type { GateCompareResult, BaselineDiffRow } from './format/baseline-diff.js';
export {
  formatSignalTableRows,
  formatSignalTableSummary,
  type SignalTableRow,
  type SignalTableSummary,
} from './format/signal-table.js';

// --- sink/ — effectful delivery (file/cloud egress) ---
export {
  checkEntitlement,
  invalidateEntitlement,
  type EntitlementResult,
  type EntitlementSource,
  type CheckEntitlementInput,
} from './sink/entitlement.js';
export { createCloudSignalSink, type CloudSignalSinkOptions } from './sink/cloud-signal-sink.js';
export {
  postChunked,
  type EgressResult,
  type RetryPolicy,
  type PostChunkedArgs,
} from './sink/http-egress.js';
export {
  resolveSignalSink,
  DEFAULT_CLOUD_ENDPOINT,
  type ResolveSignalSinkInput,
} from './sink/resolve-signal-sink.js';
export { resolveRepoIdentity } from './sink/repo-identity.js';

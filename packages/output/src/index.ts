/**
 * @opensip-tools/output — the tool-run output layer.
 *
 * Renamed from `@opensip-tools/reporting` (Phase 2, ADR-0011): the package no
 * longer just reports to cloud — it owns all machine formatting + delivery.
 * It depends on core + contracts only.
 */

// --- format/ — pure (envelope) => string formatters (no IO) ---
export type { Formatter } from './format/types.js';
export { formatSignalJson } from './format/signal-json.js';
export { formatSignalSarif, buildOpenSipSarif, type SarifDriver } from './format/signal-sarif.js';

// --- legacy CliOutput-based SARIF (transitional; retired in Phase 7) ---
export { buildSarifLog, chunkSarifRuns, reportToCloud, type ReportResult } from './sarif.js';
export type { SarifResult, SarifLocation } from './sarif-types.js';

// --- sink/ — effectful delivery (file/cloud egress) ---
export { collectSignalBatch, type CollectSignalBatchInput } from './sink/collect-batch.js';
export {
  checkEntitlement,
  invalidateEntitlement,
  type EntitlementResult,
  type EntitlementSource,
  type CheckEntitlementInput,
} from './sink/entitlement.js';
export { createCloudSignalSink, type CloudSignalSinkOptions } from './sink/cloud-signal-sink.js';
export { postChunked, type EgressResult, type RetryPolicy, type PostChunkedArgs } from './sink/http-egress.js';
export {
  resolveSignalSink,
  DEFAULT_CLOUD_ENDPOINT,
  type ResolveSignalSinkInput,
} from './sink/resolve-signal-sink.js';
export {
  emitRunSignals,
  resolveRepoIdentity,
  type EmitRunSignalsInput,
} from './sink/emit-run-signals.js';

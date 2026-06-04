/**
 * @opensip-tools/output — the tool-run output layer.
 *
 * Renamed from `@opensip-tools/reporting` (Phase 2, ADR-0011): the package no
 * longer just reports to cloud — it owns all machine formatting + delivery.
 * It depends on core + contracts only.
 */

export { buildSarifLog, chunkSarifRuns, reportToCloud, type ReportResult } from './sarif.js';
export type { SarifResult, SarifLocation } from './sarif-types.js';
export { collectSignalBatch, type CollectSignalBatchInput } from './collect-batch.js';
export {
  checkEntitlement,
  invalidateEntitlement,
  type EntitlementResult,
  type EntitlementSource,
  type CheckEntitlementInput,
} from './entitlement.js';
export { createCloudSignalSink, type CloudSignalSinkOptions } from './cloud-signal-sink.js';
export { postChunked, type EgressResult, type RetryPolicy, type PostChunkedArgs } from './http-egress.js';
export {
  resolveSignalSink,
  DEFAULT_CLOUD_ENDPOINT,
  type ResolveSignalSinkInput,
} from './resolve-signal-sink.js';
export {
  emitRunSignals,
  resolveRepoIdentity,
  type EmitRunSignalsInput,
} from './emit-run-signals.js';

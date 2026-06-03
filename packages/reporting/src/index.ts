/**
 * @opensip-tools/reporting — SARIF report generation + cloud upload.
 *
 * Pure data-in/JSON-out plus one network call (`reportToCloud`). Consumes
 * the `CliOutput` type from @opensip-tools/contracts. Extracted from
 * contracts so that package carries types only (audit 2026-05-29,
 * contracts split).
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

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

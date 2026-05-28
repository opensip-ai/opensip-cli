/**
 * @fileoverview SARIF renderer entry point.
 *
 * Phase 2 Task 2.2 (DEC-498): replaced the prior `@opensip-tools/fitness`
 * `buildSarifLog` wrapper with a graph-native emitter. Re-exports
 * `renderSarifOpenSip` as `renderSarif` so existing import paths keep
 * working. The fitness package's `buildSarifLog` is no longer a graph
 * dependency; `reportToCloud` is imported directly from
 * `@opensip-tools/fitness` at its consumption site (`cli/graph.ts`).
 */

export { renderSarifOpenSip as renderSarif } from './sarif-opensip.js';

// @fitness-ignore-file batch-operation-limits -- bounded synchronous union over the active rule set + caller columns (no async, no unbounded data load); the heuristic mis-reads the nested synchronous for...of as an async/unbounded batch.
/**
 * Per-run feature dependency union.
 *
 * The features stage computes the UNION of every enabled rule's declared
 * `featureDeps` plus the caller's `emitFeatures` (the dashboard columns on a
 * dashboard-bound run) — lazy/needed-only, nothing more. Pure; no module
 * state (the dependency set is recomputed per run from the active rule set).
 * Shared by both orchestrators (single-program `runGraph` + sharded build) so
 * the union is computed by one function, not two copies.
 */

import type { FeatureColumn, Rule } from '../types.js';

/**
 * De-duplicated union of every rule's `featureDeps` and the caller's `extra`
 * (e.g. `RunGraphInput.emitFeatures`). Empty when no rule declares deps and
 * `extra` is absent/empty ⇒ the features stage computes nothing and persists
 * no blob.
 */
export function unionFeatureDeps(
  rules: readonly Rule[],
  extra: readonly FeatureColumn[] | undefined,
): readonly FeatureColumn[] {
  const set = new Set<FeatureColumn>();
  for (const rule of rules) {
    for (const col of rule.featureDeps ?? []) set.add(col);
  }
  for (const col of extra ?? []) set.add(col);
  return [...set];
}

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Per-baseline-row Signal fingerprint store.
 *
 * v1 stored a single JSON file with a sorted `fingerprints: string[]`
 * field; v2 promotes each fingerprint to its own row keyed by
 * fingerprint string. Save replaces the entire set in one transaction
 * (DELETE + bulk INSERT), preserving v1's atomic-replace semantic.
 */
export const graphBaselineSignals = sqliteTable('graph_baseline_signals', {
  fingerprint: text('fingerprint').primaryKey(),
  capturedAt: integer('captured_at').notNull(),
});

/**
 * Baseline existence marker. v1's "the file exists" predicate becomes
 * "row 1 exists in this table" — separate from the fingerprint set so
 * an empty-but-saved baseline (legitimate, e.g. a clean codebase)
 * still reports `exists() === true`.
 */
export const graphBaselineMeta = sqliteTable('graph_baseline_meta', {
  id: integer('id').primaryKey(),
  capturedAt: integer('captured_at').notNull(),
});

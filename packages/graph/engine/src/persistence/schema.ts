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

/**
 * Catalog single-row store (id = 1).
 *
 * v1 stored the full Catalog object as a streamed JSON file at
 * `paths.graphCatalogPath`. v2 stores it as one row whose `payload`
 * column holds the same JSON, with the metadata fields (language,
 * cache_key, files_fingerprint, built_at) lifted out for cheap
 * fingerprint-mismatch checks without parsing the full payload.
 *
 * The catalog payload remains a single document at parity. The
 * follow-up `graph-catalog-perf` plan normalizes this into per-
 * function / per-occurrence / per-edge tables and pushes view
 * derivations down into SQL.
 */
export const graphCatalog = sqliteTable('graph_catalog', {
  id: integer('id').primaryKey(),
  language: text('language').notNull(),
  cacheKey: text('cache_key').notNull(),
  filesFingerprint: text('files_fingerprint').notNull(),
  builtAt: text('built_at').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
});

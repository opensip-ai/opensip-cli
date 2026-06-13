import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Generic host-owned baseline entries (ADR-0036). ONE table pair replaces the
 * per-tool baseline tables (`graph_baseline_signals`, `fit_baseline`, …): each
 * row is one finding's fingerprint + its full `Signal` payload, scoped by the
 * `tool` column so tools share the table but never see each other's rows.
 *
 * The composite primary key `(tool, fingerprint)` makes save a per-tool
 * delete-all + bulk-insert (atomic replace), and the `payload` column supplies
 * the full-object `resolved` diff bucket AND the SARIF re-render
 * (synthetic envelope → `formatSignalSarif`).
 */
export const toolBaselineEntries = sqliteTable(
  'tool_baseline_entries',
  {
    tool: text('tool').notNull(), // human `name` value (for compat + current queries)
    stableId: text('stable_id'), // tool stable UUID (additive per ADR-0048; null for legacy rows)
    fingerprint: text('fingerprint').notNull(),
    payload: text('payload', { mode: 'json' }), // the Signal as JSON
    capturedAt: integer('captured_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tool, t.fingerprint] })],
);

/**
 * Per-tool baseline existence marker + capture timestamp (ADR-0036). Keyed by
 * `tool`, separate from the entries so an empty-but-saved baseline (a clean
 * codebase) still reports `exists() === true` — distinguishing "saved, no
 * findings" from "never saved". `capturedAt` feeds the JSON export's timestamp.
 */
export const toolBaselineMeta = sqliteTable('tool_baseline_meta', {
  tool: text('tool').primaryKey(), // human `name` value (for compat)
  stableId: text('stable_id'), // tool stable UUID (additive)
  capturedAt: integer('captured_at').notNull(),
});

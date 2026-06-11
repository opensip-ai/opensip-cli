import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Single-row baseline store. v1 wrote a SARIF JSON file at
 * `<runtime>/baseline.sarif`; v2 stores the run's `SignalEnvelope` as a
 * single row in this table (id constrained to 1). Save overwrites the row;
 * load reads it; exists() probes for its presence.
 */
export const fitBaseline = sqliteTable('fit_baseline', {
  id: integer('id').primaryKey(),
  capturedAt: integer('captured_at').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
});

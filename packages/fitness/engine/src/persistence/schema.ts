import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Single-row baseline store. v1 wrote a SARIF JSON file at
 * `<runtime>/baseline.sarif`; v2 stores the same SARIF document as a
 * single row in this table (id constrained to 1). Save overwrites the
 * row; load reads it; exists() probes for its presence.
 */
export const fitBaseline = sqliteTable('fit_baseline', {
  id: integer('id').primaryKey(),
  capturedAt: integer('captured_at').notNull(),
  sarifPayload: text('sarif_payload', { mode: 'json' }).notNull(),
});

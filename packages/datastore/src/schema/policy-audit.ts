import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Host-owned local trust-policy audit events. The datastore keeps the table
 * vocabulary-neutral: CLI/config policy terms are persisted as bounded strings
 * and JSON blobs, and tools never write these rows.
 */
export const policyAuditEvents = sqliteTable(
  'policy_audit_events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id'),
    timestamp: text('timestamp').notNull(),
    subjectKind: text('subject_kind').notNull(),
    subjectId: text('subject_id').notNull(),
    subject: text('subject', { mode: 'json' }),
    action: text('action').notNull(),
    outcome: text('outcome').notNull(),
    reasons: text('reasons', { mode: 'json' }),
    sourceTiers: text('source_tiers', { mode: 'json' }),
    matchedExceptionIds: text('matched_exception_ids', { mode: 'json' }),
    metadata: text('metadata', { mode: 'json' }),
  },
  (t) => [index('policy_audit_events_timestamp_idx').on(t.timestamp)],
);

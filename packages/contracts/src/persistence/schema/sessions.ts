import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Generic tool-run session record. Holds only columns every tool shares;
 * per-session detail lives in {@link sessionToolPayload}. The persistence
 * layer holds ZERO tool-specific vocabulary. (Audit 2026-05-29.)
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    tool: text('tool').notNull(),
    timestamp: integer('timestamp').notNull(),
    cwd: text('cwd').notNull(),
    recipe: text('recipe'),
    score: integer('score').notNull(),
    passed: integer('passed', { mode: 'boolean' }).notNull(),
    durationMs: integer('duration_ms').notNull(),
  },
  (table) => [
    index('sessions_tool_timestamp_idx').on(table.tool, sql`${table.timestamp} DESC`),
  ],
);

/**
 * Tool-owned opaque per-session detail (audit 2026-05-29, session split).
 *
 * One row per session. `payload` is a JSON blob whose shape is owned and
 * validated by the writing tool — `contracts` treats it as opaque and
 * holds zero tool-specific (check/finding/summary) vocabulary. The
 * dashboard, as the presentation owner, reads this payload and renders
 * it — the same producer/consumer split used for `GraphCatalog`.
 */
export const sessionToolPayload = sqliteTable('session_tool_payload', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
});

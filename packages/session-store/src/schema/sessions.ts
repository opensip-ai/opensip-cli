import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
    // `timestamp`/`timestamp_iso` are the run START (host-owned-run-timing
    // `startedAt`). The physical column names are kept as an internal migration
    // detail; the exported contract field is `startedAt` (mapped in SessionRepo).
    timestamp: integer('timestamp').notNull(), // startedAt ms epoch for ordering/index; see timestamp_iso for fidelity
    timestamp_iso: text('timestamp_iso'), // startedAt original ISO string from host for replay fidelity
    // Run COMPLETION (host-owned-run-timing `completedAt`). Nullable for
    // legacy/pre-migration rows; the repo synthesizes startedAt + durationMs on
    // read when absent. New writes always populate it.
    completed_at: integer('completed_at'), // completedAt ms epoch
    completed_at_iso: text('completed_at_iso'), // completedAt original ISO string
    cwd: text('cwd').notNull(),
    recipe: text('recipe'),
    score: integer('score').notNull(),
    passed: integer('passed', { mode: 'boolean' }).notNull(),
    durationMs: integer('duration_ms').notNull(),
  },
  (table) => [index('sessions_tool_timestamp_idx').on(table.tool, sql`${table.timestamp} DESC`)],
);

/**
 * Sibling host-metrics record (host-owned-run-timing §5.3/§5.4). One row per
 * session id, holding host-side overhead that is known at different times:
 * `persistMs` after the session write, `egressMs` after post-run delivery,
 * etc. Kept separate from the `sessions` row so late-arriving metrics are a
 * best-effort upsert rather than a row rewrite. Hydrated back onto
 * `StoredSession.hostMetrics`. All metrics are nullable.
 */
export const sessionHostMetrics = sqliteTable('session_host_metrics', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  ttyBusyMs: integer('tty_busy_ms'),
  renderMs: integer('render_ms'),
  persistMs: integer('persist_ms'),
  egressMs: integer('egress_ms'),
  totalCommandMs: integer('total_command_ms'),
});

/**
 * Durable per-run dashboard contribution (host-owned-run-timing §7). One row
 * per (session id, tool): the opaque `ToolDashboardContribution` a run
 * returned, persisted so a later `opensip report` process can hydrate the
 * tool's tab without same-process in-memory state. The persistence layer holds
 * ZERO tool vocabulary — `contribution` is an opaque JSON blob owned by the
 * producing tool, like `session_tool_payload.payload`.
 */
export const sessionDashboardContributions = sqliteTable(
  'session_dashboard_contributions',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tool: text('tool').notNull(),
    contribution: text('contribution', { mode: 'json' }).notNull(),
    version: integer('version').notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.tool] })],
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
  payload_version: integer('payload_version').notNull().default(1), // tool-owned payload schema version; future versions may require CLI upgrade to interpret
});

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { sessions } from './sessions.js';

/**
 * Host-owned Run + RunStep execution ledger (ADR-0143).
 *
 * The ledger is the canonical composition evidence record. Tool-specific replay
 * detail stays in `sessions` / `session_tool_payload`; step rows optionally link
 * to a session when one exists.
 */
export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    source: text('source').notNull(),
    correlation_run_id: text('correlation_run_id'),
    cwd: text('cwd').notNull(),
    started_at: integer('started_at').notNull(),
    started_at_iso: text('started_at_iso'),
    completed_at: integer('completed_at').notNull(),
    completed_at_iso: text('completed_at_iso'),
    duration_ms: integer('duration_ms').notNull(),
    exit_code: integer('exit_code').notNull(),
    aggregate: text('aggregate', { mode: 'json' }).notNull(),
    scope: text('scope', { mode: 'json' }),
    review_brief: text('review_brief', { mode: 'json' }),
    legacy_suite_run_id: text('legacy_suite_run_id'),
    cli_version: text('cli_version'),
    engine_versions: text('engine_versions', { mode: 'json' }),
  },
  (table) => [
    index('runs_completed_at_idx').on(sql`${table.completed_at} DESC`),
    index('runs_legacy_suite_run_id_idx').on(table.legacy_suite_run_id),
    index('runs_source_completed_at_idx').on(table.source, sql`${table.completed_at} DESC`),
  ],
);

export const runSteps = sqliteTable(
  'run_steps',
  {
    id: text('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    logical_step_key: text('logical_step_key').notNull(),
    ordinal: integer('ordinal').notNull(),
    attempt: integer('attempt').notNull().default(1),
    tool: text('tool').notNull(),
    command: text('command').notNull(),
    stable_id: text('stable_id').notNull(),
    effective_args: text('effective_args', { mode: 'json' }),
    exit_code: integer('exit_code').notNull(),
    outcome: text('outcome').notNull(),
    duration_ms: integer('duration_ms').notNull(),
    verdict_summary: text('verdict_summary', { mode: 'json' }),
    session_id: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    evidence: text('evidence', { mode: 'json' }),
    parent_step_id: text('parent_step_id'),
    dependency: text('dependency', { mode: 'json' }),
  },
  (table) => [
    index('run_steps_run_order_idx').on(table.run_id, table.ordinal, table.attempt),
    index('run_steps_session_id_idx').on(table.session_id),
    index('run_steps_stable_id_idx').on(table.stable_id),
  ],
);

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
    summary: text('summary', { mode: 'json' }).notNull(),
    durationMs: integer('duration_ms').notNull(),
  },
  (table) => ({
    toolTimestampIdx: index('sessions_tool_timestamp_idx').on(table.tool, sql`${table.timestamp} DESC`),
  }),
);

export const sessionChecks = sqliteTable(
  'session_checks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    checkSlug: text('check_slug').notNull(),
    passed: integer('passed', { mode: 'boolean' }).notNull(),
    violationCount: integer('violation_count'),
    durationMs: integer('duration_ms').notNull(),
  },
  (table) => ({
    sessionIdx: index('session_checks_session_idx').on(table.sessionId),
  }),
);

export const sessionFindings = sqliteTable(
  'session_findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionCheckId: integer('session_check_id')
      .notNull()
      .references(() => sessionChecks.id, { onDelete: 'cascade' }),
    ruleId: text('rule_id').notNull(),
    severity: text('severity').notNull(),
    message: text('message').notNull(),
    filePath: text('file_path'),
    line: integer('line'),
    column: integer('column'),
    suggestion: text('suggestion'),
    category: text('category'),
  },
  (table) => ({
    sessionCheckIdx: index('session_findings_check_idx').on(table.sessionCheckId),
  }),
);

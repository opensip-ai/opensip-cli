import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Generic host-owned keyed tool state (ADR-0042 — the third-party persistence
 * parity mechanism). ONE table serves every tool: each row is one opaque JSON
 * payload under a `(tool, key)` identity, so tools share the table but never
 * see each other's rows — the exact pattern the ADR-0036 baseline pair proved.
 * Tools reach it ONLY through the `ToolStateRepo` / the `cli.toolState` seams;
 * they never own schema.
 *
 * Durability note: unlike baselines (drop-and-recapture, CI-ephemeral), tool
 * state is DURABLE tool data — a release never drops these rows.
 */
export const toolState = sqliteTable(
  'tool_state',
  {
    tool: text('tool').notNull(), // human `name` value — the scoping key
    key: text('key').notNull(),
    payload: text('payload', { mode: 'json' }),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tool, t.key] })],
);

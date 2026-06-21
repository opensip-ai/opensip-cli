import type { Config } from 'drizzle-kit';

/**
 * Single, centralized Drizzle migration config for the whole platform: one SQLite
 * database, one `migrations/` folder. It aggregates BOTH host-owned schema
 * (`./src/schema/*`) and TOOL-owned schema sources (session-store, graph) into one
 * migration set. Consequence (a known ownership inversion — ADR-0036): editing any
 * listed schema, including a tool's, requires regenerating migrations HERE:
 *   `pnpm --filter @opensip-cli/datastore db:generate` + bump LOGICAL_SCHEMA_VERSION.
 * Each tool-owned schema file carries the same signpost at its top.
 */
export default {
  dialect: 'sqlite',
  schema: [
    '../session-store/src/schema/sessions.ts',
    // graph keeps its schema source for graphCatalog/graphShardFragment; its
    // baseline tables were removed from the schema (P3) so drizzle drops them.
    '../graph/engine/src/persistence/schema.ts',
    // fitness's per-tool schema is now empty (fit_baseline moved to the generic
    // pair below) — its path is dropped here; the snapshot still drops the table.
    './src/schema/baseline.ts',
    // ADR-0042: the generic keyed tool-state table (the cli.toolState seams).
    './src/schema/tool-state.ts',
  ],
  out: './migrations',
} satisfies Config;

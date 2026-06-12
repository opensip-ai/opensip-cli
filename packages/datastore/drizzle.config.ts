import type { Config } from 'drizzle-kit';

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

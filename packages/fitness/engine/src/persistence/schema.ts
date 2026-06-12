// ADR-0036: the `fit_baseline` table moved to the generic host-owned
// `tool_baseline_entries` / `tool_baseline_meta` pair in `@opensip-tools/datastore`.
// This per-tool schema is now empty; its `drizzle.config.ts` schema path is removed
// and the DROP-table migration is generated in P4 Task 4.5.
export {};

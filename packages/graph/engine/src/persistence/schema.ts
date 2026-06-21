/**
 * @fileoverview Graph tool's Drizzle table definitions (catalog + shard fragment).
 *
 * ⚠️ MIGRATIONS LIVE IN `@opensip-cli/datastore`, NOT HERE. The platform uses one
 * SQLite database with a single centralized migrations folder; this tool's tables
 * are migrated alongside everyone else's. `datastore/drizzle.config.ts` imports
 * THIS file as a schema source. Therefore, after editing the tables below you MUST:
 *
 *   1. `pnpm --filter @opensip-cli/datastore db:generate`  (regenerate the migration)
 *   2. commit the generated `packages/datastore/migrations/*` files
 *   3. bump `LOGICAL_SCHEMA_VERSION` in `datastore/src/schema-version.ts` in lockstep
 *      with the new journal entry count (so existing DBs migrate forward).
 *
 * `datastore`'s `migration-integrity` + `version-guard` test suites fail loudly if
 * the journal and schema drift, but they can't tell you to run db:generate — this
 * note is the signpost. (Owning the schema here but the migration there is a known
 * inversion; centralizing migrations is the deliberate trade — see ADR-0036.)
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// ADR-0036: the graph baseline tables (`graph_baseline_signals` /
// `graph_baseline_meta`) moved to the generic host-owned `tool_baseline_entries`
// / `tool_baseline_meta` pair in `@opensip-cli/datastore`. The DROP migration
// for the old tables is generated in this plan's P4 (one migration drops all three
// per-tool baseline tables at once, after fitness also re-points).

/**
 * Catalog single-row store (id = 1).
 *
 * v1 stored the full Catalog object as a streamed JSON file at
 * `paths.graphCatalogPath`. v2 stores it as one row whose `payload`
 * column holds the same JSON, with the metadata fields (language,
 * cache_key, files_fingerprint, built_at) lifted out for cheap
 * fingerprint-mismatch checks without parsing the full payload.
 *
 * The catalog payload remains a single document at parity. The
 * follow-up `graph-catalog-perf` plan normalizes this into per-
 * function / per-occurrence / per-edge tables and pushes view
 * derivations down into SQL.
 */
export const graphCatalog = sqliteTable('graph_catalog', {
  id: integer('id').primaryKey(),
  language: text('language').notNull(),
  cacheKey: text('cache_key').notNull(),
  filesFingerprint: text('files_fingerprint').notNull(),
  builtAt: text('built_at').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
});

/**
 * Per-shard catalog fragment store (plan #2 — sharded build).
 *
 * One row per shard (keyed by `shard_id`), holding that shard's
 * serialized `ShardBuildResult` (fragment + boundary calls + parse
 * errors). A fragment is valid for incremental reuse only when BOTH its
 * `cache_key` (the shard's tsconfig/version/mode key) and its
 * `shard_fingerprint` (mtime+size over the shard's files) match the
 * current run — the same validity discipline as the full-catalog path.
 * On a rebuild, shards whose fingerprint matches load their fragment with
 * no parse; only changed shards re-run a worker.
 *
 * Schema note (flagged in the plan for a data-layer pass): this is a
 * draft — table-vs-column, stale-row retention, and a build-scoped sweep
 * are deferred. Replacement is per-shard upsert; stale rows for shards no
 * longer present are pruned by the orchestrator after a build.
 */
export const graphShardFragment = sqliteTable('graph_shard_fragment', {
  shardId: text('shard_id').primaryKey(),
  language: text('language').notNull(),
  cacheKey: text('cache_key').notNull(),
  shardFingerprint: text('shard_fingerprint').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
});

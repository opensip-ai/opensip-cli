/**
 * CatalogRepo — SQLite-backed graph catalog at parity with v1's
 * single-JSON-file shape.
 *
 * v1 stored the catalog as `<runtime>/cache/graph/catalog.json`. v2
 * stores it in `graph_catalog` row 1, lifting the cache-validity
 * fields (language, cacheKey, filesFingerprint) into typed columns so
 * the orchestrator can fingerprint-mismatch without parsing the full
 * payload. The catalog perf follow-up plan normalizes the payload
 * into per-function/occurrence/edge tables and pushes dashboard view
 * derivations into SQL.
 */

import { logger } from '@opensip-tools/core';
import { sql } from 'drizzle-orm';

import { graphCatalog, graphShardFragment } from './schema.js';

import type { ShardBuildResult } from '../cli/orchestrate/shard-model.js';
import type { Catalog, PersistedFeatures, ResolutionMode } from '../types.js';
import type { GraphCatalog } from '@opensip-tools/contracts';
import type { DataStore } from '@opensip-tools/datastore';

const MODULE_NAME = 'graph:catalog-repo';

interface CatalogRowPayload {
  readonly version: '3.0';
  readonly tool: 'graph';
  readonly language: string;
  readonly builtAt: string;
  readonly cacheKey: string;
  readonly filesFingerprint?: string;
  /**
   * The resolution tier that built this catalog. Stored in the JSON
   * payload (no schema column needed) so a loaded catalog self-describes
   * its tier on cache hits — consumers (report banner, lookup note, gate
   * refusal, rule caveats) stay honest on warm runs, not just fresh
   * builds. Absent ⇒ exact (catalogs persisted before fast mode landed).
   */
  readonly resolutionMode?: ResolutionMode;
  readonly functions: Catalog['functions'];
  /**
   * Materialized dashboard columns (ADR-0006); present ONLY when the producing
   * run requested `emitFeatures`. A lean default run omits this key entirely,
   * so the stored payload stays byte-unchanged for non-dashboard builds.
   */
  readonly features?: PersistedFeatures;
}

/**
 * SQLite/Drizzle-backed repository for the graph catalog and its per-shard
 * fragments. Owns the `graph_catalog` row plus the `graph_shard_fragment`
 * table; all reads/writes are synchronous (better-sqlite3). The orchestrator
 * uses it to persist whole catalogs and incremental shard fragments, and to
 * fingerprint-match for cache validity without parsing the full payload.
 */
export class CatalogRepo {
  constructor(private readonly datastore: DataStore) {}

  /**
   * Replace the catalog with a fresh value. Mirrors v1's atomic
   * tmp-file + rename write — the upsert is a single statement, and
   * SQLite's transaction semantics guarantee no torn reads.
   */
  replaceAll(catalog: Catalog): void {
    try {
      const filesFingerprint = catalog.filesFingerprint ?? '';
      const payload: CatalogRowPayload = {
        version: catalog.version,
        tool: catalog.tool,
        language: catalog.language,
        builtAt: catalog.builtAt,
        cacheKey: catalog.cacheKey,
        filesFingerprint: catalog.filesFingerprint,
        resolutionMode: catalog.resolutionMode,
        functions: catalog.functions,
        // Carries through whatever the caller attached; `undefined` when none
        // (a lean run) so the key is omitted from the persisted JSON.
        features: catalog.features,
      };
      this.datastore.db
        .insert(graphCatalog)
        .values({
          id: 1,
          language: catalog.language,
          cacheKey: catalog.cacheKey,
          filesFingerprint,
          builtAt: catalog.builtAt,
          payload,
        })
        .onConflictDoUpdate({
          target: graphCatalog.id,
          set: {
            language: sql`excluded.language`,
            cacheKey: sql`excluded.cache_key`,
            filesFingerprint: sql`excluded.files_fingerprint`,
            builtAt: sql`excluded.built_at`,
            payload: sql`excluded.payload`,
          },
        })
        .run();
      logger.info({
        evt: 'graph.catalog.write.complete',
        module: MODULE_NAME,
        msg: 'Catalog written',
        functions: Object.keys(catalog.functions).length,
      });
    } catch (error) {
      /* v8 ignore start */
      logger.error({
        evt: 'graph.catalog.write.error',
        module: MODULE_NAME,
        msg: 'Failed to write catalog',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
      /* v8 ignore stop */
    }
  }

  /**
   * Load the full catalog. Returns `null` on cache miss (no row).
   * Reconstructs the legacy `Catalog` shape from the JSON payload at
   * parity — view derivations under
   * `packages/contracts/src/persistence/dashboard/code-paths/` consume
   * the same shape they always have.
   */
  loadFullCatalog(): Catalog | null {
    try {
      const row = this.datastore.db.select().from(graphCatalog).where(sql`id = 1`).get();
      if (!row) {
        logger.info({
          evt: 'graph.catalog.read.miss',
          module: MODULE_NAME,
          reason: 'empty-catalog',
        });
        return null;
      }
      const payload = row.payload as CatalogRowPayload;
      logger.info({
        evt: 'graph.catalog.read.hit',
        module: MODULE_NAME,
        functions: Object.keys(payload.functions).length,
      });
      return {
        version: payload.version,
        tool: payload.tool,
        language: payload.language,
        builtAt: payload.builtAt,
        cacheKey: payload.cacheKey,
        filesFingerprint: payload.filesFingerprint,
        resolutionMode: payload.resolutionMode,
        functions: payload.functions,
        features: payload.features,
      };
    } catch (error) {
      /* v8 ignore start */
      logger.error({
        evt: 'graph.catalog.read.error',
        module: MODULE_NAME,
        msg: 'Failed to read catalog',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
      /* v8 ignore stop */
    }
  }

  /**
   * Read the catalog as the cross-tool {@link GraphCatalog} contract —
   * the shape the dashboard (and fitness's dashboard command) depend on.
   * This is the supported cross-tool read path: it lets fitness drop its
   * raw-SQL `SELECT … FROM graph_catalog` (audit 2026-05-29, H1). The
   * internal `Catalog` is structurally assignable to the GraphCatalog
   * contract, so this is a plain widening — no cast — verified by the
   * compiler at this boundary, where graph owns both types.
   */
  loadCatalogContract(): GraphCatalog | null {
    return this.loadFullCatalog();
  }

  /**
   * True iff a catalog row exists. Used by the orchestrator to short-
   * circuit fingerprint mismatch checks when nothing is cached.
   */
  hasAnyCatalog(): boolean {
    const row = this.datastore.db
      .select({ id: graphCatalog.id })
      .from(graphCatalog)
      .limit(1)
      .get();
    return row !== undefined;
  }

  // ── Per-shard fragment cache (plan #2 — sharded build) ──────────

  /**
   * Persist one shard's `ShardBuildResult`, replacing any prior row for
   * the same shard id. The validity keys (`cache_key`, `shard_fingerprint`)
   * are lifted from the result so a reuse check needs no payload parse.
   */
  upsertShardFragment(result: ShardBuildResult): void {
    this.datastore.db
      .insert(graphShardFragment)
      .values({
        shardId: result.shardId,
        language: result.fragment.language,
        cacheKey: result.fragment.cacheKey,
        shardFingerprint: result.fingerprint,
        payload: result,
      })
      .onConflictDoUpdate({
        target: graphShardFragment.shardId,
        set: {
          language: sql`excluded.language`,
          cacheKey: sql`excluded.cache_key`,
          shardFingerprint: sql`excluded.shard_fingerprint`,
          payload: sql`excluded.payload`,
        },
      })
      .run();
  }

  /**
   * Load a shard fragment ONLY if it is still valid — both the shard's
   * cache key (tsconfig/version/mode) and its files fingerprint must match
   * the current run. Returns `null` on miss or staleness, signalling the
   * orchestrator to re-run that shard's worker. No parse happens here
   * beyond the JSON payload of a single valid shard.
   */
  loadValidShardFragment(
    shardId: string,
    expectedCacheKey: string,
    expectedFingerprint: string,
  ): ShardBuildResult | null {
    const row = this.datastore.db
      .select()
      .from(graphShardFragment)
      .where(sql`shard_id = ${shardId}`)
      .get();
    if (!row) return null;
    if (row.cacheKey !== expectedCacheKey || row.shardFingerprint !== expectedFingerprint) {
      return null;
    }
    return row.payload as ShardBuildResult;
  }

  /**
   * Drop fragment rows for shards no longer present in the current build
   * (e.g. a package was removed). Keeps the per-shard cache from
   * accumulating stale rows. No-op when `keepShardIds` is empty.
   */
  pruneShardFragmentsExcept(keepShardIds: readonly string[]): void {
    if (keepShardIds.length === 0) return;
    const separator = sql`, `;
    const placeholders = keepShardIds.map((id) => sql`${id}`);
    const keepList = sql.join(placeholders, separator);
    this.datastore.db
      .delete(graphShardFragment)
      .where(sql`shard_id NOT IN (${keepList})`)
      .run();
  }
}

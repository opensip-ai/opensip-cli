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

import { graphCatalog } from './schema.js';

import type { Catalog } from '../types.js';
import type { DataStore } from '@opensip-tools/datastore';

const MODULE_NAME = 'graph:catalog-repo';

interface CatalogRowPayload {
  readonly version: '3.0';
  readonly tool: 'graph';
  readonly language: string;
  readonly builtAt: string;
  readonly cacheKey: string;
  readonly filesFingerprint?: string;
  readonly functions: Catalog['functions'];
}

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
        functions: catalog.functions,
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
        functions: payload.functions,
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
}

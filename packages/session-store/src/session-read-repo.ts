import { logger, type ToolShortId } from '@opensip-cli/core';
import { count, desc, eq, inArray } from 'drizzle-orm';

import { sessions, sessionToolPayload } from './schema/sessions.js';
import { isSessionCwdWithin } from './session-cwd-scope.js';
import { buildSession, type StoredPayloadRow } from './session-hydrator.js';
import { hostMetricsBySessionId, readHostMetrics } from './session-repo-host-metrics.js';

import type { StoredSession } from '@opensip-cli/contracts';
import type { DrizzleDataStore } from '@opensip-cli/datastore/internal';

const MODULE_NAME = 'session-store:session-repo';

/** Filters for {@link SessionReadRepo.list}: tool short-id and/or max row count. */
export interface SessionListOptions {
  readonly tool?: ToolShortId;
  readonly limit?: number;
  readonly cwdWithin?: string;
}

/** Read side of the session store: list/get/latest/count with hydration. */
export class SessionReadRepo {
  constructor(private readonly datastore: DrizzleDataStore) {}

  list(opts: SessionListOptions = {}): readonly StoredSession[] {
    try {
      const baseQuery = opts.tool
        ? this.datastore.db.select().from(sessions).where(eq(sessions.tool, opts.tool))
        : this.datastore.db.select().from(sessions);
      const ordered = baseQuery.orderBy(desc(sessions.timestamp));
      let sessionRows: (typeof sessions.$inferSelect)[];
      if (opts.cwdWithin === undefined) {
        sessionRows = opts.limit === undefined ? ordered.all() : ordered.limit(opts.limit).all();
      } else {
        const root = opts.cwdWithin;
        const filteredRows = ordered.all().filter((row) => isSessionCwdWithin(row.cwd, root));
        sessionRows = opts.limit === undefined ? filteredRows : filteredRows.slice(0, opts.limit);
      }

      const ids = sessionRows.map((row) => row.id);
      const payloadsById = this.payloadsBySessionId(ids);
      const metricsById = hostMetricsBySessionId(this.datastore, ids);
      const results = sessionRows.map((row) =>
        buildSession(row, payloadsById.get(row.id), metricsById.get(row.id)),
      );
      logger.info({
        evt: 'session.list.complete',
        module: MODULE_NAME,
        msg: 'Listed sessions',
        count: results.length,
      });
      return results;
    } catch (error) {
      logger.error({
        evt: 'session.list.error',
        module: MODULE_NAME,
        msg: 'Failed to list sessions',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  get(id: string): StoredSession | null {
    const row = this.datastore.db.select().from(sessions).where(eq(sessions.id, id)).get();
    return row ? this.hydrateSession(row) : null;
  }

  /**
   * The most recent session. With `cwdWithin`, returns the newest session
   * whose stored `cwd` is inside that root — `list` applies the containment
   * filter BEFORE the limit, so this is the newest in-scope row, not the
   * global newest filtered down to nothing.
   */
  latest(opts: { tool?: ToolShortId; cwdWithin?: string } = {}): StoredSession | null {
    const rows = this.list({ ...opts, limit: 1 });
    return rows[0] ?? null;
  }

  count(): number {
    const row = this.datastore.db.select({ value: count() }).from(sessions).get();
    return row?.value ?? 0;
  }

  /** Hydrate one session via point queries — the single-row get() path. */
  private hydrateSession(row: typeof sessions.$inferSelect): StoredSession {
    // Tool-owned opaque detail — drizzle returns the JSON pre-parsed; the owning
    // tool (not persistence) validates its shape.
    const payloadRow = this.datastore.db
      .select({
        payload: sessionToolPayload.payload,
        payload_version: sessionToolPayload.payload_version,
      })
      .from(sessionToolPayload)
      .where(eq(sessionToolPayload.sessionId, row.id))
      .get();
    return buildSession(row, payloadRow, readHostMetrics(this.datastore, row.id));
  }

  /** Batch-load tool payloads for a page of session ids (avoids list()'s N+1). */
  private payloadsBySessionId(ids: readonly string[]): Map<string, StoredPayloadRow> {
    const byId = new Map<string, StoredPayloadRow>();
    // Chunk to stay under SQLite's bound-parameter ceiling
    // (SQLITE_MAX_VARIABLE_NUMBER, ~32k): `list()` with no limit is unbounded, so
    // `ids` can exceed the ceiling on a large, retention-disabled history.
    // Mirrors BaselineRepo.save's chunking. An empty `ids` runs 0 loops.
    const CHUNK = 2000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      if (slice.length === 0) continue;
      const rows = this.datastore.db
        .select({
          sessionId: sessionToolPayload.sessionId,
          payload: sessionToolPayload.payload,
          payload_version: sessionToolPayload.payload_version,
        })
        .from(sessionToolPayload)
        .where(inArray(sessionToolPayload.sessionId, slice))
        .all();
      for (const r of rows) {
        byId.set(r.sessionId, {
          payload: r.payload,
          payload_version: r.payload_version,
        });
      }
    }
    return byId;
  }
}

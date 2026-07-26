import { ValidationError } from '@opensip-cli/core';
import { eq, inArray } from 'drizzle-orm';

import { sessionStoreErrorCatalog } from './errors/session-store-error-catalog.js';
import { sessionHostMetrics } from './schema/sessions.js';

import type { StoredSessionHostMetrics } from '@opensip-cli/contracts';
import type { DrizzleDataStore, DrizzleHandle } from '@opensip-cli/datastore/internal';


// Plan 01: 22 literals become five registered definitions; the branch lives in metadata.
const WRITE_INVALID = sessionStoreErrorCatalog.require('SESSION.WRITE.RECORD_INVALID');

const HOST_METRIC_KEYS = [
  'ttyBusyMs',
  'renderMs',
  'persistMs',
  'egressMs',
  'totalCommandMs',
] as const;

/** Package-private validated metrics projection shared by both write paths. */
export interface PreparedHostMetricsWrite {
  readonly row: typeof sessionHostMetrics.$inferInsert;
  readonly patch: Partial<typeof sessionHostMetrics.$inferInsert>;
}

export function prepareHostMetricsWrite(
  sessionId: string,
  metrics: StoredSessionHostMetrics,
): PreparedHostMetricsWrite {
  if (
    typeof metrics !== 'object' ||
    metrics === null ||
    Array.isArray(metrics) ||
    typeof sessionId !== 'string' ||
    sessionId.length === 0
  ) {
    throw new ValidationError('Invalid host metrics input.', {
      code: WRITE_INVALID.code,
      definition: WRITE_INVALID,
      metadata: { field: 'host-metrics' },
    });
  }
  for (const key of HOST_METRIC_KEYS) {
    const value = metrics[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    ) {
      throw new ValidationError(`Invalid host metric ${key} for session ${sessionId}.`, {
        code: WRITE_INVALID.code,
        definition: WRITE_INVALID,
        metadata: { field: 'host-metrics' },
      });
    }
  }

  const patch: Partial<typeof sessionHostMetrics.$inferInsert> = {};
  if (metrics.ttyBusyMs !== undefined) patch.ttyBusyMs = metrics.ttyBusyMs;
  if (metrics.renderMs !== undefined) patch.renderMs = metrics.renderMs;
  if (metrics.persistMs !== undefined) patch.persistMs = metrics.persistMs;
  if (metrics.egressMs !== undefined) patch.egressMs = metrics.egressMs;
  if (metrics.totalCommandMs !== undefined) patch.totalCommandMs = metrics.totalCommandMs;
  return {
    row: {
      sessionId,
      ttyBusyMs: metrics.ttyBusyMs ?? null,
      renderMs: metrics.renderMs ?? null,
      persistMs: metrics.persistMs ?? null,
      egressMs: metrics.egressMs ?? null,
      totalCommandMs: metrics.totalCommandMs ?? null,
    },
    patch,
  };
}

/** Project a raw host-metrics row, dropping null columns (only captured metrics). */
export function projectHostMetrics(
  row: typeof sessionHostMetrics.$inferSelect,
): StoredSessionHostMetrics | undefined {
  const metrics: Record<string, number> = {};
  if (row.ttyBusyMs != null) metrics.ttyBusyMs = row.ttyBusyMs;
  if (row.renderMs != null) metrics.renderMs = row.renderMs;
  if (row.persistMs != null) metrics.persistMs = row.persistMs;
  if (row.egressMs != null) metrics.egressMs = row.egressMs;
  if (row.totalCommandMs != null) metrics.totalCommandMs = row.totalCommandMs;
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

/** Read host-metrics for one session, or `undefined` when no row exists. */
export function readHostMetrics(
  datastore: DrizzleDataStore,
  sessionId: string,
): StoredSessionHostMetrics | undefined {
  const row = datastore.db
    .select()
    .from(sessionHostMetrics)
    .where(eq(sessionHostMetrics.sessionId, sessionId))
    .get();
  return row ? projectHostMetrics(row) : undefined;
}

/** Batch-load host-metrics for a page of session ids (avoids list()'s N+1). */
export function hostMetricsBySessionId(
  datastore: DrizzleDataStore,
  ids: readonly string[],
): Map<string, StoredSessionHostMetrics> {
  const byId = new Map<string, StoredSessionHostMetrics>();
  // Chunk to stay under SQLite's bound-parameter ceiling
  // (SQLITE_MAX_VARIABLE_NUMBER, ~32k): `list()` is unbounded when no limit is
  // given, so `ids` can exceed the ceiling on a large, retention-disabled
  // history. Mirrors BaselineRepo.save's chunking. An empty `ids` runs 0 loops.
  const CHUNK = 2000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    if (slice.length === 0) continue;
    const rows = datastore.db
      .select()
      .from(sessionHostMetrics)
      .where(inArray(sessionHostMetrics.sessionId, slice))
      .all();
    for (const row of rows) {
      const metrics = projectHostMetrics(row);
      if (metrics) byId.set(row.sessionId, metrics);
    }
  }
  return byId;
}

/** Package-private strict metrics upsert used inside an owning transaction. */
export function writeHostMetricsRowOrThrow(
  tx: DrizzleHandle,
  sessionId: string,
  metrics: StoredSessionHostMetrics,
): void {
  const prepared = prepareHostMetricsWrite(sessionId, metrics);
  // `set` keys are the Drizzle COLUMN PROPERTY names (camelCase), NOT the
  // SQL column names — Drizzle silently ignores unknown keys, so snake_case
  // here would no-op the ON CONFLICT update and the merge would be lost.
  if (Object.keys(prepared.patch).length === 0) return;
  tx.insert(sessionHostMetrics)
    .values(prepared.row)
    .onConflictDoUpdate({
      target: sessionHostMetrics.sessionId,
      set: prepared.patch,
    })
    .run();
}

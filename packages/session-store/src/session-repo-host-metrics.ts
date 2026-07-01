import { logger } from '@opensip-cli/core';
import { eq, inArray } from 'drizzle-orm';

import { sessionHostMetrics } from './schema/sessions.js';

import type { StoredSessionHostMetrics } from '@opensip-cli/contracts';
import type { DrizzleDataStore } from '@opensip-cli/datastore/internal';

const MODULE_NAME = 'session-store:session-repo';

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
  if (ids.length === 0) return byId;
  const rows = datastore.db
    .select()
    .from(sessionHostMetrics)
    .where(inArray(sessionHostMetrics.sessionId, ids))
    .all();
  for (const row of rows) {
    const metrics = projectHostMetrics(row);
    if (metrics) byId.set(row.sessionId, metrics);
  }
  return byId;
}

/**
 * Best-effort upsert of host-side overhead metrics for a session. Only the
 * provided fields are written, merging onto any existing row. Never throws.
 */
export function upsertHostMetricsRow(
  datastore: DrizzleDataStore,
  sessionId: string,
  metrics: StoredSessionHostMetrics,
): void {
  try {
    // `set` keys are the Drizzle COLUMN PROPERTY names (camelCase), NOT the
    // SQL column names — Drizzle silently ignores unknown keys, so snake_case
    // here would no-op the ON CONFLICT update and the merge would be lost.
    const patch: Partial<typeof sessionHostMetrics.$inferInsert> = {};
    if (metrics.ttyBusyMs !== undefined) patch.ttyBusyMs = metrics.ttyBusyMs;
    if (metrics.renderMs !== undefined) patch.renderMs = metrics.renderMs;
    if (metrics.persistMs !== undefined) patch.persistMs = metrics.persistMs;
    if (metrics.egressMs !== undefined) patch.egressMs = metrics.egressMs;
    if (metrics.totalCommandMs !== undefined) patch.totalCommandMs = metrics.totalCommandMs;
    if (Object.keys(patch).length === 0) return;
    datastore.db
      .insert(sessionHostMetrics)
      .values({
        sessionId,
        ttyBusyMs: metrics.ttyBusyMs ?? null,
        renderMs: metrics.renderMs ?? null,
        persistMs: metrics.persistMs ?? null,
        egressMs: metrics.egressMs ?? null,
        totalCommandMs: metrics.totalCommandMs ?? null,
      })
      .onConflictDoUpdate({
        target: sessionHostMetrics.sessionId,
        set: patch,
      })
      .run();
  } catch (error) {
    logger.warn({
      evt: 'session.host_metrics.upsert_failed',
      module: MODULE_NAME,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

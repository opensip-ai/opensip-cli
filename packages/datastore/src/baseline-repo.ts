import { logger, type Signal } from '@opensip-cli/core';
import { eq, sql } from 'drizzle-orm';

import { requireDrizzleDataStore, type DataStore, type DrizzleDataStore } from './data-store.js';
import { toolBaselineEntries, toolBaselineMeta } from './schema/baseline.js';

const MODULE_NAME = 'datastore:baseline-repo';

/** One baseline entry to persist: its opaque fingerprint + the full Signal payload. */
export interface BaselineEntry {
  readonly fingerprint: string;
  readonly payload: Signal;
}

/** One loaded baseline row: the fingerprint + its stored payload (null if absent). */
export interface BaselineRow {
  readonly fingerprint: string;
  readonly payload: Signal | null;
}

/**
 * The generic host-owned baseline repository (ADR-0036). One repo over the
 * shared `tool_baseline_entries` / `tool_baseline_meta` tables, scoped by the
 * `tool` column so every tool shares the table but never sees another tool's
 * rows. Replaces the per-tool `GraphBaselineRepo` / `FitBaselineRepo`.
 *
 * `save` is an atomic per-tool replace (delete-all + bulk insert + meta upsert in
 * one transaction), mirroring graph's atomic-rename-of-tmp-file semantic. The
 * `payload` column carries the full Signal so the diff can surface full-object
 * `resolved` findings and re-render SARIF.
 */
export class BaselineRepo {
  private readonly datastore: DrizzleDataStore;

  constructor(datastore: DataStore) {
    this.datastore = requireDrizzleDataStore(datastore);
  }

  /**
   * Replace this tool's entire baseline in one transaction. Entries are deduped
   * by fingerprint (last wins) and sorted by fingerprint for deterministic
   * ordering. The meta row is upserted as the existence marker — an empty
   * baseline is a valid saved state ("saved, no findings" ≠ "never saved").
   */
  save(tool: string, entries: readonly BaselineEntry[]): void {
    try {
      const capturedAt = Date.now();
      const byFingerprint = new Map<string, Signal>();
      for (const e of entries) byFingerprint.set(e.fingerprint, e.payload);
      const rows = [...byFingerprint.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([fingerprint, payload]) => ({ tool, fingerprint, payload, capturedAt }));

      this.datastore.transaction((tx) => {
        tx.delete(toolBaselineEntries).where(eq(toolBaselineEntries.tool, tool)).run();
        if (rows.length > 0) {
          tx.insert(toolBaselineEntries).values(rows).run();
        }
        // Upsert the existence marker keyed on `tool`.
        tx.insert(toolBaselineMeta)
          .values({ tool, capturedAt })
          .onConflictDoUpdate({
            target: toolBaselineMeta.tool,
            set: { capturedAt: sql`excluded.captured_at` },
          })
          .run();
      });
      logger.info({
        evt: 'datastore.baseline.save.complete',
        module: MODULE_NAME,
        msg: 'Saved tool baseline',
        tool,
        count: rows.length,
      });
    } catch (error) {
      /* v8 ignore start */
      logger.error({
        evt: 'datastore.baseline.save.error',
        module: MODULE_NAME,
        msg: 'Failed to save tool baseline',
        tool,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
      /* v8 ignore stop */
    }
  }

  /** Load this tool's baseline rows (fingerprint + payload). Empty when none saved. */
  load(tool: string): readonly BaselineRow[] {
    try {
      const rows = this.datastore.db
        .select({
          fingerprint: toolBaselineEntries.fingerprint,
          payload: toolBaselineEntries.payload,
        })
        .from(toolBaselineEntries)
        .where(eq(toolBaselineEntries.tool, tool))
        .all();
      logger.info({
        evt: 'datastore.baseline.load.complete',
        module: MODULE_NAME,
        msg: 'Loaded tool baseline',
        tool,
        count: rows.length,
      });
      return rows.map((r) => ({ fingerprint: r.fingerprint, payload: r.payload as Signal | null }));
    } catch (error) {
      /* v8 ignore start */
      logger.error({
        evt: 'datastore.baseline.load.error',
        module: MODULE_NAME,
        msg: 'Failed to load tool baseline',
        tool,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
      /* v8 ignore stop */
    }
  }

  /** True iff this tool has saved a baseline (independent of whether it was empty). */
  exists(tool: string): boolean {
    const row = this.datastore.db
      .select({ tool: toolBaselineMeta.tool })
      .from(toolBaselineMeta)
      .where(eq(toolBaselineMeta.tool, tool))
      .limit(1)
      .get();
    return row !== undefined;
  }

  /** When this tool's baseline was captured (ms epoch), or undefined when none exists. */
  capturedAt(tool: string): number | undefined {
    const row = this.datastore.db
      .select({ capturedAt: toolBaselineMeta.capturedAt })
      .from(toolBaselineMeta)
      .where(eq(toolBaselineMeta.tool, tool))
      .limit(1)
      .get();
    return row?.capturedAt;
  }

  /**
   * Delete this tool's baseline — entries + the meta existence marker, one
   * transaction (`tools data purge`, ADR-0042). After a clear, `exists()` is
   * false (vs. `save(tool, [])`, which leaves an EMPTY-but-saved baseline).
   */
  clear(tool: string): { readonly entries: number; readonly meta: boolean } {
    let entries = 0;
    let meta = false;
    this.datastore.transaction((tx) => {
      entries = tx
        .delete(toolBaselineEntries)
        .where(eq(toolBaselineEntries.tool, tool))
        .run().changes;
      meta = tx.delete(toolBaselineMeta).where(eq(toolBaselineMeta.tool, tool)).run().changes > 0;
    });
    logger.info({
      evt: 'datastore.baseline.clear.complete',
      module: MODULE_NAME,
      msg: 'Cleared tool baseline',
      tool,
      entries,
      meta,
    });
    return { entries, meta };
  }
}

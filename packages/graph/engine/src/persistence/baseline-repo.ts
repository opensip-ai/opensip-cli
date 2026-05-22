import { logger, type Signal } from '@opensip-tools/core';
import { sql } from 'drizzle-orm';

import { fingerprintSignal } from '../gate.js';

import { graphBaselineMeta, graphBaselineSignals } from './schema.js';

import type { DataStore } from '@opensip-tools/datastore';

const MODULE_NAME = 'graph:baseline-repo';

export class GraphBaselineRepo {
  constructor(private readonly datastore: DataStore) {}

  /**
   * Replace the entire baseline with a fresh fingerprint set in one
   * transaction. Mirrors v1's atomic-rename-of-tmp-file semantic.
   */
  save(signals: readonly Signal[]): void {
    try {
      const capturedAt = Date.now();
      const rows = [...new Set(signals.map((s) => fingerprintSignal(s)))]
        .sort((a, b) => a.localeCompare(b))
        .map((fp) => ({ fingerprint: fp, capturedAt }));
      this.datastore.transaction((tx) => {
        tx.delete(graphBaselineSignals).run();
        if (rows.length > 0) {
          tx.insert(graphBaselineSignals).values(rows).run();
        }
        // Upsert the existence marker. An empty baseline is a valid
        // saved state; this row distinguishes "saved but no findings"
        // from "never saved".
        tx.insert(graphBaselineMeta)
          .values({ id: 1, capturedAt })
          .onConflictDoUpdate({
            target: graphBaselineMeta.id,
            set: { capturedAt: sql`excluded.captured_at` },
          })
          .run();
      });
      logger.info({
        evt: 'graph.baseline.save.complete',
        module: MODULE_NAME,
        msg: 'Saved graph baseline',
        count: rows.length,
      });
    } catch (error) {
      logger.error({
        evt: 'graph.baseline.save.error',
        module: MODULE_NAME,
        msg: 'Failed to save graph baseline',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Load the baseline fingerprint set. Empty array if no baseline exists. */
  loadFingerprints(): readonly string[] {
    try {
      const rows = this.datastore.db
        .select({ fingerprint: graphBaselineSignals.fingerprint })
        .from(graphBaselineSignals)
        .all();
      logger.info({
        evt: 'graph.baseline.load.complete',
        module: MODULE_NAME,
        msg: 'Loaded graph baseline',
        count: rows.length,
      });
      return rows.map((r) => r.fingerprint);
    } catch (error) {
      logger.error({
        evt: 'graph.baseline.load.error',
        module: MODULE_NAME,
        msg: 'Failed to load graph baseline',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** True iff a baseline has been saved (independent of whether the fingerprint set was empty). */
  exists(): boolean {
    const row = this.datastore.db.select().from(graphBaselineMeta).limit(1).get();
    if (!row) {
      logger.info({
        evt: 'graph.baseline.load.miss',
        module: MODULE_NAME,
        msg: 'No graph baseline marker present',
      });
    }
    return row !== undefined;
  }
}

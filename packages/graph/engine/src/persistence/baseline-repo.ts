import { logger, type Signal } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

import { fingerprintSignal } from '../gate.js';

import { graphBaselineSignals } from './schema.js';

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
      });
      logger.info({
        evt: 'graph.baseline.save.complete',
        module: 'graph:baseline-repo',
        msg: 'Saved graph baseline',
        count: rows.length,
      });
    } catch (error) {
      logger.error({
        evt: 'graph.baseline.save.error',
        module: 'graph:baseline-repo',
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
        module: 'graph:baseline-repo',
        msg: 'Loaded graph baseline',
        count: rows.length,
      });
      return rows.map((r) => r.fingerprint);
    } catch (error) {
      logger.error({
        evt: 'graph.baseline.load.error',
        module: 'graph:baseline-repo',
        msg: 'Failed to load graph baseline',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** True iff at least one fingerprint row is present. */
  exists(): boolean {
    const row = this.datastore.db
      .select({ fingerprint: graphBaselineSignals.fingerprint })
      .from(graphBaselineSignals)
      .limit(1)
      .get();
    if (!row) {
      logger.info({
        evt: 'graph.baseline.load.miss',
        module: 'graph:baseline-repo',
        msg: 'No graph baseline rows present',
      });
    }
    return row !== undefined;
  }
}

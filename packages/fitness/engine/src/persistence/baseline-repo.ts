import { logger } from '@opensip-tools/core';
import {
  requireDrizzleDataStore,
  type DataStore,
  type DrizzleDataStore,
} from '@opensip-tools/datastore';
import { sql } from 'drizzle-orm';

import { fitBaseline } from './schema.js';

const MODULE_NAME = 'fitness:baseline-repo';

/** Repository for the single-row SignalEnvelope baseline used by --gate-compare. */
export class FitBaselineRepo {
  private readonly datastore: DrizzleDataStore;

  constructor(datastore: DataStore) {
    this.datastore = requireDrizzleDataStore(datastore);
  }

  /** Persist a SignalEnvelope as the baseline. Overwrites any prior row. */
  save(payload: unknown, findingCount: number): void {
    try {
      const capturedAt = Date.now();
      this.datastore.db
        .insert(fitBaseline)
        .values({ id: 1, capturedAt, payload })
        .onConflictDoUpdate({
          target: fitBaseline.id,
          set: {
            capturedAt: sql`excluded.captured_at`,
            payload: sql`excluded.payload`,
          },
        })
        .run();
      logger.info({
        evt: 'fit.baseline.save.complete',
        module: MODULE_NAME,
        msg: 'Saved fit baseline',
        findingCount,
      });
    } catch (error) {
      logger.error({
        evt: 'fit.baseline.save.error',
        module: MODULE_NAME,
        msg: 'Failed to save fit baseline',
        /* v8 ignore next -- SQLite always throws Error subclasses; the String(error) fallback is defensive */
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Load the SignalEnvelope baseline. Returns `null` if no row is present. */
  load(): unknown {
    try {
      const row = this.datastore.db
        .select()
        .from(fitBaseline)
        .where(sql`id = 1`)
        .get();
      if (!row) {
        logger.info({
          evt: 'fit.baseline.load.miss',
          module: MODULE_NAME,
          msg: 'No fit baseline row',
        });
        return null;
      }
      logger.info({
        evt: 'fit.baseline.load.complete',
        module: MODULE_NAME,
      });
      return row.payload;
    } catch (error) {
      logger.error({
        evt: 'fit.baseline.load.error',
        module: MODULE_NAME,
        msg: 'Failed to load fit baseline',
        /* v8 ignore next -- SQLite always throws Error subclasses; the String(error) fallback is defensive */
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** True iff a baseline row exists. */
  exists(): boolean {
    const row = this.datastore.db
      .select()
      .from(fitBaseline)
      .where(sql`id = 1`)
      .limit(1)
      .get();
    return row !== undefined;
  }
}

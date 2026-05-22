import { logger } from '@opensip-tools/core';
import { sql } from 'drizzle-orm';

import { fitBaseline } from './schema.js';

import type { DataStore } from '@opensip-tools/datastore';

export class FitBaselineRepo {
  constructor(private readonly datastore: DataStore) {}

  /** Persist a SARIF document as the baseline. Overwrites any prior row. */
  save(sarif: unknown, findingCount: number): void {
    try {
      const capturedAt = Date.now();
      this.datastore.db
        .insert(fitBaseline)
        .values({ id: 1, capturedAt, sarifPayload: sarif })
        .onConflictDoUpdate({
          target: fitBaseline.id,
          set: {
            capturedAt: sql`excluded.captured_at`,
            sarifPayload: sql`excluded.sarif_payload`,
          },
        })
        .run();
      logger.info({
        evt: 'fit.baseline.save.complete',
        module: 'fitness:baseline-repo',
        msg: 'Saved fit baseline',
        findingCount,
      });
    } catch (error) {
      logger.error({
        evt: 'fit.baseline.save.error',
        module: 'fitness:baseline-repo',
        msg: 'Failed to save fit baseline',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Load the SARIF baseline. Returns `null` if no row is present. */
  load(): unknown {
    try {
      const row = this.datastore.db.select().from(fitBaseline).where(sql`id = 1`).get();
      if (!row) {
        logger.info({
          evt: 'fit.baseline.load.miss',
          module: 'fitness:baseline-repo',
          msg: 'No fit baseline row',
        });
        return null;
      }
      logger.info({
        evt: 'fit.baseline.load.complete',
        module: 'fitness:baseline-repo',
      });
      return row.sarifPayload;
    } catch (error) {
      logger.error({
        evt: 'fit.baseline.load.error',
        module: 'fitness:baseline-repo',
        msg: 'Failed to load fit baseline',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** True iff a baseline row exists. */
  exists(): boolean {
    const row = this.datastore.db.select().from(fitBaseline).where(sql`id = 1`).limit(1).get();
    return row !== undefined;
  }
}

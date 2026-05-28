import { SystemError, isToolShortId, logger } from '@opensip-tools/core';
import { desc, eq, lt } from 'drizzle-orm';

import { sessions, sessionChecks, sessionFindings } from './schema/sessions.js';

import type { StoredSession } from './store.js';
import type { ToolShortId } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

const MODULE_NAME = 'contracts:session-repo';

/** Filters for {@link SessionRepo.list}: tool short-id and/or max row count. */
export interface SessionListOptions {
  readonly tool?: ToolShortId;
  readonly limit?: number;
}

interface SessionSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
  readonly warnings: number;
}

function isSessionSummary(v: unknown): v is SessionSummary {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.total === 'number' &&
    typeof s.passed === 'number' &&
    typeof s.failed === 'number' &&
    typeof s.errors === 'number' &&
    typeof s.warnings === 'number'
  );
}

/** Persistence layer for tool-run sessions and their per-check findings. */
export class SessionRepo {
  constructor(private readonly datastore: DataStore) {}

  save(session: StoredSession): void {
    try {
      this.datastore.transaction((tx) => {
        tx.insert(sessions)
          .values({
            id: session.id,
            tool: session.tool,
            timestamp: new Date(session.timestamp).getTime(),
            cwd: session.cwd,
            recipe: session.recipe ?? null,
            score: session.score,
            passed: session.passed,
            summary: session.summary,
            durationMs: session.durationMs,
          })
          .run();
        for (const check of session.checks) {
          const inserted = tx
            .insert(sessionChecks)
            .values({
              sessionId: session.id,
              checkSlug: check.checkSlug,
              passed: check.passed,
              violationCount: check.violationCount ?? null,
              durationMs: check.durationMs,
            })
            .returning({ id: sessionChecks.id })
            .all();
          const sessionCheckId = inserted[0]?.id;
          if (sessionCheckId === undefined) continue;
          if (check.findings.length === 0) continue;
          tx.insert(sessionFindings)
            .values(
              check.findings.map((f) => ({
                sessionCheckId,
                ruleId: f.ruleId,
                severity: f.severity,
                message: f.message,
                filePath: f.filePath ?? null,
                line: f.line ?? null,
                column: f.column ?? null,
                suggestion: f.suggestion ?? null,
                category: f.category ?? null,
              })),
            )
            .run();
        }
      });
      logger.info({
        evt: 'session.save.complete',
        module: MODULE_NAME,
        msg: 'Session saved',
        sessionId: session.id,
        tool: session.tool,
        checkCount: session.checks.length,
      });
    } catch (error) {
      logger.error({
        evt: 'session.save.error',
        module: MODULE_NAME,
        msg: 'Failed to save session',
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  list(opts: SessionListOptions = {}): readonly StoredSession[] {
    try {
      const baseQuery = opts.tool
        ? this.datastore.db.select().from(sessions).where(eq(sessions.tool, opts.tool))
        : this.datastore.db.select().from(sessions);
      const ordered = baseQuery.orderBy(desc(sessions.timestamp));
      const sessionRows = opts.limit ? ordered.limit(opts.limit).all() : ordered.all();
      const results: StoredSession[] = [];
      for (const row of sessionRows) {
        results.push(this.hydrateSession(row));
      }
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

  latest(): StoredSession | null {
    const rows = this.list({ limit: 1 });
    return rows[0] ?? null;
  }

  count(): number {
    const rows = this.datastore.db.select({ id: sessions.id }).from(sessions).all();
    return rows.length;
  }

  /** Delete sessions older than the given Date. Returns affected rowcount. */
  purge(before: Date): number {
    try {
      const cutoff = before.getTime();
      const removed = this.datastore.db
        .delete(sessions)
        .where(lt(sessions.timestamp, cutoff))
        .run();
      logger.info({
        evt: 'session.purge.complete',
        module: MODULE_NAME,
        msg: 'Purged sessions older than cutoff',
        cutoff: before.toISOString(),
        deleted: removed.changes,
      });
      return removed.changes;
    } catch (error) {
      logger.error({
        evt: 'session.purge.error',
        module: MODULE_NAME,
        msg: 'Failed to purge sessions',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Delete every session. Returns affected rowcount. */
  clearAll(): number {
    const removed = this.datastore.db.delete(sessions).run();
    logger.info({
      evt: 'session.clear.complete',
      module: MODULE_NAME,
      msg: 'Cleared all sessions',
      deleted: removed.changes,
    });
    return removed.changes;
  }

  private hydrateSession(row: typeof sessions.$inferSelect): StoredSession {
    // Validate row.tool against the documented union — the SQLite column
    // is plain text with no CHECK constraint, so a legacy or hand-edited
    // row could carry a value outside the type. Casting blindly would
    // silently misroute downstream consumers that branch on `tool`.
    if (!isToolShortId(row.tool)) {
      throw new SystemError(
        `Session ${row.id} has unknown tool value: ${JSON.stringify(row.tool)}`,
        { code: 'SYSTEM.DATA.UNKNOWN_TOOL' },
      );
    }
    // Validate the JSON summary blob — drizzle returns it as `unknown` and
    // an older writer (or a corrupted row) could be missing fields. Reading
    // them as `undefined` where `number` is expected would corrupt history
    // display and gate comparison silently.
    if (!isSessionSummary(row.summary)) {
      throw new SystemError(
        `Session ${row.id} has corrupted summary JSON`,
        { code: 'SYSTEM.DATA.CORRUPT_SUMMARY' },
      );
    }
    // Hydrate checks + findings inside a single read transaction so the
    // multi-statement walk presents a consistent snapshot — otherwise a
    // concurrent writer could insert or delete findings between the
    // check-row fetch and the per-check finding fetch, producing phantom
    // or missing findings for the same session.
    const checks = this.datastore.transaction((tx) => {
      const checkRows = tx
        .select()
        .from(sessionChecks)
        .where(eq(sessionChecks.sessionId, row.id))
        .all();
      return checkRows.map((check) => {
        const findingRows = tx
          .select()
          .from(sessionFindings)
          .where(eq(sessionFindings.sessionCheckId, check.id))
          .all();
        return {
          checkSlug: check.checkSlug,
          passed: check.passed,
          violationCount: check.violationCount ?? undefined,
          findings: findingRows.map((f) => ({
            ruleId: f.ruleId,
            message: f.message,
            severity: f.severity,
            filePath: f.filePath ?? undefined,
            line: f.line ?? undefined,
            column: f.column ?? undefined,
            suggestion: f.suggestion ?? undefined,
            category: f.category ?? undefined,
          })),
          durationMs: check.durationMs,
        };
      });
    });
    return {
      id: row.id,
      tool: row.tool,
      timestamp: new Date(row.timestamp).toISOString(),
      cwd: row.cwd,
      recipe: row.recipe ?? undefined,
      score: row.score,
      passed: row.passed,
      summary: row.summary,
      checks,
      durationMs: row.durationMs,
    };
  }
}


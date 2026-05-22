import { logger } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';
import { desc, eq, lt } from 'drizzle-orm';

import { sessions, sessionChecks, sessionFindings } from './schema/sessions.js';
import type { StoredSession } from './store.js';

export interface SessionListOptions {
  readonly tool?: 'fit' | 'sim' | 'graph';
  readonly limit?: number;
}

interface SessionSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
  readonly warnings: number;
}

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
        module: 'contracts:session-repo',
        msg: 'Session saved',
        sessionId: session.id,
        tool: session.tool,
        checkCount: session.checks.length,
      });
    } catch (error) {
      logger.error({
        evt: 'session.save.error',
        module: 'contracts:session-repo',
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
        module: 'contracts:session-repo',
        msg: 'Listed sessions',
        count: results.length,
      });
      return results;
    } catch (error) {
      logger.error({
        evt: 'session.list.error',
        module: 'contracts:session-repo',
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
        module: 'contracts:session-repo',
        msg: 'Purged sessions older than cutoff',
        cutoff: before.toISOString(),
        deleted: removed.changes,
      });
      return removed.changes;
    } catch (error) {
      logger.error({
        evt: 'session.purge.error',
        module: 'contracts:session-repo',
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
      module: 'contracts:session-repo',
      msg: 'Cleared all sessions',
      deleted: removed.changes,
    });
    return removed.changes;
  }

  private hydrateSession(row: typeof sessions.$inferSelect): StoredSession {
    const checkRows = this.datastore.db
      .select()
      .from(sessionChecks)
      .where(eq(sessionChecks.sessionId, row.id))
      .all();
    const checks = checkRows.map((check) => {
      const findingRows = this.datastore.db
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
    return {
      id: row.id,
      tool: row.tool as StoredSession['tool'],
      timestamp: new Date(row.timestamp).toISOString(),
      cwd: row.cwd,
      recipe: row.recipe ?? undefined,
      score: row.score,
      passed: row.passed,
      summary: row.summary as SessionSummary,
      checks,
      durationMs: row.durationMs,
    };
  }
}


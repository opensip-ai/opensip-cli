import { logger, ValidationError } from '@opensip-cli/core';
import { desc, sql } from 'drizzle-orm';

import { requireDrizzleHandle, type DataStore, type DrizzleDataStore } from './data-store.js';
import { policyAuditEvents } from './schema/policy-audit.js';

const MODULE_NAME = 'datastore:policy-audit-repo';

export const POLICY_AUDIT_MAX_ROWS = 1000;
export const POLICY_AUDIT_DEFAULT_LIMIT = 50;
export const POLICY_AUDIT_MAX_LIMIT = 500;
export const POLICY_AUDIT_MAX_JSON_BYTES = 16 * 1024;
export const POLICY_AUDIT_MAX_STRING_BYTES = 2048;

export interface PolicyAuditAppendEvent {
  readonly id: string;
  readonly runId?: string;
  readonly timestamp: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly subject: unknown;
  readonly action: string;
  readonly outcome: string;
  readonly reasons: readonly string[];
  readonly sourceTiers: readonly string[];
  readonly matchedExceptionIds: readonly string[];
  readonly metadata?: unknown;
}

export interface PolicyAuditStoredEvent extends PolicyAuditAppendEvent {
  readonly metadata?: unknown;
}

export interface PolicyAuditListOptions {
  readonly limit?: number;
}

export class PolicyAuditRepo {
  private readonly datastore: DrizzleDataStore;

  // @yagni-ignore-next-line duplicate-body-candidate -- repository constructors intentionally share the datastore narrowing idiom.
  constructor(datastore: DataStore) {
    this.datastore = requireDrizzleHandle(datastore);
  }

  append(events: readonly PolicyAuditAppendEvent[]): number {
    if (events.length === 0) return 0;
    const rows = events.map(toRow);
    return this.datastore.withWriteLock('policy_audit.append', () => {
      let inserted = 0;
      this.datastore.transaction((tx) => {
        for (const row of rows) {
          inserted += tx.insert(policyAuditEvents).values(row).onConflictDoNothing().run().changes;
        }
        tx.run(sql`
          DELETE FROM policy_audit_events
          WHERE id NOT IN (
            SELECT id FROM policy_audit_events
            ORDER BY timestamp DESC, id DESC
            LIMIT ${POLICY_AUDIT_MAX_ROWS}
          )
        `);
      });
      logger.info({
        evt: 'datastore.policy_audit.append.complete',
        module: MODULE_NAME,
        count: inserted,
      });
      return inserted;
    });
  }

  list(options: PolicyAuditListOptions = {}): readonly PolicyAuditStoredEvent[] {
    const limit = clampPolicyAuditLimit(options.limit);
    return this.datastore.db
      .select()
      .from(policyAuditEvents)
      .orderBy(desc(policyAuditEvents.timestamp), desc(policyAuditEvents.id))
      .limit(limit)
      .all()
      .map((row) => ({
        id: row.id,
        ...(row.runId === null ? {} : { runId: row.runId }),
        timestamp: row.timestamp,
        subjectKind: row.subjectKind,
        subjectId: row.subjectId,
        subject: row.subject,
        action: row.action,
        outcome: row.outcome,
        reasons: stringArray(row.reasons),
        sourceTiers: stringArray(row.sourceTiers),
        matchedExceptionIds: stringArray(row.matchedExceptionIds),
        ...(row.metadata === null || row.metadata === undefined ? {} : { metadata: row.metadata }),
      }));
  }
}

function clampPolicyAuditLimit(limit: number | undefined): number {
  if (limit === undefined) return POLICY_AUDIT_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ValidationError(
      `Invalid policy audit limit '${String(limit)}'. Must be a positive integer.`,
      {
        code: 'VALIDATION.POLICY_AUDIT.LIMIT_INVALID',
      },
    );
  }
  return Math.min(limit, POLICY_AUDIT_MAX_LIMIT);
}

function toRow(event: PolicyAuditAppendEvent): typeof policyAuditEvents.$inferInsert {
  return {
    id: boundedString(event.id, 'id'),
    runId: event.runId === undefined ? null : boundedString(event.runId, 'runId'),
    timestamp: boundedString(event.timestamp, 'timestamp'),
    subjectKind: boundedString(event.subjectKind, 'subjectKind'),
    subjectId: boundedString(event.subjectId, 'subjectId'),
    subject: event.subject === undefined ? null : boundedJson(event.subject, 'subject'),
    action: boundedString(event.action, 'action'),
    outcome: boundedString(event.outcome, 'outcome'),
    reasons: boundedJson(event.reasons, 'reasons'),
    sourceTiers: boundedJson(event.sourceTiers, 'sourceTiers'),
    matchedExceptionIds: boundedJson(event.matchedExceptionIds, 'matchedExceptionIds'),
    metadata: event.metadata === undefined ? null : boundedJson(event.metadata, 'metadata'),
  };
}

function boundedString(value: string, field: string): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > POLICY_AUDIT_MAX_STRING_BYTES) {
    throw new ValidationError(
      `policy audit ${field} is ${bytes} bytes; max is ${POLICY_AUDIT_MAX_STRING_BYTES}`,
      { code: 'VALIDATION.POLICY_AUDIT.FIELD_TOO_LARGE' },
    );
  }
  return value;
}

function boundedJson(value: unknown, field: string): unknown {
  const bytes = Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
  if (bytes > POLICY_AUDIT_MAX_JSON_BYTES) {
    throw new ValidationError(
      `policy audit ${field} is ${bytes} bytes; max is ${POLICY_AUDIT_MAX_JSON_BYTES}`,
      { code: 'VALIDATION.POLICY_AUDIT.JSON_TOO_LARGE' },
    );
  }
  return value;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

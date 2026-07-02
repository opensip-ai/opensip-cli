import { ValidationError } from '@opensip-cli/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { requireDrizzleHandle } from '../data-store.js';
import { DataStoreFactory } from '../factory.js';
import {
  PolicyAuditRepo,
  POLICY_AUDIT_MAX_JSON_BYTES,
  POLICY_AUDIT_MAX_LIMIT,
  POLICY_AUDIT_MAX_ROWS,
} from '../policy-audit-repo.js';

import type { DataStore } from '../data-store.js';
import type { PolicyAuditAppendEvent } from '../policy-audit-repo.js';

let ds: DataStore;
let repo: PolicyAuditRepo;

function event(
  id: string,
  timestamp = `2026-07-02T00:00:${id.padStart(2, '0')}.000Z`,
): PolicyAuditAppendEvent {
  return {
    id: `policy_audit_${id}`,
    runId: 'run_1',
    timestamp,
    subjectKind: 'installed-tool',
    subjectId: `tool-${id}`,
    subject: { kind: 'installed-tool', id: `tool-${id}` },
    action: 'load',
    outcome: 'allow',
    reasons: ['ok'],
    sourceTiers: ['builtin'],
    matchedExceptionIds: [],
  };
}

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
  repo = new PolicyAuditRepo(ds);
});

afterEach(() => {
  ds.close();
});

describe('PolicyAuditRepo', () => {
  it('appends and lists newest events first', () => {
    expect(repo.append([event('1'), event('2')])).toBe(2);
    expect(repo.list().map((row) => row.id)).toEqual(['policy_audit_2', 'policy_audit_1']);
  });

  it('caps list limits to the documented maximum', () => {
    repo.append([event('1'), event('2')]);
    expect(repo.list({ limit: POLICY_AUDIT_MAX_LIMIT + 1 })).toHaveLength(2);
    expect(() => repo.list({ limit: 0 })).toThrow(ValidationError);
  });

  it('prunes older rows after append', () => {
    const rows = Array.from({ length: POLICY_AUDIT_MAX_ROWS + 2 }, (_value, index) =>
      event(
        String(index).padStart(4, '0'),
        `2026-07-02T00:${String(index).padStart(2, '0')}:00.000Z`,
      ),
    );
    repo.append(rows);
    const count = requireDrizzleHandle(ds).db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM policy_audit_events`,
    );
    expect(count?.count).toBe(POLICY_AUDIT_MAX_ROWS);
    expect(repo.list({ limit: POLICY_AUDIT_MAX_ROWS + 10 })).toHaveLength(POLICY_AUDIT_MAX_LIMIT);
    const oldest = requireDrizzleHandle(ds).db.get<{ id: string }>(
      sql`SELECT id FROM policy_audit_events ORDER BY timestamp ASC LIMIT 1`,
    );
    expect(oldest?.id).not.toBe('policy_audit_0000');
  });

  it('rejects oversized JSON payloads', () => {
    const oversized = {
      ...event('1'),
      metadata: { value: 'x'.repeat(POLICY_AUDIT_MAX_JSON_BYTES + 1) },
    };
    expect(() => repo.append([oversized])).toThrow(ValidationError);
  });
});

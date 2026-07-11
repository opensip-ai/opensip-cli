import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { DataStoreFactory, PolicyAuditRepo } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flushPolicyAuditEvents } from '../policy-audit-flush.js';
import { PolicyAuditCollector } from '../policy-audit.js';

import type { PolicyAuditEvent } from '@opensip-cli/config';
import type { DataStore } from '@opensip-cli/datastore';

let root: string;
let datastore: DataStore;

function event(overrides: Partial<PolicyAuditEvent> = {}): PolicyAuditEvent {
  return {
    occurredAt: '2026-07-02T00:00:00.000Z',
    action: 'load',
    subject: 'installed-tool:demo',
    outcome: 'allow-with-conditions',
    sourceTier: 'project',
    reasons: ['matched exception'],
    exceptionIds: ['ex-1'],
    metadata: { packageName: 'demo' },
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-policy-audit-flush-'));
  datastore = DataStoreFactory.open({ backend: 'sqlite', path: join(root, 'd.sqlite') });
});

afterEach(() => {
  datastore.close();
  rmSync(root, { recursive: true, force: true });
});

describe('flushPolicyAuditEvents', () => {
  it('returns zero when no policy audit collector is available', () => {
    expect(flushPolicyAuditEvents(datastore)).toBe(0);
  });

  it('returns zero for an empty collector without draining it', () => {
    const audit = new PolicyAuditCollector('run-1');
    const scope = new RunScope({ policyAudit: audit, datastore: () => datastore });

    const inserted = runWithScopeSync(scope, () => flushPolicyAuditEvents());

    expect(inserted).toBe(0);
    expect(audit.list()).toEqual([]);
  });

  it('persists buffered events through the scoped datastore and drains the collector', () => {
    const audit = new PolicyAuditCollector('run-1');
    audit.record(event());
    audit.record(event({ subject: 'not-a-policy-subject', action: 'install', outcome: 'deny' }));
    const scope = new RunScope({ policyAudit: audit, datastore: () => datastore });

    const inserted = runWithScopeSync(scope, () => flushPolicyAuditEvents());

    expect(inserted).toBe(2);
    expect(audit.list()).toEqual([]);
    const rows = new PolicyAuditRepo(datastore).list({ limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.subjectKind === 'installed-tool')).toMatchObject({
      runId: 'run-1',
      subjectKind: 'installed-tool',
      subjectId: 'demo',
      action: 'load',
      sourceTiers: ['project'],
      matchedExceptionIds: ['ex-1'],
    });
    expect(rows.find((row) => row.subjectKind === 'unknown')).toMatchObject({
      subjectKind: 'unknown',
      subjectId: 'not-a-policy-subject',
      action: 'install',
      outcome: 'deny',
    });
  });

  it('keeps buffered events when datastore lookup or append fails', () => {
    const unavailable = new PolicyAuditCollector();
    unavailable.record(event());
    const unavailableScope = new RunScope({
      policyAudit: unavailable,
      datastore: () => {
        throw new Error('no datastore');
      },
    });

    expect(runWithScopeSync(unavailableScope, () => flushPolicyAuditEvents())).toBe(0);
    expect(unavailable.list()).toHaveLength(1);

    const failing = new PolicyAuditCollector();
    failing.record(event());
    const failingStore = {
      close: () => undefined,
      transaction: () => {
        throw new Error('not drizzle-backed');
      },
      withWriteLock: (_operation: string, fn: () => unknown) => fn(),
    };

    const inserted = runWithScopeSync(new RunScope({ policyAudit: failing }), () =>
      flushPolicyAuditEvents(failingStore as DataStore),
    );

    expect(inserted).toBe(0);
    expect(failing.list()).toHaveLength(1);
  });
});

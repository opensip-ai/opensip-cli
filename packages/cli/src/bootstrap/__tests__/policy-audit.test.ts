import { describe, expect, it } from 'vitest';

import { PolicyAuditCollector, isPolicyAuditCollector } from '../policy-audit.js';

import type { PolicyAuditEvent } from '@opensip-cli/config';

function event(action: PolicyAuditEvent['action'] = 'load'): PolicyAuditEvent {
  return {
    occurredAt: '2026-07-02T00:00:00.000Z',
    action,
    subject: 'installed-tool:demo',
    outcome: 'allow',
    sourceTier: 'project',
    reasons: ['trusted'],
    exceptionIds: [],
    metadata: {},
  };
}

describe('PolicyAuditCollector', () => {
  it('records, lists, drains, and identifies collectors', () => {
    const collector = new PolicyAuditCollector('run_1');
    collector.record(event());

    expect(isPolicyAuditCollector(collector)).toBe(true);
    expect(isPolicyAuditCollector({})).toBe(false);
    expect(collector.list()).toMatchObject([
      {
        runId: 'run_1',
        action: 'load',
        subject: 'installed-tool:demo',
      },
    ]);
    const drained = collector.drain();
    expect(drained).toHaveLength(1);
    expect(collector.list()).toEqual([]);
  });

  it('merges drained events and stamps missing run ids', () => {
    const source = new PolicyAuditCollector();
    source.record(event('install'));
    const target = new PolicyAuditCollector('run_2');

    target.merge(source);

    expect(source.list()).toEqual([]);
    expect(target.list()).toMatchObject([{ runId: 'run_2', action: 'install' }]);
  });
});

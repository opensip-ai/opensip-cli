import { renderToText } from '@opensip-cli/cli-ui';
import { describe, expect, it } from 'vitest';

import {
  viewPolicyAudit,
  viewPolicyExplain,
  viewPolicyResult,
  viewPolicyStatus,
} from '../policy-views.js';

import type {
  PolicyAuditResult,
  PolicyExplainResult,
  PolicyStatusResult,
} from '@opensip-cli/contracts';

function status(overrides: Partial<PolicyStatusResult> = {}): PolicyStatusResult {
  return {
    type: 'policy-status',
    mode: 'strict',
    ci: 'strict',
    orgStatus: { state: 'required-unavailable', reason: 'cache stale' },
    sources: ['builtin', 'project'],
    exceptions: [
      {
        id: 'temp-demo',
        subject: 'installed-tool:demo',
        action: 'load',
        expiresAt: '2026-09-01T00:00:00.000Z',
        sourceTier: 'project',
      },
      {
        id: 'no-expiry',
        subject: 'baseline:fit',
        action: 'baseline-save',
        sourceTier: 'org',
      },
    ],
    ...overrides,
  };
}

function explain(overrides: Partial<PolicyExplainResult> = {}): PolicyExplainResult {
  return {
    type: 'policy-explain',
    subject: 'installed-tool:demo',
    action: 'load',
    decision: {
      outcome: 'allow-with-conditions',
      reasons: ['optional org policy unavailable'],
      matchedExceptionIds: ['temp-demo'],
      sourceTiers: ['builtin', 'project'],
    },
    ...overrides,
  };
}

function audit(overrides: Partial<PolicyAuditResult> = {}): PolicyAuditResult {
  return {
    type: 'policy-audit',
    totalCount: 2,
    exportedTo: '/workspace/policy.json',
    events: [
      {
        id: 'evt-1',
        runId: 'run-1',
        timestamp: '2026-07-02T00:00:00.000Z',
        subject: 'installed-tool:demo',
        subjectKind: 'installed-tool',
        action: 'load',
        outcome: 'deny',
        reasons: ['strict mode'],
        matchedExceptionIds: [],
        sourceTiers: ['project'],
      },
      {
        id: 'evt-2',
        timestamp: '2026-07-02T00:00:01.000Z',
        subject: 'baseline:fit',
        subjectKind: 'baseline',
        action: 'baseline-save',
        outcome: 'allow-with-conditions',
        reasons: [],
        matchedExceptionIds: ['temp-demo'],
        sourceTiers: ['org'],
      },
    ],
    ...overrides,
  };
}

describe('policy views', () => {
  it('renders status with org reason, sources, and exceptions', () => {
    const out = renderToText(viewPolicyStatus(status()));

    expect(out).toContain('Policy');
    expect(out).toContain('mode strict');
    expect(out).toContain('required-unavailable');
    expect(out).toContain('cache stale');
    expect(out).toContain('temp-demo');
    expect(out).toContain('no-expiry');
  });

  it('renders status defaults when sources and exceptions are empty', () => {
    const out = renderToText(
      viewPolicyResult(
        status({
          orgStatus: { state: 'available', sourceTier: 'builtin' },
          sources: [],
          exceptions: [],
        }),
      ),
    );

    expect(out).toContain('Sources: builtin');
  });

  it('renders explain decisions with and without matched exceptions', () => {
    const conditioned = renderToText(viewPolicyExplain(explain()));
    expect(conditioned).toContain('allow-with-conditions');
    expect(conditioned).toContain('Exceptions:');
    expect(conditioned).toContain('temp-demo');

    const allowed = renderToText(
      viewPolicyResult(
        explain({
          decision: {
            outcome: 'allow',
            reasons: [],
            matchedExceptionIds: [],
            sourceTiers: ['builtin'],
          },
        }),
      ),
    );
    expect(allowed).toContain('Outcome:');
    expect(allowed).not.toContain('Exceptions:');
  });

  it('renders audit rows, empty state, and export path', () => {
    const rendered = renderToText(viewPolicyAudit(audit()));
    expect(rendered).toContain('Policy audit');
    expect(rendered).toContain('exported /workspace/policy.json');
    expect(rendered).toContain('strict mode');
    expect(rendered).toContain('-');

    expect(renderToText(viewPolicyAudit(audit({ events: [], totalCount: 0 })))).toContain(
      'No policy audit events recorded.',
    );
  });
});

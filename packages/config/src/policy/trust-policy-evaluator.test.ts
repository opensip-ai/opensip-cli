import { describe, expect, it } from 'vitest';

import { evaluateTrustPolicy } from './trust-policy-evaluator.js';
import { resolveTrustPolicySources } from './trust-policy-resolution.js';

const NOW = new Date('2026-07-02T00:00:00.000Z');

describe('evaluateTrustPolicy', () => {
  it('preserves default-mode local trust with conditions when provenance is unavailable', () => {
    const policy = resolveTrustPolicySources([], NOW);
    const decision = evaluateTrustPolicy(policy, {
      subject: { kind: 'installed-tool', id: 'demo', source: 'installed' },
      action: 'load',
      evidence: { legacyTrusted: true, provenanceStatus: 'unavailable' },
      now: NOW,
    });

    expect(decision.outcome).toBe('allow-with-conditions');
    expect(decision.reasons.join(' ')).toContain('default mode preserves local trust');
  });

  it('denies unverified executable loads in strict mode', () => {
    const policy = resolveTrustPolicySources(
      [{ tier: 'project', policy: { mode: 'strict' } }],
      NOW,
    );
    const decision = evaluateTrustPolicy(policy, {
      subject: { kind: 'installed-tool', id: 'demo', source: 'installed' },
      action: 'load',
      evidence: { legacyTrusted: true, provenanceStatus: 'unavailable' },
      now: NOW,
    });

    expect(decision.outcome).toBe('deny');
    expect(decision.reasons.join(' ')).toContain('strict mode requires verified provenance');
  });

  it('allows a strict-mode action with an unexpired exact exception', () => {
    const policy = resolveTrustPolicySources(
      [
        {
          tier: 'project',
          policy: {
            mode: 'strict',
            exceptions: [
              {
                id: 'temp-demo',
                subject: 'installed-tool:demo',
                action: 'load',
                reason: 'temporary rollout',
                expiresAt: '2026-09-01T00:00:00.000Z',
              },
            ],
          },
        },
      ],
      NOW,
    );
    const decision = evaluateTrustPolicy(policy, {
      subject: { kind: 'installed-tool', id: 'demo', source: 'installed' },
      action: 'load',
      evidence: { legacyTrusted: true, provenanceStatus: 'unavailable' },
      now: NOW,
    });

    expect(decision.outcome).toBe('allow');
    expect(decision.matchedExceptionIds).toEqual(['temp-demo']);
  });

  it('fails closed when required org policy is unavailable', () => {
    const policy = resolveTrustPolicySources(
      [
        { tier: 'project', policy: { org: { required: true } } },
        { tier: 'org', orgStatus: { state: 'required-unavailable', reason: 'cache stale' } },
      ],
      NOW,
    );
    const decision = evaluateTrustPolicy(policy, {
      subject: { kind: 'baseline', id: 'fit' },
      action: 'baseline-save',
      now: NOW,
    });

    expect(decision.outcome).toBe('deny');
    expect(decision.reasons).toContain('required org policy unavailable: cache stale');
  });
});

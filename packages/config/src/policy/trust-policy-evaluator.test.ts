import { describe, expect, it } from 'vitest';

import { evaluateTrustPolicy } from './trust-policy-evaluator.js';
import { resolveTrustPolicySources } from './trust-policy-resolution.js';

import type { PolicyResourceRequirement } from './trust-policy-schema.js';

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
    expect(decision.auditEvent.sourceTier).toBe('project');
  });

  it('attributes CI-mode decisions to the tier that supplied the CI policy', () => {
    const policy = resolveTrustPolicySources(
      [
        { tier: 'org', policy: { mode: 'default' } },
        { tier: 'project', policy: { ci: 'strict' } },
      ],
      NOW,
    );
    const decision = evaluateTrustPolicy(policy, {
      subject: { kind: 'baseline', id: 'fit' },
      action: 'baseline-save',
      evidence: { ci: true },
      now: NOW,
    });

    expect(decision.outcome).toBe('deny');
    expect(decision.auditEvent.sourceTier).toBe('project');
  });

  it('keeps legacy resolved-policy objects auditable when scalar provenance is absent', () => {
    const resolved = resolveTrustPolicySources([], NOW);
    const legacy = {
      mode: resolved.mode,
      ci: resolved.ci,
      exceptions: resolved.exceptions,
      org: resolved.org,
      orgStatus: resolved.orgStatus,
      sourceTiers: resolved.sourceTiers,
      capabilityGrants: resolved.capabilityGrants,
    };
    const decision = evaluateTrustPolicy(legacy, {
      subject: { kind: 'baseline', id: 'fit' },
      action: 'baseline-save',
      now: NOW,
    });

    expect(decision.auditEvent.sourceTier).toBe('builtin');
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

  it('returns a worker resource decision for allowed external capability packs', () => {
    const policy = resolveTrustPolicySources([], NOW);
    const decision = evaluateTrustPolicy(policy, {
      subject: { kind: 'capability-pack', id: '@acme/fit-pack', source: 'capability-pack' },
      action: 'load',
      evidence: {
        legacyTrusted: true,
        provenanceStatus: 'unavailable',
        declaredResources: [
          { resource: 'env', scope: 'OPENAI_API_KEY', reason: 'fixture auth' },
          { resource: 'network', scope: 'https://example.test', reason: 'metadata fetch' },
        ],
        targetDomain: 'fit-pack',
        manifestHash: 'sha256:abc',
      },
      now: NOW,
    });

    expect(decision.outcome).toBe('allow-with-conditions');
    expect(decision.resourceDecision).toEqual({
      isolation: 'worker',
      allowedResources: [
        { resource: 'env', scope: 'OPENAI_API_KEY', reason: 'fixture auth' },
        { resource: 'network', scope: 'https://example.test', reason: 'metadata fetch' },
      ],
      denyUndeclared: true,
      reasons: [
        'external capability pack must run in a resource-bounded worker',
        'undeclared resources are denied',
      ],
    });
    expect(decision.auditEvent.metadata.resourceDecision).toMatchObject({
      isolation: 'worker',
      denyUndeclared: true,
    });
  });

  it('returns a host resource decision only for bundled capability packs', () => {
    const policy = resolveTrustPolicySources([], NOW);
    const decision = evaluateTrustPolicy(policy, {
      subject: { kind: 'capability-pack', id: '@opensip-cli/checks-typescript' },
      action: 'load',
      evidence: {
        legacyTrusted: true,
        bundled: true,
        provenanceStatus: 'verified',
        declaredResources: [],
      },
      now: NOW,
    });

    expect(decision.outcome).toBe('allow');
    expect(decision.resourceDecision?.isolation).toBe('host');
    expect(decision.resourceDecision?.denyUndeclared).toBe(true);
  });

  it('does not grant resources for denied capability pack loads', () => {
    const policy = resolveTrustPolicySources(
      [{ tier: 'project', policy: { mode: 'strict' } }],
      NOW,
    );
    const decision = evaluateTrustPolicy(policy, {
      subject: { kind: 'capability-pack', id: '@acme/fit-pack' },
      action: 'load',
      evidence: {
        legacyTrusted: true,
        provenanceStatus: 'unavailable',
        declaredResources: [{ resource: 'env', scope: 'TOKEN' }],
      },
      now: NOW,
    });

    expect(decision.outcome).toBe('deny');
    expect(decision.resourceDecision).toBeUndefined();
    expect(decision.auditEvent.metadata.resourceDecision).toBeUndefined();
  });

  it('applies CI strict mode, optional org conditions, and expired exceptions', () => {
    const policy = resolveTrustPolicySources(
      [
        {
          tier: 'project',
          policy: {
            ci: 'strict',
            exceptions: [
              {
                id: 'expired',
                subject: 'installed-tool:demo',
                action: 'load',
                reason: 'expired rollout',
                expiresAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        },
        { tier: 'org', orgStatus: { state: 'optional-unavailable', reason: 'cache stale' } },
      ],
      NOW,
    );

    const load = evaluateTrustPolicy(policy, {
      subject: { kind: 'installed-tool', id: 'demo' },
      action: 'load',
      evidence: { legacyTrusted: true, provenanceStatus: 'unavailable', ci: true },
      now: NOW,
    });
    expect(load.outcome).toBe('deny');
    expect(load.matchedExceptionIds).toEqual([]);
    expect(load.reasons.join(' ')).toContain('optional org policy unavailable');

    const runtimeExclude = evaluateTrustPolicy(policy, {
      subject: { kind: 'runtime-exclude', id: 'paths' },
      action: 'runtime-exclude',
      evidence: { ci: false },
      now: NOW,
    });
    expect(runtimeExclude.outcome).toBe('allow-with-conditions');
    expect(runtimeExclude.reasons.join(' ')).toContain('runtime exclude is per-run');
  });

  it('denies locally untrusted executables and sanitizes metadata', () => {
    const policy = resolveTrustPolicySources([], NOW);
    const decision = evaluateTrustPolicy(policy, {
      subject: { kind: 'user-global-tool', id: 'demo' },
      action: 'install',
      evidence: {
        legacyTrusted: false,
        provenanceStatus: 'failed',
        token: 'token=secret-value',
        nested: { apiKey: 'api_key=abc123', ignored: Symbol('skip') },
      },
      now: NOW,
    });

    expect(decision.outcome).toBe('deny');
    expect(decision.provenanceStatus).toBe('failed');
    expect(decision.auditEvent.metadata).toMatchObject({
      provenanceStatus: 'failed',
      token: 'token=<redacted>',
      nested: { 'apiKey=<redacted>': 'api_key=<redacted>' },
    });
  });

  it('normalizes capability resources defensively', () => {
    const policy = resolveTrustPolicySources([], NOW);
    const decision = evaluateTrustPolicy(policy, {
      subject: { kind: 'capability-pack', id: '@acme/fit-pack' },
      action: 'load',
      evidence: {
        legacyTrusted: true,
        declaredResources: [
          { resource: 'filesystem', scope: 'src/**' },
          // Deliberately malformed entries — this test asserts the evaluator
          // normalizes untrusted declared resources defensively (drops both).
          { resource: 'not-real', scope: 'ignored' } as unknown as PolicyResourceRequirement,
          null as unknown as PolicyResourceRequirement,
          { resource: 'subprocess', reason: 'run scanner' },
        ],
      },
      now: NOW,
    });

    expect(decision.resourceDecision?.allowedResources).toEqual([
      { resource: 'filesystem', scope: 'src/**' },
      { resource: 'subprocess', reason: 'run scanner' },
    ]);
  });

  it('does not let arbitrary evidence forge authoritative audit metadata', () => {
    const policy = resolveTrustPolicySources(
      [{ tier: 'project', policy: { mode: 'strict' } }],
      NOW,
    );
    const decision = evaluateTrustPolicy(policy, {
      subject: { kind: 'installed-tool', id: 'demo' },
      action: 'load',
      evidence: {
        legacyTrusted: true,
        provenanceStatus: 'unavailable',
        subjectKind: 'baseline',
        policyMode: 'default',
        sourceTiers: ['forged'],
        orgStatus: 'forged',
        resourceDecision: { isolation: 'host' },
      },
      now: NOW,
    });

    expect(decision.auditEvent.metadata).toMatchObject({
      subjectKind: 'installed-tool',
      provenanceStatus: 'unavailable',
      policyMode: 'strict',
      sourceTiers: ['builtin', 'project'],
      orgStatus: 'available',
    });
    expect(decision.auditEvent.metadata).not.toHaveProperty('resourceDecision');
  });
});

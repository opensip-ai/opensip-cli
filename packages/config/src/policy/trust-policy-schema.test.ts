import { describe, expect, it } from 'vitest';

import { resolveTrustPolicySources } from './trust-policy-resolution.js';
import {
  capabilityIsolationLevelSchema,
  capabilityTrustGrantSchema,
  formatPolicySubject,
  orgPolicyCacheSchema,
  parsePolicySubject,
  policyDecisionOutcomeSchema,
  policyResourceClassSchema,
  policySubjectKindSchema,
  provenanceStatusSchema,
  trustPolicyExceptionSchema,
  trustPolicyOrgConfigSchema,
  trustPolicySchema,
  userTrustPolicySchema,
} from './trust-policy-schema.js';

const GRANT = {
  id: '@acme/fit-rules',
  manifestHash: `sha256:${'a'.repeat(64)}`,
};

describe('capability trust grants (plan 09 Phase 3 — user-tier-only surface)', () => {
  it('accepts grants on the USER document and rejects them on the project document', () => {
    expect(userTrustPolicySchema.parse({ trustedCapabilityPacks: [GRANT] })).toMatchObject({
      trustedCapabilityPacks: [GRANT],
    });
    // The project tier stays on the strict base schema: a trust block inside
    // the analyzed repo's config is a HARD schema error, never silently
    // ignored — it must not even appear load-bearing.
    expect(() => trustPolicySchema.parse({ trustedCapabilityPacks: [GRANT] })).toThrow();
  });

  it('requires exact ids and a sha256 provenance binding', () => {
    expect(() =>
      capabilityTrustGrantSchema.parse({ id: '', manifestHash: GRANT.manifestHash }),
    ).toThrow();
    expect(() =>
      capabilityTrustGrantSchema.parse({ id: '@acme/fit-rules', manifestHash: 'sha256:short' }),
    ).toThrow();
    expect(() => capabilityTrustGrantSchema.parse({ id: '@acme/fit-rules' })).toThrow();
  });

  it('resolves grants from the user tier only (defensive against other tiers)', () => {
    const NOW = new Date('2026-07-18T00:00:00.000Z');
    const resolved = resolveTrustPolicySources(
      [
        { tier: 'user', policy: { trustedCapabilityPacks: [GRANT] } },
        {
          tier: 'project',
          policy: { trustedCapabilityPacks: [{ ...GRANT, id: '@evil/injected' }] },
        },
      ],
      NOW,
    );
    expect(resolved.capabilityGrants).toEqual([GRANT]);
  });

  it('defaults to no grants (absent field reads as deny)', () => {
    const resolved = resolveTrustPolicySources([], new Date('2026-07-18T00:00:00.000Z'));
    expect(resolved.capabilityGrants).toEqual([]);
  });
});

describe('trust policy schemas', () => {
  it('validates trust policy documents and bounded exception subjects', () => {
    expect(
      trustPolicySchema.parse({
        mode: 'strict',
        ci: 'default',
        exceptions: [
          {
            id: 'temporary-tool',
            subject: 'installed-tool:demo',
            action: 'load',
            reason: 'temporary rollout',
            expiresAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        org: { required: true, cachePath: '.opensip/org-policy.json', maxAgeMs: 1000 },
      }),
    ).toMatchObject({ mode: 'strict' });

    expect(() =>
      trustPolicyExceptionSchema.parse({
        id: 'wildcard',
        subject: 'installed-tool:*',
        action: 'load',
        reason: 'wildcards are ambiguous',
        expiresAt: '2026-08-01T00:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      trustPolicyExceptionSchema.parse({
        id: 'unknown-kind',
        subject: 'unknown:demo',
        action: 'load',
        reason: 'bad kind',
        expiresAt: '2026-08-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('validates org cache and enum surfaces used by policy decisions', () => {
    expect(trustPolicyOrgConfigSchema.parse({ maxAgeMs: 2_592_000_000 })).toMatchObject({
      maxAgeMs: 2_592_000_000,
    });
    expect(() => trustPolicyOrgConfigSchema.parse({ maxAgeMs: 2_678_400_000 })).toThrow();
    expect(
      orgPolicyCacheSchema.parse({
        schemaVersion: 1,
        generatedAt: '2026-07-02T00:00:00.000Z',
        policy: { mode: 'default' },
      }),
    ).toMatchObject({ schemaVersion: 1 });

    expect(policySubjectKindSchema.parse('baseline')).toBe('baseline');
    expect(policyDecisionOutcomeSchema.parse('allow-with-conditions')).toBe(
      'allow-with-conditions',
    );
    expect(provenanceStatusSchema.parse('verified')).toBe('verified');
    expect(policyResourceClassSchema.parse('network')).toBe('network');
    expect(capabilityIsolationLevelSchema.parse('worker')).toBe('worker');
  });

  it('formats and parses policy subjects', () => {
    expect(formatPolicySubject({ kind: 'capability-pack', id: '@acme/fit-pack' })).toBe(
      'capability-pack:@acme/fit-pack',
    );
    expect(parsePolicySubject('capability-pack:@acme/fit-pack')).toEqual({
      kind: 'capability-pack',
      id: '@acme/fit-pack',
    });
    expect(parsePolicySubject('bad-subject')).toBeUndefined();
    expect(parsePolicySubject('unknown:thing')).toBeUndefined();
  });
});

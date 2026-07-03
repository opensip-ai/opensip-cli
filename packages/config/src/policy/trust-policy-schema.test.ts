import { describe, expect, it } from 'vitest';

import {
  capabilityIsolationLevelSchema,
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
} from './trust-policy-schema.js';

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

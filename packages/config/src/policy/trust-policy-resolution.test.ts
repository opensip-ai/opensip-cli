import { describe, expect, it } from 'vitest';

import { resolveTrustPolicySources } from './trust-policy-resolution.js';

const NOW = new Date('2026-07-19T00:00:00.000Z');

function exception(id: string) {
  return {
    id,
    subject: 'baseline:fit',
    action: 'baseline-save' as const,
    reason: `${id} rollout`,
    expiresAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('resolveTrustPolicySources', () => {
  it('applies canonical tier precedence regardless of input order', () => {
    const resolved = resolveTrustPolicySources(
      [
        {
          tier: 'org',
          policy: { mode: 'default', exceptions: [exception('org')] },
        },
        {
          tier: 'user',
          policy: { mode: 'default', exceptions: [exception('user')] },
        },
        {
          tier: 'project',
          policy: { mode: 'strict', exceptions: [exception('project')] },
        },
      ],
      NOW,
    );

    expect(resolved.mode).toBe('default');
    expect(resolved.modeSourceTier).toBe('org');
    expect(resolved.sourceTiers).toEqual(['builtin', 'user', 'project', 'org']);
    expect(resolved.exceptions.map(({ id }) => id)).toEqual(['user', 'project', 'org']);
  });

  it('tracks the source tier of independently resolved mode scalars', () => {
    const resolved = resolveTrustPolicySources(
      [
        { tier: 'org', policy: { mode: 'default' } },
        { tier: 'project', policy: { ci: 'strict' } },
      ],
      NOW,
    );

    expect(resolved.modeSourceTier).toBe('org');
    expect(resolved.ciSourceTier).toBe('project');
  });

  it('omits expired exceptions from the resolved active policy', () => {
    const resolved = resolveTrustPolicySources(
      [
        {
          tier: 'project',
          policy: {
            exceptions: [
              {
                ...exception('expired'),
                expiresAt: '2026-07-18T00:00:00.000Z',
              },
              exception('active'),
            ],
          },
        },
      ],
      NOW,
    );

    expect(resolved.exceptions.map(({ id }) => id)).toEqual(['active']);
  });
});

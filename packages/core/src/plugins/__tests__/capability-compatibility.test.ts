import { describe, expect, it } from 'vitest';

import { checkCapabilityContributionCompatibility } from '../capability-compatibility.js';

import type { CapabilityDomainSpec } from '../../tools/capability.js';

function domain(overrides: Partial<CapabilityDomainSpec> = {}): CapabilityDomainSpec {
  return {
    id: 'items',
    ownerToolId: 'items-tool',
    apiVersion: 2,
    minSupportedApiVersion: 1,
    contributionSchema: undefined,
    contributionKind: 'module-export',
    ...overrides,
  };
}

describe('checkCapabilityContributionCompatibility', () => {
  it('accepts a compatible current epoch', () => {
    expect(
      checkCapabilityContributionCompatibility({
        targetDomainId: 'items',
        packageTargetDomain: 'items',
        packageTargetDomainApiVersion: 2,
        domainSpec: domain(),
      }),
    ).toEqual({ kind: 'compatible' });
  });

  it('accepts a compatible minimum epoch', () => {
    expect(
      checkCapabilityContributionCompatibility({
        targetDomainId: 'items',
        packageTargetDomain: 'items',
        packageTargetDomainApiVersion: 1,
        domainSpec: domain(),
      }),
    ).toEqual({ kind: 'compatible' });
  });

  it('rejects a too-old epoch', () => {
    const verdict = checkCapabilityContributionCompatibility({
      targetDomainId: 'items',
      packageTargetDomain: 'items',
      packageTargetDomainApiVersion: 0,
      domainSpec: domain(),
    });
    expect(verdict.kind).toBe('incompatible');
    if (verdict.kind === 'incompatible') {
      expect(verdict.reason).toContain('supported range is 1..2');
    }
  });

  it('rejects a future epoch', () => {
    const verdict = checkCapabilityContributionCompatibility({
      targetDomainId: 'items',
      packageTargetDomain: 'items',
      packageTargetDomainApiVersion: 3,
      domainSpec: domain(),
    });
    expect(verdict.kind).toBe('incompatible');
    if (verdict.kind === 'incompatible') {
      expect(verdict.reason).toContain('supported range is 1..2');
    }
  });

  it('rejects a wrong target domain', () => {
    const verdict = checkCapabilityContributionCompatibility({
      targetDomainId: 'items',
      packageTargetDomain: 'other',
      packageTargetDomainApiVersion: 1,
      domainSpec: domain(),
    });
    expect(verdict.kind).toBe('incompatible');
    if (verdict.kind === 'incompatible') {
      expect(verdict.reason).toContain("targets domain 'other'");
    }
  });

  it('rejects missing target domain metadata', () => {
    const verdict = checkCapabilityContributionCompatibility({
      targetDomainId: 'items',
      packageTargetDomainApiVersion: 1,
      domainSpec: domain(),
    });
    expect(verdict.kind).toBe('incompatible');
    if (verdict.kind === 'incompatible') {
      expect(verdict.reason).toContain('missing opensipTools.targetDomain');
    }
  });

  it('rejects missing target domain API epoch metadata', () => {
    const verdict = checkCapabilityContributionCompatibility({
      targetDomainId: 'items',
      packageTargetDomain: 'items',
      domainSpec: domain(),
    });
    expect(verdict.kind).toBe('incompatible');
    if (verdict.kind === 'incompatible') {
      expect(verdict.reason).toContain('missing opensipTools.targetDomainApiVersion');
    }
  });
});

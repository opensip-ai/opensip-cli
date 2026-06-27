import { checkCapabilityContributionCompatibility } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import type { CapabilityDomainSpec } from '@opensip-cli/core';

const documentedFitPackManifest = {
  kind: 'fit-pack',
  targetDomain: 'fit-pack',
  targetDomainApiVersion: 1,
} as const;

const documentedGraphAdapterManifest = {
  kind: 'graph-adapter',
  targetDomain: 'graph-adapter',
  targetDomainApiVersion: 1,
} as const;

function domainSpec(targetDomainId: string): CapabilityDomainSpec {
  return {
    id: targetDomainId,
    ownerToolId: 'fixture-tool',
    apiVersion: 1,
    minSupportedApiVersion: 1,
    contributionKind: 'module-export',
    contributionSchema: { type: 'object' },
  };
}

function compatibilityKind(opensipToolsBlock: unknown, targetDomainId: string): string {
  const block =
    typeof opensipToolsBlock === 'object' &&
    opensipToolsBlock !== null &&
    !Array.isArray(opensipToolsBlock)
      ? (opensipToolsBlock as Record<string, unknown>)
      : {};
  return checkCapabilityContributionCompatibility({
    targetDomainId,
    packageTargetDomain: typeof block.targetDomain === 'string' ? block.targetDomain : undefined,
    packageTargetDomainApiVersion:
      typeof block.targetDomainApiVersion === 'number' ? block.targetDomainApiVersion : undefined,
    domainSpec: domainSpec(targetDomainId),
  }).kind;
}

describe('documented capability pack markers', () => {
  it('loads the documented fit-pack marker block', () => {
    expect(compatibilityKind(documentedFitPackManifest, 'fit-pack')).toBe('compatible');
  });

  it('loads the documented graph-adapter marker block', () => {
    expect(compatibilityKind(documentedGraphAdapterManifest, 'graph-adapter')).toBe('compatible');
  });

  it('rejects the obsolete kind-only marker block', () => {
    expect(compatibilityKind({ kind: 'fit-pack' }, 'fit-pack')).not.toBe('compatible');
  });
});

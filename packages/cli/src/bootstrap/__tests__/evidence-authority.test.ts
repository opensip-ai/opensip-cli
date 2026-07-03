import { resolveTrustPolicySources } from '@opensip-cli/config';
import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { RunScope } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { buildEvidenceAuthority } from '../evidence-authority.js';

import type { DeclaredInputs, SignalEnvelope } from '@opensip-cli/contracts';
import type { ToolPluginManifest, ToolProvenance } from '@opensip-cli/core';

function envelope(input: {
  readonly tool?: string;
  readonly declaredInputs?: DeclaredInputs;
}): SignalEnvelope {
  const built = buildSignalEnvelope({
    tool: input.tool ?? 'fit',
    runId: 'run-1',
    createdAt: '2026-07-02T00:00:00.000Z',
    units: [{ slug: 'check-a', passed: true, durationMs: 1 }],
    signals: [],
    policy: { failOnErrors: 1, failOnWarnings: 0 },
    runFaulted: false,
  });
  return input.declaredInputs === undefined
    ? built
    : {
        ...built,
        declaredInputs: input.declaredInputs,
      };
}

function completeDeclaredInputs(tool = 'fit'): DeclaredInputs {
  return {
    cliVersion: '0.3.0',
    nodeVersion: 'v24.0.0',
    packageManager: 'pnpm@10.0.0',
    platform: 'darwin-arm64',
    tool,
    engineVersion: '1.0.0',
    baselineIdentity: {
      fingerprintStrategyId: 'default',
      fingerprintStrategyVersion: 1,
    },
  };
}

function manifest(): ToolPluginManifest {
  return {
    apiVersion: 1,
    kind: 'tool',
    id: 'fit-manifest',
    stableId: 'fit-stable',
    packageName: '@opensip-cli/fitness',
    version: '0.3.0',
    entry: './dist/index.js',
    identity: { name: 'fit', aliases: ['fitness'] },
    compatibility: { core: '^0.3.0' },
    commands: [{ name: 'fit', description: 'fitness' }],
  };
}

function provenance(overrides: Partial<ToolProvenance> = {}): ToolProvenance {
  return {
    source: 'bundled',
    id: 'fit-manifest',
    stableId: 'fit-stable',
    packageName: '@opensip-cli/fitness',
    version: '0.3.0',
    manifestHash: 'sha256:abc',
    ...overrides,
  };
}

describe('buildEvidenceAuthority', () => {
  it('attests bundled tools with complete declared inputs as cli-attested', () => {
    const scope = new RunScope({
      toolManifests: [manifest()],
      toolProvenance: [provenance()],
      trustPolicy: resolveTrustPolicySources(
        [{ tier: 'project', policy: { mode: 'strict' } }],
        new Date('2026-07-02T00:00:00.000Z'),
      ),
    });

    const result = buildEvidenceAuthority({
      envelope: envelope({ declaredInputs: completeDeclaredInputs() }),
      scope,
    });

    expect(result).toMatchObject({
      tier: 'cli-attested',
      attestation: { status: 'verified' },
      declaredInputs: {
        cliVersion: '0.3.0',
        packageManager: 'pnpm@10.0.0',
        engineVersion: '1.0.0',
      },
      provenance: {
        source: 'bundled',
        packageName: '@opensip-cli/fitness',
        stableId: 'fit-stable',
        manifestHash: 'sha256:abc',
      },
      policy: { mode: 'strict', orgStatus: 'available' },
    });
  });

  it('marks verified provenance as partial when declared inputs are incomplete', () => {
    const scope = new RunScope({
      toolManifests: [manifest()],
      toolProvenance: [provenance()],
    });

    const result = buildEvidenceAuthority({
      envelope: envelope({
        declaredInputs: {
          ...completeDeclaredInputs(),
          baselineIdentity: undefined,
        },
      }),
      scope,
    });

    expect(result.tier).toBe('external-untrusted');
    expect(result.attestation).toEqual({
      status: 'partial',
      reason: 'declared input provenance is incomplete',
    });
  });

  it('marks missing or non-bundled provenance as unavailable', () => {
    const externalScope = new RunScope({
      toolManifests: [manifest()],
      toolProvenance: [provenance({ source: 'installed' })],
    });

    expect(
      buildEvidenceAuthority({
        envelope: envelope({ declaredInputs: completeDeclaredInputs() }),
        scope: externalScope,
      }).attestation,
    ).toEqual({ status: 'unavailable', reason: 'tool provenance is not locally verified' });

    expect(buildEvidenceAuthority({ envelope: envelope({ tool: 'unknown' }) }).attestation).toEqual(
      {
        status: 'unavailable',
        reason: 'tool provenance record is unavailable',
      },
    );
  });
});

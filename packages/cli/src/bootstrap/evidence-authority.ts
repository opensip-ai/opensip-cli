import {
  EVIDENCE_AUTHORITY_CONTRACT_VERSION,
  EVIDENCE_DIVERGENCE_CONTRACT_VERSION,
  type DeclaredInputs,
  type SignalEnvelope,
} from '@opensip-cli/contracts';
import {
  isPlainRecord,
  type RunScope,
  type SignalBatchAttestationStatus,
  type SignalBatchAuthorityTier,
  type SignalBatchEvidence,
  type ToolPluginManifest,
  type ToolProvenance,
} from '@opensip-cli/core';

import { verifyPackageProvenance } from './provenance-verifier.js';

import type { ResolvedTrustPolicy } from '@opensip-cli/config';

export interface BuildEvidenceAuthorityInput {
  readonly envelope: SignalEnvelope;
  readonly scope?: RunScope;
}

function isResolvedTrustPolicy(value: unknown): value is ResolvedTrustPolicy {
  if (!isPlainRecord(value)) return false;
  if (!isPlainRecord(value.orgStatus)) return false;
  return (
    (value.mode === 'default' || value.mode === 'strict') &&
    (value.ci === 'default' || value.ci === 'strict') &&
    Array.isArray(value.sourceTiers) &&
    typeof value.orgStatus.state === 'string'
  );
}

function manifestFor(
  tool: string,
  manifests: readonly ToolPluginManifest[],
): ToolPluginManifest | undefined {
  return manifests.find(
    (manifest) =>
      manifest.id === tool || manifest.identity.name === tool || manifest.stableId === tool,
  );
}

function provenanceFor(
  tool: string,
  manifest: ToolPluginManifest | undefined,
  provenance: readonly ToolProvenance[],
): ToolProvenance | undefined {
  return provenance.find(
    (record) =>
      record.id === tool ||
      record.stableId === tool ||
      record.id === manifest?.id ||
      record.stableId === manifest?.stableId,
  );
}

function declaredInputsComplete(inputs: DeclaredInputs | undefined): inputs is DeclaredInputs {
  return (
    inputs !== undefined &&
    inputs.cliVersion.length > 0 &&
    inputs.nodeVersion.length > 0 &&
    inputs.platform.length > 0 &&
    inputs.tool.length > 0 &&
    inputs.baselineIdentity !== undefined
  );
}

function declaredInputsRecord(inputs: DeclaredInputs): Record<string, unknown> {
  return {
    cliVersion: inputs.cliVersion,
    nodeVersion: inputs.nodeVersion,
    ...(inputs.packageManager === undefined ? {} : { packageManager: inputs.packageManager }),
    platform: inputs.platform,
    tool: inputs.tool,
    ...(inputs.engineVersion === undefined ? {} : { engineVersion: inputs.engineVersion }),
  };
}

function policySummary(policy: unknown): SignalBatchEvidence['policy'] | undefined {
  if (!isResolvedTrustPolicy(policy)) return undefined;
  return {
    mode: policy.mode,
    ci: policy.ci,
    sourceTiers: policy.sourceTiers,
    orgStatus: policy.orgStatus.state,
  };
}

function provenanceSummary(
  record: ToolProvenance | undefined,
): SignalBatchEvidence['provenance'] | undefined {
  if (record === undefined) return undefined;
  return {
    source: record.source,
    id: record.id,
    ...(record.packageName === undefined ? {} : { packageName: record.packageName }),
    ...(record.stableId === undefined ? {} : { stableId: record.stableId }),
    manifestHash: record.manifestHash,
  };
}

function authorityDecision(args: {
  readonly declaredComplete: boolean;
  readonly provenanceStatus: SignalBatchAttestationStatus;
  readonly provenance: ToolProvenance | undefined;
}): {
  readonly tier: SignalBatchAuthorityTier;
  readonly attestation: SignalBatchEvidence['attestation'];
} {
  if (args.provenanceStatus === 'verified' && args.declaredComplete) {
    return { tier: 'cli-attested', attestation: { status: 'verified' } };
  }
  if (args.provenanceStatus === 'verified') {
    return {
      tier: 'external-untrusted',
      attestation: {
        status: 'partial',
        reason: 'declared input provenance is incomplete',
      },
    };
  }
  return {
    tier: 'external-untrusted',
    attestation: {
      status: args.provenanceStatus,
      reason:
        args.provenance === undefined
          ? 'tool provenance record is unavailable'
          : 'tool provenance is not locally verified',
    },
  };
}

export function buildEvidenceAuthority(input: BuildEvidenceAuthorityInput): SignalBatchEvidence {
  const manifest = manifestFor(input.envelope.tool, input.scope?.toolManifests ?? []);
  const provenance = provenanceFor(
    input.envelope.tool,
    manifest,
    input.scope?.toolProvenance ?? [],
  );
  const provenanceStatus = verifyPackageProvenance({
    packageName: provenance?.packageName,
    provenance,
  });
  const decision = authorityDecision({
    declaredComplete: declaredInputsComplete(input.envelope.declaredInputs),
    provenanceStatus,
    provenance,
  });
  const policy = policySummary(input.scope?.trustPolicy);
  const provenanceEvidence = provenanceSummary(provenance);

  return {
    contractVersion: EVIDENCE_AUTHORITY_CONTRACT_VERSION,
    tier: decision.tier,
    attestation: decision.attestation,
    baselineIdentity: input.envelope.baselineIdentity,
    ...(input.envelope.declaredInputs === undefined
      ? {}
      : {
          declaredInputs: declaredInputsRecord(input.envelope.declaredInputs),
        }),
    ...(policy === undefined ? {} : { policy }),
    ...(provenanceEvidence === undefined ? {} : { provenance: provenanceEvidence }),
    divergenceContractVersion: EVIDENCE_DIVERGENCE_CONTRACT_VERSION,
  };
}

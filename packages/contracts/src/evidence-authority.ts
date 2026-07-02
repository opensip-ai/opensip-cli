import type { BaselineIdentity, DeclaredInputs } from './signal-envelope.js';

export const EVIDENCE_AUTHORITY_CONTRACT_VERSION = 1 as const;
export const EVIDENCE_DIVERGENCE_CONTRACT_VERSION = 1 as const;

/** Authority tier describing how much trust a consumer should place in evidence. */
export type EvidenceAuthorityTier = 'cloud-derived' | 'cli-attested' | 'external-untrusted';

/** Verification state for the inputs and provenance behind an evidence record. */
export type EvidenceAttestationStatus = 'verified' | 'partial' | 'unavailable' | 'failed';

/** Attestation summary attached to a native signal batch or Cloud evidence record. */
export interface EvidenceAttestation {
  readonly status: EvidenceAttestationStatus;
  readonly reason?: string;
}

/** Minimal package or tool provenance projected into evidence metadata. */
export interface EvidenceProvenanceSummary {
  readonly source?: string;
  readonly packageName?: string;
  readonly manifestHash?: string;
  readonly stableId?: string;
}

/** Trust-policy inputs that influenced a CLI evidence authority decision. */
export interface EvidencePolicySummary {
  readonly mode?: 'default' | 'strict';
  readonly ci?: 'default' | 'strict';
  readonly sourceTiers?: readonly string[];
  readonly orgStatus?: string;
}

/** Native evidence authority header emitted with OpenSIP signal batches. */
export interface EvidenceAuthority {
  readonly contractVersion: typeof EVIDENCE_AUTHORITY_CONTRACT_VERSION;
  readonly tier: EvidenceAuthorityTier;
  readonly attestation: EvidenceAttestation;
  readonly baselineIdentity?: BaselineIdentity;
  readonly declaredInputs?: DeclaredInputs;
  readonly policy?: EvidencePolicySummary;
  readonly provenance?: EvidenceProvenanceSummary;
  readonly divergenceContractVersion: typeof EVIDENCE_DIVERGENCE_CONTRACT_VERSION;
}

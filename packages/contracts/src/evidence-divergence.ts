import type { EvidenceAuthority } from './evidence-authority.js';

/** Severity band for a difference between CLI-attested evidence and Cloud-derived evidence. */
export type EvidenceDivergenceSeverity = 'none' | 'cosmetic' | 'sub-verdict' | 'verdict-changing';

/** Stable fields used to decide whether two evidence records refer to the same finding. */
export interface EvidenceDivergenceIdentity {
  readonly fingerprint?: string;
  readonly ruleId?: string;
  readonly filePath?: string;
}

/** Minimal signal identity attached to an evidence divergence report. */
export interface EvidenceDivergenceSignalRef {
  readonly fingerprint?: string;
  readonly ruleId: string;
  readonly filePath?: string;
}

/** Contract record a Cloud consumer can persist when CLI and Cloud evidence disagree. */
export interface EvidenceDivergenceRecord {
  readonly contractVersion: 1;
  readonly identity: EvidenceDivergenceIdentity;
  readonly cliAuthority: EvidenceAuthority['tier'];
  readonly cloudAuthority: EvidenceAuthority['tier'];
  readonly severity: EvidenceDivergenceSeverity;
  readonly reason: string;
  readonly signals?: readonly EvidenceDivergenceSignalRef[];
}

/** Inputs required to classify a CLI-vs-Cloud evidence comparison. */
export interface ClassifyEvidenceDivergenceInput {
  readonly cliVerdict: boolean;
  readonly cloudVerdict: boolean;
  readonly identityMatch: boolean;
  readonly changedFields?: readonly string[];
}

const COSMETIC_FIELDS = new Set(['line', 'column', 'message', 'ordering']);

/** Classify whether an evidence difference is cosmetic, identity-level, or verdict-changing. */
export function classifyEvidenceDivergence(
  input: ClassifyEvidenceDivergenceInput,
): EvidenceDivergenceSeverity {
  if (input.cliVerdict !== input.cloudVerdict) return 'verdict-changing';
  if (!input.identityMatch) return 'sub-verdict';
  const fields = input.changedFields ?? [];
  if (fields.length === 0) return 'none';
  return fields.every((field) => COSMETIC_FIELDS.has(field)) ? 'cosmetic' : 'sub-verdict';
}

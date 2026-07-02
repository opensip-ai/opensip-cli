import type { ProvenanceStatus } from '@opensip-cli/config';
import type { ToolProvenance } from '@opensip-cli/core';

export interface PackageProvenanceInput {
  readonly packageName?: string;
  readonly provenance?: ToolProvenance;
  readonly source?: string;
}

export function verifyPackageProvenance(input: PackageProvenanceInput): ProvenanceStatus {
  const source = input.provenance?.source ?? input.source;
  return source === 'bundled' ? 'verified' : 'unavailable';
}

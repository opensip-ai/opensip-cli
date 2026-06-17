import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { ToolSessionContribution } from '@opensip-cli/core';

/**
 * Result of a static graph command path. Carries the deliverable signal envelope
 * for host egress and, on human-facing paths, the optional generic session the
 * host run plane persists.
 */
export interface GraphRunOutcome {
  readonly envelope?: SignalEnvelope;
  readonly session?: ToolSessionContribution;
}

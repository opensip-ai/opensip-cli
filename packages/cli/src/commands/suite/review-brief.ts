import type { SignalEnvelope, SuiteStepSummary } from '@opensip-cli/contracts';
import type { EvidenceSnapshotContribution } from '@opensip-cli/core';

export const DEFAULT_REVIEW_BRIEF_RISK_LIMIT = 20;
export const DEFAULT_REVIEW_BRIEF_DEGRADATION_LIMIT = 20;

export interface SuiteStepReviewInput {
  readonly stepIndex: number;
  readonly summary: SuiteStepSummary;
  readonly effectiveArgs?: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
  /**
   * Detached, bounded evidence captured at the step boundary for durable ledger
   * projection. The full envelope below remains review-only.
   */
  readonly ledgerEvidence?: unknown;
  readonly capturedEnvelope?: SignalEnvelope;
  readonly evidenceSnapshots?: readonly EvidenceSnapshotContribution[];
}

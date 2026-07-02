import type { SignalEnvelope, SuiteStepSummary } from '@opensip-cli/contracts';

export const DEFAULT_REVIEW_BRIEF_RISK_LIMIT = 20;
export const DEFAULT_REVIEW_BRIEF_DEGRADATION_LIMIT = 20;

export interface SuiteStepReviewInput {
  readonly stepIndex: number;
  readonly summary: SuiteStepSummary;
  readonly capturedEnvelope?: SignalEnvelope;
}

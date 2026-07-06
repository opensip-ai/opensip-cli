export type PolicyMode = 'default' | 'strict';

export type PolicyDecisionOutcome = 'allow' | 'allow-with-conditions' | 'deny';

export interface PolicyDecisionSummary {
  readonly outcome: PolicyDecisionOutcome;
  readonly reasons: readonly string[];
  readonly matchedExceptionIds: readonly string[];
  readonly sourceTiers: readonly string[];
}

export interface PolicyStatusResult {
  type: 'policy-status';
  readonly mode: PolicyMode;
  readonly ci: PolicyMode;
  readonly orgStatus: {
    readonly state:
      'available' | 'not-configured' | 'optional-unavailable' | 'required-unavailable';
    readonly reason?: string;
  };
  readonly sources: readonly string[];
  readonly exceptions: readonly {
    readonly id: string;
    readonly subject: string;
    readonly action: string;
    readonly expiresAt?: string;
    readonly sourceTier: string;
  }[];
}

export interface PolicyExplainResult {
  type: 'policy-explain';
  readonly subject: string;
  readonly action: string;
  readonly decision: PolicyDecisionSummary;
}

export interface PolicyAuditRow {
  readonly id: string;
  readonly runId?: string;
  readonly timestamp: string;
  readonly subject: string;
  readonly subjectKind: string;
  readonly action: string;
  readonly outcome: PolicyDecisionOutcome;
  readonly reasons: readonly string[];
  readonly matchedExceptionIds: readonly string[];
  readonly sourceTiers: readonly string[];
}

export interface PolicyAuditResult {
  type: 'policy-audit';
  readonly events: readonly PolicyAuditRow[];
  readonly totalCount: number;
  readonly exportedTo?: string;
}

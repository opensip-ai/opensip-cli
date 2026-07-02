import {
  BUILTIN_TRUST_POLICY,
  evaluateTrustPolicy,
  formatPolicySubject,
  type PolicyAction,
  type PolicyDecision,
  type PolicyResourceRequirement,
  type PolicySubject,
  type ProvenanceStatus,
  type ResolvedTrustPolicy,
} from '@opensip-cli/config';
import { currentScope, logger } from '@opensip-cli/core';

import { isPolicyAuditCollector, type PolicyAuditCollector } from './policy-audit.js';

export interface PolicyPepRequest {
  readonly policy: ResolvedTrustPolicy;
  readonly subject: PolicySubject;
  readonly action: PolicyAction;
  readonly evidence?: Record<string, unknown> & {
    readonly ci?: boolean;
    readonly provenanceStatus?: ProvenanceStatus;
    readonly bundled?: boolean;
    readonly trustedByLocation?: boolean;
    readonly declaredResources?: readonly PolicyResourceRequirement[];
    readonly targetDomain?: string;
    readonly manifestHash?: string;
  };
  readonly audit?: PolicyAuditCollector;
  readonly now?: Date;
}

export interface PolicyPepResult {
  readonly allowed: boolean;
  readonly conditioned: boolean;
  readonly decision: PolicyDecision;
}

export function evaluatePolicyPep(request: PolicyPepRequest): PolicyPepResult {
  const decision = evaluateTrustPolicy(request.policy, {
    subject: request.subject,
    action: request.action,
    evidence: request.evidence,
    now: request.now ?? new Date(),
  });
  request.audit?.record(decision.auditEvent);
  logPolicyDecision(request.subject, request.action, decision);
  return {
    allowed: decision.outcome !== 'deny',
    conditioned: decision.outcome === 'allow-with-conditions',
    decision,
  };
}

export function policyFromCurrentScope(): ResolvedTrustPolicy {
  const value = currentScope()?.trustPolicy;
  return isResolvedTrustPolicy(value) ? value : BUILTIN_TRUST_POLICY;
}

export function policyAuditFromCurrentScope(): PolicyAuditCollector | undefined {
  const value = currentScope()?.policyAudit;
  return isPolicyAuditCollector(value) ? value : undefined;
}

function isResolvedTrustPolicy(value: unknown): value is ResolvedTrustPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.mode === 'default' || record.mode === 'strict') &&
    (record.ci === 'default' || record.ci === 'strict') &&
    Array.isArray(record.exceptions) &&
    typeof record.org === 'object'
  );
}

function logPolicyDecision(
  subject: PolicySubject,
  action: PolicyAction,
  decision: PolicyDecision,
): void {
  if (decision.outcome === 'allow') return;
  logger.warn({
    evt:
      decision.outcome === 'deny'
        ? 'policy.pep.decision.denied'
        : 'policy.pep.decision.conditioned',
    module: 'cli:policy-pep',
    action,
    subjectKind: subject.kind,
    subject: formatPolicySubject(subject),
    outcome: decision.outcome,
    sourceTiers: decision.sourceTiers,
    exceptionIds: decision.matchedExceptionIds,
  });
}

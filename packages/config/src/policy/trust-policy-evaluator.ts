import {
  formatPolicySubject,
  type PolicyAuditEvent,
  type PolicyDecision,
  type PolicyDecisionOutcome,
  type PolicyEvaluationRequest,
  type PolicyResourceClass,
  type PolicyResourceDecision,
  type PolicyResourceRequirement,
  type PolicySubject,
  type ProvenanceStatus,
  type ResolvedTrustPolicy,
  type ResolvedTrustPolicyException,
  type TrustPolicySourceTier,
} from './trust-policy-schema.js';

interface DecisionDraft {
  readonly outcome: PolicyDecisionOutcome;
  readonly reasons: readonly string[];
  readonly matchedExceptionIds: readonly string[];
  readonly sourceTier: TrustPolicySourceTier | 'none';
}

interface EffectiveMode {
  readonly value: 'default' | 'strict';
  readonly sourceTier: TrustPolicySourceTier;
}

function effectiveMode(
  policy: ResolvedTrustPolicy,
  request: PolicyEvaluationRequest,
): EffectiveMode {
  return request.evidence?.ci === true && policy.ci === 'strict'
    ? { value: 'strict', sourceTier: policy.ciSourceTier ?? 'builtin' }
    : { value: policy.mode, sourceTier: policy.modeSourceTier ?? 'builtin' };
}

function unexpired(exception: ResolvedTrustPolicyException, now: Date): boolean {
  const expires = Date.parse(exception.expiresAt);
  return Number.isFinite(expires) && expires > now.getTime();
}

function matchingExceptions(
  policy: ResolvedTrustPolicy,
  request: PolicyEvaluationRequest,
): readonly ResolvedTrustPolicyException[] {
  const subject = formatPolicySubject(request.subject);
  return policy.exceptions.filter(
    (exception) =>
      exception.subject === subject &&
      exception.action === request.action &&
      unexpired(exception, request.now),
  );
}

function provenanceStatus(request: PolicyEvaluationRequest): ProvenanceStatus | undefined {
  const value = request.evidence?.provenanceStatus;
  return value === 'verified' || value === 'unavailable' || value === 'failed' ? value : undefined;
}

function isVerified(request: PolicyEvaluationRequest): boolean {
  return request.evidence?.bundled === true || provenanceStatus(request) === 'verified';
}

function isExecutableLoad(subject: PolicySubject, action: string): boolean {
  return (
    (action === 'load' || action === 'install') &&
    (subject.kind === 'installed-tool' ||
      subject.kind === 'project-local-tool' ||
      subject.kind === 'user-global-tool' ||
      subject.kind === 'capability-pack')
  );
}

function requiredOrgDecision(policy: ResolvedTrustPolicy): DecisionDraft | undefined {
  if (policy.orgStatus.state !== 'required-unavailable') return undefined;
  return {
    outcome: 'deny',
    reasons: [`required org policy unavailable: ${policy.orgStatus.reason}`],
    matchedExceptionIds: [],
    sourceTier: 'org',
  };
}

function optionalOrgReason(policy: ResolvedTrustPolicy): readonly string[] {
  return policy.orgStatus.state === 'optional-unavailable'
    ? [`optional org policy unavailable: ${policy.orgStatus.reason}`]
    : [];
}

function exceptionDecision(
  exceptions: readonly ResolvedTrustPolicyException[],
  baseReasons: readonly string[],
): DecisionDraft | undefined {
  if (exceptions.length === 0) return undefined;
  const last = exceptions.at(-1);
  if (last === undefined) return undefined;
  return {
    outcome: 'allow',
    reasons: [...baseReasons, `matched policy exception ${last.id}`],
    matchedExceptionIds: exceptions.map((exception) => exception.id),
    sourceTier: last.sourceTier,
  };
}

function executableDecision(
  request: PolicyEvaluationRequest,
  mode: EffectiveMode,
  baseReasons: readonly string[],
): DecisionDraft {
  const status = provenanceStatus(request);
  const subject = formatPolicySubject(request.subject);
  if (request.evidence?.legacyTrusted === false) {
    return deny(baseReasons, 'not admitted by local trust evidence');
  }
  if (isVerified(request)) {
    return allow(baseReasons, 'verified first-party or signed provenance');
  }
  if (mode.value === 'strict') {
    return deny(
      baseReasons,
      `strict mode requires verified provenance or an unexpired exception for ${subject}`,
      mode.sourceTier,
    );
  }
  return {
    outcome: status === undefined ? 'allow' : 'allow-with-conditions',
    reasons: [
      ...baseReasons,
      status === 'failed'
        ? 'provenance verification failed; default mode preserves local trust behavior'
        : 'provenance unavailable; default mode preserves local trust behavior',
    ],
    matchedExceptionIds: [],
    sourceTier: mode.sourceTier,
  };
}

function guardedActionDecision(
  action: string,
  mode: EffectiveMode,
  baseReasons: readonly string[],
): DecisionDraft {
  return mode.value === 'strict'
    ? deny(
        baseReasons,
        `strict mode requires an unexpired exception for ${action}`,
        mode.sourceTier,
      )
    : allow(baseReasons, `${action} allowed in default mode`, mode.sourceTier);
}

function defaultActionDecision(action: string, baseReasons: readonly string[]): DecisionDraft {
  return allow(
    baseReasons,
    action === 'runtime-exclude'
      ? 'runtime exclude is per-run and allowed'
      : `${action} allowed by default policy`,
  );
}

function actionDecision(
  request: PolicyEvaluationRequest,
  mode: EffectiveMode,
  baseReasons: readonly string[],
): DecisionDraft {
  if (isExecutableLoad(request.subject, request.action)) {
    return executableDecision(request, mode, baseReasons);
  }
  if (request.action === 'disable-check' || request.action === 'baseline-save') {
    return guardedActionDecision(request.action, mode, baseReasons);
  }
  return defaultActionDecision(request.action, baseReasons);
}

function applyOptionalOrgCondition(
  policy: ResolvedTrustPolicy,
  draft: DecisionDraft,
): DecisionDraft {
  if (policy.orgStatus.state !== 'optional-unavailable' || draft.outcome !== 'allow') {
    return draft;
  }
  return { ...draft, outcome: 'allow-with-conditions' };
}

function allow(
  baseReasons: readonly string[],
  reason: string,
  sourceTier: TrustPolicySourceTier = 'builtin',
): DecisionDraft {
  return {
    outcome: 'allow',
    reasons: [...baseReasons, reason],
    matchedExceptionIds: [],
    sourceTier,
  };
}

function deny(
  baseReasons: readonly string[],
  reason: string,
  sourceTier: TrustPolicySourceTier = 'builtin',
): DecisionDraft {
  return {
    outcome: 'deny',
    reasons: [...baseReasons, reason],
    matchedExceptionIds: [],
    sourceTier,
  };
}

/** Evaluate one trust-policy decision and produce an auditable decision record. */
export function evaluateTrustPolicy(
  policy: ResolvedTrustPolicy,
  request: PolicyEvaluationRequest,
): PolicyDecision {
  const mode = effectiveMode(policy, request);
  const requiredOrg = requiredOrgDecision(policy);
  if (requiredOrg !== undefined) return buildDecision(policy, request, requiredOrg);
  const baseReasons = optionalOrgReason(policy);
  const exceptions = matchingExceptions(policy, request);
  const exception = exceptionDecision(exceptions, baseReasons);
  if (exception !== undefined) return buildDecision(policy, request, exception);
  return buildDecision(
    policy,
    request,
    applyOptionalOrgCondition(policy, actionDecision(request, mode, baseReasons)),
  );
}

function buildDecision(
  policy: ResolvedTrustPolicy,
  request: PolicyEvaluationRequest,
  draft: DecisionDraft,
): PolicyDecision {
  const status = provenanceStatus(request);
  const resourceDecision = buildCapabilityResourceDecision(request, draft);
  const auditEvent: PolicyAuditEvent = {
    occurredAt: request.now.toISOString(),
    action: request.action,
    subject: formatPolicySubject(request.subject),
    outcome: draft.outcome,
    sourceTier: draft.sourceTier,
    reasons: draft.reasons,
    exceptionIds: draft.matchedExceptionIds,
    metadata: sanitizeMetadata({
      // Evidence is caller-supplied and may contain arbitrary diagnostic keys.
      // Apply it first so it cannot forge the authoritative policy fields.
      ...request.evidence,
      subjectKind: request.subject.kind,
      provenanceStatus: status,
      policyMode: effectiveMode(policy, request).value,
      resourceDecision,
      sourceTiers: policy.sourceTiers,
      orgStatus: policy.orgStatus.state,
    }),
  };
  return {
    outcome: draft.outcome,
    reasons: draft.reasons,
    matchedExceptionIds: draft.matchedExceptionIds,
    sourceTiers: policy.sourceTiers,
    ...(status === undefined ? {} : { provenanceStatus: status }),
    ...(resourceDecision === undefined ? {} : { resourceDecision }),
    auditEvent,
  };
}

function buildCapabilityResourceDecision(
  request: PolicyEvaluationRequest,
  draft: DecisionDraft,
): PolicyResourceDecision | undefined {
  if (
    request.subject.kind !== 'capability-pack' ||
    request.action !== 'load' ||
    draft.outcome === 'deny'
  ) {
    return undefined;
  }
  const allowedResources = normalizeDeclaredResources(request.evidence?.declaredResources);
  const isolation = request.evidence?.bundled === true ? 'host' : 'worker';
  return {
    isolation,
    allowedResources,
    denyUndeclared: true,
    reasons: [
      isolation === 'host'
        ? 'bundled first-party capability pack may run in the host'
        : 'external capability pack must run in a resource-bounded worker',
      'undeclared resources are denied',
    ],
  };
}

function normalizeDeclaredResources(value: unknown): readonly PolicyResourceRequirement[] {
  if (!Array.isArray(value)) return [];
  const out: PolicyResourceRequirement[] = [];
  for (const entry of value) {
    const requirement = normalizeDeclaredResource(entry);
    if (requirement !== undefined) out.push(requirement);
  }
  return out;
}

function normalizeDeclaredResource(value: unknown): PolicyResourceRequirement | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isPolicyResourceClass(record.resource)) return undefined;
  const { scope, reason } = record;
  return {
    resource: record.resource,
    ...(typeof scope === 'string' ? { scope } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

function isPolicyResourceClass(value: unknown): value is PolicyResourceClass {
  return value === 'filesystem' || value === 'network' || value === 'env' || value === 'subprocess';
}

function sanitizeMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const sanitized = sanitizeMetadataValue(value, 0);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function sanitizeMetadataValue(value: unknown, depth: number): unknown {
  if (value === undefined || depth > 2) return undefined;
  if (typeof value === 'string') return redact(value).slice(0, depth === 0 ? 240 : 120);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item: unknown) => sanitizeMetadataValue(item, depth + 1))
      .filter((item: unknown) => item !== undefined);
  }
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, 20)) {
      const sanitized = sanitizeMetadataValue(child, depth + 1);
      if (sanitized !== undefined) output[redact(key).slice(0, 80)] = sanitized;
    }
    return output;
  }
  return undefined;
}

function redact(value: string): string {
  return value.replace(/(api[_-]?key|token|secret)=?[^,\s]*/gi, '$1=<redacted>');
}

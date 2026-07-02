import { z } from 'zod';

export const POLICY_ACTIONS = [
  'load',
  'install',
  'disable-check',
  'runtime-exclude',
  'baseline-save',
] as const;

export const POLICY_SUBJECT_KINDS = [
  'installed-tool',
  'project-local-tool',
  'user-global-tool',
  'capability-pack',
  'fitness.disabledChecks',
  'baseline',
  'runtime-exclude',
] as const;

export const TRUST_POLICY_SOURCE_TIERS = ['builtin', 'user', 'project', 'org'] as const;
export const POLICY_DECISION_OUTCOMES = ['allow', 'deny', 'allow-with-conditions'] as const;
export const PROVENANCE_STATUSES = ['verified', 'unavailable', 'failed'] as const;
export const POLICY_RESOURCE_CLASSES = ['filesystem', 'network', 'env', 'subprocess'] as const;
export const CAPABILITY_ISOLATION_LEVELS = ['host', 'worker'] as const;

export const POLICY_EXCEPTION_MAX_COUNT = 100;
export const POLICY_REASON_MAX_LENGTH = 240;
export const POLICY_SUBJECT_MAX_LENGTH = 256;
export const POLICY_ID_MAX_LENGTH = 80;
export const POLICY_ORG_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const policyModeSchema = z.enum(['default', 'strict']);
const policyActionSchema = z.enum(POLICY_ACTIONS);

const policySubjectSchema = z
  .string()
  .min(3)
  .max(POLICY_SUBJECT_MAX_LENGTH)
  .refine((value) => !value.includes('*'), 'wildcard policy subjects are not supported')
  .refine((value) => {
    const separator = value.indexOf(':');
    if (separator <= 0 || separator === value.length - 1) return false;
    const kind = value.slice(0, separator);
    return (POLICY_SUBJECT_KINDS as readonly string[]).includes(kind);
  }, 'subject must be <known-kind>:<id>');

export const trustPolicyExceptionSchema = z
  .object({
    id: z.string().min(1).max(POLICY_ID_MAX_LENGTH),
    subject: policySubjectSchema,
    action: policyActionSchema,
    reason: z.string().min(1).max(POLICY_REASON_MAX_LENGTH),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const trustPolicyOrgConfigSchema = z
  .object({
    required: z.boolean().optional(),
    cachePath: z.string().min(1).max(512).optional(),
    maxAgeMs: z.number().int().positive().max(POLICY_ORG_CACHE_MAX_AGE_MS).optional(),
  })
  .strict();

export const trustPolicySchema = z
  .object({
    mode: policyModeSchema.optional(),
    ci: policyModeSchema.optional(),
    exceptions: z.array(trustPolicyExceptionSchema).max(POLICY_EXCEPTION_MAX_COUNT).optional(),
    org: trustPolicyOrgConfigSchema.optional(),
  })
  .strict();

export const orgPolicyCacheSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.iso.datetime({ offset: true }),
    policy: trustPolicySchema,
  })
  .strict();

export const policySubjectKindSchema = z.enum(POLICY_SUBJECT_KINDS);
export const policyDecisionOutcomeSchema = z.enum(POLICY_DECISION_OUTCOMES);
export const provenanceStatusSchema = z.enum(PROVENANCE_STATUSES);
export const policyResourceClassSchema = z.enum(POLICY_RESOURCE_CLASSES);
export const capabilityIsolationLevelSchema = z.enum(CAPABILITY_ISOLATION_LEVELS);

export type TrustPolicyDocument = z.infer<typeof trustPolicySchema>;
export type TrustPolicyOrgConfig = z.infer<typeof trustPolicyOrgConfigSchema>;
export type TrustPolicyExceptionDocument = z.infer<typeof trustPolicyExceptionSchema>;
export type TrustPolicySourceTier = (typeof TRUST_POLICY_SOURCE_TIERS)[number];
export type PolicyAction = z.infer<typeof policyActionSchema>;
export type PolicySubjectKind = z.infer<typeof policySubjectKindSchema>;
export type PolicyDecisionOutcome = z.infer<typeof policyDecisionOutcomeSchema>;
export type ProvenanceStatus = z.infer<typeof provenanceStatusSchema>;
export type PolicyResourceClass = z.infer<typeof policyResourceClassSchema>;
export type CapabilityIsolationLevel = z.infer<typeof capabilityIsolationLevelSchema>;
export type OrgPolicyCacheDocument = z.infer<typeof orgPolicyCacheSchema>;

export interface PolicyResourceRequirement {
  readonly resource: PolicyResourceClass;
  readonly scope?: string;
  readonly reason?: string;
}

export interface PolicyResourceDecision {
  readonly isolation: CapabilityIsolationLevel;
  readonly allowedResources: readonly PolicyResourceRequirement[];
  readonly denyUndeclared: true;
  readonly reasons: readonly string[];
}

export interface PolicySubject {
  readonly kind: PolicySubjectKind;
  readonly id: string;
  readonly packageName?: string;
  readonly source?: string;
}

export interface ResolvedTrustPolicyException extends TrustPolicyExceptionDocument {
  readonly sourceTier: TrustPolicySourceTier;
}

export type OrgPolicyStatus =
  | { readonly state: 'available'; readonly sourceTier?: TrustPolicySourceTier }
  | { readonly state: 'optional-unavailable'; readonly reason: string }
  | { readonly state: 'required-unavailable'; readonly reason: string };

export interface ResolvedTrustPolicy {
  readonly mode: 'default' | 'strict';
  readonly ci: 'default' | 'strict';
  readonly exceptions: readonly ResolvedTrustPolicyException[];
  readonly org: Required<TrustPolicyOrgConfig>;
  readonly orgStatus: OrgPolicyStatus;
  readonly sourceTiers: readonly TrustPolicySourceTier[];
}

export interface TrustPolicySource {
  readonly tier: TrustPolicySourceTier;
  readonly policy?: TrustPolicyDocument;
  readonly orgStatus?: OrgPolicyStatus;
}

export interface PolicyEvaluationRequest {
  readonly subject: PolicySubject;
  readonly action: PolicyAction;
  readonly evidence?: Record<string, unknown> & {
    readonly ci?: boolean;
    readonly provenanceStatus?: ProvenanceStatus;
    readonly bundled?: boolean;
    readonly legacyTrusted?: boolean;
    readonly trustedByLocation?: boolean;
    readonly declaredResources?: readonly PolicyResourceRequirement[];
    readonly targetDomain?: string;
    readonly manifestHash?: string;
  };
  readonly now: Date;
}

export interface PolicyAuditEvent {
  readonly occurredAt: string;
  readonly action: PolicyAction;
  readonly subject: string;
  readonly outcome: PolicyDecisionOutcome;
  readonly sourceTier: TrustPolicySourceTier | 'none';
  readonly reasons: readonly string[];
  readonly exceptionIds: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PolicyDecision {
  readonly outcome: PolicyDecisionOutcome;
  readonly reasons: readonly string[];
  readonly matchedExceptionIds: readonly string[];
  readonly sourceTiers: readonly TrustPolicySourceTier[];
  readonly provenanceStatus?: ProvenanceStatus;
  readonly resourceDecision?: PolicyResourceDecision;
  readonly auditEvent: PolicyAuditEvent;
}

export function formatPolicySubject(subject: PolicySubject): string {
  return `${subject.kind}:${subject.id}`;
}

export function parsePolicySubject(value: string): PolicySubject | undefined {
  const parsed = policySubjectSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const separator = value.indexOf(':');
  const kind = value.slice(0, separator) as PolicySubjectKind;
  const id = value.slice(separator + 1);
  return { kind, id };
}

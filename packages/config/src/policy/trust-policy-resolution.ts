import {
  type OrgPolicyStatus,
  type ResolvedTrustPolicy,
  type ResolvedTrustPolicyException,
  type TrustPolicyOrgConfig,
  type TrustPolicyDocument,
  type TrustPolicySource,
  type TrustPolicySourceTier,
} from './trust-policy-schema.js';

const DEFAULT_ORG_CACHE_PATH = '.opensip/policy/org-policy.json';
const DEFAULT_ORG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const BUILTIN_TRUST_POLICY: ResolvedTrustPolicy = {
  mode: 'default',
  ci: 'default',
  exceptions: [],
  org: {
    required: false,
    cachePath: DEFAULT_ORG_CACHE_PATH,
    maxAgeMs: DEFAULT_ORG_MAX_AGE_MS,
  },
  orgStatus: { state: 'available', sourceTier: 'builtin' },
  sourceTiers: ['builtin'],
};

interface TrustPolicyResolutionState {
  mode: ResolvedTrustPolicy['mode'];
  ci: ResolvedTrustPolicy['ci'];
  org: Required<TrustPolicyOrgConfig>;
  orgStatus: OrgPolicyStatus;
  exceptions: ResolvedTrustPolicyException[];
  sourceTiers: TrustPolicySourceTier[];
}

export function resolveTrustPolicySources(
  sources: readonly TrustPolicySource[],
  _now: Date,
): ResolvedTrustPolicy {
  const state: TrustPolicyResolutionState = {
    mode: BUILTIN_TRUST_POLICY.mode,
    ci: BUILTIN_TRUST_POLICY.ci,
    org: { ...BUILTIN_TRUST_POLICY.org },
    orgStatus: BUILTIN_TRUST_POLICY.orgStatus,
    exceptions: [],
    sourceTiers: ['builtin'],
  };

  for (const source of sources) {
    applyTrustPolicySource(state, source);
  }

  return {
    mode: state.mode,
    ci: state.ci,
    exceptions: state.exceptions,
    org: state.org,
    orgStatus: state.orgStatus,
    sourceTiers: state.sourceTiers,
  };
}

function applyTrustPolicySource(
  state: TrustPolicyResolutionState,
  source: TrustPolicySource,
): void {
  appendSourceTier(state.sourceTiers, source.tier);
  if (source.policy !== undefined) applyTrustPolicyDocument(state, source.tier, source.policy);
  if (source.orgStatus !== undefined) state.orgStatus = source.orgStatus;
}

function appendSourceTier(sourceTiers: TrustPolicySourceTier[], tier: TrustPolicySourceTier): void {
  if (tier !== 'builtin' && !sourceTiers.includes(tier)) sourceTiers.push(tier);
}

function applyTrustPolicyDocument(
  state: TrustPolicyResolutionState,
  tier: TrustPolicySourceTier,
  policy: TrustPolicyDocument,
): void {
  if (policy.mode !== undefined) state.mode = policy.mode;
  if (policy.ci !== undefined) state.ci = policy.ci;
  if (policy.org !== undefined) state.org = { ...state.org, ...withoutUndefined(policy.org) };
  state.exceptions.push(
    ...(policy.exceptions ?? []).map((exception) => ({ ...exception, sourceTier: tier })),
  );
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function trustPolicySource(
  tier: TrustPolicySourceTier,
  policy: TrustPolicyDocument | undefined,
  orgStatus?: OrgPolicyStatus,
): TrustPolicySource {
  return orgStatus === undefined ? { tier, policy } : { tier, policy, orgStatus };
}

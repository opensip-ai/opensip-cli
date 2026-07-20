import {
  TRUST_POLICY_SOURCE_TIERS,
  type CapabilityTrustGrant,
  type OrgPolicyStatus,
  type ResolvedTrustPolicy,
  type ResolvedTrustPolicyException,
  type TrustPolicyOrgConfig,
  type TrustPolicySource,
  type TrustPolicySourceTier,
  type UserTrustPolicyDocument,
} from './trust-policy-schema.js';

const DEFAULT_ORG_CACHE_PATH = '.opensip/policy/org-policy.json';
const DEFAULT_ORG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const BUILTIN_TRUST_POLICY: ResolvedTrustPolicy = {
  mode: 'default',
  modeSourceTier: 'builtin',
  ci: 'default',
  ciSourceTier: 'builtin',
  exceptions: [],
  org: {
    required: false,
    cachePath: DEFAULT_ORG_CACHE_PATH,
    maxAgeMs: DEFAULT_ORG_MAX_AGE_MS,
  },
  orgStatus: { state: 'available', sourceTier: 'builtin' },
  sourceTiers: ['builtin'],
  capabilityGrants: [],
};

interface TrustPolicyResolutionState {
  mode: ResolvedTrustPolicy['mode'];
  modeSourceTier: TrustPolicySourceTier;
  ci: ResolvedTrustPolicy['ci'];
  ciSourceTier: TrustPolicySourceTier;
  org: Required<TrustPolicyOrgConfig>;
  orgStatus: OrgPolicyStatus;
  exceptions: ResolvedTrustPolicyException[];
  sourceTiers: TrustPolicySourceTier[];
  capabilityGrants: CapabilityTrustGrant[];
}

export function resolveTrustPolicySources(
  sources: readonly TrustPolicySource[],
  now: Date,
): ResolvedTrustPolicy {
  const state: TrustPolicyResolutionState = {
    mode: BUILTIN_TRUST_POLICY.mode,
    modeSourceTier: 'builtin',
    ci: BUILTIN_TRUST_POLICY.ci,
    ciSourceTier: 'builtin',
    org: { ...BUILTIN_TRUST_POLICY.org },
    orgStatus: BUILTIN_TRUST_POLICY.orgStatus,
    exceptions: [],
    sourceTiers: ['builtin'],
    capabilityGrants: [],
  };

  // Source precedence is a property of the tier, not of whatever order a
  // caller happened to collect the inputs in. Preserve order within one tier
  // while always applying the documented builtin → user → project → org
  // layering.
  for (const tier of TRUST_POLICY_SOURCE_TIERS) {
    for (const source of sources) {
      if (source.tier === tier) applyTrustPolicySource(state, source);
    }
  }

  return {
    mode: state.mode,
    modeSourceTier: state.modeSourceTier,
    ci: state.ci,
    ciSourceTier: state.ciSourceTier,
    // Status reports expose active exceptions. Keep the evaluator's
    // request-time check too, because a long-lived process can cross an expiry
    // boundary after policy resolution.
    exceptions: state.exceptions.filter((exception) => {
      const expiresAt = Date.parse(exception.expiresAt);
      return Number.isFinite(expiresAt) && expiresAt > now.getTime();
    }),
    org: state.org,
    orgStatus: state.orgStatus,
    sourceTiers: state.sourceTiers,
    capabilityGrants: state.capabilityGrants,
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
  policy: UserTrustPolicyDocument,
): void {
  if (policy.mode !== undefined) {
    state.mode = policy.mode;
    state.modeSourceTier = tier;
  }
  if (policy.ci !== undefined) {
    state.ci = policy.ci;
    state.ciSourceTier = tier;
  }
  if (policy.org !== undefined) state.org = { ...state.org, ...withoutUndefined(policy.org) };
  state.exceptions.push(
    ...(policy.exceptions ?? []).map((exception) => ({ ...exception, sourceTier: tier })),
  );
  // Capability trust grants are USER-TIER-ONLY: the global config document is
  // the single out-of-repo trust surface. Any other tier carrying the field
  // (impossible via the strict project schema, defensive here) is ignored.
  if (tier === 'user' && policy.trustedCapabilityPacks !== undefined) {
    state.capabilityGrants.push(...policy.trustedCapabilityPacks);
  }
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function trustPolicySource(
  tier: TrustPolicySourceTier,
  policy: UserTrustPolicyDocument | undefined,
  orgStatus?: OrgPolicyStatus,
): TrustPolicySource {
  return orgStatus === undefined ? { tier, policy } : { tier, policy, orgStatus };
}

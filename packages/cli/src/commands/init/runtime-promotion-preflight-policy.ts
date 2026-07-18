import type {
  RuntimePromotionConflictPolicy,
  RuntimePromotionRoute,
  RuntimePromotionSourceClassification,
} from './runtime-promotion-journal-schema.js';

export type RuntimePromotionPreliminaryEquality =
  'not-required' | 'verified-equal' | 'verified-different' | 'unverified';

export type RuntimePromotionPreflightConflictReason =
  | 'cache-candidates-ambiguous'
  | 'cache-marker-invalid'
  | 'cache-path-unsafe'
  | 'project-path-unsafe'
  | 'keep-project-requires-destination'
  | 'weak-source-requires-use-cache'
  | 'weak-source-not-deduplicable'
  | 'runtime-diverged'
  | 'runtime-equivalence-unverified';

export interface RuntimePromotionAuthorityPolicyInput {
  readonly sourceClassification: RuntimePromotionSourceClassification;
  readonly destinationRuntimePreexisting: boolean;
  readonly requestedConflict?: RuntimePromotionConflictPolicy;
  readonly preliminaryEquality?: RuntimePromotionPreliminaryEquality;
}

export type RuntimePromotionAuthorityPolicySelection =
  | {
      readonly status: 'selected';
      readonly route: RuntimePromotionRoute;
      readonly effectiveConflict: RuntimePromotionConflictPolicy;
    }
  | {
      readonly status: 'conflict';
      readonly reason: RuntimePromotionPreflightConflictReason;
      readonly effectiveConflict: RuntimePromotionConflictPolicy;
      readonly sourcePreserved: boolean;
      readonly allowedPolicies: readonly RuntimePromotionConflictPolicy[];
    };

const KEEP_OR_USE_CACHE = ['keep-project', 'use-cache'] as const;
const USE_CACHE_ONLY = ['use-cache'] as const;
const ABORT_OR_USE_CACHE = ['abort', 'use-cache'] as const;

function isWeakSource(classification: RuntimePromotionSourceClassification): boolean {
  return classification === 'path-only' || classification === 'legacy';
}

function conflict(
  reason: RuntimePromotionPreflightConflictReason,
  effectiveConflict: RuntimePromotionConflictPolicy,
  allowedPolicies: readonly RuntimePromotionConflictPolicy[],
): RuntimePromotionAuthorityPolicySelection {
  return {
    status: 'conflict',
    reason,
    effectiveConflict,
    sourcePreserved: true,
    allowedPolicies,
  };
}

function selectWithoutDestination(
  requested: RuntimePromotionConflictPolicy,
  weak: boolean,
): RuntimePromotionAuthorityPolicySelection {
  if (requested === 'keep-project') {
    return conflict(
      'keep-project-requires-destination',
      requested,
      weak ? USE_CACHE_ONLY : ABORT_OR_USE_CACHE,
    );
  }
  if (weak && requested !== 'use-cache') {
    return conflict('weak-source-requires-use-cache', requested, USE_CACHE_ONLY);
  }
  return {
    status: 'selected',
    route: 'promote-cache',
    effectiveConflict: requested,
  };
}

/**
 * Select fresh runtime authority without touching the filesystem.
 *
 * Policies are normalized to `abort` only when no cache source exists and the
 * supplied choice is therefore irrelevant. An explicit `keep-project` is
 * never reinterpreted when a source exists: without a destination it is a
 * conflict that preserves the source.
 */
export function selectRuntimePromotionAuthority(
  input: RuntimePromotionAuthorityPolicyInput,
): RuntimePromotionAuthorityPolicySelection {
  const requested = input.requestedConflict ?? 'abort';
  const sourcePresent = input.sourceClassification !== 'none';

  if (!sourcePresent) {
    return {
      status: 'selected',
      route: input.destinationRuntimePreexisting ? 'project-authority' : 'authored-only',
      effectiveConflict: 'abort',
    };
  }

  const weak = isWeakSource(input.sourceClassification);
  if (!input.destinationRuntimePreexisting) {
    return selectWithoutDestination(requested, weak);
  }

  if (requested === 'keep-project') {
    return {
      status: 'selected',
      route: 'keep-project',
      effectiveConflict: requested,
    };
  }
  if (requested === 'use-cache') {
    return {
      status: 'selected',
      route: 'promote-cache',
      effectiveConflict: requested,
    };
  }
  if (weak) {
    return conflict('weak-source-not-deduplicable', requested, KEEP_OR_USE_CACHE);
  }

  const equality = input.preliminaryEquality ?? 'unverified';
  if (equality === 'verified-equal') {
    return {
      status: 'selected',
      route: 'deduplicate-cache',
      effectiveConflict: 'abort',
    };
  }
  return conflict(
    equality === 'verified-different' ? 'runtime-diverged' : 'runtime-equivalence-unverified',
    'abort',
    KEEP_OR_USE_CACHE,
  );
}

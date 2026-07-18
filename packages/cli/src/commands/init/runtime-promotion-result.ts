import type { AuthoredStateSummary } from './authored-state-transaction.js';
import type {
  RuntimePromotionPreflightConflict,
  RuntimePromotionPreflightSelected,
} from './runtime-promotion-preflight.js';
import type {
  RuntimeAdoptionReasonCode,
  RuntimeAdoptionResult,
  RuntimeAdoptionStatus,
  RuntimeIdentityStrength,
  RuntimeRecoveryCommand,
} from '@opensip-cli/contracts';

const SOURCE_ROUTES = new Set(['promote-cache', 'keep-project', 'deduplicate-cache']);

export function promotionDuration(startedAt: number, now: () => number): number {
  return Math.max(0, now() - startedAt);
}

export function proofStrength(
  preflight: Pick<RuntimePromotionPreflightSelected, 'source'>,
): RuntimeIdentityStrength | undefined {
  switch (preflight.source.classification) {
    case 'generation-bound': {
      return 'generation-bound';
    }
    case 'path-only': {
      return 'path-only';
    }
    case 'legacy': {
      return 'legacy-unverified';
    }
    case 'none': {
      return undefined;
    }
  }
}

export function authoredResult(
  summary: AuthoredStateSummary | null,
): RuntimeAdoptionResult['authored'] {
  return summary === null
    ? undefined
    : {
        created: summary.created,
        replaced: summary.replaced,
        deleted: summary.deleted,
        preserved: summary.preserved,
      };
}

function conflictReason(conflict: RuntimePromotionPreflightConflict): RuntimeAdoptionReasonCode {
  switch (conflict.reason) {
    case 'keep-project-requires-destination': {
      return 'destination-absent';
    }
    case 'weak-source-requires-use-cache':
    case 'weak-source-not-deduplicable': {
      return 'weak-source-requires-selection';
    }
    case 'runtime-diverged': {
      return 'divergent';
    }
    case 'cache-candidates-ambiguous': {
      return 'state-ambiguous';
    }
    case 'cache-marker-invalid':
    case 'cache-path-unsafe':
    case 'project-path-unsafe':
    case 'runtime-equivalence-unverified': {
      return 'destination-unverified';
    }
  }
}

function conflictNextCommand(
  conflict: RuntimePromotionPreflightConflict,
): RuntimeRecoveryCommand | undefined {
  if (conflict.allowedPolicies.includes('keep-project')) {
    return 'opensip init --runtime-conflict keep-project';
  }
  if (conflict.allowedPolicies.includes('use-cache')) {
    return 'opensip init --runtime-conflict use-cache';
  }
  return undefined;
}

export function conflictResult(
  conflict: RuntimePromotionPreflightConflict,
  startedAt: number,
  now: () => number,
): RuntimeAdoptionResult {
  const nextCommand = conflictNextCommand(conflict);
  return {
    status: 'conflict',
    sourcePreserved: conflict.sourcePreserved,
    durationMs: promotionDuration(startedAt, now),
    reasonCode: conflictReason(conflict),
    ...(nextCommand === undefined ? {} : { nextCommand }),
  };
}

export function busyResult(startedAt: number, now: () => number): RuntimeAdoptionResult {
  return {
    status: 'busy',
    durationMs: promotionDuration(startedAt, now),
    reasonCode: 'lease-busy',
    nextCommand: 'opensip init',
  };
}

function committedStatus(preflight: RuntimePromotionPreflightSelected): RuntimeAdoptionStatus {
  switch (preflight.route) {
    case 'authored-only': {
      return 'not-found';
    }
    case 'project-authority': {
      return 'already-project';
    }
    case 'promote-cache': {
      return 'promoted';
    }
    case 'keep-project': {
      return 'kept-project';
    }
    case 'deduplicate-cache': {
      return 'deduplicated';
    }
  }
}

function committedReason(
  preflight: RuntimePromotionPreflightSelected,
): RuntimeAdoptionReasonCode | undefined {
  switch (preflight.route) {
    case 'authored-only':
    case 'project-authority': {
      return 'source-absent';
    }
    case 'promote-cache': {
      return preflight.destinationRuntimePreexisting ? undefined : 'destination-absent';
    }
    case 'keep-project': {
      return undefined;
    }
    case 'deduplicate-cache': {
      return 'equivalent';
    }
  }
}

export function committedResult(input: {
  readonly preflight: RuntimePromotionPreflightSelected;
  readonly authored: AuthoredStateSummary | null;
  readonly cleanupPending: boolean;
  readonly startedAt: number;
  readonly now: () => number;
}): RuntimeAdoptionResult {
  const strength = proofStrength(input.preflight);
  const authored = authoredResult(input.authored);
  const sourceRetired = SOURCE_ROUTES.has(input.preflight.route);
  const reason = committedReason(input.preflight);
  const reasonFields: {
    reasonCode?: RuntimeAdoptionReasonCode;
    nextCommand?: RuntimeRecoveryCommand;
  } = {};
  if (input.cleanupPending) {
    reasonFields.reasonCode = 'cleanup-pending';
    reasonFields.nextCommand = 'opensip init';
  } else if (reason !== undefined) {
    reasonFields.reasonCode = reason;
  }
  return {
    status: input.cleanupPending ? 'cleanup-pending' : committedStatus(input.preflight),
    ...(strength === undefined ? {} : { proofStrength: strength }),
    sourcePreserved: false,
    ...(sourceRetired ? { sourceRetired: true } : {}),
    ...(input.cleanupPending ? { cleanupPending: true } : {}),
    ...(authored === undefined ? {} : { authored }),
    durationMs: promotionDuration(input.startedAt, input.now),
    ...reasonFields,
  };
}

export function rolledBackResult(input: {
  readonly preflight: RuntimePromotionPreflightSelected;
  readonly authored: AuthoredStateSummary | null;
  readonly sourcePreserved: boolean;
  readonly cleanupPending: boolean;
  readonly startedAt: number;
  readonly now: () => number;
}): RuntimeAdoptionResult {
  const strength = proofStrength(input.preflight);
  const authored = authoredResult(input.authored);
  return {
    status: input.cleanupPending ? 'cleanup-pending' : 'rolled-back',
    ...(strength === undefined ? {} : { proofStrength: strength }),
    sourcePreserved: input.sourcePreserved,
    sourceRetired: false,
    ...(input.cleanupPending ? { cleanupPending: true } : {}),
    ...(authored === undefined ? {} : { authored }),
    durationMs: promotionDuration(input.startedAt, input.now),
    reasonCode: input.cleanupPending ? 'cleanup-pending' : 'operation-failed',
    nextCommand: 'opensip init',
  };
}

export function recoveryRequiredResult(input: {
  readonly preflight: RuntimePromotionPreflightSelected;
  readonly authored: AuthoredStateSummary | null;
  readonly sourcePreserved?: boolean;
  readonly startedAt: number;
  readonly now: () => number;
}): RuntimeAdoptionResult {
  const strength = proofStrength(input.preflight);
  const authored = authoredResult(input.authored);
  return {
    status: 'recovery-required',
    ...(strength === undefined ? {} : { proofStrength: strength }),
    ...(input.sourcePreserved === undefined ? {} : { sourcePreserved: input.sourcePreserved }),
    ...(authored === undefined ? {} : { authored }),
    durationMs: promotionDuration(input.startedAt, input.now),
    reasonCode: 'operation-failed',
    nextCommand: 'opensip init',
  };
}

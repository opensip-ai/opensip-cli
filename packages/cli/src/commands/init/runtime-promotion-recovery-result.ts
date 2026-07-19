import type { AuthoredStateSummary } from './authored-state-transaction.js';
import type {
  RuntimePromotionJournal,
  RuntimePromotionRoute,
  RuntimePromotionSourceClassification,
} from './runtime-promotion-journal-schema.js';
import type {
  RuntimeAdoptionResult,
  RuntimeAdoptionStatus,
  RuntimeIdentityStrength,
} from '@opensip-cli/contracts';

const INIT_COMMAND = 'opensip init' as const;

function duration(startedAt: number, now: () => number): number {
  return Math.max(0, now() - startedAt);
}

function proofStrength(
  classification: RuntimePromotionSourceClassification | undefined,
): RuntimeIdentityStrength | undefined {
  switch (classification) {
    case 'generation-bound': {
      return 'generation-bound';
    }
    case 'path-only': {
      return 'path-only';
    }
    case 'legacy': {
      return 'legacy-unverified';
    }
    case 'none':
    case undefined: {
      return undefined;
    }
  }
}

function authored(summary: AuthoredStateSummary | null): RuntimeAdoptionResult['authored'] {
  return summary === null
    ? undefined
    : {
        created: summary.created,
        replaced: summary.replaced,
        deleted: summary.deleted,
        preserved: summary.preserved,
      };
}

function committedStatus(route: RuntimePromotionRoute): RuntimeAdoptionStatus {
  switch (route) {
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
  journal: RuntimePromotionJournal,
): 'source-absent' | 'destination-absent' | 'equivalent' | undefined {
  switch (journal.route) {
    case 'authored-only':
    case 'project-authority': {
      return 'source-absent';
    }
    case 'promote-cache': {
      return journal.destinationRuntimePreexisting ? undefined : 'destination-absent';
    }
    case 'keep-project': {
      return undefined;
    }
    case 'deduplicate-cache': {
      return 'equivalent';
    }
  }
}

export function recoveryBusyResult(startedAt: number, now: () => number): RuntimeAdoptionResult {
  return {
    status: 'busy',
    durationMs: duration(startedAt, now),
    reasonCode: 'lease-busy',
    nextCommand: INIT_COMMAND,
  };
}

export function recoveryInputConflictResult(
  journal: RuntimePromotionJournal,
  startedAt: number,
  now: () => number,
): RuntimeAdoptionResult {
  const strength = proofStrength(journal.source.classification);
  return {
    status: 'conflict',
    ...(strength === undefined ? {} : { proofStrength: strength }),
    durationMs: duration(startedAt, now),
    reasonCode: 'state-ambiguous',
    nextCommand: INIT_COMMAND,
  };
}

export function recoveryRequiredFromJournal(input: {
  readonly journal?: RuntimePromotionJournal;
  readonly authored?: AuthoredStateSummary | null;
  readonly sourcePreserved?: boolean;
  readonly reasonCode?:
    | 'operation-failed'
    | 'journal-malformed'
    | 'journal-oversize'
    | 'journal-key-mismatch'
    | 'journal-phase-invalid'
    | 'artifact-missing'
    | 'artifact-mismatch'
    | 'state-ambiguous'
    | 'rollback-incomplete';
  readonly startedAt: number;
  readonly now: () => number;
}): RuntimeAdoptionResult {
  const strength = proofStrength(input.journal?.source.classification);
  const authoredSummary = authored(input.authored ?? null);
  return {
    status: 'recovery-required',
    ...(strength === undefined ? {} : { proofStrength: strength }),
    ...(input.sourcePreserved === undefined ? {} : { sourcePreserved: input.sourcePreserved }),
    ...(authoredSummary === undefined ? {} : { authored: authoredSummary }),
    durationMs: duration(input.startedAt, input.now),
    reasonCode: input.reasonCode ?? 'operation-failed',
    nextCommand: INIT_COMMAND,
  };
}

interface RecoveredTerminalResultInput {
  readonly journal: RuntimePromotionJournal;
  readonly authored: AuthoredStateSummary | null;
  readonly cleanupPending: boolean;
  readonly startedAt: number;
  readonly now: () => number;
}

function recoveredRolledBackResult(
  input: RecoveredTerminalResultInput,
  terminal: NonNullable<RuntimePromotionJournal['terminal']>,
): RuntimeAdoptionResult {
  const strength = proofStrength(input.journal.source.classification);
  const authoredSummary = authored(input.authored);
  return {
    status: 'rolled-back',
    ...(strength === undefined ? {} : { proofStrength: strength }),
    sourcePreserved: terminal.sourcePreserved,
    sourceRetired: false,
    ...(input.cleanupPending ? { cleanupPending: true } : {}),
    ...(authoredSummary === undefined ? {} : { authored: authoredSummary }),
    durationMs: duration(input.startedAt, input.now),
    reasonCode: 'operation-failed',
    nextCommand: INIT_COMMAND,
  };
}

function recoveredCommittedResult(input: RecoveredTerminalResultInput): RuntimeAdoptionResult {
  const strength = proofStrength(input.journal.source.classification);
  const authoredSummary = authored(input.authored);
  const sourceRoute = input.journal.source.classification !== 'none';
  const reason = committedReason(input.journal);
  const cleanup = input.cleanupPending
    ? {
        cleanupPending: true as const,
        reasonCode: 'cleanup-pending' as const,
        nextCommand: INIT_COMMAND,
      }
    : {};
  return {
    status: input.cleanupPending ? 'cleanup-pending' : committedStatus(input.journal.route),
    ...(strength === undefined ? {} : { proofStrength: strength }),
    sourcePreserved: false,
    ...(sourceRoute ? { sourceRetired: true } : {}),
    ...(authoredSummary === undefined ? {} : { authored: authoredSummary }),
    durationMs: duration(input.startedAt, input.now),
    ...(reason === undefined || input.cleanupPending ? {} : { reasonCode: reason }),
    ...cleanup,
  };
}

/**
 * Project a terminal recovery result from durable journal evidence.
 *
 * @throws {Error} When the supplied journal has no terminal evidence.
 */
export function recoveredTerminalResult(
  input: RecoveredTerminalResultInput,
): RuntimeAdoptionResult {
  const terminal = input.journal.terminal;
  if (terminal === null) {
    throw new Error('A recovered terminal result requires terminal journal evidence');
  }
  return terminal.outcome === 'rolled-back'
    ? recoveredRolledBackResult(input, terminal)
    : recoveredCommittedResult(input);
}

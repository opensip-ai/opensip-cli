/** Complete closed-schema validation assembled from focused nested validators. */

import { validateRuntimePromotionCrossFields } from './runtime-promotion-journal-cross-validation.js';
import {
  assertRuntimeManifestIdentity,
  validateIntent,
  validateManifests,
  validatePostcondition,
} from './runtime-promotion-journal-identity-validation.js';
import {
  RUNTIME_PROMOTION_AUTHORITIES,
  RUNTIME_PROMOTION_CLEANUP_STATES,
  RUNTIME_PROMOTION_COORDINATION_KEY_PATTERN,
  RUNTIME_PROMOTION_DIRECTIONS,
  RUNTIME_PROMOTION_JOURNAL_CAPS,
  RUNTIME_PROMOTION_JOURNAL_KIND,
  RUNTIME_PROMOTION_JOURNAL_VERSION,
  RUNTIME_PROMOTION_OPERATION_ID_PATTERN,
  RUNTIME_PROMOTION_OWNED_SLOT_NAMES,
  RUNTIME_PROMOTION_OWNER_TOKEN_PATTERN,
  RUNTIME_PROMOTION_PHASES,
  RUNTIME_PROMOTION_ROUTES,
  RUNTIME_PROMOTION_RUNTIME_INSTALL_STATES,
  RUNTIME_PROMOTION_TERMINAL_OUTCOMES,
  type RuntimePromotionJournal,
} from './runtime-promotion-journal-types.js';
import {
  journalChoice,
  journalFailure,
  journalInteger,
  journalKeys,
  journalObject,
  journalPattern,
  validateInputs,
  validateOwned,
  validatePlan,
  validateSource,
} from './runtime-promotion-journal-validation-helpers.js';

export function isRuntimePromotionCoordinationKey(value: string): boolean {
  return RUNTIME_PROMOTION_COORDINATION_KEY_PATTERN.test(value);
}

const TOP_LEVEL_KEYS = [
  'kind',
  'version',
  'coordinationKey',
  'operationId',
  'state',
  'revision',
  'recoveryOwnerToken',
  'recoveryAttempt',
  'route',
  'destinationParentPreexisting',
  'destinationRuntimePreexisting',
  'source',
  'inputs',
  'plan',
  'owned',
  'manifests',
  'progress',
  'terminal',
  'cleanup',
  'counts',
  'timestamps',
] as const;

function validateProgress(value: unknown, mutationCount: number): void {
  const progress = journalObject(value, 'progress');
  journalKeys(
    progress,
    [
      'phase',
      'direction',
      'runtimeInstallState',
      'authoredCursor',
      'rollbackCursor',
      'pendingIntent',
      'lastPostcondition',
    ],
    'progress',
  );
  const phase = journalChoice(progress.phase, RUNTIME_PROMOTION_PHASES, 'progress.phase');
  const direction = journalChoice(
    progress.direction,
    RUNTIME_PROMOTION_DIRECTIONS,
    'progress.direction',
  );
  journalChoice(
    progress.runtimeInstallState,
    RUNTIME_PROMOTION_RUNTIME_INSTALL_STATES,
    'progress.runtimeInstallState',
  );
  const authored = journalInteger(
    progress.authoredCursor,
    'progress.authoredCursor',
    mutationCount,
  );
  const rollback = journalInteger(
    progress.rollbackCursor,
    'progress.rollbackCursor',
    mutationCount,
  );
  if (rollback > authored) journalFailure('progress.rollbackCursor cannot exceed authoredCursor');
  const pending =
    progress.pendingIntent === null
      ? null
      : validateIntent(progress.pendingIntent, 'progress.pendingIntent');
  const last =
    progress.lastPostcondition === null
      ? null
      : validatePostcondition(progress.lastPostcondition, 'progress.lastPostcondition');
  if (
    (pending?.cursor !== null && pending !== null && pending.cursor >= mutationCount) ||
    (last?.cursor !== null && last !== null && last.cursor >= mutationCount)
  ) {
    journalFailure('authored cursor is outside the replay plan');
  }
  const rollbackPhase = [
    'rollback-started',
    'runtime-rolled-back',
    'authored-rolled-back',
    'rolled-back',
  ].includes(phase);
  const cleanupPhase = phase === 'closed' || phase === 'cleanup';
  if (
    (rollbackPhase && direction !== 'rollback') ||
    (cleanupPhase && direction !== 'cleanup') ||
    (!rollbackPhase && !cleanupPhase && direction !== 'forward')
  ) {
    journalFailure('progress phase and direction are inconsistent');
  }
}

function validateTerminal(value: unknown): void {
  if (value === null) return;
  const terminal = journalObject(value, 'terminal');
  journalKeys(
    terminal,
    [
      'outcome',
      'authority',
      'runtimeManifest',
      'authoredVerified',
      'sourcePreserved',
      'verifiedAt',
    ],
    'terminal',
  );
  journalChoice(terminal.outcome, RUNTIME_PROMOTION_TERMINAL_OUTCOMES, 'terminal.outcome');
  journalChoice(terminal.authority, RUNTIME_PROMOTION_AUTHORITIES, 'terminal.authority');
  if (terminal.runtimeManifest !== null) {
    assertRuntimeManifestIdentity(terminal.runtimeManifest, 'terminal.runtimeManifest');
  }
  if (
    typeof terminal.authoredVerified !== 'boolean' ||
    typeof terminal.sourcePreserved !== 'boolean'
  ) {
    journalFailure('terminal verification flags must be boolean');
  }
  journalInteger(
    terminal.verifiedAt,
    'terminal.verifiedAt',
    RUNTIME_PROMOTION_JOURNAL_CAPS.maxTimestamp,
  );
}

function validateCleanupAndCounts(journal: Record<string, unknown>, mutationCount: number): void {
  const cleanup = journalObject(journal.cleanup, 'cleanup');
  journalKeys(cleanup, RUNTIME_PROMOTION_OWNED_SLOT_NAMES, 'cleanup');
  for (const name of RUNTIME_PROMOTION_OWNED_SLOT_NAMES) {
    journalChoice(cleanup[name], RUNTIME_PROMOTION_CLEANUP_STATES, `cleanup.${name}`);
  }
  const counts = journalObject(journal.counts, 'counts');
  journalKeys(
    counts,
    [
      'intentCount',
      'postconditionCount',
      'authoredCompleted',
      'authoredRolledBack',
      'cleanupCompleted',
    ],
    'counts',
  );
  const intents = journalInteger(
    counts.intentCount,
    'counts.intentCount',
    RUNTIME_PROMOTION_JOURNAL_CAPS.maxRevision,
  );
  const posts = journalInteger(
    counts.postconditionCount,
    'counts.postconditionCount',
    RUNTIME_PROMOTION_JOURNAL_CAPS.maxRevision,
  );
  if (posts > intents) journalFailure('postcondition count cannot exceed intent count');
  journalInteger(counts.authoredCompleted, 'counts.authoredCompleted', mutationCount);
  journalInteger(counts.authoredRolledBack, 'counts.authoredRolledBack', mutationCount);
  journalInteger(
    counts.cleanupCompleted,
    'counts.cleanupCompleted',
    RUNTIME_PROMOTION_OWNED_SLOT_NAMES.length,
  );
}

function validateTimestamps(value: unknown): void {
  const timestamps = journalObject(value, 'timestamps');
  journalKeys(timestamps, ['createdAt', 'updatedAt', 'closedAt'], 'timestamps');
  const created = journalInteger(
    timestamps.createdAt,
    'timestamps.createdAt',
    RUNTIME_PROMOTION_JOURNAL_CAPS.maxTimestamp,
  );
  const updated = journalInteger(
    timestamps.updatedAt,
    'timestamps.updatedAt',
    RUNTIME_PROMOTION_JOURNAL_CAPS.maxTimestamp,
  );
  if (updated < created) journalFailure('timestamps.updatedAt precedes createdAt');
  if (timestamps.closedAt !== null) {
    const closed = journalInteger(
      timestamps.closedAt,
      'timestamps.closedAt',
      RUNTIME_PROMOTION_JOURNAL_CAPS.maxTimestamp,
    );
    if (closed < created || closed > updated) {
      journalFailure('timestamps.closedAt is outside the journal lifetime');
    }
  }
}

export function assertRuntimePromotionJournalShape(
  value: unknown,
): asserts value is RuntimePromotionJournal {
  const journal = journalObject(value, 'journal');
  journalKeys(
    journal,
    journal.reason === undefined ? TOP_LEVEL_KEYS : [...TOP_LEVEL_KEYS, 'reason'],
    'journal',
  );
  if (journal.kind !== RUNTIME_PROMOTION_JOURNAL_KIND) journalFailure('kind is unsupported');
  if (journal.version !== RUNTIME_PROMOTION_JOURNAL_VERSION) {
    journalFailure('version is unsupported');
  }
  journalPattern(
    journal.coordinationKey,
    RUNTIME_PROMOTION_COORDINATION_KEY_PATTERN,
    'coordinationKey',
  );
  const operationId = journalPattern(
    journal.operationId,
    RUNTIME_PROMOTION_OPERATION_ID_PATTERN,
    'operationId',
  );
  if (journal.state !== 'open' && journal.state !== 'closed')
    journalFailure('state is unsupported');
  journalInteger(journal.revision, 'revision', RUNTIME_PROMOTION_JOURNAL_CAPS.maxRevision);
  journalPattern(
    journal.recoveryOwnerToken,
    RUNTIME_PROMOTION_OWNER_TOKEN_PATTERN,
    'recoveryOwnerToken',
  );
  journalInteger(
    journal.recoveryAttempt,
    'recoveryAttempt',
    RUNTIME_PROMOTION_JOURNAL_CAPS.maxRecoveryAttempts,
    1,
  );
  journalChoice(journal.route, RUNTIME_PROMOTION_ROUTES, 'route');
  if (typeof journal.destinationParentPreexisting !== 'boolean') {
    journalFailure('destinationParentPreexisting must be boolean');
  }
  if (typeof journal.destinationRuntimePreexisting !== 'boolean') {
    journalFailure('destinationRuntimePreexisting must be boolean');
  }
  validateSource(journal.source);
  validateInputs(journal.inputs);
  const mutationCount = validatePlan(journal.plan);
  validateOwned(journal.owned, operationId);
  validateManifests(journal.manifests);
  validateProgress(journal.progress, mutationCount);
  validateTerminal(journal.terminal);
  validateCleanupAndCounts(journal, mutationCount);
  validateTimestamps(journal.timestamps);
  const reasonHasControl =
    typeof journal.reason === 'string' &&
    [...journal.reason].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    });
  if (
    journal.reason !== undefined &&
    (typeof journal.reason !== 'string' ||
      journal.reason.length === 0 ||
      reasonHasControl ||
      Buffer.byteLength(journal.reason, 'utf8') > RUNTIME_PROMOTION_JOURNAL_CAPS.maxReasonBytes)
  ) {
    journalFailure('reason must be bounded and free of control characters');
  }
  validateRuntimePromotionCrossFields(journal as unknown as RuntimePromotionJournal);
}

export function isRuntimePromotionJournalShape(value: unknown): value is RuntimePromotionJournal {
  try {
    assertRuntimePromotionJournalShape(value);
    return true;
  } catch {
    return false;
  }
}

export {
  canonicalSqliteIdentity,
  assertRuntimeManifestIdentity,
} from './runtime-promotion-journal-identity-validation.js';
export {
  isRuntimePromotionDigest,
  isSafeRuntimePromotionBasename,
} from './runtime-promotion-journal-validation-helpers.js';

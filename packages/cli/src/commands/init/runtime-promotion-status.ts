/**
 * Read-only, bounded projection of Init's fixed promotion journal.
 *
 * The core runtime plane owns the filesystem trust boundary and transports only
 * anchored, bounded bytes. Init owns the complete journal schema and reduces it
 * to the small customer-safe recovery vocabulary returned here.
 */

import {
  inspectRuntimePromotionRecoveryHeader,
  projectCoordinationKey,
  readAnchoredRecord,
  resolveCoordinationPaths,
  RUNTIME_PROMOTION_JOURNAL_FILE,
  RUNTIME_RECOVERY_RECORD_MAX_BYTES,
  type AnchoredRecordReadResult,
  type RecoveryHeaderInspection,
} from '@opensip-cli/core';

import { getErrorCode } from './error-code.js';
import {
  parseRuntimePromotionJournal,
  RUNTIME_PROMOTION_JOURNAL_MAX_BYTES,
  type RuntimePromotionJournal,
  type RuntimePromotionPendingIntent,
  type RuntimePromotionPhase,
} from './runtime-promotion-journal-schema.js';

import type {
  RuntimeRecoveryCommand,
  RuntimeRecoveryPhase,
  RuntimeRecoveryReasonCode,
} from '@opensip-cli/contracts';

export type RuntimePromotionStatusInspection =
  | { readonly status: 'absent' }
  | { readonly status: 'busy' }
  | {
      readonly status: 'recovery-required';
      readonly recoveryPhase: RuntimeRecoveryPhase;
      readonly recoveryReasonCode: RuntimeRecoveryReasonCode;
      readonly recoveryCommand: RuntimeRecoveryCommand;
    }
  | {
      readonly status: 'cleanup-pending';
      readonly recoveryPhase: 'cleanup';
      readonly recoveryReasonCode: 'cleanup-pending';
      readonly recoveryCommand: 'opensip init';
      readonly sourcePreserved?: boolean;
    };

/** Injectable journal-inspection seam for deterministic race and trust-boundary tests. */
export interface RuntimePromotionStatusDependencies {
  readonly coordinationKeyForProject: (projectRoot: string) => string;
  readonly inspectHeader: (projectRoot: string) => RecoveryHeaderInspection;
  readonly readJournal: (coordinationKey: string) => AnchoredRecordReadResult;
}

export interface InspectRuntimePromotionStatusInput {
  readonly projectRoot: string;
  readonly coordinationKey: string;
  readonly dependencies?: Partial<RuntimePromotionStatusDependencies>;
}

interface RuntimePromotionJournalReadAttempt {
  readonly observed?: AnchoredRecordReadResult;
  readonly error?: unknown;
}

const INTENT_PHASES: Readonly<Record<RuntimePromotionPendingIntent['kind'], RuntimeRecoveryPhase>> =
  {
    'runtime-stage-create': 'runtime-staging',
    'destination-parent-create': 'runtime-staging',
    'destination-backup-create': 'destination-backup',
    'destination-install': 'destination-install',
    'authored-prepare': 'authored-prepare',
    'authored-target-commit': 'authored-commit',
    'source-retire': 'source-retirement',
    'runtime-rollback': 'rollback',
    'authored-target-rollback': 'rollback',
    'owned-slot-cleanup': 'cleanup',
  };

const IDLE_PHASES: Readonly<Record<RuntimePromotionPhase, RuntimeRecoveryPhase>> = {
  prepared: 'prepared',
  'source-verified': 'source-verification',
  'destination-verified': 'source-verification',
  'authored-prepared': 'authored-prepare',
  'destination-ready': 'runtime-staging',
  'runtime-staged': 'runtime-staging',
  'destination-backed-up': 'destination-backup',
  'runtime-installed': 'destination-install',
  'authored-committed': 'authored-commit',
  'source-retired': 'source-retirement',
  'authority-verified': 'source-retirement',
  committed: 'cleanup',
  'rollback-started': 'rollback',
  'runtime-rolled-back': 'rollback',
  'authored-rolled-back': 'rollback',
  'rolled-back': 'rollback',
  closed: 'cleanup',
  cleanup: 'cleanup',
};

/**
 * Reduce Init's internal phase machine to its deliberately coarser public
 * vocabulary. Direction is authoritative; a pending forward intent is more
 * current than the last completed idle phase.
 */
export function projectRuntimePromotionRecoveryPhase(
  journal: Pick<RuntimePromotionJournal, 'progress'>,
): RuntimeRecoveryPhase {
  if (journal.progress.direction === 'rollback') return 'rollback';
  if (journal.progress.direction === 'cleanup') return 'cleanup';
  const pending = journal.progress.pendingIntent;
  return pending === null ? IDLE_PHASES[journal.progress.phase] : INTENT_PHASES[pending.kind];
}

function defaultReadJournal(coordinationKey: string): AnchoredRecordReadResult {
  const paths = resolveCoordinationPaths();
  const projectPaths = paths.forProject(coordinationKey);
  return readAnchoredRecord({
    trustedAnchorDir: paths.coordinationDir,
    parentDir: projectPaths.projectCoordinationDir,
    basename: RUNTIME_PROMOTION_JOURNAL_FILE,
    maxBytes: RUNTIME_RECOVERY_RECORD_MAX_BYTES,
    permissionPosture: 'private',
  });
}

function dependencies(
  overrides: Partial<RuntimePromotionStatusDependencies> | undefined,
): RuntimePromotionStatusDependencies {
  return {
    coordinationKeyForProject: projectCoordinationKey,
    inspectHeader: inspectRuntimePromotionRecoveryHeader,
    readJournal: defaultReadJournal,
    ...overrides,
  };
}

function sameHeader(before: RecoveryHeaderInspection, after: RecoveryHeaderInspection): boolean {
  if (before.status !== after.status) return false;
  if (before.status === 'absent' || after.status === 'absent') return true;
  if (before.status === 'malformed' && after.status === 'malformed') {
    return before.reason === after.reason;
  }
  if (before.status !== 'valid' || after.status !== 'valid') return false;
  return (
    before.state === after.state &&
    before.operationId === after.operationId &&
    before.reason === after.reason
  );
}

function malformedReason(
  reason: Extract<RecoveryHeaderInspection, { readonly status: 'malformed' }>['reason'],
): RuntimeRecoveryReasonCode {
  if (reason === 'oversize') return 'journal-oversize';
  if (reason === 'coordination-key-mismatch') return 'journal-key-mismatch';
  if (reason === 'unsafe-file') return 'state-ambiguous';
  return 'journal-malformed';
}

function recoveryRequired(
  recoveryReasonCode: RuntimeRecoveryReasonCode,
): RuntimePromotionStatusInspection {
  return {
    status: 'recovery-required',
    recoveryPhase: 'unknown',
    recoveryReasonCode,
    recoveryCommand: 'opensip init',
  };
}

function cleanupPending(sourcePreserved?: boolean): RuntimePromotionStatusInspection {
  return {
    status: 'cleanup-pending',
    recoveryPhase: 'cleanup',
    recoveryReasonCode: 'cleanup-pending',
    recoveryCommand: 'opensip init',
    ...(sourcePreserved === undefined ? {} : { sourcePreserved }),
  };
}

function retryCommand(journal: RuntimePromotionJournal): RuntimeRecoveryCommand {
  if (journal.inputs.conflict === 'keep-project') {
    return 'opensip init --runtime-conflict keep-project';
  }
  if (journal.inputs.conflict === 'use-cache') {
    return 'opensip init --runtime-conflict use-cache';
  }
  return 'opensip init';
}



function inspectCanonicalJournal(input: {
  readonly observed: AnchoredRecordReadResult;
  readonly header: Extract<RecoveryHeaderInspection, { readonly status: 'valid' }>;
  readonly coordinationKey: string;
}): RuntimePromotionStatusInspection {
  if (input.observed.status === 'absent') return { status: 'busy' };
  if (Buffer.byteLength(input.observed.content, 'utf8') > RUNTIME_PROMOTION_JOURNAL_MAX_BYTES) {
    return recoveryRequired('journal-oversize');
  }

  let journal: RuntimePromotionJournal;
  try {
    journal = parseRuntimePromotionJournal(input.observed.content);
  } catch {
    return recoveryRequired('journal-phase-invalid');
  }
  if (journal.coordinationKey !== input.coordinationKey) {
    return recoveryRequired('journal-key-mismatch');
  }
  if (journal.operationId !== input.header.operationId || journal.state !== input.header.state) {
    return recoveryRequired('journal-phase-invalid');
  }

  if (journal.state === 'open') {
    return {
      status: 'recovery-required',
      recoveryPhase: projectRuntimePromotionRecoveryPhase(journal),
      recoveryReasonCode:
        journal.progress.direction === 'rollback' ? 'operation-failed' : 'operation-interrupted',
      recoveryCommand: retryCommand(journal),
    };
  }

  if (journal.terminal === null) {
    return recoveryRequired('journal-phase-invalid');
  }
  return journal.source.classification === 'none'
    ? cleanupPending()
    : cleanupPending(journal.terminal.sourcePreserved);
}

function readJournalForHeader(
  inspection: RuntimePromotionStatusDependencies,
  before: RecoveryHeaderInspection,
  coordinationKey: string,
): RuntimePromotionJournalReadAttempt {
  if (before.status !== 'valid') return {};
  try {
    return { observed: inspection.readJournal(coordinationKey) };
  } catch (error) {
    return { error };
  }
}

function projectStableHeader(input: {
  readonly before: RecoveryHeaderInspection;
  readonly read: RuntimePromotionJournalReadAttempt;
  readonly coordinationKey: string;
}): RuntimePromotionStatusInspection {
  const { before, read } = input;
  if (before.status === 'absent') return { status: 'absent' };
  if (before.status === 'malformed') {
    return recoveryRequired(malformedReason(before.reason));
  }
  if (read.error !== undefined) {
    const code = getErrorCode(read.error);
    if (
      code === 'SYSTEM.RUNTIME_COORDINATION.BUSY' ||
      code === 'SYSTEM.RUNTIME_COORDINATION.CAS_MISMATCH'
    ) {
      return { status: 'busy' };
    }
    if (before.state === 'closed') return cleanupPending();
    return recoveryRequired(
      code === 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' ? 'state-ambiguous' : 'journal-malformed',
    );
  }
  if (read.observed === undefined) {
    return before.state === 'closed' ? cleanupPending() : { status: 'busy' };
  }
  const projection = inspectCanonicalJournal({
    observed: read.observed,
    header: before,
    coordinationKey: input.coordinationKey,
  });
  return before.state === 'closed' && projection.status !== 'cleanup-pending'
    ? cleanupPending()
    : projection;
}

/**
 * Bracket one full anchored read with the core-owned bounded header. Any
 * publication or state transition observed across that window is reported as
 * busy rather than combining two journal generations.
 */
export function inspectRuntimePromotionStatus(
  input: InspectRuntimePromotionStatusInput,
): RuntimePromotionStatusInspection {
  const inspection = dependencies(input.dependencies);
  if (inspection.coordinationKeyForProject(input.projectRoot) !== input.coordinationKey) {
    return recoveryRequired('journal-key-mismatch');
  }
  const before = inspection.inspectHeader(input.projectRoot);
  const read = readJournalForHeader(inspection, before, input.coordinationKey);
  const after = inspection.inspectHeader(input.projectRoot);
  if (!sameHeader(before, after)) return { status: 'busy' };
  return projectStableHeader({
    before,
    read,
    coordinationKey: input.coordinationKey,
  });
}

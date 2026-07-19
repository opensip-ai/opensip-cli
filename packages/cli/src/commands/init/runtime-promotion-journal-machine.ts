/** Pure legal-transition reducer for the fixed promotion journal. */

import { runtimePromotionDestinationParentReady } from './runtime-promotion-intent-policy.js';
import { assertRuntimePromotionJournal } from './runtime-promotion-journal-schema.js';
import {
  assertRecoveryOwner,
  assertTransitionIdentity,
  assertTransitionManifests,
} from './runtime-promotion-transition-identity-validation.js';
import {
  assertIntentLifecycle,
  sameTransitionValue,
  transitionFailure,
} from './runtime-promotion-transition-validation.js';

import type {
  RuntimePromotionCleanup,
  RuntimePromotionJournal,
  RuntimePromotionOwnedSlotName,
} from './runtime-promotion-journal-schema.js';

const FORWARD_PHASES = [
  'prepared',
  'source-verified',
  'destination-verified',
  'authored-prepared',
  'destination-ready',
  'runtime-staged',
  'destination-backed-up',
  'runtime-installed',
  'authored-committed',
  'source-retired',
  'authority-verified',
  'committed',
] as const;

const ROLLBACK_PHASES = [
  'rollback-started',
  'runtime-rolled-back',
  'authored-rolled-back',
  'rolled-back',
] as const;

function phaseIndex(
  phase: RuntimePromotionJournal['progress']['phase'],
  phases: readonly string[],
) {
  return phases.indexOf(phase);
}

function assertClosedPhase(previous: RuntimePromotionJournal, next: RuntimePromotionJournal): void {
  const cleanupRegressed =
    previous.progress.phase === 'cleanup' && next.progress.phase !== 'cleanup';
  if (
    next.progress.direction !== 'cleanup' ||
    cleanupRegressed ||
    !['closed', 'cleanup'].includes(next.progress.phase)
  ) {
    transitionFailure('closed journal permits only monotonic cleanup phases');
  }
}

function beginsRollback(previous: RuntimePromotionJournal, next: RuntimePromotionJournal): boolean {
  if (previous.progress.direction !== 'forward' || next.progress.direction !== 'rollback') {
    return false;
  }
  if (
    next.progress.phase !== 'rollback-started' ||
    previous.terminal !== null ||
    (previous.route !== 'authored-only' &&
      phaseIndex(previous.progress.phase, FORWARD_PHASES) <
        phaseIndex('destination-verified', FORWARD_PHASES)) ||
    phaseIndex(previous.progress.phase, FORWARD_PHASES) >=
      phaseIndex('source-retired', FORWARD_PHASES)
  ) {
    transitionFailure('rollback must begin explicitly before terminal authority');
  }
  return true;
}

function assertPhase(previous: RuntimePromotionJournal, next: RuntimePromotionJournal): void {
  if (previous.state === 'closed') {
    assertClosedPhase(previous, next);
    return;
  }
  if (next.state === 'closed') {
    if (next.progress.direction !== 'cleanup' || next.progress.phase !== 'closed') {
      transitionFailure('closing must enter the closed cleanup phase');
    }
    return;
  }
  if (beginsRollback(previous, next)) return;
  if (previous.progress.direction !== next.progress.direction) {
    transitionFailure('direction cannot return from rollback or cleanup');
  }
  const phases = next.progress.direction === 'forward' ? FORWARD_PHASES : ROLLBACK_PHASES;
  if (phaseIndex(next.progress.phase, phases) < phaseIndex(previous.progress.phase, phases)) {
    transitionFailure('phase cannot move backward');
  }
  if (!runtimePromotionDestinationParentReady(next)) {
    transitionFailure('destination readiness requires its explicit creation postcondition');
  }
}

function assertTerminal(previous: RuntimePromotionJournal, next: RuntimePromotionJournal): void {
  if (previous.terminal !== null && !sameTransitionValue(previous.terminal, next.terminal)) {
    transitionFailure('terminal authority is immutable');
  }
  if (previous.terminal === null && next.terminal !== null) {
    if (previous.progress.pendingIntent !== null || next.progress.pendingIntent !== null) {
      transitionFailure('terminal authority cannot seal an unresolved intent');
    }
    if (
      (next.terminal.outcome === 'committed' &&
        (previous.progress.phase !== 'authority-verified' ||
          next.progress.phase !== 'committed')) ||
      (next.terminal.outcome === 'rolled-back' &&
        (previous.progress.phase !== 'authored-rolled-back' ||
          next.progress.phase !== 'rolled-back'))
    ) {
      transitionFailure('terminal requires exact committed or rolled-back verification');
    }
  }
  if (
    previous.state === 'open' &&
    next.state === 'closed' &&
    (previous.terminal === null ||
      !sameTransitionValue(previous.terminal, next.terminal) ||
      previous.progress.pendingIntent !== null ||
      next.timestamps.closedAt !== next.timestamps.updatedAt)
  ) {
    transitionFailure('close requires prior terminal proof and no unresolved intent');
  }
}

function validCleanupStep(before: string, after: string): boolean {
  return (
    before === after ||
    (before === 'unmaterialized' && after === 'pending') ||
    (before === 'pending' && after === 'removed')
  );
}

function assertCleanup(previous: RuntimePromotionJournal, next: RuntimePromotionJournal): void {
  for (const name of Object.keys(previous.cleanup) as RuntimePromotionOwnedSlotName[]) {
    if (!validCleanupStep(previous.cleanup[name], next.cleanup[name])) {
      transitionFailure(`${name} cleanup state is not monotonic`);
    }
  }
  if (
    previous.state === 'closed' &&
    !sameTransitionValue(
      {
        manifests: previous.manifests,
        terminal: previous.terminal,
        reason: previous.reason,
        runtimeInstallState: previous.progress.runtimeInstallState,
        authoredCursor: previous.progress.authoredCursor,
        rollbackCursor: previous.progress.rollbackCursor,
      },
      {
        manifests: next.manifests,
        terminal: next.terminal,
        reason: next.reason,
        runtimeInstallState: next.progress.runtimeInstallState,
        authoredCursor: next.progress.authoredCursor,
        rollbackCursor: next.progress.rollbackCursor,
      },
    )
  ) {
    transitionFailure('closed receipt permits cleanup-only mutations');
  }
}

export function assertRuntimePromotionTransition(
  previous: RuntimePromotionJournal,
  proposed: RuntimePromotionJournal,
): void {
  assertRuntimePromotionJournal(previous);
  assertRuntimePromotionJournal(proposed);
  assertTransitionIdentity(previous, proposed);
  assertRecoveryOwner(previous, proposed);
  assertTransitionManifests(previous, proposed);
  assertIntentLifecycle(previous, proposed);
  assertPhase(previous, proposed);
  assertTerminal(previous, proposed);
  assertCleanup(previous, proposed);
}

/** Revision zero is always the journal-first prepared record. */
export function assertInitialRuntimePromotionJournal(journal: RuntimePromotionJournal): void {
  assertRuntimePromotionJournal(journal);
  const emptyCleanup: RuntimePromotionCleanup = {
    destinationParent: 'unmaterialized',
    runtimeStage: 'unmaterialized',
    destinationBackup: 'unmaterialized',
    sourceTombstone: 'unmaterialized',
    authoredStage: 'unmaterialized',
    authoredBackup: 'unmaterialized',
    replayManifest: 'unmaterialized',
  };
  if (
    journal.revision !== 0 ||
    journal.state !== 'open' ||
    journal.recoveryAttempt !== 1 ||
    journal.progress.phase !== 'prepared' ||
    journal.progress.direction !== 'forward' ||
    journal.progress.runtimeInstallState !== 'not-installed' ||
    journal.progress.pendingIntent !== null ||
    journal.progress.lastPostcondition !== null ||
    journal.terminal !== null ||
    !sameTransitionValue(journal.cleanup, emptyCleanup) ||
    Object.values(journal.counts).some((count) => count !== 0) ||
    journal.timestamps.createdAt !== journal.timestamps.updatedAt ||
    journal.timestamps.closedAt !== null
  ) {
    transitionFailure('initial record is not the durable prepared revision');
  }
}

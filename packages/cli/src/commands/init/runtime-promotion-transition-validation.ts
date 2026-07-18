/** Identity, manifest, and intent-lifecycle checks for the pure journal reducer. */

import { isDeepStrictEqual } from 'node:util';

import {
  runtimePromotionPendingIntentAllowed,
  runtimePromotionPostconditionPhaseAllowed,
} from './runtime-promotion-intent-policy.js';

import type {
  RuntimeManifestIdentity,
  RuntimePromotionJournal,
  RuntimePromotionOwnedSlotName,
  RuntimePromotionPendingIntent,
  RuntimePromotionPostcondition,
} from './runtime-promotion-journal-schema.js';

export function transitionFailure(message: string): never {
  throw new Error(`Invalid runtime promotion transition: ${message}`);
}

export function sameTransitionValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export function assertTransitionIdentity(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
): void {
  const immutable: readonly (readonly [unknown, unknown, string])[] = [
    [previous.kind, next.kind, 'kind'],
    [previous.version, next.version, 'version'],
    [previous.coordinationKey, next.coordinationKey, 'coordinationKey'],
    [previous.operationId, next.operationId, 'operationId'],
    [previous.route, next.route, 'route'],
    [
      previous.destinationParentPreexisting,
      next.destinationParentPreexisting,
      'destinationParentPreexisting',
    ],
    [
      previous.destinationRuntimePreexisting,
      next.destinationRuntimePreexisting,
      'destinationRuntimePreexisting',
    ],
    [previous.source, next.source, 'source'],
    [previous.inputs, next.inputs, 'inputs'],
    [previous.plan, next.plan, 'plan'],
    [previous.owned, next.owned, 'owned slots'],
    [previous.timestamps.createdAt, next.timestamps.createdAt, 'createdAt'],
  ];
  for (const [before, after, name] of immutable) {
    if (!sameTransitionValue(before, after)) transitionFailure(`${name} is immutable`);
  }
  if (next.revision !== previous.revision + 1) {
    transitionFailure('revision must increase by exactly one');
  }
  if (next.timestamps.updatedAt < previous.timestamps.updatedAt) {
    transitionFailure('updatedAt cannot move backward');
  }
  if (previous.state === 'closed' && next.state !== 'closed') {
    transitionFailure('closed state is monotonic');
  }
  if (
    previous.timestamps.closedAt !== null &&
    previous.timestamps.closedAt !== next.timestamps.closedAt
  ) {
    transitionFailure('closedAt is immutable after closure');
  }
}

export function assertRecoveryOwner(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
): void {
  const changed = previous.recoveryOwnerToken !== next.recoveryOwnerToken;
  if (
    (changed && next.recoveryAttempt !== previous.recoveryAttempt + 1) ||
    (!changed && next.recoveryAttempt !== previous.recoveryAttempt)
  ) {
    transitionFailure('recovery owner handoff must increment attempt exactly once');
  }
  if (!changed) return;
  const before = {
    state: previous.state,
    manifests: previous.manifests,
    progress: previous.progress,
    terminal: previous.terminal,
    cleanup: previous.cleanup,
    counts: previous.counts,
    reason: previous.reason,
  };
  const after = {
    state: next.state,
    manifests: next.manifests,
    progress: next.progress,
    terminal: next.terminal,
    cleanup: next.cleanup,
    counts: next.counts,
    reason: next.reason,
  };
  if (!sameTransitionValue(before, after)) {
    transitionFailure('owner handoff must be a standalone transition');
  }
}

function assertManifestSlot(
  previous: RuntimeManifestIdentity | null,
  next: RuntimeManifestIdentity | null,
  field: string,
): void {
  if (previous !== null && !sameTransitionValue(previous, next)) {
    transitionFailure(`${field} identity is monotonic`);
  }
}

function isForwardVerificationTransition(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
  previousPhase: RuntimePromotionJournal['progress']['phase'],
  nextPhase: RuntimePromotionJournal['progress']['phase'],
): boolean {
  return (
    previous.state === 'open' &&
    next.state === 'open' &&
    previous.progress.direction === 'forward' &&
    next.progress.direction === 'forward' &&
    previous.progress.phase === previousPhase &&
    next.progress.phase === nextPhase &&
    previous.progress.pendingIntent === null &&
    next.progress.pendingIntent === null
  );
}

function isRuntimeStagePostcondition(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
): boolean {
  const intent = previous.progress.pendingIntent;
  const post = next.progress.lastPostcondition;
  return (
    intent?.kind === 'runtime-stage-create' &&
    next.progress.pendingIntent === null &&
    post?.sequence === intent.sequence &&
    post.kind === intent.kind &&
    post.slot === intent.slot &&
    post.cursor === intent.cursor
  );
}

function assertNewManifestAllowed(
  previous: RuntimeManifestIdentity | null,
  next: RuntimeManifestIdentity | null,
  allowed: boolean,
  field: string,
): void {
  if (previous === null && next !== null && !allowed) {
    transitionFailure(`${field} was published outside its exact verification transition`);
  }
}

export function assertTransitionManifests(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
): void {
  assertManifestSlot(previous.manifests.source, next.manifests.source, 'source manifest');
  assertManifestSlot(
    previous.manifests.destination,
    next.manifests.destination,
    'destination manifest',
  );
  assertManifestSlot(
    previous.manifests.runtimeStage,
    next.manifests.runtimeStage,
    'runtime-stage manifest',
  );
  assertNewManifestAllowed(
    previous.manifests.source,
    next.manifests.source,
    isForwardVerificationTransition(previous, next, 'prepared', 'source-verified'),
    'source manifest',
  );
  const destinationPreviousPhase =
    previous.source.classification === 'none' ? 'prepared' : 'source-verified';
  assertNewManifestAllowed(
    previous.manifests.destination,
    next.manifests.destination,
    isForwardVerificationTransition(
      previous,
      next,
      destinationPreviousPhase,
      'destination-verified',
    ),
    'destination manifest',
  );
  assertNewManifestAllowed(
    previous.manifests.runtimeStage,
    next.manifests.runtimeStage,
    isRuntimeStagePostcondition(previous, next),
    'runtime-stage manifest',
  );
  if (previous.terminal !== null && !sameTransitionValue(previous.manifests, next.manifests)) {
    transitionFailure('terminal authority freezes recorded manifests');
  }
}

function matchingPostcondition(
  intent: RuntimePromotionPendingIntent,
  post: RuntimePromotionPostcondition,
): boolean {
  return (
    intent.sequence === post.sequence &&
    intent.kind === post.kind &&
    intent.slot === post.slot &&
    intent.cursor === post.cursor &&
    post.recordedAt >= intent.recordedAt
  );
}

function assertIntentRecorded(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
  intent: RuntimePromotionPendingIntent,
): void {
  if (
    intent.sequence !== previous.counts.intentCount + 1 ||
    next.counts.intentCount !== previous.counts.intentCount + 1 ||
    next.counts.postconditionCount !== previous.counts.postconditionCount
  ) {
    transitionFailure('intent must advance the exact sequence and intent count');
  }
  if (!runtimePromotionPendingIntentAllowed(previous, intent)) {
    transitionFailure('intent is illegal for this route or phase');
  }
  const before = {
    phase: previous.progress.phase,
    direction: previous.progress.direction,
    runtimeInstallState: previous.progress.runtimeInstallState,
    cursors: [previous.progress.authoredCursor, previous.progress.rollbackCursor],
    last: previous.progress.lastPostcondition,
    manifests: previous.manifests,
    terminal: previous.terminal,
    cleanup: previous.cleanup,
  };
  const after = {
    phase: next.progress.phase,
    direction: next.progress.direction,
    runtimeInstallState: next.progress.runtimeInstallState,
    cursors: [next.progress.authoredCursor, next.progress.rollbackCursor],
    last: next.progress.lastPostcondition,
    manifests: next.manifests,
    terminal: next.terminal,
    cleanup: next.cleanup,
  };
  if (!sameTransitionValue(before, after)) {
    transitionFailure('write-ahead intent must precede every execution result');
  }
}

function assertCursorPostcondition(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
  intent: RuntimePromotionPendingIntent,
): void {
  const authoredDelta = next.progress.authoredCursor - previous.progress.authoredCursor;
  const rollbackDelta = next.progress.rollbackCursor - previous.progress.rollbackCursor;
  if (
    intent.kind === 'authored-target-commit' &&
    (intent.cursor !== previous.progress.authoredCursor ||
      authoredDelta !== 1 ||
      rollbackDelta !== 0)
  ) {
    transitionFailure('authored commit must advance its exact cursor');
  }
  if (
    intent.kind === 'authored-target-rollback' &&
    (intent.cursor !== previous.progress.authoredCursor - previous.progress.rollbackCursor - 1 ||
      authoredDelta !== 0 ||
      rollbackDelta !== 1)
  ) {
    transitionFailure('authored rollback must advance its exact reverse cursor');
  }
  if (
    intent.kind !== 'authored-target-commit' &&
    intent.kind !== 'authored-target-rollback' &&
    (authoredDelta !== 0 || rollbackDelta !== 0)
  ) {
    transitionFailure('non-authored postcondition cannot change authored cursors');
  }
}

function assertCleanupPostcondition(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
  intent: RuntimePromotionPendingIntent,
): void {
  const delta = next.counts.cleanupCompleted - previous.counts.cleanupCompleted;
  if (intent.kind !== 'owned-slot-cleanup') {
    if (delta !== 0) transitionFailure('non-cleanup postcondition changed cleanup count');
    return;
  }
  if (intent.slot === null || next.cleanup[intent.slot] !== 'removed' || delta !== 1) {
    transitionFailure('owned cleanup must remove exactly its recorded slot');
  }
  for (const name of Object.keys(previous.cleanup) as RuntimePromotionOwnedSlotName[]) {
    if (name !== intent.slot && previous.cleanup[name] !== next.cleanup[name]) {
      transitionFailure('owned cleanup changed another slot');
    }
  }
}

function allowedCleanupSlots(
  kind: RuntimePromotionPendingIntent['kind'],
): readonly RuntimePromotionOwnedSlotName[] {
  switch (kind) {
    case 'destination-parent-create': {
      return ['destinationParent'];
    }
    case 'destination-install': {
      return ['destinationParent', 'runtimeStage'];
    }
    case 'runtime-stage-create': {
      return ['runtimeStage'];
    }
    case 'destination-backup-create': {
      return ['destinationBackup'];
    }
    case 'authored-prepare': {
      return ['authoredStage', 'authoredBackup', 'replayManifest'];
    }
    case 'source-retire': {
      return ['sourceTombstone'];
    }
    case 'runtime-rollback': {
      return ['destinationBackup'];
    }
    default: {
      return [];
    }
  }
}

function assertRuntimeInstallStatePostcondition(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
  intent: RuntimePromotionPendingIntent,
): void {
  let expected = previous.progress.runtimeInstallState;
  if (intent.kind === 'destination-install') expected = 'installed';
  if (intent.kind === 'runtime-rollback') {
    expected =
      previous.progress.runtimeInstallState === 'installed' ? 'rolled-back' : 'backup-restored';
  }
  if (next.progress.runtimeInstallState !== expected) {
    transitionFailure('runtime install state changed outside its exact postcondition');
  }
}

function assertDestinationInstallOwnership(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
): void {
  if (previous.cleanup.runtimeStage !== 'pending' || next.cleanup.runtimeStage !== 'removed') {
    transitionFailure('destination install must consume its owned runtime stage');
  }
  const expectedParentBefore = previous.destinationParentPreexisting ? 'unmaterialized' : 'pending';
  const expectedParentAfter = previous.destinationParentPreexisting ? 'unmaterialized' : 'removed';
  if (
    previous.cleanup.destinationParent !== expectedParentBefore ||
    next.cleanup.destinationParent !== expectedParentAfter
  ) {
    transitionFailure('destination install must resolve destination-parent ownership');
  }
}

function assertRuntimeRollbackOwnership(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
): void {
  const destinationExisted = previous.destinationRuntimePreexisting;
  const expectedBackupBefore = destinationExisted ? 'pending' : 'unmaterialized';
  const expectedBackupAfter = destinationExisted ? 'removed' : 'unmaterialized';
  if (
    previous.cleanup.destinationBackup !== expectedBackupBefore ||
    next.cleanup.destinationBackup !== expectedBackupAfter
  ) {
    transitionFailure('runtime rollback must consume its exact destination backup');
  }
}

function assertPostconditionCleanupChanges(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
  intent: RuntimePromotionPendingIntent,
  allowed: ReadonlySet<RuntimePromotionOwnedSlotName>,
): void {
  if (intent.kind !== 'owned-slot-cleanup') {
    for (const name of Object.keys(previous.cleanup) as RuntimePromotionOwnedSlotName[]) {
      if (!allowed.has(name) && previous.cleanup[name] !== next.cleanup[name]) {
        transitionFailure('postcondition changed an unrelated owned slot');
      }
    }
  }
  const materialized =
    [
      'destination-parent-create',
      'runtime-stage-create',
      'destination-backup-create',
      'authored-prepare',
      'source-retire',
    ].includes(intent.kind) && next.progress.lastPostcondition?.outcome !== 'aborted';
  if (materialized && [...allowed].some((slot) => next.cleanup[slot] !== 'pending')) {
    transitionFailure('creation postcondition must publish every owned artifact identity');
  }
}

function assertPostconditionEffects(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
  intent: RuntimePromotionPendingIntent,
): void {
  if (!runtimePromotionPostconditionPhaseAllowed(previous, next, intent)) {
    transitionFailure('postcondition published an illegal result phase');
  }
  const allowed = new Set(allowedCleanupSlots(intent.kind));
  assertPostconditionCleanupChanges(previous, next, intent, allowed);
  if (intent.kind === 'destination-install') {
    assertDestinationInstallOwnership(previous, next);
  }
  if (intent.kind === 'runtime-rollback') {
    assertRuntimeRollbackOwnership(previous, next);
  }
  if (intent.kind === 'runtime-stage-create') {
    if (
      previous.manifests.runtimeStage !== null ||
      next.manifests.runtimeStage === null ||
      !sameTransitionValue(previous.manifests.source, next.manifests.source) ||
      !sameTransitionValue(previous.manifests.destination, next.manifests.destination)
    ) {
      transitionFailure('runtime-stage postcondition must publish only its verified manifest');
    }
  } else if (!sameTransitionValue(previous.manifests, next.manifests)) {
    transitionFailure('only runtime-stage materialization may change a manifest');
  }
}

function assertPostcondition(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
  intent: RuntimePromotionPendingIntent,
): void {
  const post = next.progress.lastPostcondition;
  if (post === null || !matchingPostcondition(intent, post)) {
    transitionFailure('postcondition must exactly match and clear the pending intent');
  }
  if (
    next.counts.intentCount !== previous.counts.intentCount ||
    next.counts.postconditionCount !== previous.counts.postconditionCount + 1
  ) {
    transitionFailure('postcondition must increment only postconditionCount');
  }
  assertCursorPostcondition(previous, next, intent);
  assertRuntimeInstallStatePostcondition(previous, next, intent);
  assertCleanupPostcondition(previous, next, intent);
  assertPostconditionEffects(previous, next, intent);
}

export function assertIntentLifecycle(
  previous: RuntimePromotionJournal,
  next: RuntimePromotionJournal,
): void {
  const before = previous.progress.pendingIntent;
  const after = next.progress.pendingIntent;
  if (before === null && after !== null) return assertIntentRecorded(previous, next, after);
  if (before !== null && after === null) return assertPostcondition(previous, next, before);
  if (
    previous.counts.intentCount !== next.counts.intentCount ||
    previous.counts.postconditionCount !== next.counts.postconditionCount ||
    !sameTransitionValue(previous.progress.lastPostcondition, next.progress.lastPostcondition)
  ) {
    transitionFailure('intent metadata changed without a lifecycle event');
  }
  if (
    before === null &&
    !sameTransitionValue(
      {
        authoredCursor: previous.progress.authoredCursor,
        rollbackCursor: previous.progress.rollbackCursor,
        runtimeInstallState: previous.progress.runtimeInstallState,
        cleanup: previous.cleanup,
        authoredCompleted: previous.counts.authoredCompleted,
        authoredRolledBack: previous.counts.authoredRolledBack,
        cleanupCompleted: previous.counts.cleanupCompleted,
      },
      {
        authoredCursor: next.progress.authoredCursor,
        rollbackCursor: next.progress.rollbackCursor,
        runtimeInstallState: next.progress.runtimeInstallState,
        cleanup: next.cleanup,
        authoredCompleted: next.counts.authoredCompleted,
        authoredRolledBack: next.counts.authoredRolledBack,
        cleanupCompleted: next.counts.cleanupCompleted,
      },
    )
  ) {
    transitionFailure('execution-derived state requires a matching postcondition');
  }
  if (before !== null && !sameTransitionValue(before, after)) {
    transitionFailure('an unresolved intent cannot be replaced');
  }
  if (
    before !== null &&
    !sameTransitionValue(
      {
        manifests: previous.manifests,
        phase: previous.progress.phase,
        runtimeInstallState: previous.progress.runtimeInstallState,
        cursors: [previous.progress.authoredCursor, previous.progress.rollbackCursor],
        terminal: previous.terminal,
        cleanup: previous.cleanup,
        counts: previous.counts,
      },
      {
        manifests: next.manifests,
        phase: next.progress.phase,
        runtimeInstallState: next.progress.runtimeInstallState,
        cursors: [next.progress.authoredCursor, next.progress.rollbackCursor],
        terminal: next.terminal,
        cleanup: next.cleanup,
        counts: next.counts,
      },
    )
  ) {
    transitionFailure('unresolved intent permits only owner handoff');
  }
}

/** Immutable identity and manifest checks for promotion-journal transitions. */

import {
  sameTransitionValue,
  transitionFailure,
} from './runtime-promotion-transition-validation.js';

import type {
  RuntimeManifestIdentity,
  RuntimePromotionJournal,
} from './runtime-promotion-journal-schema.js';

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
    [previous.destinationRootIdentity, next.destinationRootIdentity, 'destinationRootIdentity'],
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

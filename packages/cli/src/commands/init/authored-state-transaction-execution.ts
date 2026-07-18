import { join } from 'node:path';

import {
  authoredTransactionFailure,
  observeAuthoredPath,
  sameAuthoredPathState,
  type StableAuthoredRoot,
} from './authored-state-transaction-fs.js';
import {
  applyAuthoredDirectory,
  applyAuthoredFile,
  removeAuthoredTarget,
} from './authored-state-transaction-target-fs.js';

import type {
  AuthoredArtifactPaths,
  AuthoredBlobAvailability,
  AuthoredStateSummary,
} from './authored-state-transaction-types.js';
import type {
  AuthoredReplayManifest,
  InitAuthoredMutation,
  InitAuthoredPathState,
} from './init-authored-plan.js';
import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';

function pathDepth(path: string): number {
  return path.split('/').length;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function createsDirectory(mutation: InitAuthoredMutation): boolean {
  return mutation.desired.exists && mutation.desired.type === 'directory';
}

function removesDirectory(mutation: InitAuthoredMutation): boolean {
  return (
    mutation.preimage.exists &&
    mutation.preimage.type === 'directory' &&
    (!mutation.desired.exists || mutation.desired.type !== 'directory')
  );
}

function mutationRank(mutation: InitAuthoredMutation): number {
  if (createsDirectory(mutation)) return 0;
  if (removesDirectory(mutation)) return 2;
  return 1;
}

/**
 * The manifest remains in canonical path order. This derived order is also
 * canonical, but adds the filesystem dependencies required for type changes:
 * directory destinations before children and removed directories afterward.
 */
export function authoredExecutionOrder(
  manifest: AuthoredReplayManifest,
): readonly InitAuthoredMutation[] {
  return [...manifest.mutations].sort((left, right) => {
    const leftRank = mutationRank(left);
    const rightRank = mutationRank(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (leftRank === 0) {
      const depth = pathDepth(left.path) - pathDepth(right.path);
      if (depth !== 0) return depth;
    }
    if (leftRank === 2) {
      const depth = pathDepth(right.path) - pathDepth(left.path);
      if (depth !== 0) return depth;
    }
    return compareUtf8(left.path, right.path);
  });
}

export function executionIndex(
  order: readonly InitAuthoredMutation[],
): ReadonlyMap<number, number> {
  return new Map(order.map((mutation, index) => [mutation.sequence, index]));
}

function consumesDesiredBlob(mutation: InitAuthoredMutation): boolean {
  return mutation.desiredBlob !== null && mutation.action !== 'preserve';
}

function consumesPreimageBlob(mutation: InitAuthoredMutation): boolean {
  return mutation.preimageBlob !== null && mutation.action !== 'preserve';
}

function desiredConsumedSequences(
  journal: RuntimePromotionJournal,
  order: readonly InitAuthoredMutation[],
): ReadonlySet<number> {
  const desiredConsumed = new Set<number>();
  for (let index = 0; index < journal.progress.authoredCursor; index += 1) {
    const mutation = order[index];
    if (mutation !== undefined && consumesDesiredBlob(mutation)) {
      desiredConsumed.add(mutation.sequence);
    }
  }
  if (
    journal.progress.pendingIntent?.kind === 'authored-target-commit' &&
    journal.progress.pendingIntent.cursor !== null
  ) {
    const mutation = order[journal.progress.pendingIntent.cursor];
    if (mutation !== undefined && consumesDesiredBlob(mutation)) {
      desiredConsumed.add(mutation.sequence);
    }
  }
  return desiredConsumed;
}

function preimageConsumedSequences(
  journal: RuntimePromotionJournal,
  order: readonly InitAuthoredMutation[],
): ReadonlySet<number> {
  const preimageConsumed = new Set<number>();
  for (let offset = 0; offset < journal.progress.rollbackCursor; offset += 1) {
    const mutation = order[journal.progress.authoredCursor - offset - 1];
    if (mutation !== undefined && consumesPreimageBlob(mutation)) {
      preimageConsumed.add(mutation.sequence);
    }
  }
  if (
    journal.progress.pendingIntent?.kind === 'authored-target-rollback' &&
    journal.progress.pendingIntent.cursor !== null
  ) {
    const mutation = order[journal.progress.pendingIntent.cursor];
    if (mutation !== undefined && consumesPreimageBlob(mutation)) {
      preimageConsumed.add(mutation.sequence);
    }
  }
  return preimageConsumed;
}

export function authoredBlobAvailability(
  journal: RuntimePromotionJournal,
  order: readonly InitAuthoredMutation[],
): AuthoredBlobAvailability {
  const desiredConsumed = desiredConsumedSequences(journal, order);
  const preimageConsumed = preimageConsumedSequences(journal, order);
  return { desiredConsumed, preimageConsumed };
}

export function summarizeAuthoredState(
  manifest: AuthoredReplayManifest,
  journal: RuntimePromotionJournal,
  verified: boolean,
): AuthoredStateSummary {
  let created = 0;
  let replaced = 0;
  let deleted = 0;
  let preserved = 0;
  for (const mutation of manifest.mutations) {
    if (mutation.action === 'create') created += 1;
    else if (mutation.action === 'replace') replaced += 1;
    else if (mutation.action === 'delete') deleted += 1;
    else preserved += 1;
  }
  return {
    total: manifest.mutations.length,
    created,
    replaced,
    deleted,
    preserved,
    completed: journal.progress.authoredCursor,
    rolledBack: journal.progress.rollbackCursor,
    verified,
    actionsKnown: true,
  };
}

function isTypeChangeIntermediate(
  source: InitAuthoredPathState,
  target: InitAuthoredPathState,
  current: InitAuthoredPathState,
): boolean {
  return !current.exists && source.exists && target.exists && source.type !== target.type;
}

function blobPath(
  paths: AuthoredArtifactPaths,
  mutation: InitAuthoredMutation,
  direction: 'commit' | 'rollback',
): string {
  const name = direction === 'commit' ? mutation.desiredBlob : mutation.preimageBlob;
  if (name === null) authoredTransactionFailure('a file target has no durable blob');
  const root = direction === 'commit' ? paths.stageRoot : paths.backupRoot;
  return join(root, ...name.split('/'));
}

function applyTargetState(
  root: StableAuthoredRoot,
  mutation: InitAuthoredMutation,
  current: InitAuthoredPathState,
  target: InitAuthoredPathState,
  paths: AuthoredArtifactPaths,
  direction: 'commit' | 'rollback',
): void {
  if (!target.exists) {
    if (!current.exists || current.type === null) return;
    removeAuthoredTarget(root, mutation.path, current.type);
    return;
  }
  if (target.type === 'file') {
    applyFileTarget(root, mutation, current, target, paths, direction);
    return;
  }
  applyDirectoryTarget(root, mutation, current, target);
}

function applyFileTarget(
  root: StableAuthoredRoot,
  mutation: InitAuthoredMutation,
  current: InitAuthoredPathState,
  target: InitAuthoredPathState,
  paths: AuthoredArtifactPaths,
  direction: 'commit' | 'rollback',
): void {
  if (current.exists && current.type === 'directory') {
    removeAuthoredTarget(root, mutation.path, 'directory');
  }
  if (target.mode === null) {
    authoredTransactionFailure('a file target has no mode');
  }
  applyAuthoredFile(root, mutation.path, blobPath(paths, mutation, direction));
}

function applyDirectoryTarget(
  root: StableAuthoredRoot,
  mutation: InitAuthoredMutation,
  current: InitAuthoredPathState,
  target: InitAuthoredPathState,
): void {
  if (current.exists && current.type === 'file') {
    removeAuthoredTarget(root, mutation.path, 'file');
  }
  if (target.mode === null) {
    authoredTransactionFailure('a directory target has no mode');
  }
  applyAuthoredDirectory(root, mutation.path, target.mode);
}

function assertReconcilableCurrent(
  source: InitAuthoredPathState,
  target: InitAuthoredPathState,
  current: InitAuthoredPathState,
  pending: boolean,
): void {
  if (
    !sameAuthoredPathState(current, source) &&
    !(pending && isTypeChangeIntermediate(source, target, current))
  ) {
    authoredTransactionFailure('a target no longer matches its recorded preimage');
  }
}

export function reconcileAuthoredMutation(
  root: StableAuthoredRoot,
  mutation: InitAuthoredMutation,
  paths: AuthoredArtifactPaths,
  direction: 'commit' | 'rollback',
  pending: boolean,
): 'applied' | 'already-satisfied' {
  const source = direction === 'commit' ? mutation.preimage : mutation.desired;
  const target = direction === 'commit' ? mutation.desired : mutation.preimage;
  const current = observeAuthoredPath(root, mutation.path);
  if (sameAuthoredPathState(current, target)) return 'already-satisfied';
  assertReconcilableCurrent(source, target, current, pending);
  if (mutation.action !== 'preserve') {
    applyTargetState(root, mutation, current, target, paths, direction);
  }
  const verified = observeAuthoredPath(root, mutation.path);
  if (!sameAuthoredPathState(verified, target)) {
    authoredTransactionFailure('an authored target did not reach its exact postcondition');
  }
  return 'applied';
}

export function verifyEveryAuthoredTarget(
  root: StableAuthoredRoot,
  manifest: AuthoredReplayManifest,
  state: 'desired' | 'preimage',
): void {
  for (const mutation of manifest.mutations) {
    const expected = state === 'desired' ? mutation.desired : mutation.preimage;
    if (!sameAuthoredPathState(observeAuthoredPath(root, mutation.path), expected)) {
      authoredTransactionFailure('authored target verification failed');
    }
  }
}

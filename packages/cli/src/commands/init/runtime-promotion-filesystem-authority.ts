import { basename, dirname, join, resolve } from 'node:path';

import {
  projectCoordinationKey,
  resolveUserPaths,
  type RuntimeExclusiveLease,
} from '@opensip-cli/core';

import {
  assertStablePromotionDirectory,
  closeStablePromotionDirectory,
  openStablePromotionDirectory,
  runtimePromotionFilesystemFailure,
  type PromotionEntryIdentity,
  type StablePromotionDirectory,
} from './runtime-promotion-filesystem-io.js';
import { runtimePromotionOwnerMarkerBasename } from './runtime-promotion-filesystem-marker.js';
import { assertRuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';

import type {
  AuthorizeRuntimePromotionFilesystemInput,
  RuntimePromotionFilesystemAction,
  RuntimePromotionFilesystemAuthority,
  RuntimePromotionFilesystemDependencies,
  RuntimePromotionFilesystemPaths,
} from './runtime-promotion-filesystem-types.js';
import type {
  RuntimePromotionJournal,
  RuntimePromotionIntentKind,
} from './runtime-promotion-journal-schema.js';
import type {
  DurablePromotionJournal,
  RuntimePromotionJournalController,
} from './runtime-promotion-journal.js';

export interface RuntimePromotionDirectorySnapshot {
  readonly path: string;
  readonly identity: PromotionEntryIdentity;
}

export interface RuntimePromotionFilesystemCapabilityState {
  readonly action: RuntimePromotionFilesystemAction;
  readonly projectRoot: RuntimePromotionDirectorySnapshot;
  readonly destinationParent?: RuntimePromotionDirectorySnapshot;
  readonly sourceParent?: RuntimePromotionDirectorySnapshot;
  readonly paths: RuntimePromotionFilesystemPaths;
  readonly controller: RuntimePromotionJournalController;
  readonly lease: RuntimeExclusiveLease;
  readonly receipt: DurablePromotionJournal;
  readonly journal: RuntimePromotionJournal;
  readonly cleanupSlot: AuthorizeRuntimePromotionFilesystemInput['cleanupSlot'];
  readonly dependencies: RuntimePromotionFilesystemDependencies;
}

const AUTHORITIES = new WeakMap<object, RuntimePromotionFilesystemCapabilityState>();

function snapshotDirectory(path: string, description: string): RuntimePromotionDirectorySnapshot {
  const opened = openStablePromotionDirectory(path, description);
  try {
    return { path: opened.path, identity: opened.identity };
  } finally {
    closeStablePromotionDirectory(opened);
  }
}

function sameDirectorySnapshot(
  expected: RuntimePromotionDirectorySnapshot,
  observed: StablePromotionDirectory,
): boolean {
  return (
    expected.path === observed.path &&
    expected.identity.dev === observed.identity.dev &&
    expected.identity.ino === observed.identity.ino &&
    expected.identity.uid === observed.identity.uid &&
    expected.identity.mode === observed.identity.mode
  );
}

function sameDirectoryAuthoritySnapshot(
  left: RuntimePromotionDirectorySnapshot,
  right: RuntimePromotionDirectorySnapshot,
): boolean {
  return (
    left.path === right.path &&
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino &&
    left.identity.uid === right.identity.uid &&
    left.identity.mode === right.identity.mode
  );
}

function assertProjectRootAuthoritySnapshot(
  project: RuntimePromotionDirectorySnapshot,
  input: AuthorizeRuntimePromotionFilesystemInput,
): void {
  const expected = input.projectRootAuthority;
  if (
    project.path !== expected.projectRoot ||
    project.identity.dev.toString() !== expected.identity.dev ||
    project.identity.ino.toString() !== expected.identity.ino ||
    project.identity.uid.toString() !== expected.identity.uid ||
    project.identity.mode.toString() !== expected.identity.mode
  ) {
    runtimePromotionFilesystemFailure(
      'the promotion project root does not match the attempt-local root authority',
    );
  }
}

export function openCapabilityDirectory(
  snapshot: RuntimePromotionDirectorySnapshot,
  description: string,
): StablePromotionDirectory {
  const observed = openStablePromotionDirectory(snapshot.path, description);
  try {
    if (!sameDirectorySnapshot(snapshot, observed)) {
      runtimePromotionFilesystemFailure(`${description} was replaced after authorization`);
    }
    assertStablePromotionDirectory(observed, description);
    return observed;
  } catch (error) {
    closeStablePromotionDirectory(observed);
    throw error;
  }
}

function exactPendingIntent(
  journal: RuntimePromotionJournal,
  kind: RuntimePromotionIntentKind,
  slot: string | null,
): boolean {
  const pending = journal.progress.pendingIntent;
  return (
    journal.state === 'open' &&
    pending?.kind === kind &&
    pending.slot === slot &&
    pending.sequence === journal.counts.intentCount
  );
}

function assertActionAuthority(
  action: RuntimePromotionFilesystemAction,
  journal: RuntimePromotionJournal,
  cleanupSlot: AuthorizeRuntimePromotionFilesystemInput['cleanupSlot'],
): void {
  let allowed = false;
  switch (action) {
    case 'destination-parent-create': {
      allowed = exactPendingIntent(journal, 'destination-parent-create', 'destinationParent');
      break;
    }
    case 'runtime-stage-reconcile': {
      allowed = exactPendingIntent(journal, 'runtime-stage-create', 'runtimeStage');
      break;
    }
    case 'destination-backup-create': {
      allowed = exactPendingIntent(journal, 'destination-backup-create', 'destinationBackup');
      break;
    }
    case 'destination-install': {
      allowed = exactPendingIntent(journal, 'destination-install', 'destinationParent');
      break;
    }
    case 'source-retire': {
      allowed = exactPendingIntent(journal, 'source-retire', 'sourceTombstone');
      break;
    }
    case 'runtime-rollback': {
      allowed = exactPendingIntent(journal, 'runtime-rollback', 'destinationBackup');
      break;
    }
    case 'owned-slot-cleanup': {
      const pending = journal.progress.pendingIntent;
      allowed =
        cleanupSlot !== undefined &&
        journal.state === 'closed' &&
        pending?.kind === 'owned-slot-cleanup' &&
        pending.slot === cleanupSlot &&
        pending.sequence === journal.counts.intentCount &&
        journal.cleanup[cleanupSlot] === 'pending';
      break;
    }
  }
  if (!allowed) {
    runtimePromotionFilesystemFailure(
      `filesystem action ${action} lacks its exact durable journal intent`,
    );
  }
}

function derivePaths(
  projectRoot: string,
  sourceRuntime: string | undefined,
  journal: RuntimePromotionJournal,
): {
  readonly paths: RuntimePromotionFilesystemPaths;
  readonly sourceParent?: RuntimePromotionDirectorySnapshot;
} {
  const destinationParent = join(projectRoot, 'opensip-cli');
  const destinationParentStage = join(projectRoot, journal.owned.destinationParent.basename);
  const destinationBackup = join(destinationParent, journal.owned.destinationBackup.basename);
  const paths: RuntimePromotionFilesystemPaths = {
    projectRoot,
    destinationParent,
    destinationParentStage,
    destinationRuntime: join(destinationParent, '.runtime'),
    runtimeStage: join(destinationParent, journal.owned.runtimeStage.basename),
    destinationBackup,
    destinationParentMarker: join(
      projectRoot,
      runtimePromotionOwnerMarkerBasename(journal.owned.destinationParent.basename),
    ),
    destinationBackupMarker: join(
      destinationParent,
      runtimePromotionOwnerMarkerBasename(journal.owned.destinationBackup.basename),
    ),
  };
  if (sourceRuntime === undefined) return { paths };
  const resolvedSource = resolve(sourceRuntime);
  if (journal.source.cacheKey === null || basename(resolvedSource) !== journal.source.cacheKey) {
    runtimePromotionFilesystemFailure('the selected cache path does not match the journal key');
  }
  const selectedSourceParent = snapshotDirectory(
    dirname(resolvedSource),
    'the selected cache parent',
  );
  const sourceParent = snapshotDirectory(
    resolveUserPaths().ephemeralProjectsDir,
    'the ephemeral cache parent',
  );
  if (!sameDirectoryAuthoritySnapshot(selectedSourceParent, sourceParent)) {
    runtimePromotionFilesystemFailure(
      'the selected cache path is not anchored under the ephemeral cache root',
    );
  }
  const canonicalSource = join(sourceParent.path, basename(resolvedSource));
  const sourceTombstone = join(sourceParent.path, journal.owned.sourceTombstone.basename);
  return {
    sourceParent,
    paths: {
      ...paths,
      sourceRuntime: canonicalSource,
      sourceTombstone,
      sourceTombstoneMarker: join(
        sourceParent.path,
        runtimePromotionOwnerMarkerBasename(journal.owned.sourceTombstone.basename),
      ),
    },
  };
}

/** Issue an exact-object authority that can perform one and only one action. */
export async function authorizeRuntimePromotionFilesystem(
  input: AuthorizeRuntimePromotionFilesystemInput,
): Promise<RuntimePromotionFilesystemAuthority> {
  input.controller.assertBoundLease(input.lease);
  assertRuntimePromotionProjectRootAuthority({
    lease: input.lease,
    authority: input.projectRootAuthority,
  });
  const journal = await input.controller.verifyReceipt(input.receipt);
  assertActionAuthority(input.action, journal, input.cleanupSlot);
  const project = snapshotDirectory(input.projectRoot, 'the promotion project root');
  assertProjectRootAuthoritySnapshot(project, input);
  const coordinationKey = projectCoordinationKey(project.path);
  if (
    coordinationKey !== journal.coordinationKey ||
    coordinationKey !== input.lease.coordinationKey ||
    coordinationKey !== input.receipt.coordinationKey
  ) {
    runtimePromotionFilesystemFailure(
      'the promotion project root does not match the journal and lease authority',
    );
  }
  const derived = derivePaths(project.path, input.sourceRuntime, journal);
  let destinationParent: RuntimePromotionDirectorySnapshot | undefined;
  const destinationParentAuthority = input.projectRootAuthority.destinationParent;
  if (journal.destinationParentPreexisting && destinationParentAuthority === null) {
    runtimePromotionFilesystemFailure(
      'a preexisting journal destination parent lacks attempt-local root authority',
    );
  }
  if (journal.destinationParentPreexisting && destinationParentAuthority !== null) {
    if (destinationParentAuthority.path !== derived.paths.destinationParent) {
      runtimePromotionFilesystemFailure(
        'the preexisting project OpenSIP directory is outside the journal-derived destination',
      );
    }
    destinationParent = snapshotDirectory(
      destinationParentAuthority.path,
      'the preexisting project OpenSIP directory',
    );
    if (
      destinationParent.path !== destinationParentAuthority.path ||
      destinationParent.identity.dev.toString() !== destinationParentAuthority.identity.dev ||
      destinationParent.identity.ino.toString() !== destinationParentAuthority.identity.ino ||
      destinationParent.identity.uid.toString() !== destinationParentAuthority.identity.uid ||
      destinationParent.identity.mode.toString() !== destinationParentAuthority.identity.mode
    ) {
      runtimePromotionFilesystemFailure(
        'the preexisting project OpenSIP directory changed after authority capture',
      );
    }
  }
  const authority = Object.freeze({
    operationId: journal.operationId,
    revision: journal.revision,
    action: input.action,
  }) as RuntimePromotionFilesystemAuthority;
  AUTHORITIES.set(authority, {
    action: input.action,
    projectRoot: project,
    ...(destinationParent === undefined ? {} : { destinationParent }),
    ...(derived.sourceParent === undefined ? {} : { sourceParent: derived.sourceParent }),
    paths: derived.paths,
    controller: input.controller,
    lease: input.lease,
    receipt: input.receipt,
    journal,
    cleanupSlot: input.cleanupSlot,
    dependencies: input.dependencies ?? {},
  });
  return authority;
}

/** Consume before filesystem inspection so a failure never leaves reusable authority. */
export async function consumeRuntimePromotionFilesystemAuthority(
  authority: RuntimePromotionFilesystemAuthority,
  expectedAction: RuntimePromotionFilesystemAction,
): Promise<RuntimePromotionFilesystemCapabilityState> {
  const state = AUTHORITIES.get(authority);
  AUTHORITIES.delete(authority);
  if (state?.action !== expectedAction) {
    runtimePromotionFilesystemFailure('runtime promotion filesystem authority is stale or foreign');
  }
  if (
    authority.action !== expectedAction ||
    authority.operationId !== state.journal.operationId ||
    authority.revision !== state.journal.revision
  ) {
    runtimePromotionFilesystemFailure('runtime promotion filesystem authority is stale or foreign');
  }
  state.controller.assertBoundLease(state.lease);
  const journal = await state.controller.verifyReceipt(state.receipt);
  if (
    journal.operationId !== state.journal.operationId ||
    journal.revision !== state.journal.revision
  ) {
    runtimePromotionFilesystemFailure('runtime promotion receipt changed after authorization');
  }
  assertActionAuthority(state.action, journal, state.cleanupSlot);
  const project = openCapabilityDirectory(state.projectRoot, 'the promotion project root');
  closeStablePromotionDirectory(project);
  if (state.destinationParent !== undefined) {
    const destinationParent = openCapabilityDirectory(
      state.destinationParent,
      'the preexisting project OpenSIP directory',
    );
    closeStablePromotionDirectory(destinationParent);
  }
  if (state.sourceParent !== undefined) {
    const sourceParent = openCapabilityDirectory(state.sourceParent, 'the selected cache parent');
    closeStablePromotionDirectory(sourceParent);
  }
  return state;
}

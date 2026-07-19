import { join } from 'node:path';

import {
  consumeRuntimePromotionFilesystemAuthority,
  openCapabilityDirectory,
} from './runtime-promotion-filesystem-authority.js';
import {
  assertExpectedIdentity,
  stageOwnership,
} from './runtime-promotion-filesystem-forward-verification.js';
import {
  assertStablePromotionDirectory,
  classifyRuntimePromotionPath,
  closeStablePromotionDirectory,
  createStableExactPromotionDirectory,
  finalizeStablePromotionDirectoryMode,
  fsyncPromotionDirectory,
  openStablePromotionDirectory,
  renamePromotionEntry,
  runtimePromotionFilesystemFailure,
} from './runtime-promotion-filesystem-io.js';
import { ensureDurableExactPromotionMarker } from './runtime-promotion-filesystem-marker-io.js';
import { runtimePromotionCleanupMarkerBasename } from './runtime-promotion-filesystem-marker.js';
import {
  assertEmptyPromotionDirectory,
  cleanupOwnedRuntimeTree,
  encodedOwnedMarker,
  ensurePromotionMarker,
  inspectBoundOwnedMarker,
  openExactDestinationParent,
} from './runtime-promotion-filesystem-operation-helpers.js';
import { inspectRuntimeStageFilesystemState } from './runtime-promotion-filesystem-stage.js';

import type { RuntimePromotionFilesystemCapabilityState } from './runtime-promotion-filesystem-authority.js';
import type { StablePromotionDirectory } from './runtime-promotion-filesystem-io.js';
import type {
  RuntimePromotionDestinationParentResult,
  RuntimePromotionFilesystemAuthority,
  RuntimePromotionStageReconcileInput,
  RuntimePromotionStageReconcileResult,
} from './runtime-promotion-filesystem-types.js';

function destinationParentRootIdentity(directory: StablePromotionDirectory): {
  readonly device: string;
  readonly inode: string;
} {
  return {
    device: directory.identity.dev.toString(),
    inode: directory.identity.ino.toString(),
  };
}

function publishDestinationParentOwner(
  state: RuntimePromotionFilesystemCapabilityState,
  project: StablePromotionDirectory,
  stage: StablePromotionDirectory,
): void {
  ensurePromotionMarker(
    project,
    state.paths.destinationParentMarker,
    encodedOwnedMarker(
      state.journal,
      'destinationParent',
      'owner',
      null,
      destinationParentRootIdentity(stage),
    ),
    state,
    'destination-parent-marker-create',
    false,
  );
}

function replayInstalledDestinationParent(
  state: RuntimePromotionFilesystemCapabilityState,
  project: StablePromotionDirectory,
): RuntimePromotionDestinationParentResult {
  if (classifyRuntimePromotionPath(state.paths.destinationParentStage).status !== 'absent') {
    runtimePromotionFilesystemFailure(
      'both the destination parent and its operation stage are present',
    );
  }
  const marker = inspectBoundOwnedMarker(
    state.paths.destinationParentMarker,
    state.paths.destinationParent,
    state.journal,
    'destinationParent',
    'owner',
    null,
  );
  if (marker.status !== 'exact') {
    runtimePromotionFilesystemFailure(
      'an existing destination parent lacks exact operation ownership',
    );
  }
  ensureDurableExactPromotionMarker(
    project,
    state.paths.destinationParentMarker,
    marker.content,
    state.dependencies,
  );
  const destination = openExactDestinationParent(state);
  try {
    assertStablePromotionDirectory(destination, 'the operation-created destination parent');
    assertEmptyPromotionDirectory(destination.path);
    fsyncPromotionDirectory(destination, state.dependencies);
  } finally {
    closeStablePromotionDirectory(destination);
  }
  fsyncPromotionDirectory(project, state.dependencies);
  return { status: 'already-created' };
}

function openExistingDestinationParentStage(
  state: RuntimePromotionFilesystemCapabilityState,
  project: StablePromotionDirectory,
): StablePromotionDirectory {
  const stage = openStablePromotionDirectory(
    state.paths.destinationParentStage,
    'the destination-parent operation stage',
  );
  try {
    const marker = inspectBoundOwnedMarker(
      state.paths.destinationParentMarker,
      stage.path,
      state.journal,
      'destinationParent',
      'owner',
      null,
    );
    if (marker.status === 'mismatch') {
      runtimePromotionFilesystemFailure('the destination-parent stage has foreign ownership');
    }
    if (marker.status === 'absent') {
      if (Number(stage.identity.mode & 0o777n) !== 0o700) {
        runtimePromotionFilesystemFailure('an unmarked destination-parent stage is not private');
      }
      assertEmptyPromotionDirectory(stage.path);
      publishDestinationParentOwner(state, project, stage);
    } else {
      ensurePromotionMarker(
        project,
        state.paths.destinationParentMarker,
        marker.content,
        state,
        'destination-parent-marker-create',
        false,
      );
    }
    return stage;
  } catch (error) {
    closeStablePromotionDirectory(stage);
    throw error;
  }
}

function prepareDestinationParentStage(
  state: RuntimePromotionFilesystemCapabilityState,
  project: StablePromotionDirectory,
): StablePromotionDirectory {
  const staged = classifyRuntimePromotionPath(state.paths.destinationParentStage);
  if (staged.status === 'directory') {
    return openExistingDestinationParentStage(state, project);
  }
  if (staged.status !== 'absent') {
    runtimePromotionFilesystemFailure('the destination-parent stage has an unsafe root type');
  }
  if (classifyRuntimePromotionPath(state.paths.destinationParentMarker).status !== 'absent') {
    runtimePromotionFilesystemFailure(
      'a destination-parent owner marker exists without its bound root',
    );
  }
  return createStableExactPromotionDirectory(
    project,
    state.paths.destinationParentStage,
    state.dependencies,
    (created) => publishDestinationParentOwner(state, project, created),
  );
}

function installDestinationParentStage(
  state: RuntimePromotionFilesystemCapabilityState,
  project: StablePromotionDirectory,
  initialStage: StablePromotionDirectory,
): void {
  let stage = initialStage;
  try {
    assertStablePromotionDirectory(stage, 'the destination-parent operation stage');
    assertEmptyPromotionDirectory(stage.path);
    stage = finalizeStablePromotionDirectoryMode(project, stage, 0o755, state.dependencies);
    renamePromotionEntry(
      project,
      stage.path,
      state.paths.destinationParent,
      state.dependencies,
      'destination-parent-install-rename',
      () => {
        assertStablePromotionDirectory(stage, 'the destination-parent operation stage');
        const marker = inspectBoundOwnedMarker(
          state.paths.destinationParentMarker,
          stage.path,
          state.journal,
          'destinationParent',
          'owner',
          null,
        );
        if (marker.status !== 'exact') {
          runtimePromotionFilesystemFailure(
            'the destination-parent stage ownership changed before install',
          );
        }
        assertEmptyPromotionDirectory(stage.path);
      },
    );
  } finally {
    closeStablePromotionDirectory(stage);
  }
}

function verifyInstalledDestinationParent(
  state: RuntimePromotionFilesystemCapabilityState,
  project: StablePromotionDirectory,
): void {
  const installedMarker = inspectBoundOwnedMarker(
    state.paths.destinationParentMarker,
    state.paths.destinationParent,
    state.journal,
    'destinationParent',
    'owner',
    null,
  );
  if (installedMarker.status !== 'exact') {
    runtimePromotionFilesystemFailure(
      'the installed destination parent lost its ownership binding',
    );
  }
  const destination = openExactDestinationParent(state);
  try {
    assertEmptyPromotionDirectory(destination.path);
    fsyncPromotionDirectory(destination, state.dependencies);
  } finally {
    closeStablePromotionDirectory(destination);
  }
  fsyncPromotionDirectory(project, state.dependencies);
}

/**
 * Materialize the authored-plan `opensip-cli` directory without adding a child marker.
 *
 * @throws When filesystem authority, ownership, or durability verification fails.
 */
export async function createRuntimePromotionDestinationParent(
  authority: RuntimePromotionFilesystemAuthority,
): Promise<RuntimePromotionDestinationParentResult> {
  const state = await consumeRuntimePromotionFilesystemAuthority(
    authority,
    'destination-parent-create',
  );
  if (state.journal.destinationParentPreexisting) {
    runtimePromotionFilesystemFailure('a preexisting destination parent cannot be created');
  }
  const project = openCapabilityDirectory(state.projectRoot, 'the promotion project root');
  try {
    const target = classifyRuntimePromotionPath(state.paths.destinationParent);
    if (target.status === 'directory') {
      return replayInstalledDestinationParent(state, project);
    }
    if (target.status !== 'absent') {
      runtimePromotionFilesystemFailure('the destination parent has an unsafe root type');
    }
    installDestinationParentStage(state, project, prepareDestinationParentStage(state, project));
    verifyInstalledDestinationParent(state, project);
    return { status: 'created' };
  } finally {
    closeStablePromotionDirectory(project);
  }
}

/**
 * Settle, verify, or conservatively discard an incomplete owned stage.
 *
 * @throws When filesystem authority, stage ownership, or cleanup verification fails.
 */
export async function reconcileRuntimePromotionStage(
  authority: RuntimePromotionFilesystemAuthority,
  input: RuntimePromotionStageReconcileInput,
): Promise<RuntimePromotionStageReconcileResult> {
  const state = await consumeRuntimePromotionFilesystemAuthority(
    authority,
    'runtime-stage-reconcile',
  );
  assertExpectedIdentity(
    state.journal.manifests.source,
    input.expected.identity,
    'the stage source manifest',
  );
  const parent = openExactDestinationParent(state);
  try {
    const ownership = stageOwnership(
      state.journal.operationId,
      state.journal.owned.runtimeStage.basename,
      state.journal.owned.runtimeStage.ownershipId,
    );
    const cleanupPath = join(
      parent.path,
      runtimePromotionCleanupMarkerBasename(state.journal.owned.runtimeStage.basename),
    );
    const cleanupState = inspectBoundOwnedMarker(
      cleanupPath,
      state.paths.runtimeStage,
      state.journal,
      'runtimeStage',
      'cleanup',
      input.expected.identity,
    );
    const observed = inspectRuntimeStageFilesystemState(
      state.paths.runtimeStage,
      ownership,
      input.expected,
      false,
    );
    if (observed.status === 'verified') {
      if (cleanupState.status !== 'absent') {
        runtimePromotionFilesystemFailure(
          'a verified stage unexpectedly has a cleanup-start marker',
        );
      }
      return { status: 'verified', manifest: observed.manifest };
    }
    if (observed.status === 'absent' && cleanupState.status === 'absent') {
      return { status: 'absent' };
    }
    cleanupOwnedRuntimeTree({
      state,
      parent,
      root: state.paths.runtimeStage,
      slot: 'runtimeStage',
      expected: input.expected.identity,
      verifyBefore: () => {
        const current = inspectRuntimeStageFilesystemState(
          state.paths.runtimeStage,
          ownership,
          input.expected,
          false,
        );
        if (current.status !== 'incomplete-owned') {
          runtimePromotionFilesystemFailure('the incomplete stage changed before cleanup');
        }
      },
      revalidateBeforeMutation: () =>
        assertStablePromotionDirectory(parent, 'the runtime-stage cleanup parent'),
    });
    return { status: 'discarded-incomplete' };
  } finally {
    closeStablePromotionDirectory(parent);
  }
}

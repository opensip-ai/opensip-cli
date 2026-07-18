import { join } from 'node:path';

import {
  encodeRuntimeStageOwnershipMarker,
  inspectVerifiedRuntimeManifest,
  runtimeManifestIdentityEqual,
  RUNTIME_STAGE_OWNERSHIP_FILE,
} from './runtime-manifest.js';
import {
  assertRuntimePromotionDestinationRootAuthority,
  withRuntimePromotionDestinationRootAuthority,
} from './runtime-promotion-destination-authority.js';
import {
  consumeRuntimePromotionFilesystemAuthority,
  openCapabilityDirectory,
} from './runtime-promotion-filesystem-authority.js';
import {
  assertPromotionRootIdentity,
  assertStablePromotionDirectory,
  classifyRuntimePromotionPath,
  closeStablePromotionDirectory,
  createStableExactPromotionDirectory,
  finalizeStablePromotionDirectoryMode,
  fsyncPromotionDirectory,
  openStablePromotionDirectory,
  renamePromotionEntry,
  runtimePromotionFilesystemFailure,
  withOpenedStablePromotionDirectory,
} from './runtime-promotion-filesystem-io.js';
import {
  ensureDurableExactPromotionMarker,
  inspectExactPromotionMarker,
  removeExactPromotionMarker,
} from './runtime-promotion-filesystem-marker-io.js';
import { runtimePromotionCleanupMarkerBasename } from './runtime-promotion-filesystem-marker.js';
import {
  cleanupOwnedRuntimeTree,
  artifactPresence,
  assertEmptyPromotionDirectory,
  encodedOwnedMarker,
  ensureBoundOwnerMarker,
  ensurePromotionMarker,
  inspectExactRuntimeManifest,
  inspectBoundOwnedMarker,
  openExactDestinationParent,
} from './runtime-promotion-filesystem-operation-helpers.js';
import {
  inspectRuntimeStageFilesystemState,
  stageMarkerPath,
} from './runtime-promotion-filesystem-stage.js';

import type {
  RuntimeManifestIdentity,
  RuntimeStageOwnershipIdentity,
  VerifiedRuntimeManifest,
} from './runtime-manifest.js';
import type { RuntimePromotionFilesystemCapabilityState } from './runtime-promotion-filesystem-authority.js';
import type { StablePromotionDirectory } from './runtime-promotion-filesystem-io.js';
import type {
  RuntimePromotionBackupResult,
  RuntimePromotionDestinationParentResult,
  RuntimePromotionFilesystemAuthority,
  RuntimePromotionInstallResult,
  RuntimePromotionStageReconcileInput,
  RuntimePromotionStageReconcileResult,
} from './runtime-promotion-filesystem-types.js';

const PROJECT_RUNTIME_POSTURE = 'project-runtime';

function stageOwnership(
  operationId: string,
  stageBasename: string,
  ownershipId: string,
): RuntimeStageOwnershipIdentity {
  return { operationId, stageBasename, ownershipId };
}

function assertExpectedIdentity(
  actual: RuntimeManifestIdentity | null,
  expected: RuntimeManifestIdentity,
  description: string,
): void {
  if (actual === null || !runtimeManifestIdentityEqual(actual, expected)) {
    runtimePromotionFilesystemFailure(`${description} does not match the journal`);
  }
}

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

/** Materialize the authored-plan `opensip-cli` directory without adding a child marker. */
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

/** Settle, verify, or conservatively discard an incomplete owned stage. */
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

export async function backupRuntimePromotionDestination(
  authority: RuntimePromotionFilesystemAuthority,
  expected: RuntimeManifestIdentity,
): Promise<RuntimePromotionBackupResult> {
  const state = await consumeRuntimePromotionFilesystemAuthority(
    authority,
    'destination-backup-create',
  );
  assertExpectedIdentity(
    state.journal.manifests.destination,
    expected,
    'the destination backup manifest',
  );
  const parent = openExactDestinationParent(state);
  try {
    const destination = artifactPresence(state.paths.destinationRuntime);
    const backup = artifactPresence(state.paths.destinationBackup);
    if (destination === 'directory' && backup === 'directory') {
      runtimePromotionFilesystemFailure('both destination and backup are present');
    }
    if (destination === 'directory') {
      const verified = withRuntimePromotionDestinationRootAuthority(
        state.paths.destinationRuntime,
        state.journal,
        () =>
          inspectExactRuntimeManifest(
            state.paths.destinationRuntime,
            PROJECT_RUNTIME_POSTURE,
            expected,
          ),
      );
      const owner = ensureBoundOwnerMarker({
        state,
        parent,
        root: state.paths.destinationRuntime,
        markerPath: state.paths.destinationBackupMarker,
        slot: 'destinationBackup',
        expected,
        operation: 'destination-backup-marker-create',
      });
      renamePromotionEntry(
        parent,
        state.paths.destinationRuntime,
        state.paths.destinationBackup,
        state.dependencies,
        'destination-backup-rename',
        () => {
          assertRuntimePromotionDestinationRootAuthority(
            state.paths.destinationRuntime,
            state.journal,
          );
          assertPromotionRootIdentity(state.paths.destinationRuntime, owner.rootIdentity);
          inspectExactRuntimeManifest(
            state.paths.destinationRuntime,
            PROJECT_RUNTIME_POSTURE,
            expected,
          );
        },
      );
      assertRuntimePromotionDestinationRootAuthority(state.paths.destinationBackup, state.journal);
      inspectExactRuntimeManifest(state.paths.destinationBackup, PROJECT_RUNTIME_POSTURE, expected);
      if (
        inspectBoundOwnedMarker(
          state.paths.destinationBackupMarker,
          state.paths.destinationBackup,
          state.journal,
          'destinationBackup',
          'owner',
          expected,
        ).status !== 'exact'
      ) {
        runtimePromotionFilesystemFailure('the destination backup owner lost its inode binding');
      }
      return { status: 'applied', manifest: verified };
    }
    if (backup === 'directory') {
      assertRuntimePromotionDestinationRootAuthority(state.paths.destinationBackup, state.journal);
      const owner = inspectBoundOwnedMarker(
        state.paths.destinationBackupMarker,
        state.paths.destinationBackup,
        state.journal,
        'destinationBackup',
        'owner',
        expected,
      );
      if (owner.status !== 'exact') {
        runtimePromotionFilesystemFailure('the destination backup owner is absent or foreign');
      }
      ensureDurableExactPromotionMarker(
        parent,
        state.paths.destinationBackupMarker,
        owner.content,
        state.dependencies,
      );
      const manifest = inspectExactRuntimeManifest(
        state.paths.destinationBackup,
        PROJECT_RUNTIME_POSTURE,
        expected,
      );
      if (
        inspectBoundOwnedMarker(
          state.paths.destinationBackupMarker,
          state.paths.destinationBackup,
          state.journal,
          'destinationBackup',
          'owner',
          expected,
        ).status !== 'exact'
      ) {
        runtimePromotionFilesystemFailure(
          'the replayed destination backup owner lost its inode binding',
        );
      }
      return {
        status: 'already-applied',
        manifest,
      };
    }
    runtimePromotionFilesystemFailure('neither destination nor its backup is present');
  } finally {
    closeStablePromotionDirectory(parent);
  }
}

function inspectInstallStage(
  state: Awaited<ReturnType<typeof consumeRuntimePromotionFilesystemAuthority>>,
  expected: RuntimeManifestIdentity,
  ownership: RuntimeStageOwnershipIdentity,
): { readonly manifest: VerifiedRuntimeManifest; readonly marked: boolean } {
  const marker = inspectExactPromotionMarker(
    stageMarkerPath(state.paths.runtimeStage),
    encodeRuntimeStageOwnershipMarker(ownership),
  );
  if (marker.status === 'partial-prefix' || marker.status === 'mismatch') {
    runtimePromotionFilesystemFailure('the install stage has an ambiguous ownership marker');
  }
  const manifest =
    marker.status === 'exact'
      ? inspectVerifiedRuntimeManifest(state.paths.runtimeStage, 'promotion-stage', {}, ownership)
      : inspectVerifiedRuntimeManifest(state.paths.runtimeStage, PROJECT_RUNTIME_POSTURE);
  if (!runtimeManifestIdentityEqual(manifest.identity, expected)) {
    runtimePromotionFilesystemFailure('the install stage does not match its journal manifest');
  }
  return { manifest, marked: marker.status === 'exact' };
}

type PromotionArtifactPresence = ReturnType<typeof artifactPresence>;

function assertInstallBackupReady(
  state: RuntimePromotionFilesystemCapabilityState,
  parent: ReturnType<typeof openExactDestinationParent>,
  backup: PromotionArtifactPresence,
): void {
  if (!state.journal.destinationRuntimePreexisting) {
    if (backup !== 'absent') {
      runtimePromotionFilesystemFailure('an unplanned destination backup is present');
    }
    return;
  }
  const backupIdentity = state.journal.manifests.destination;
  if (backupIdentity === null || backup !== 'directory') {
    runtimePromotionFilesystemFailure('the required rollback backup is absent');
  }
  const backupOwner = inspectBoundOwnedMarker(
    state.paths.destinationBackupMarker,
    state.paths.destinationBackup,
    state.journal,
    'destinationBackup',
    'owner',
    backupIdentity,
  );
  if (backupOwner.status !== 'exact') {
    runtimePromotionFilesystemFailure('the required rollback backup owner is invalid');
  }
  ensureDurableExactPromotionMarker(
    parent,
    state.paths.destinationBackupMarker,
    backupOwner.content,
    state.dependencies,
  );
  inspectExactRuntimeManifest(
    state.paths.destinationBackup,
    PROJECT_RUNTIME_POSTURE,
    backupIdentity,
  );
  if (
    inspectBoundOwnedMarker(
      state.paths.destinationBackupMarker,
      state.paths.destinationBackup,
      state.journal,
      'destinationBackup',
      'owner',
      backupIdentity,
    ).status !== 'exact'
  ) {
    runtimePromotionFilesystemFailure(
      'the required rollback backup owner changed during verification',
    );
  }
}

function assertInstallParentOwnership(
  state: RuntimePromotionFilesystemCapabilityState,
  project: ReturnType<typeof openCapabilityDirectory>,
): void {
  if (state.journal.destinationParentPreexisting) return;
  const marker = inspectBoundOwnedMarker(
    state.paths.destinationParentMarker,
    state.paths.destinationParent,
    state.journal,
    'destinationParent',
    'owner',
    null,
  );
  if (marker.status !== 'exact') {
    runtimePromotionFilesystemFailure('destination-parent ownership is ambiguous at install');
  }
  ensureDurableExactPromotionMarker(
    project,
    state.paths.destinationParentMarker,
    marker.content,
    state.dependencies,
  );
}

function installStageOrVerifyDestination(
  state: RuntimePromotionFilesystemCapabilityState,
  parent: ReturnType<typeof openExactDestinationParent>,
  stage: PromotionArtifactPresence,
  destination: PromotionArtifactPresence,
  expected: RuntimeManifestIdentity,
): RuntimePromotionInstallResult['status'] {
  if (stage !== 'directory') {
    if (destination !== 'directory') {
      runtimePromotionFilesystemFailure('neither runtime stage nor destination is present');
    }
    fsyncPromotionDirectory(parent, state.dependencies);
    return 'already-applied';
  }
  const ownership = stageOwnership(
    state.journal.operationId,
    state.journal.owned.runtimeStage.basename,
    state.journal.owned.runtimeStage.ownershipId,
  );
  const inspected = inspectInstallStage(state, expected, ownership);
  if (inspected.marked) {
    const stageDirectory = openStablePromotionDirectory(
      state.paths.runtimeStage,
      'the runtime install stage',
    );
    try {
      removeExactPromotionMarker(
        stageDirectory,
        join(stageDirectory.path, RUNTIME_STAGE_OWNERSHIP_FILE),
        encodeRuntimeStageOwnershipMarker(ownership),
        state.dependencies,
        'runtime-stage-marker-unlink',
      );
    } finally {
      closeStablePromotionDirectory(stageDirectory);
    }
  }
  renamePromotionEntry(
    parent,
    state.paths.runtimeStage,
    state.paths.destinationRuntime,
    state.dependencies,
    'destination-install-rename',
    () => {
      inspectExactRuntimeManifest(state.paths.runtimeStage, PROJECT_RUNTIME_POSTURE, expected);
    },
  );
  return 'applied';
}

export async function installRuntimePromotionStage(
  authority: RuntimePromotionFilesystemAuthority,
  expected: RuntimeManifestIdentity,
): Promise<RuntimePromotionInstallResult> {
  const state = await consumeRuntimePromotionFilesystemAuthority(authority, 'destination-install');
  assertExpectedIdentity(
    state.journal.manifests.runtimeStage,
    expected,
    'the installed runtime manifest',
  );
  const parent = openExactDestinationParent(state);
  return withOpenedStablePromotionDirectory(parent, (parent) => {
    const project = openCapabilityDirectory(state.projectRoot, 'the promotion project root');
    return withOpenedStablePromotionDirectory(project, (project) => {
      const stage = artifactPresence(state.paths.runtimeStage);
      const destination = artifactPresence(state.paths.destinationRuntime);
      const backup = artifactPresence(state.paths.destinationBackup);
      if (stage === 'directory' && destination === 'directory') {
        runtimePromotionFilesystemFailure('both runtime stage and destination are present');
      }
      assertInstallBackupReady(state, parent, backup);
      assertInstallParentOwnership(state, project);
      const status = installStageOrVerifyDestination(state, parent, stage, destination, expected);
      const installed = inspectExactRuntimeManifest(
        state.paths.destinationRuntime,
        PROJECT_RUNTIME_POSTURE,
        expected,
      );
      return { status, manifest: installed };
    });
  });
}

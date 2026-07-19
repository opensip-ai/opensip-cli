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
  assertExpectedIdentity,
  PROJECT_RUNTIME_POSTURE,
  stageOwnership,
} from './runtime-promotion-filesystem-forward-verification.js';
import {
  assertPromotionRootIdentity,
  closeStablePromotionDirectory,
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
import {
  artifactPresence,
  ensureBoundOwnerMarker,
  inspectBoundOwnedMarker,
  inspectExactRuntimeManifest,
  openExactDestinationParent,
} from './runtime-promotion-filesystem-operation-helpers.js';
import { stageMarkerPath } from './runtime-promotion-filesystem-stage.js';

import type {
  RuntimeManifestIdentity,
  RuntimeStageOwnershipIdentity,
  VerifiedRuntimeManifest,
} from './runtime-manifest.js';
import type { RuntimePromotionFilesystemCapabilityState } from './runtime-promotion-filesystem-authority.js';
import type {
  RuntimePromotionBackupResult,
  RuntimePromotionFilesystemAuthority,
  RuntimePromotionInstallResult,
} from './runtime-promotion-filesystem-types.js';

/**
 * Move an exact destination runtime aside as the operation's rollback backup.
 *
 * @throws When filesystem authority, manifest, ownership, or durability verification fails.
 */
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

/**
 * Install the verified runtime stage into the destination runtime path.
 *
 * @throws When filesystem authority, manifest, ownership, or durability verification fails.
 */
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

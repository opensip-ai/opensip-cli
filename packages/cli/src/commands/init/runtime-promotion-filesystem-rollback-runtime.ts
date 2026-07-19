import { join } from 'node:path';

import {
  encodeRuntimeStageOwnershipMarker,
  inspectVerifiedRuntimeManifest,
  isRuntimeManifestReleaseUnsafe,
  runtimeManifestIdentityEqual,
} from './runtime-manifest.js';
import {
  assertRuntimePromotionDestinationRootAuthority,
  withRuntimePromotionDestinationRootAuthority,
} from './runtime-promotion-destination-authority.js';
import { removeBoundedOwnedTree } from './runtime-promotion-filesystem-cleanup-io.js';
import {
  assertPromotionRootIdentity,
  assertStablePromotionDirectory,
  capturePromotionRootIdentity,
  fsyncPromotionDirectory,
  renamePromotionEntry,
  runtimePromotionFilesystemFailure,
} from './runtime-promotion-filesystem-io.js';
import {
  ensureDurableExactPromotionMarker,
  inspectExactPromotionMarker,
  removeExactPromotionMarker,
} from './runtime-promotion-filesystem-marker-io.js';
import { runtimePromotionRollbackMarkerBasename } from './runtime-promotion-filesystem-marker.js';
import {
  artifactPresence,
  cleanupOwnedRuntimeTree,
  encodedOwnedMarker,
  ensurePromotionMarker,
  inspectBoundOwnedMarker,
  inspectExactRuntimeManifest,
} from './runtime-promotion-filesystem-operation-helpers.js';
import { stageMarkerPath } from './runtime-promotion-filesystem-stage.js';

import type {
  RuntimeManifestIdentity,
  RuntimeStageOwnershipIdentity,
  VerifiedRuntimeManifest,
} from './runtime-manifest.js';
import type { RuntimePromotionFilesystemCapabilityState } from './runtime-promotion-filesystem-authority.js';
import type { StablePromotionDirectory } from './runtime-promotion-filesystem-io.js';
import type { RuntimePromotionArtifactMarker } from './runtime-promotion-filesystem-types.js';

const PROJECT_RUNTIME_POSTURE = 'project-runtime';

/** Validate one optional manifest identity against its journal projection. */
export function assertRollbackIdentity(
  recorded: RuntimeManifestIdentity | null,
  expected: RuntimeManifestIdentity | null,
  description: string,
): void {
  if (
    (recorded === null) !== (expected === null) ||
    (recorded !== null && expected !== null && !runtimeManifestIdentityEqual(recorded, expected))
  ) {
    runtimePromotionFilesystemFailure(`${description} does not match the journal`);
  }
}

function stageOwnership(
  state: RuntimePromotionFilesystemCapabilityState,
): RuntimeStageOwnershipIdentity {
  return {
    operationId: state.journal.operationId,
    stageBasename: state.journal.owned.runtimeStage.basename,
    ownershipId: state.journal.owned.runtimeStage.ownershipId,
  };
}

function verifyCompleteStage(
  state: RuntimePromotionFilesystemCapabilityState,
  expected: RuntimeManifestIdentity,
): void {
  const ownership = stageOwnership(state);
  if (
    inspectExactPromotionMarker(
      stageMarkerPath(state.paths.runtimeStage),
      encodeRuntimeStageOwnershipMarker(ownership),
    ).status !== 'exact'
  ) {
    runtimePromotionFilesystemFailure('the rollback stage owner is missing or foreign');
  }
  const manifest = inspectVerifiedRuntimeManifest(
    state.paths.runtimeStage,
    'promotion-stage',
    {},
    ownership,
  );
  if (!runtimeManifestIdentityEqual(manifest.identity, expected)) {
    runtimePromotionFilesystemFailure('the rollback stage does not match its journal manifest');
  }
}

/** Remove an operation-created runtime stage after proving its exact ownership. */
export function removeCreatedParentStage(
  state: RuntimePromotionFilesystemCapabilityState,
  parent: StablePromotionDirectory,
  expected: RuntimeManifestIdentity | null,
): boolean {
  const stage = artifactPresence(state.paths.runtimeStage);
  if (stage === 'absent') return false;
  if (expected === null) {
    runtimePromotionFilesystemFailure('an unrecorded runtime stage is present during rollback');
  }
  return cleanupOwnedRuntimeTree({
    state,
    parent,
    root: state.paths.runtimeStage,
    slot: 'runtimeStage',
    expected,
    verifyBefore: () => verifyCompleteStage(state, expected),
    revalidateBeforeMutation: () =>
      assertStablePromotionDirectory(parent, 'the rollback stage cleanup parent'),
  });
}

function ensureRollbackStarted(
  state: RuntimePromotionFilesystemCapabilityState,
  parent: StablePromotionDirectory,
  expected: RuntimeManifestIdentity,
): {
  readonly path: string;
  readonly content: string;
  readonly rootIdentity: NonNullable<RuntimePromotionArtifactMarker['rootIdentity']>;
} {
  const path = join(
    parent.path,
    runtimePromotionRollbackMarkerBasename(state.journal.owned.runtimeStage.basename),
  );
  const marker = inspectBoundOwnedMarker(
    path,
    state.paths.destinationRuntime,
    state.journal,
    'runtimeStage',
    'rollback',
    expected,
  );
  if (marker.status === 'exact') {
    fsyncPromotionDirectory(parent, state.dependencies);
    return { path, content: marker.content, rootIdentity: marker.rootIdentity };
  }
  if (marker.status === 'mismatch') {
    runtimePromotionFilesystemFailure('the rollback marker lacks an exact inode binding');
  }
  inspectExactRuntimeManifest(state.paths.destinationRuntime, PROJECT_RUNTIME_POSTURE, expected);
  const rootIdentity = capturePromotionRootIdentity(state.paths.destinationRuntime);
  const content = encodedOwnedMarker(
    state.journal,
    'runtimeStage',
    'rollback',
    expected,
    rootIdentity,
  );
  ensurePromotionMarker(parent, path, content, state, 'rollback-marker-create', false, () =>
    assertPromotionRootIdentity(state.paths.destinationRuntime, rootIdentity),
  );
  const bound = inspectBoundOwnedMarker(
    path,
    state.paths.destinationRuntime,
    state.journal,
    'runtimeStage',
    'rollback',
    expected,
  );
  if (bound.status !== 'exact') {
    runtimePromotionFilesystemFailure(
      'the rollback marker lost its inode binding after publication',
    );
  }
  return { path, content: bound.content, rootIdentity: bound.rootIdentity };
}

function removeInstalledDestination(
  state: RuntimePromotionFilesystemCapabilityState,
  parent: StablePromotionDirectory,
  expected: RuntimeManifestIdentity,
): ReturnType<typeof ensureRollbackStarted> {
  const rollbackMarker = ensureRollbackStarted(state, parent, expected);
  removeBoundedOwnedTree(
    parent,
    state.paths.destinationRuntime,
    state.dependencies,
    rollbackMarker.rootIdentity,
  );
  return rollbackMarker;
}

function runtimeMatches(path: string, expected: RuntimeManifestIdentity): boolean {
  try {
    inspectExactRuntimeManifest(path, PROJECT_RUNTIME_POSTURE, expected);
    return true;
  } catch (error) {
    if (isRuntimeManifestReleaseUnsafe(error)) throw error;
    return false;
  }
}

/** Remove an installed runtime exactly once and settle its rollback marker. */
export function rollbackInstalledState(
  state: RuntimePromotionFilesystemCapabilityState,
  parent: StablePromotionDirectory,
  installed: RuntimeManifestIdentity,
  backup: RuntimeManifestIdentity | null,
): boolean {
  const markerPath = join(
    parent.path,
    runtimePromotionRollbackMarkerBasename(state.journal.owned.runtimeStage.basename),
  );
  const marker = inspectBoundOwnedMarker(
    markerPath,
    state.paths.destinationRuntime,
    state.journal,
    'runtimeStage',
    'rollback',
    installed,
  );
  if (marker.status === 'mismatch') {
    runtimePromotionFilesystemFailure('the interrupted rollback marker is ambiguous');
  }
  if (marker.status === 'exact') {
    removeBoundedOwnedTree(
      parent,
      state.paths.destinationRuntime,
      state.dependencies,
      marker.rootIdentity,
    );
    removeExactPromotionMarker(parent, markerPath, marker.content, state.dependencies);
    return true;
  }
  const destination = artifactPresence(state.paths.destinationRuntime);
  if (
    marker.status === 'absent' &&
    (destination === 'absent' ||
      (backup !== null &&
        artifactPresence(state.paths.destinationBackup) === 'absent' &&
        runtimeMatches(state.paths.destinationRuntime, backup)))
  ) {
    return false;
  }
  const started = removeInstalledDestination(state, parent, installed);
  removeExactPromotionMarker(parent, started.path, started.content, state.dependencies);
  return true;
}

function verifyBackupOwner(
  state: RuntimePromotionFilesystemCapabilityState,
  parent: StablePromotionDirectory,
  expected: RuntimeManifestIdentity,
): {
  readonly content: string;
  readonly rootIdentity: NonNullable<RuntimePromotionArtifactMarker['rootIdentity']>;
} {
  const owner = inspectBoundOwnedMarker(
    state.paths.destinationBackupMarker,
    state.paths.destinationBackup,
    state.journal,
    'destinationBackup',
    'owner',
    expected,
  );
  if (owner.status !== 'exact') {
    runtimePromotionFilesystemFailure('the rollback backup owner is absent or foreign');
  }
  ensureDurableExactPromotionMarker(
    parent,
    state.paths.destinationBackupMarker,
    owner.content,
    state.dependencies,
  );
  return { content: owner.content, rootIdentity: owner.rootIdentity };
}

/** Restore or validate the exact pre-install destination backup. */
export function restoreDestinationBackup(
  state: RuntimePromotionFilesystemCapabilityState,
  parent: StablePromotionDirectory,
  expected: RuntimeManifestIdentity,
): { readonly restored: VerifiedRuntimeManifest; readonly changed: boolean } {
  const backup = artifactPresence(state.paths.destinationBackup);
  const destination = artifactPresence(state.paths.destinationRuntime);
  if (backup === 'directory' && destination === 'directory') {
    runtimePromotionFilesystemFailure('both rollback backup and destination are present');
  }
  if (backup === 'directory') {
    assertRuntimePromotionDestinationRootAuthority(state.paths.destinationBackup, state.journal);
    const owner = verifyBackupOwner(state, parent, expected);
    withRuntimePromotionDestinationRootAuthority(state.paths.destinationBackup, state.journal, () =>
      inspectExactRuntimeManifest(state.paths.destinationBackup, PROJECT_RUNTIME_POSTURE, expected),
    );
    renamePromotionEntry(
      parent,
      state.paths.destinationBackup,
      state.paths.destinationRuntime,
      state.dependencies,
      'destination-backup-restore',
      () => {
        assertRuntimePromotionDestinationRootAuthority(
          state.paths.destinationBackup,
          state.journal,
        );
        assertPromotionRootIdentity(state.paths.destinationBackup, owner.rootIdentity);
        inspectExactRuntimeManifest(
          state.paths.destinationBackup,
          PROJECT_RUNTIME_POSTURE,
          expected,
        );
      },
    );
    assertRuntimePromotionDestinationRootAuthority(state.paths.destinationRuntime, state.journal);
    const restored = inspectExactRuntimeManifest(
      state.paths.destinationRuntime,
      PROJECT_RUNTIME_POSTURE,
      expected,
    );
    const restoredOwner = inspectBoundOwnedMarker(
      state.paths.destinationBackupMarker,
      state.paths.destinationRuntime,
      state.journal,
      'destinationBackup',
      'owner',
      expected,
    );
    if (restoredOwner.status !== 'exact') {
      runtimePromotionFilesystemFailure('the restored destination lost its backup owner binding');
    }
    removeExactPromotionMarker(
      parent,
      state.paths.destinationBackupMarker,
      restoredOwner.content,
      state.dependencies,
    );
    return { restored, changed: true };
  }
  if (destination === 'directory') {
    const restored = withRuntimePromotionDestinationRootAuthority(
      state.paths.destinationRuntime,
      state.journal,
      () =>
        inspectExactRuntimeManifest(
          state.paths.destinationRuntime,
          PROJECT_RUNTIME_POSTURE,
          expected,
        ),
    );
    const owner = inspectBoundOwnedMarker(
      state.paths.destinationBackupMarker,
      state.paths.destinationRuntime,
      state.journal,
      'destinationBackup',
      'owner',
      expected,
    );
    if (owner.status === 'mismatch') {
      runtimePromotionFilesystemFailure('the settled backup owner is ambiguous');
    }
    if (owner.status === 'absent') return { restored, changed: false };
    removeExactPromotionMarker(
      parent,
      state.paths.destinationBackupMarker,
      owner.content,
      state.dependencies,
    );
    return { restored, changed: true };
  }
  runtimePromotionFilesystemFailure('neither rollback backup nor restored destination exists');
}

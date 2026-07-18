import { join } from 'node:path';

import {
  encodeRuntimeStageOwnershipMarker,
  inspectVerifiedRuntimeManifest,
  isRuntimeManifestReleaseUnsafe,
  runtimeManifestIdentityEqual,
} from './runtime-manifest.js';
import {
  consumeRuntimePromotionFilesystemAuthority,
  openCapabilityDirectory,
} from './runtime-promotion-filesystem-authority.js';
import { removeBoundedOwnedTree } from './runtime-promotion-filesystem-cleanup-io.js';
import {
  assertPromotionRootIdentity,
  capturePromotionRootIdentity,
  classifyRuntimePromotionPath,
  closeStablePromotionDirectory,
  fsyncPromotionDirectory,
  removeEmptyPromotionDirectory,
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
  openExactDestinationParent,
} from './runtime-promotion-filesystem-operation-helpers.js';
import { stageMarkerPath } from './runtime-promotion-filesystem-stage.js';

import type {
  RuntimeManifestIdentity,
  RuntimeStageOwnershipIdentity,
  VerifiedRuntimeManifest,
} from './runtime-manifest.js';
import type { RuntimePromotionFilesystemCapabilityState } from './runtime-promotion-filesystem-authority.js';
import type { StablePromotionDirectory } from './runtime-promotion-filesystem-io.js';
import type {
  RuntimePromotionArtifactMarker,
  RuntimePromotionFilesystemAuthority,
  RuntimePromotionRollbackInput,
  RuntimePromotionRollbackResult,
} from './runtime-promotion-filesystem-types.js';

const PROJECT_RUNTIME_POSTURE = 'project-runtime';

function assertIdentity(
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

function removeCreatedParentStage(
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
  return {
    path,
    content: bound.content,
    rootIdentity: bound.rootIdentity,
  };
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

function rollbackInstalledState(
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

function restoreDestinationBackup(
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
    const owner = verifyBackupOwner(state, parent, expected);
    inspectExactRuntimeManifest(state.paths.destinationBackup, PROJECT_RUNTIME_POSTURE, expected);
    renamePromotionEntry(
      parent,
      state.paths.destinationBackup,
      state.paths.destinationRuntime,
      state.dependencies,
      'destination-backup-restore',
      () => {
        assertPromotionRootIdentity(state.paths.destinationBackup, owner.rootIdentity);
        inspectExactRuntimeManifest(
          state.paths.destinationBackup,
          PROJECT_RUNTIME_POSTURE,
          expected,
        );
      },
    );
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
    const restored = inspectExactRuntimeManifest(
      state.paths.destinationRuntime,
      PROJECT_RUNTIME_POSTURE,
      expected,
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
    if (owner.status === 'absent') {
      return { restored, changed: false };
    }
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

function createdPreinstallParentRoot(state: RuntimePromotionFilesystemCapabilityState): {
  readonly root: string;
  readonly present: boolean;
  readonly publicParentPresent: boolean;
} {
  const parentState = classifyRuntimePromotionPath(state.paths.destinationParent);
  const stagedState = classifyRuntimePromotionPath(state.paths.destinationParentStage);
  if (parentState.status !== 'absent' && parentState.status !== 'directory') {
    runtimePromotionFilesystemFailure('the operation-created parent has an unsafe root');
  }
  if (stagedState.status !== 'absent' && stagedState.status !== 'directory') {
    runtimePromotionFilesystemFailure('the operation-created parent stage has an unsafe root');
  }
  if (parentState.status === 'directory' && stagedState.status === 'directory') {
    runtimePromotionFilesystemFailure(
      'both the operation-created parent and its stage are present',
    );
  }
  if (parentState.status === 'directory') {
    return {
      root: state.paths.destinationParent,
      present: true,
      publicParentPresent: true,
    };
  }
  if (stagedState.status === 'directory') {
    return {
      root: state.paths.destinationParentStage,
      present: true,
      publicParentPresent: false,
    };
  }
  return {
    root: state.paths.destinationParent,
    present: false,
    publicParentPresent: false,
  };
}

function rollbackCreatedPreinstallParent(
  state: RuntimePromotionFilesystemCapabilityState,
  project: StablePromotionDirectory,
): boolean {
  const rootState = createdPreinstallParentRoot(state);
  const marker = inspectBoundOwnedMarker(
    state.paths.destinationParentMarker,
    rootState.root,
    state.journal,
    'destinationParent',
    'owner',
    null,
  );
  if (!rootState.present) {
    if (marker.status === 'absent') return false;
    if (marker.status !== 'exact') {
      runtimePromotionFilesystemFailure('the removed destination-parent owner is ambiguous');
    }
    return removeExactPromotionMarker(
      project,
      state.paths.destinationParentMarker,
      marker.content,
      state.dependencies,
    );
  }
  if (marker.status !== 'exact') {
    runtimePromotionFilesystemFailure(
      'an existing operation-created parent lacks its exact owner marker',
    );
  }
  ensureDurableExactPromotionMarker(
    project,
    state.paths.destinationParentMarker,
    marker.content,
    state.dependencies,
  );
  if (rootState.publicParentPresent) {
    const parent = openExactDestinationParent(state);
    try {
      removeCreatedParentStage(state, parent, state.journal.manifests.runtimeStage);
    } finally {
      closeStablePromotionDirectory(parent);
    }
  }
  removeEmptyPromotionDirectory(
    project,
    rootState.root,
    state.dependencies,
    'rollback-destination-remove',
    marker.rootIdentity,
  );
  removeExactPromotionMarker(
    project,
    state.paths.destinationParentMarker,
    marker.content,
    state.dependencies,
  );
  return true;
}

function settleCreatedInstalledParent(
  state: RuntimePromotionFilesystemCapabilityState,
  project: StablePromotionDirectory,
): boolean {
  if (state.journal.destinationParentPreexisting || state.journal.progress.authoredCursor > 0) {
    return false;
  }
  const parent = classifyRuntimePromotionPath(state.paths.destinationParent);
  const staged = classifyRuntimePromotionPath(state.paths.destinationParentStage);
  if (staged.status !== 'absent') {
    runtimePromotionFilesystemFailure(
      'an installed destination parent still has an operation stage',
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
  if (parent.status === 'absent') {
    if (marker.status === 'absent') return false;
    if (marker.status !== 'exact') {
      runtimePromotionFilesystemFailure('the removed destination-parent owner is ambiguous');
    }
    return removeExactPromotionMarker(
      project,
      state.paths.destinationParentMarker,
      marker.content,
      state.dependencies,
    );
  }
  if (parent.status !== 'directory') {
    runtimePromotionFilesystemFailure('the installed operation-created parent is unsafe');
  }
  if (marker.status !== 'exact') {
    runtimePromotionFilesystemFailure(
      'the installed operation-created parent lacks its exact owner marker',
    );
  }
  ensureDurableExactPromotionMarker(
    project,
    state.paths.destinationParentMarker,
    marker.content,
    state.dependencies,
  );
  removeEmptyPromotionDirectory(
    project,
    state.paths.destinationParent,
    state.dependencies,
    'rollback-destination-remove',
    marker.rootIdentity,
  );
  removeExactPromotionMarker(
    project,
    state.paths.destinationParentMarker,
    marker.content,
    state.dependencies,
  );
  return true;
}

export async function rollbackRuntimePromotion(
  authority: RuntimePromotionFilesystemAuthority,
  input: RuntimePromotionRollbackInput,
): Promise<RuntimePromotionRollbackResult> {
  const state = await consumeRuntimePromotionFilesystemAuthority(authority, 'runtime-rollback');
  assertIdentity(state.journal.manifests.runtimeStage, input.installed, 'installed rollback state');
  assertIdentity(state.journal.manifests.destination, input.backup, 'rollback backup state');
  const installedWasAuthoritative = state.journal.progress.runtimeInstallState === 'installed';
  if (input.installedWasAuthoritative !== installedWasAuthoritative) {
    runtimePromotionFilesystemFailure(
      'the rollback install posture does not match the durable journal',
    );
  }
  const project = openCapabilityDirectory(state.projectRoot, 'the promotion project root');
  let changed = false;
  try {
    if (!installedWasAuthoritative && !state.journal.destinationParentPreexisting) {
      changed = rollbackCreatedPreinstallParent(state, project);
      return {
        status: changed ? 'rolled-back' : 'already-rolled-back',
        runtimeInstallState: 'rolled-back',
        restored: null,
      };
    }
    const parent = openExactDestinationParent(state);
    let restored: VerifiedRuntimeManifest | null = null;
    try {
      if (installedWasAuthoritative) {
        if (input.installed === null) {
          runtimePromotionFilesystemFailure('installed rollback lacks a runtime manifest');
        }
        changed = rollbackInstalledState(state, parent, input.installed, input.backup);
      } else if (state.journal.cleanup.runtimeStage === 'pending') {
        changed = removeCreatedParentStage(state, parent, input.installed);
      }
      if (input.backup !== null) {
        const result = restoreDestinationBackup(state, parent, input.backup);
        restored = result.restored;
        changed ||= result.changed;
      } else if (artifactPresence(state.paths.destinationRuntime) !== 'absent') {
        runtimePromotionFilesystemFailure('rollback left an unplanned destination runtime');
      }
    } finally {
      closeStablePromotionDirectory(parent);
    }
    if (installedWasAuthoritative) {
      changed = settleCreatedInstalledParent(state, project) || changed;
    }
    return {
      status: changed ? 'rolled-back' : 'already-rolled-back',
      runtimeInstallState: installedWasAuthoritative ? 'rolled-back' : 'backup-restored',
      restored,
    };
  } finally {
    closeStablePromotionDirectory(project);
  }
}

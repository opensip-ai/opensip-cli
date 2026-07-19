import {
  consumeRuntimePromotionFilesystemAuthority,
  openCapabilityDirectory,
} from './runtime-promotion-filesystem-authority.js';
import {
  classifyRuntimePromotionPath,
  closeStablePromotionDirectory,
  removeEmptyPromotionDirectory,
  runtimePromotionFilesystemFailure,
} from './runtime-promotion-filesystem-io.js';
import {
  ensureDurableExactPromotionMarker,
  removeExactPromotionMarker,
} from './runtime-promotion-filesystem-marker-io.js';
import {
  artifactPresence,
  inspectBoundOwnedMarker,
  openExactDestinationParent,
} from './runtime-promotion-filesystem-operation-helpers.js';
import {
  assertRollbackIdentity,
  removeCreatedParentStage,
  restoreDestinationBackup,
  rollbackInstalledState,
} from './runtime-promotion-filesystem-rollback-runtime.js';

import type { VerifiedRuntimeManifest } from './runtime-manifest.js';
import type { RuntimePromotionFilesystemCapabilityState } from './runtime-promotion-filesystem-authority.js';
import type { StablePromotionDirectory } from './runtime-promotion-filesystem-io.js';
import type {
  RuntimePromotionFilesystemAuthority,
  RuntimePromotionRollbackInput,
  RuntimePromotionRollbackResult,
} from './runtime-promotion-filesystem-types.js';

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

/** Roll back a runtime promotion under the consumed filesystem capability. */
export async function rollbackRuntimePromotion(
  authority: RuntimePromotionFilesystemAuthority,
  input: RuntimePromotionRollbackInput,
): Promise<RuntimePromotionRollbackResult> {
  const state = await consumeRuntimePromotionFilesystemAuthority(authority, 'runtime-rollback');
  assertRollbackIdentity(
    state.journal.manifests.runtimeStage,
    input.installed,
    'installed rollback state',
  );
  assertRollbackIdentity(
    state.journal.manifests.destination,
    input.backup,
    'rollback backup state',
  );
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

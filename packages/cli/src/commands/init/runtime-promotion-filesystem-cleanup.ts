import { join } from 'node:path';

import {
  encodeRuntimeStageOwnershipMarker,
  inspectVerifiedRuntimeManifest,
  runtimeManifestIdentityEqual,
} from './runtime-manifest.js';
import {
  consumeRuntimePromotionFilesystemAuthority,
  openCapabilityDirectory,
} from './runtime-promotion-filesystem-authority.js';
import {
  classifyRuntimePromotionPath,
  closeStablePromotionDirectory,
  runtimePromotionFilesystemFailure,
} from './runtime-promotion-filesystem-io.js';
import {
  ensureDurableExactPromotionMarker,
  inspectExactPromotionMarker,
  removeExactPromotionMarker,
} from './runtime-promotion-filesystem-marker-io.js';
import {
  isRuntimeFilesystemSlot,
  runtimePromotionCleanupMarkerBasename,
} from './runtime-promotion-filesystem-marker.js';
import {
  artifactPresence,
  cleanupOwnedRuntimeTree,
  inspectBoundOwnedMarker,
  inspectExactRuntimeManifest,
  openExactDestinationParent,
} from './runtime-promotion-filesystem-operation-helpers.js';
import { stageMarkerPath } from './runtime-promotion-filesystem-stage.js';

import type { RuntimeManifestIdentity } from './runtime-manifest.js';
import type { RuntimePromotionFilesystemCapabilityState } from './runtime-promotion-filesystem-authority.js';
import type { StablePromotionDirectory } from './runtime-promotion-filesystem-io.js';
import type {
  RuntimePromotionFilesystemAuthority,
  RuntimePromotionOwnedCleanupResult,
} from './runtime-promotion-filesystem-types.js';

const CLEANUP_ALREADY_ABSENT = 'already-absent';

function cleanupMarkerPath(parent: StablePromotionDirectory, artifactBasename: string): string {
  return join(parent.path, runtimePromotionCleanupMarkerBasename(artifactBasename));
}

function cleanupDestinationParentMarker(
  state: RuntimePromotionFilesystemCapabilityState,
): RuntimePromotionOwnedCleanupResult['status'] {
  const project = openCapabilityDirectory(state.projectRoot, 'the promotion project root');
  try {
    if (classifyRuntimePromotionPath(state.paths.destinationParentMarker).status === 'absent') {
      return CLEANUP_ALREADY_ABSENT;
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
      runtimePromotionFilesystemFailure('destination-parent cleanup ownership is ambiguous');
    }
    return removeExactPromotionMarker(
      project,
      state.paths.destinationParentMarker,
      marker.content,
      state.dependencies,
    )
      ? 'removed'
      : CLEANUP_ALREADY_ABSENT;
  } finally {
    closeStablePromotionDirectory(project);
  }
}

function verifyCompleteOwnedStage(
  state: RuntimePromotionFilesystemCapabilityState,
  expected: RuntimeManifestIdentity,
): void {
  const ownership = {
    operationId: state.journal.operationId,
    stageBasename: state.journal.owned.runtimeStage.basename,
    ownershipId: state.journal.owned.runtimeStage.ownershipId,
  };
  if (
    inspectExactPromotionMarker(
      stageMarkerPath(state.paths.runtimeStage),
      encodeRuntimeStageOwnershipMarker(ownership),
    ).status !== 'exact'
  ) {
    runtimePromotionFilesystemFailure('the cleanup stage owner is absent or foreign');
  }
  const manifest = inspectVerifiedRuntimeManifest(
    state.paths.runtimeStage,
    'promotion-stage',
    {},
    ownership,
  );
  if (!runtimeManifestIdentityEqual(manifest.identity, expected)) {
    runtimePromotionFilesystemFailure('the cleanup stage does not match its journal manifest');
  }
}

function cleanupRuntimeStage(
  state: RuntimePromotionFilesystemCapabilityState,
): RuntimePromotionOwnedCleanupResult['status'] {
  const expected = state.journal.manifests.runtimeStage;
  if (expected === null) {
    runtimePromotionFilesystemFailure('runtime-stage cleanup lacks a recorded manifest');
  }
  if (classifyRuntimePromotionPath(state.paths.destinationParent).status === 'absent') {
    if (classifyRuntimePromotionPath(state.paths.runtimeStage).status !== 'absent') {
      runtimePromotionFilesystemFailure('a runtime stage escaped its destination parent');
    }
    return CLEANUP_ALREADY_ABSENT;
  }
  const parent = openExactDestinationParent(state);
  try {
    const cleanupPath = cleanupMarkerPath(parent, state.journal.owned.runtimeStage.basename);
    if (
      artifactPresence(state.paths.runtimeStage) === 'absent' &&
      inspectBoundOwnedMarker(
        cleanupPath,
        state.paths.runtimeStage,
        state.journal,
        'runtimeStage',
        'cleanup',
        expected,
      ).status === 'absent'
    ) {
      return CLEANUP_ALREADY_ABSENT;
    }
    return cleanupOwnedRuntimeTree({
      state,
      parent,
      root: state.paths.runtimeStage,
      slot: 'runtimeStage',
      expected,
      verifyBefore: () => {
        verifyCurrentProjectSuccessor(state);
        verifyCompleteOwnedStage(state, expected);
      },
    })
      ? 'removed'
      : CLEANUP_ALREADY_ABSENT;
  } finally {
    closeStablePromotionDirectory(parent);
  }
}

interface ExternalTreeCleanupInput {
  readonly state: RuntimePromotionFilesystemCapabilityState;
  readonly parent: StablePromotionDirectory;
  readonly root: string;
  readonly ownerPath: string;
  readonly slot: 'destinationBackup' | 'sourceTombstone';
  readonly expected: RuntimeManifestIdentity;
  readonly posture: 'cache-source' | 'project-runtime';
}

/**
 * Generic recovery cleanup deliberately proves a valid current successor, not
 * historical byte equality: ordinary runs may have changed the project runtime
 * after the promotion journal closed.
 */
function verifyCurrentProjectSuccessor(state: RuntimePromotionFilesystemCapabilityState): void {
  const terminal = state.journal.terminal;
  if (
    terminal?.outcome !== 'committed' ||
    terminal.authority !== 'project' ||
    terminal.runtimeManifest === null
  ) {
    runtimePromotionFilesystemFailure('owned cleanup lacks committed project successor authority');
  }
  const current = inspectVerifiedRuntimeManifest(state.paths.destinationRuntime, 'project-runtime');
  if (
    terminal.runtimeManifest.sqlite.status === 'verified' &&
    current.identity.sqlite.status !== 'verified'
  ) {
    runtimePromotionFilesystemFailure(
      'owned cleanup cannot discard the last database-bearing authority',
    );
  }
}

function cleanupExternalOwnedTree(
  input: ExternalTreeCleanupInput,
): RuntimePromotionOwnedCleanupResult['status'] {
  const cleanupPath = cleanupMarkerPath(
    input.parent,
    input.state.journal.owned[input.slot].basename,
  );
  const root = artifactPresence(input.root);
  const ownerState = inspectBoundOwnedMarker(
    input.ownerPath,
    input.root,
    input.state.journal,
    input.slot,
    'owner',
    input.expected,
  );
  const cleanupState = inspectBoundOwnedMarker(
    cleanupPath,
    input.root,
    input.state.journal,
    input.slot,
    'cleanup',
    input.expected,
  );
  if (ownerState.status === 'mismatch' || cleanupState.status === 'mismatch') {
    runtimePromotionFilesystemFailure('owned tree cleanup identity is ambiguous');
  }
  if (root === 'absent' && cleanupState.status === 'absent') {
    if (ownerState.status === 'absent') {
      return CLEANUP_ALREADY_ABSENT;
    }
    return removeExactPromotionMarker(
      input.parent,
      input.ownerPath,
      ownerState.content,
      input.state.dependencies,
    )
      ? 'removed'
      : CLEANUP_ALREADY_ABSENT;
  }
  if (cleanupState.status !== 'exact' && ownerState.status !== 'exact') {
    runtimePromotionFilesystemFailure('an owned cleanup root has no durable owner');
  }
  if (ownerState.status === 'exact') {
    ensureDurableExactPromotionMarker(
      input.parent,
      input.ownerPath,
      ownerState.content,
      input.state.dependencies,
    );
  }
  const removed = cleanupOwnedRuntimeTree({
    state: input.state,
    parent: input.parent,
    root: input.root,
    slot: input.slot,
    expected: input.expected,
    ...(ownerState.status === 'exact'
      ? {
          externalOwner: {
            path: input.ownerPath,
            content: ownerState.content,
          },
        }
      : {}),
    verifyBefore: () => {
      verifyCurrentProjectSuccessor(input.state);
      if (
        inspectBoundOwnedMarker(
          input.ownerPath,
          input.root,
          input.state.journal,
          input.slot,
          'owner',
          input.expected,
        ).status !== 'exact'
      ) {
        runtimePromotionFilesystemFailure('the owned root owner changed before cleanup');
      }
      inspectExactRuntimeManifest(input.root, input.posture, input.expected);
    },
  });
  return removed ? 'removed' : CLEANUP_ALREADY_ABSENT;
}

function cleanupDestinationBackup(
  state: RuntimePromotionFilesystemCapabilityState,
): RuntimePromotionOwnedCleanupResult['status'] {
  const expected = state.journal.manifests.destination;
  if (expected === null) {
    runtimePromotionFilesystemFailure('destination-backup cleanup lacks a manifest');
  }
  const parent = openExactDestinationParent(state);
  try {
    return cleanupExternalOwnedTree({
      state,
      parent,
      root: state.paths.destinationBackup,
      ownerPath: state.paths.destinationBackupMarker,
      slot: 'destinationBackup',
      expected,
      posture: 'project-runtime',
    });
  } finally {
    closeStablePromotionDirectory(parent);
  }
}

function cleanupSourceTombstone(
  state: RuntimePromotionFilesystemCapabilityState,
): RuntimePromotionOwnedCleanupResult['status'] {
  const expected = state.journal.manifests.source;
  if (
    expected === null ||
    state.sourceParent === undefined ||
    state.paths.sourceTombstone === undefined ||
    state.paths.sourceTombstoneMarker === undefined
  ) {
    runtimePromotionFilesystemFailure('source-tombstone cleanup lacks journal-bound source state');
  }
  const parent = openCapabilityDirectory(state.sourceParent, 'the selected cache parent');
  try {
    return cleanupExternalOwnedTree({
      state,
      parent,
      root: state.paths.sourceTombstone,
      ownerPath: state.paths.sourceTombstoneMarker,
      slot: 'sourceTombstone',
      expected,
      posture: 'cache-source',
    });
  } finally {
    closeStablePromotionDirectory(parent);
  }
}

export async function cleanupRuntimePromotionOwnedSlot(
  authority: RuntimePromotionFilesystemAuthority,
): Promise<RuntimePromotionOwnedCleanupResult> {
  const state = await consumeRuntimePromotionFilesystemAuthority(authority, 'owned-slot-cleanup');
  const slot = state.cleanupSlot;
  if (slot === undefined || !isRuntimeFilesystemSlot(slot)) {
    runtimePromotionFilesystemFailure('the requested slot belongs to authored-state cleanup');
  }
  let status: RuntimePromotionOwnedCleanupResult['status'];
  switch (slot) {
    case 'destinationParent': {
      status = cleanupDestinationParentMarker(state);
      break;
    }
    case 'runtimeStage': {
      status = cleanupRuntimeStage(state);
      break;
    }
    case 'destinationBackup': {
      status = cleanupDestinationBackup(state);
      break;
    }
    case 'sourceTombstone': {
      status = cleanupSourceTombstone(state);
      break;
    }
  }
  return { slot, status };
}

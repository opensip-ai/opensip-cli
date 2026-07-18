import { join } from 'node:path';

import { EPHEMERAL_MARKER_FILE, EPHEMERAL_MARKER_MAX_BYTES } from '@opensip-cli/core';

import { runtimeManifestIdentityEqual } from './runtime-manifest.js';
import { withRuntimePromotionDestinationRootAuthority } from './runtime-promotion-destination-authority.js';
import {
  consumeRuntimePromotionFilesystemAuthority,
  openCapabilityDirectory,
} from './runtime-promotion-filesystem-authority.js';
import {
  assertPromotionRootIdentity,
  classifyRuntimePromotionPath,
  closeStablePromotionDirectory,
  renamePromotionEntry,
  runtimePromotionFilesystemFailure,
} from './runtime-promotion-filesystem-io.js';
import {
  digestStablePromotionFile,
  ensureDurableExactPromotionMarker,
} from './runtime-promotion-filesystem-marker-io.js';
import {
  artifactPresence,
  ensureBoundOwnerMarker,
  inspectBoundOwnedMarker,
  inspectExactRuntimeManifest,
} from './runtime-promotion-filesystem-operation-helpers.js';

import type { RuntimeManifestIdentity } from './runtime-manifest.js';
import type { RuntimePromotionFilesystemCapabilityState } from './runtime-promotion-filesystem-authority.js';
import type {
  RuntimePromotionFilesystemAuthority,
  RuntimePromotionRetireResult,
} from './runtime-promotion-filesystem-types.js';
import type { RuntimePromotionRootIdentity } from './runtime-promotion-journal-schema.js';

function journalSourceRootIdentity(
  state: RuntimePromotionFilesystemCapabilityState,
): RuntimePromotionRootIdentity {
  const identity = state.journal.source.rootIdentity;
  if (identity === null) {
    runtimePromotionFilesystemFailure('source retirement lacks journal root identity');
  }
  return identity;
}

function assertSelectedSourceMarker(runtime: string, expectedSha256: string | null): void {
  const markerPath = join(runtime, EPHEMERAL_MARKER_FILE);
  const marker = classifyRuntimePromotionPath(markerPath);
  if (expectedSha256 === null) {
    if (marker.status !== 'absent') {
      runtimePromotionFilesystemFailure('a markerless selected source gained marker bytes');
    }
    return;
  }
  if (
    marker.status !== 'file' ||
    digestStablePromotionFile(markerPath, EPHEMERAL_MARKER_MAX_BYTES) !== expectedSha256
  ) {
    runtimePromotionFilesystemFailure('the selected cache marker changed before retirement');
  }
}

function assertProjectSuccessor(state: RuntimePromotionFilesystemCapabilityState): void {
  const successor =
    state.journal.route === 'promote-cache'
      ? state.journal.manifests.runtimeStage
      : state.journal.manifests.destination;
  if (successor === null) {
    runtimePromotionFilesystemFailure('source retirement lacks project successor authority');
  }
  if (state.journal.route === 'promote-cache') {
    inspectExactRuntimeManifest(state.paths.destinationRuntime, 'project-runtime', successor);
    return;
  }
  withRuntimePromotionDestinationRootAuthority(state.paths.destinationRuntime, state.journal, () =>
    inspectExactRuntimeManifest(state.paths.destinationRuntime, 'project-runtime', successor),
  );
}

export async function retireRuntimePromotionSource(
  authority: RuntimePromotionFilesystemAuthority,
  expected: RuntimeManifestIdentity,
): Promise<RuntimePromotionRetireResult> {
  const state = await consumeRuntimePromotionFilesystemAuthority(authority, 'source-retire');
  if (
    state.journal.manifests.source === null ||
    !runtimeManifestIdentityEqual(state.journal.manifests.source, expected)
  ) {
    runtimePromotionFilesystemFailure('the retired source manifest does not match the journal');
  }
  if (
    state.sourceParent === undefined ||
    state.paths.sourceRuntime === undefined ||
    state.paths.sourceTombstone === undefined ||
    state.paths.sourceTombstoneMarker === undefined
  ) {
    runtimePromotionFilesystemFailure('source retirement lacks an anchored cache path');
  }
  const parent = openCapabilityDirectory(state.sourceParent, 'the selected cache parent');
  try {
    assertProjectSuccessor(state);
    const sourceRootIdentity = journalSourceRootIdentity(state);
    const source = artifactPresence(state.paths.sourceRuntime);
    const tombstone = artifactPresence(state.paths.sourceTombstone);
    if (source === 'directory' && tombstone === 'directory') {
      runtimePromotionFilesystemFailure('both source and source tombstone are present');
    }
    if (source === 'directory') {
      assertPromotionRootIdentity(state.paths.sourceRuntime, sourceRootIdentity);
      assertSelectedSourceMarker(state.paths.sourceRuntime, state.journal.source.markerSha256);
      const verified = inspectExactRuntimeManifest(
        state.paths.sourceRuntime,
        'cache-source',
        expected,
      );
      assertPromotionRootIdentity(state.paths.sourceRuntime, sourceRootIdentity);
      const owner = ensureBoundOwnerMarker({
        state,
        parent,
        root: state.paths.sourceRuntime,
        markerPath: state.paths.sourceTombstoneMarker,
        slot: 'sourceTombstone',
        expected,
        operation: 'source-tombstone-marker-create',
      });
      renamePromotionEntry(
        parent,
        state.paths.sourceRuntime,
        state.paths.sourceTombstone,
        state.dependencies,
        'source-retire-rename',
        () => {
          assertPromotionRootIdentity(state.paths.sourceRuntime!, sourceRootIdentity);
          assertPromotionRootIdentity(state.paths.sourceRuntime!, owner.rootIdentity);
          assertSelectedSourceMarker(state.paths.sourceRuntime!, state.journal.source.markerSha256);
          inspectExactRuntimeManifest(state.paths.sourceRuntime!, 'cache-source', expected);
          assertProjectSuccessor(state);
          assertPromotionRootIdentity(state.paths.sourceRuntime!, sourceRootIdentity);
        },
      );
      assertSelectedSourceMarker(state.paths.sourceTombstone, state.journal.source.markerSha256);
      inspectExactRuntimeManifest(state.paths.sourceTombstone, 'cache-source', expected);
      if (
        inspectBoundOwnedMarker(
          state.paths.sourceTombstoneMarker,
          state.paths.sourceTombstone,
          state.journal,
          'sourceTombstone',
          'owner',
          expected,
        ).status !== 'exact'
      ) {
        runtimePromotionFilesystemFailure('the source tombstone owner lost its inode binding');
      }
      return { status: 'applied', manifest: verified };
    }
    if (tombstone === 'directory') {
      assertPromotionRootIdentity(state.paths.sourceTombstone, sourceRootIdentity);
      const owner = inspectBoundOwnedMarker(
        state.paths.sourceTombstoneMarker,
        state.paths.sourceTombstone,
        state.journal,
        'sourceTombstone',
        'owner',
        expected,
      );
      if (owner.status !== 'exact') {
        runtimePromotionFilesystemFailure('the source tombstone owner is absent or foreign');
      }
      ensureDurableExactPromotionMarker(
        parent,
        state.paths.sourceTombstoneMarker,
        owner.content,
        state.dependencies,
      );
      assertSelectedSourceMarker(state.paths.sourceTombstone, state.journal.source.markerSha256);
      const manifest = inspectExactRuntimeManifest(
        state.paths.sourceTombstone,
        'cache-source',
        expected,
      );
      if (
        inspectBoundOwnedMarker(
          state.paths.sourceTombstoneMarker,
          state.paths.sourceTombstone,
          state.journal,
          'sourceTombstone',
          'owner',
          expected,
        ).status !== 'exact'
      ) {
        runtimePromotionFilesystemFailure(
          'the replayed source tombstone owner lost its inode binding',
        );
      }
      return {
        status: 'already-applied',
        manifest,
      };
    }
    runtimePromotionFilesystemFailure('neither source nor source tombstone is present');
  } finally {
    closeStablePromotionDirectory(parent);
  }
}

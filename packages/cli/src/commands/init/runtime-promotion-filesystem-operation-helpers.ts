import { opendirSync } from 'node:fs';
import { join } from 'node:path';

import {
  inspectVerifiedRuntimeManifest,
  runtimeManifestIdentityEqual,
  type RuntimeTreePosture,
  type VerifiedRuntimeManifest,
} from './runtime-manifest.js';
import {
  openCapabilityDirectory,
  type RuntimePromotionFilesystemCapabilityState,
} from './runtime-promotion-filesystem-authority.js';
import { removeBoundedOwnedTree } from './runtime-promotion-filesystem-cleanup-io.js';
import {
  assertPromotionRootIdentity,
  capturePromotionRootIdentity,
  classifyRuntimePromotionPath,
  closeStablePromotionDirectory,
  openStablePromotionDirectory,
  runtimePromotionFilesystemFailure,
} from './runtime-promotion-filesystem-io.js';
import {
  ensureDurableExactPromotionMarker,
  inspectExactPromotionMarker,
  publishPromotionMarker,
  removeExactPromotionMarker,
  removePartialPromotionMarker,
  readStablePromotionMarkerContent,
} from './runtime-promotion-filesystem-marker-io.js';
import {
  encodeRuntimePromotionArtifactMarker,
  markerForOwnedSlot,
  parseRuntimePromotionArtifactMarker,
  runtimePromotionCleanupMarkerBasename,
} from './runtime-promotion-filesystem-marker.js';

import type { StablePromotionDirectory } from './runtime-promotion-filesystem-io.js';
import type {
  RuntimePromotionFilesystemMutation,
  RuntimePromotionArtifactMarker,
} from './runtime-promotion-filesystem-types.js';
import type {
  RuntimeManifestIdentity,
  RuntimePromotionJournal,
} from './runtime-promotion-journal-schema.js';

type RuntimeFilesystemSlot =
  'destinationParent' | 'runtimeStage' | 'destinationBackup' | 'sourceTombstone';

export function encodedOwnedMarker(
  journal: RuntimePromotionJournal,
  slot: RuntimeFilesystemSlot,
  purpose: RuntimePromotionArtifactMarker['purpose'],
  manifest: RuntimeManifestIdentity | null,
  rootIdentity: RuntimePromotionArtifactMarker['rootIdentity'] = null,
): string {
  const marker = markerForOwnedSlot(journal.operationId, slot, purpose, manifest, rootIdentity);
  const journalOwned = journal.owned[slot];
  if (
    marker.ownershipId !== journalOwned.ownershipId ||
    marker.artifactBasename !== journalOwned.basename
  ) {
    runtimePromotionFilesystemFailure('an artifact marker does not match journal ownership');
  }
  return encodeRuntimePromotionArtifactMarker(marker);
}

export type BoundOwnedMarkerInspection =
  | { readonly status: 'absent' }
  | {
      readonly status: 'exact';
      readonly content: string;
      readonly rootIdentity: NonNullable<RuntimePromotionArtifactMarker['rootIdentity']>;
    }
  | { readonly status: 'mismatch' };

export function inspectBoundOwnedMarker(
  markerPath: string,
  rootPath: string,
  journal: RuntimePromotionJournal,
  slot: RuntimeFilesystemSlot,
  purpose: RuntimePromotionArtifactMarker['purpose'],
  manifest: RuntimeManifestIdentity | null,
): BoundOwnedMarkerInspection {
  const markerClassification = classifyRuntimePromotionPath(markerPath);
  if (markerClassification.status === 'absent') return { status: 'absent' };
  if (
    markerClassification.status !== 'file' ||
    markerClassification.mode !== 0o600 ||
    markerClassification.links !== 1 ||
    markerClassification.owner !== 'current'
  ) {
    return { status: 'mismatch' };
  }
  const raw = readStablePromotionMarkerContent(markerPath);
  try {
    const parsed = parseRuntimePromotionArtifactMarker(raw);
    if (parsed.rootIdentity === null) return { status: 'mismatch' };
    const expected = encodedOwnedMarker(journal, slot, purpose, manifest, parsed.rootIdentity);
    if (raw !== expected) return { status: 'mismatch' };
    const root = classifyRuntimePromotionPath(rootPath);
    if (root.status !== 'absent') {
      if (root.status !== 'directory' || root.owner !== 'current') {
        return { status: 'mismatch' };
      }
      assertPromotionRootIdentity(rootPath, parsed.rootIdentity);
    }
    return {
      status: 'exact',
      content: expected,
      rootIdentity: parsed.rootIdentity,
    };
  } catch {
    // A truncated marker cannot prove which inode was recorded in the missing
    // suffix. Rebinding it to the currently visible root would let a
    // byte-identical replacement inherit destructive authority.
    return { status: 'mismatch' };
  }
}

export function ensurePromotionMarker(
  parent: StablePromotionDirectory,
  path: string,
  content: string,
  state: RuntimePromotionFilesystemCapabilityState,
  operation: RuntimePromotionFilesystemMutation,
  allowPartial: boolean,
  revalidateBeforeCreate?: () => void,
): void {
  const observed = inspectExactPromotionMarker(path, content);
  if (observed.status === 'exact') {
    ensureDurableExactPromotionMarker(parent, path, content, state.dependencies);
    return;
  }
  if (observed.status === 'mismatch') {
    runtimePromotionFilesystemFailure('an operation marker has a foreign identity');
  }
  if (observed.status === 'partial-prefix') {
    if (!allowPartial) {
      runtimePromotionFilesystemFailure('a partial operation marker is ambiguous');
    }
    removePartialPromotionMarker(parent, path, content, state.dependencies);
  }
  publishPromotionMarker(
    parent,
    path,
    content,
    state.dependencies,
    operation,
    revalidateBeforeCreate,
  );
}

interface EnsureBoundOwnerMarkerInput {
  readonly state: RuntimePromotionFilesystemCapabilityState;
  readonly parent: StablePromotionDirectory;
  readonly root: string;
  readonly markerPath: string;
  readonly slot: 'destinationBackup' | 'sourceTombstone';
  readonly expected: RuntimeManifestIdentity;
  readonly operation: Extract<
    RuntimePromotionFilesystemMutation,
    'destination-backup-marker-create' | 'source-tombstone-marker-create'
  >;
}

/**
 * Publish or replay an owner marker whose canonical bytes name the exact
 * artifact inode. A byte-identical replacement therefore cannot inherit
 * destructive rollback or cleanup authority.
 */
export function ensureBoundOwnerMarker(
  input: EnsureBoundOwnerMarkerInput,
): Extract<BoundOwnedMarkerInspection, { readonly status: 'exact' }> {
  const observed = inspectBoundOwnedMarker(
    input.markerPath,
    input.root,
    input.state.journal,
    input.slot,
    'owner',
    input.expected,
  );
  if (observed.status === 'mismatch') {
    runtimePromotionFilesystemFailure('an artifact owner marker has a foreign inode binding');
  }

  const rootIdentity =
    observed.status === 'exact' ? observed.rootIdentity : capturePromotionRootIdentity(input.root);
  const content =
    observed.status === 'exact'
      ? observed.content
      : encodedOwnedMarker(input.state.journal, input.slot, 'owner', input.expected, rootIdentity);
  ensurePromotionMarker(
    input.parent,
    input.markerPath,
    content,
    input.state,
    input.operation,
    false,
    () => assertPromotionRootIdentity(input.root, rootIdentity),
  );
  const bound = inspectBoundOwnedMarker(
    input.markerPath,
    input.root,
    input.state.journal,
    input.slot,
    'owner',
    input.expected,
  );
  if (bound.status !== 'exact') {
    runtimePromotionFilesystemFailure('an artifact owner marker lost its inode binding');
  }
  return bound;
}

export function openExactDestinationParent(
  state: RuntimePromotionFilesystemCapabilityState,
): StablePromotionDirectory {
  const parent =
    state.destinationParent === undefined
      ? openStablePromotionDirectory(state.paths.destinationParent, 'the project OpenSIP directory')
      : openCapabilityDirectory(
          state.destinationParent,
          'the preexisting project OpenSIP directory',
        );
  try {
    if (
      !state.journal.destinationParentPreexisting &&
      process.platform !== 'win32' &&
      Number(parent.identity.mode & 0o777n) !== 0o755
    ) {
      runtimePromotionFilesystemFailure(
        'the project OpenSIP directory does not match the authored plan mode',
      );
    }
    if (!state.journal.destinationParentPreexisting) {
      const owner = inspectBoundOwnedMarker(
        state.paths.destinationParentMarker,
        parent.path,
        state.journal,
        'destinationParent',
        'owner',
        null,
      );
      if (owner.status !== 'exact') {
        runtimePromotionFilesystemFailure(
          'the operation-created project OpenSIP directory lost its inode-bound owner',
        );
      }
    }
    return parent;
  } catch (error) {
    closeStablePromotionDirectory(parent);
    throw error;
  }
}

export function assertEmptyPromotionDirectory(path: string): void {
  const directory = opendirSync(path);
  try {
    if (directory.readSync() !== null) {
      runtimePromotionFilesystemFailure('an operation-created directory is not empty');
    }
  } finally {
    directory.closeSync();
  }
}

export function inspectExactRuntimeManifest(
  path: string,
  posture: Extract<RuntimeTreePosture, 'cache-source' | 'project-runtime'>,
  expected: RuntimeManifestIdentity,
): VerifiedRuntimeManifest {
  let manifest: VerifiedRuntimeManifest;
  try {
    manifest = inspectVerifiedRuntimeManifest(path, posture);
  } catch (error) {
    runtimePromotionFilesystemFailure('a runtime tree could not be verified', error);
  }
  if (!runtimeManifestIdentityEqual(manifest.identity, expected)) {
    runtimePromotionFilesystemFailure('a runtime tree does not match its journal manifest');
  }
  return manifest;
}

interface CleanupOwnedRuntimeTreeInput {
  readonly state: RuntimePromotionFilesystemCapabilityState;
  readonly parent: StablePromotionDirectory;
  readonly root: string;
  readonly slot: Exclude<RuntimeFilesystemSlot, 'destinationParent'>;
  readonly expected: RuntimeManifestIdentity;
  readonly externalOwner?: {
    readonly path: string;
    readonly content: string;
  };
  /**
   * Required before the cleanup-start marker is durable. It may validate a
   * complete manifest or a narrowly recoverable incomplete stage.
   */
  readonly verifyBefore: () => void;
}

/**
 * Publish a separate cleanup-start proof before the first recursive unlink.
 * Once durable, it authorizes bounded idempotent continuation of a partial
 * cleanup without pretending the now-incomplete tree still has its old digest.
 */
export function cleanupOwnedRuntimeTree(input: CleanupOwnedRuntimeTreeInput): boolean {
  const artifactBasename = input.state.journal.owned[input.slot].basename;
  const cleanupPath = join(
    input.parent.path,
    runtimePromotionCleanupMarkerBasename(artifactBasename),
  );
  const cleanup = inspectBoundOwnedMarker(
    cleanupPath,
    input.root,
    input.state.journal,
    input.slot,
    'cleanup',
    input.expected,
  );
  if (cleanup.status === 'mismatch') {
    runtimePromotionFilesystemFailure('an owned cleanup marker has a foreign identity');
  }
  let cleanupContent: string;
  let rootIdentity: NonNullable<RuntimePromotionArtifactMarker['rootIdentity']>;
  if (cleanup.status === 'exact') {
    cleanupContent = cleanup.content;
    rootIdentity = cleanup.rootIdentity;
    ensureDurableExactPromotionMarker(
      input.parent,
      cleanupPath,
      cleanupContent,
      input.state.dependencies,
    );
  } else {
    rootIdentity = capturePromotionRootIdentity(input.root);
    cleanupContent = encodedOwnedMarker(
      input.state.journal,
      input.slot,
      'cleanup',
      input.expected,
      rootIdentity,
    );
    input.verifyBefore();
    assertPromotionRootIdentity(input.root, rootIdentity);
    publishPromotionMarker(
      input.parent,
      cleanupPath,
      cleanupContent,
      input.state.dependencies,
      'owned-cleanup-marker-create',
      () => {
        assertPromotionRootIdentity(input.root, rootIdentity);
        input.verifyBefore();
        assertPromotionRootIdentity(input.root, rootIdentity);
      },
    );
  }
  const removed = removeBoundedOwnedTree(
    input.parent,
    input.root,
    input.state.dependencies,
    rootIdentity,
  );
  if (input.externalOwner !== undefined) {
    removeExactPromotionMarker(
      input.parent,
      input.externalOwner.path,
      input.externalOwner.content,
      input.state.dependencies,
    );
  }
  removeExactPromotionMarker(input.parent, cleanupPath, cleanupContent, input.state.dependencies);
  return removed;
}

export function artifactPresence(path: string): 'absent' | 'directory' {
  const classification = classifyRuntimePromotionPath(path);
  if (classification.status === 'absent') return 'absent';
  if (classification.status !== 'directory' || classification.owner !== 'current') {
    runtimePromotionFilesystemFailure('an operation-owned artifact has an unsafe root');
  }
  return 'directory';
}

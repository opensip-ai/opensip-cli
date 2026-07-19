import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { normalizeAuthoredPathMode } from './authored-path-mode.js';
import {
  assertStableAuthoredEntry,
  authoredEntryIdentity,
  authoredTransactionFailure,
  bindStableAuthoredEntry,
  fsyncStableAuthoredDirectory,
  readStableArtifactFile,
  type AuthoredEntryIdentity,
  type StableAuthoredEntry,
} from './authored-state-transaction-fs.js';
import {
  assertPinnedParentAndAncestors,
  assertPinnedTarget,
  closeTargetDescriptor,
  currentDirectoryIdentity,
  entryType,
  openTargetEntry,
  type AuthoredTargetMutationHooks,
  type AuthoredTargetMutationOperation,
  type BoundAuthoredTarget,
  type BoundAuthoredTargetEntry,
} from './authored-state-transaction-target-fs.js';
import { hasErrorCode } from './error-code.js';
import { isWindowsDirectoryHandleFallback } from './runtime-directory-handle-fallback.js';

import type { InitAuthoredPathState } from './init-authored-plan.js';

const FILE_BLOB_DESCRIPTION = 'an authored file blob';
const FILE_TEMPORARY_DESCRIPTION = 'an authored file replacement temporary';

function sameFilesystemObject(left: AuthoredEntryIdentity, right: AuthoredEntryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function assertDirectoryObjectAfterOperation(
  authority: BoundAuthoredTarget,
  expectedObject: AuthoredEntryIdentity,
  mode: number,
  description: string,
): AuthoredEntryIdentity {
  assertPinnedParentAndAncestors(authority);
  const current = currentDirectoryIdentity(authority.path, description);
  if (!sameFilesystemObject(expectedObject, current)) {
    authoredTransactionFailure(`${description} was replaced`);
  }
  const normalizedMode = normalizeAuthoredPathMode(
    current.mode,
    'directory',
    authority.filesystem.platform,
  );
  const expectedMode = normalizeAuthoredPathMode(mode, 'directory', authority.filesystem.platform);
  if (normalizedMode !== expectedMode) {
    authoredTransactionFailure(`${description} has the wrong committed mode`);
  }
  const descriptor = authority.target?.descriptor;
  if (descriptor !== null && descriptor !== undefined) {
    const opened = fstatSync(descriptor, { bigint: true });
    const openedIdentity = authoredEntryIdentity(opened);
    if (
      entryType(opened) !== 'directory' ||
      !sameFilesystemObject(expectedObject, openedIdentity) ||
      normalizeAuthoredPathMode(opened.mode, 'directory', authority.filesystem.platform) !==
        expectedMode
    ) {
      authoredTransactionFailure(`${description} changed through its descriptor`);
    }
  }
  return current;
}

function commitPinnedDirectoryMode(
  authority: BoundAuthoredTarget,
  target: BoundAuthoredTargetEntry,
  mode: number,
  description: string,
): void {
  let pathChmodRequired = target.descriptor === null;
  if (target.descriptor !== null) {
    try {
      authority.filesystem.fchmodDirectory(target.descriptor, mode);
    } catch (error) {
      if (!isWindowsDirectoryHandleFallback(error, authority.filesystem.platform)) {
        authoredTransactionFailure(`${description} mode could not be committed`, error);
      }
      pathChmodRequired = true;
    }
  }
  if (!pathChmodRequired) return;
  const before = currentDirectoryIdentity(authority.path, description);
  if (!sameFilesystemObject(target.identity, before)) {
    authoredTransactionFailure(`${description} was replaced before path chmod`);
  }
  assertPinnedParentAndAncestors(authority);
  try {
    authority.filesystem.chmodDirectoryPath(authority.path, mode);
  } catch (error) {
    authoredTransactionFailure(`${description} mode could not be committed by path`, error);
  }
}

function syncPinnedDirectory(
  authority: BoundAuthoredTarget,
  target: BoundAuthoredTargetEntry,
  description: string,
): void {
  if (target.descriptor === null) return;
  try {
    authority.filesystem.fsyncDirectoryDescriptor(target.descriptor);
  } catch (error) {
    if (!isWindowsDirectoryHandleFallback(error, authority.filesystem.platform)) {
      authoredTransactionFailure(`${description} could not be synced`, error);
    }
  }
}

function finalizePinnedAuthoredDirectory(
  authority: BoundAuthoredTarget,
  target: BoundAuthoredTargetEntry,
  mode: number,
  description: string,
): AuthoredEntryIdentity {
  if (target.type !== 'directory') {
    authoredTransactionFailure(`${description} has the wrong pinned type`);
  }
  commitPinnedDirectoryMode(authority, target, mode, description);
  assertDirectoryObjectAfterOperation(authority, target.identity, mode, description);
  syncPinnedDirectory(authority, target, description);
  return assertDirectoryObjectAfterOperation(authority, target.identity, mode, description);
}

function refreshTarget(
  authority: BoundAuthoredTarget,
  expectedObject?: AuthoredEntryIdentity,
): void {
  const previous = authority.target;
  authority.target = null;
  closeTargetDescriptor(previous);
  authority.target = openTargetEntry(authority.path, authority.filesystem);
  if (
    expectedObject !== undefined &&
    (authority.target === null || !sameFilesystemObject(expectedObject, authority.target.identity))
  ) {
    authoredTransactionFailure('an authored target was replaced during mutation');
  }
  assertPinnedParentAndAncestors(authority);
}

function fsyncPinnedParent(authority: BoundAuthoredTarget): void {
  assertPinnedParentAndAncestors(authority);
  if (authority.parentDescriptor !== null) {
    try {
      authority.filesystem.fsyncDirectoryDescriptor(authority.parentDescriptor);
    } catch (error) {
      if (!isWindowsDirectoryHandleFallback(error, authority.filesystem.platform)) {
        throw error;
      }
    }
  }
  assertPinnedParentAndAncestors(authority);
}

function mutationBoundary(
  authority: BoundAuthoredTarget,
  operation: AuthoredTargetMutationOperation,
  hooks: AuthoredTargetMutationHooks,
): void {
  hooks.beforeFinalMutation?.(operation);
  assertPinnedTarget(authority);
}

function authoredFileTemporaryPath(authority: BoundAuthoredTarget, blobPath: string): string {
  const sourceRootBasename = basename(dirname(dirname(blobPath)));
  const digest = createHash('sha256')
    .update('opensip:init-authored-target-temporary:v1')
    .update('\0')
    .update(sourceRootBasename)
    .update('\0')
    .update(authority.relativePath)
    .digest('hex');
  const temporary = join(authority.parentPath, `.opensip-init-authored-target-${digest}.tmp`);
  if (temporary === authority.path) {
    authoredTransactionFailure('an authored target collides with its replacement temporary');
  }
  return temporary;
}

function optionalStableFile(path: string, description: string): StableAuthoredEntry | null {
  try {
    lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    authoredTransactionFailure(`${description} could not be inspected`, error);
  }
  return bindStableAuthoredEntry(path, 'file', description);
}

function assertAuthoredPathAbsent(path: string, description: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    authoredTransactionFailure(`${description} could not be inspected`, error);
  }
  authoredTransactionFailure(`${description} appeared before mutation`);
}

function assertFileMatchesState(
  path: string,
  expected: InitAuthoredPathState,
  description: string,
): StableAuthoredEntry {
  if (!expected.exists || expected.type !== 'file' || expected.mode === null) {
    authoredTransactionFailure(`${description} has an impossible expected state`);
  }
  const stable = bindStableAuthoredEntry(path, 'file', description);
  const file = readStableArtifactFile(path);
  assertStableAuthoredEntry(stable, description);
  if (file.mode !== expected.mode || file.digest !== expected.digest) {
    authoredTransactionFailure(`${description} does not match its durable authored bytes`);
  }
  return stable;
}

function prepareFileTemporary(
  authority: BoundAuthoredTarget,
  blobPath: string,
  target: InitAuthoredPathState,
  hooks: AuthoredTargetMutationHooks,
): StableAuthoredEntry {
  const temporaryPath = authoredFileTemporaryPath(authority, blobPath);
  const blob = optionalStableFile(blobPath, FILE_BLOB_DESCRIPTION);
  const temporary = optionalStableFile(temporaryPath, FILE_TEMPORARY_DESCRIPTION);
  if (temporary !== null) {
    if (blob !== null) {
      authoredTransactionFailure('an authored file temporary collides with an unconsumed blob');
    }
    return assertFileMatchesState(temporaryPath, target, FILE_TEMPORARY_DESCRIPTION);
  }
  if (blob === null) {
    authoredTransactionFailure('an authored file has neither its blob nor replacement temporary');
  }
  const stableBlob = assertFileMatchesState(blobPath, target, FILE_BLOB_DESCRIPTION);
  const stableBlobParent = bindStableAuthoredEntry(
    dirname(blobPath),
    'directory',
    'the authored blob parent',
  );
  mutationBoundary(authority, 'stage-file-temporary', hooks);
  assertStableAuthoredEntry(stableBlobParent, 'the authored blob parent');
  assertStableAuthoredEntry(stableBlob, FILE_BLOB_DESCRIPTION);
  assertAuthoredPathAbsent(temporaryPath, FILE_TEMPORARY_DESCRIPTION);
  try {
    renameSync(blobPath, temporaryPath);
  } catch (error) {
    authoredTransactionFailure('an authored file temporary could not be staged', error);
  }
  fsyncStableAuthoredDirectory(stableBlobParent, 'the authored blob parent');
  fsyncPinnedParent(authority);
  return assertFileMatchesState(temporaryPath, target, FILE_TEMPORARY_DESCRIPTION);
}

export function settleSatisfiedAuthoredTarget(
  authority: BoundAuthoredTarget,
  blobPath: string | null,
  target: InitAuthoredPathState,
  hooks: AuthoredTargetMutationHooks = {},
): void {
  assertPinnedTarget(authority);
  if (blobPath !== null) {
    const temporaryPath = authoredFileTemporaryPath(authority, blobPath);
    const blob = optionalStableFile(blobPath, FILE_BLOB_DESCRIPTION);
    const temporary = optionalStableFile(temporaryPath, FILE_TEMPORARY_DESCRIPTION);
    if (blob !== null && temporary !== null) {
      authoredTransactionFailure('an authored file temporary collides with an unconsumed blob');
    }
    if (temporary !== null) {
      const exactTemporary = assertFileMatchesState(
        temporaryPath,
        target,
        FILE_TEMPORARY_DESCRIPTION,
      );
      mutationBoundary(authority, 'remove-satisfied-file-temporary', hooks);
      assertStableAuthoredEntry(exactTemporary, FILE_TEMPORARY_DESCRIPTION);
      unlinkSync(temporaryPath);
      fsyncPinnedParent(authority);
      assertAuthoredPathAbsent(temporaryPath, FILE_TEMPORARY_DESCRIPTION);
    }
  }
  fsyncPinnedParent(authority);
  assertPinnedTarget(authority);
}

export function applyAuthoredFile(
  authority: BoundAuthoredTarget,
  blobPath: string,
  target: InitAuthoredPathState,
  hooks: AuthoredTargetMutationHooks = {},
): void {
  const temporary = prepareFileTemporary(authority, blobPath, target, hooks);
  mutationBoundary(authority, 'commit-file', hooks);
  assertStableAuthoredEntry(temporary, FILE_TEMPORARY_DESCRIPTION);
  try {
    renameSync(temporary.path, authority.path);
  } catch (error) {
    authoredTransactionFailure('an authored file could not be committed', error);
  }
  fsyncPinnedParent(authority);
  refreshTarget(authority, temporary.identity);
}

export function applyAuthoredDirectory(
  authority: BoundAuthoredTarget,
  mode: number,
  hooks: AuthoredTargetMutationHooks = {},
): void {
  const current = authority.target;
  if (current !== null) {
    if (current.type !== 'directory') {
      authoredTransactionFailure('a directory target has the wrong pinned type');
    }
    mutationBoundary(authority, 'chmod-directory', hooks);
    const finalized = finalizePinnedAuthoredDirectory(
      authority,
      current,
      mode,
      'an authored directory',
    );
    refreshTarget(authority, finalized);
    return;
  }
  mutationBoundary(authority, 'create-directory', hooks);
  try {
    mkdirSync(authority.path, { recursive: false, mode });
  } catch (error) {
    authoredTransactionFailure('an authored directory could not be created exclusively', error);
  }
  const created = openTargetEntry(authority.path, authority.filesystem);
  if (created?.type !== 'directory') {
    closeTargetDescriptor(created);
    authoredTransactionFailure('a newly created authored directory has the wrong type');
  }
  authority.target = created;
  const createdIdentity = finalizePinnedAuthoredDirectory(
    authority,
    created,
    mode,
    'a newly created authored directory',
  );
  fsyncPinnedParent(authority);
  refreshTarget(authority, createdIdentity);
}

export function removeAuthoredTarget(
  authority: BoundAuthoredTarget,
  type: 'file' | 'directory',
  hooks: AuthoredTargetMutationHooks = {},
): void {
  if (authority.target?.type !== type) {
    authoredTransactionFailure('an authored removal target has the wrong pinned type');
  }
  mutationBoundary(authority, type === 'file' ? 'remove-file' : 'remove-directory', hooks);
  try {
    if (type === 'file') unlinkSync(authority.path);
    else rmdirSync(authority.path);
  } catch (error) {
    authoredTransactionFailure('an authored target could not be removed', error);
  }
  fsyncPinnedParent(authority);
  if (authority.target !== null) {
    if (authority.target.descriptor !== null) closeSync(authority.target.descriptor);
    authority.target = null;
  }
  assertPinnedParentAndAncestors(authority);
  try {
    lstatSync(authority.path);
    authoredTransactionFailure('an authored target remained after removal');
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
}

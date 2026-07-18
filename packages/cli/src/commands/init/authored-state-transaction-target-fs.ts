import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  assertSafeAuthoredOwnerMode,
  assertStableAuthoredEntry,
  assertStableAuthoredRoot,
  authoredEntryIdentity,
  authoredTransactionFailure,
  bindStableAuthoredEntry,
  fsyncStableAuthoredDirectory,
  observeAuthoredPath,
  readStableArtifactFile,
  resolveAuthoredTarget,
  sameAuthoredDirectoryAuthority,
  sameAuthoredEntryIdentity,
  type AuthoredEntryIdentity,
  type StableAuthoredEntry,
  type StableAuthoredRoot,
} from './authored-state-transaction-fs.js';
import { normalizeProjectRelativePath } from './init-authored-plan-types.js';

import type { InitAuthoredPathState } from './init-authored-plan.js';
import type { BigIntStats } from 'node:fs';

interface BoundAuthoredAncestor {
  readonly path: string;
  readonly identity: AuthoredEntryIdentity;
}

interface BoundAuthoredTargetEntry {
  readonly descriptor: number;
  readonly identity: AuthoredEntryIdentity;
  readonly type: 'directory' | 'file';
}

const FILE_BLOB_DESCRIPTION = 'an authored file blob';
const FILE_TEMPORARY_DESCRIPTION = 'an authored file replacement temporary';

/**
 * Attempt-local authority for one authored target. Node does not expose
 * openat(2)/renameat2(2), so path mutations still have an irreducible race
 * after the final check. Holding the parent and target descriptors, and
 * revalidating every path component immediately before each mutation, closes
 * all deterministic checkpoint windows without pretending this is an OS
 * sandbox.
 */
export interface BoundAuthoredTarget {
  readonly root: StableAuthoredRoot;
  readonly relativePath: string;
  readonly path: string;
  readonly parentPath: string;
  readonly parentDescriptor: number;
  readonly parentIdentity: AuthoredEntryIdentity;
  readonly ancestors: readonly BoundAuthoredAncestor[];
  target: BoundAuthoredTargetEntry | null;
}

export type AuthoredTargetMutationOperation =
  | 'stage-file-temporary'
  | 'commit-file'
  | 'remove-satisfied-file-temporary'
  | 'create-directory'
  | 'chmod-directory'
  | 'remove-file'
  | 'remove-directory';

export interface AuthoredTargetMutationHooks {
  /**
   * Test/fault-injection seam. It runs before the final authority check, never
   * after it, so a swap injected here must be rejected before the syscall.
   */
  readonly beforeFinalMutation?: (operation: AuthoredTargetMutationOperation) => void;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function entryType(stat: BigIntStats): 'directory' | 'file' {
  if (stat.isDirectory() && !stat.isSymbolicLink()) return 'directory';
  if (stat.isFile() && !stat.isSymbolicLink()) return 'file';
  authoredTransactionFailure('an authored target has an unsafe or unsupported type');
}

function assertSafeTargetStat(stat: BigIntStats, description: string): void {
  const type = entryType(stat);
  if (type === 'file' && stat.nlink !== 1n) {
    authoredTransactionFailure(`${description} has an unsafe link count`);
  }
  assertSafeAuthoredOwnerMode(stat, description);
}

function openTargetEntry(path: string): BoundAuthoredTargetEntry | null {
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    authoredTransactionFailure('an authored target could not be inspected', error);
  }
  assertSafeTargetStat(before, 'an authored target');
  const type = entryType(before);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (type === 'directory' ? constants.O_DIRECTORY : 0),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    assertSafeTargetStat(opened, 'an opened authored target');
    if (
      entryType(opened) !== type ||
      !sameAuthoredEntryIdentity(authoredEntryIdentity(before), authoredEntryIdentity(opened))
    ) {
      authoredTransactionFailure('an authored target changed while it was pinned');
    }
    return {
      descriptor,
      identity: authoredEntryIdentity(opened),
      type,
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    authoredTransactionFailure('an authored target could not be pinned', error);
  }
}

function openParentDescriptor(path: string, identity: AuthoredEntryIdentity): number {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isDirectory() ||
      opened.isSymbolicLink() ||
      !sameAuthoredDirectoryAuthority(identity, authoredEntryIdentity(opened))
    ) {
      authoredTransactionFailure('an authored target parent changed while it was pinned');
    }
    assertSafeAuthoredOwnerMode(opened, 'an authored target parent');
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    authoredTransactionFailure('an authored target parent could not be pinned', error);
  }
}

function bindAuthoredTarget(root: StableAuthoredRoot, relativePath: string): BoundAuthoredTarget {
  assertStableAuthoredRoot(root);
  const normalized = normalizeProjectRelativePath(relativePath);
  const segments = normalized.split('/');
  const ancestors: BoundAuthoredAncestor[] = [];
  let currentPath = root.path;
  for (const segment of segments.slice(0, -1)) {
    currentPath = join(currentPath, segment);
    let stat: BigIntStats;
    try {
      stat = lstatSync(currentPath, { bigint: true });
    } catch (error) {
      authoredTransactionFailure('an authored target ancestor is missing or unreadable', error);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      authoredTransactionFailure('an authored target ancestor is not a real directory');
    }
    assertSafeAuthoredOwnerMode(stat, 'an authored target ancestor');
    ancestors.push({
      path: currentPath,
      identity: authoredEntryIdentity(stat),
    });
  }
  const parentIdentity = ancestors.at(-1)?.identity ?? root.identity;
  const parentDescriptor = openParentDescriptor(currentPath, parentIdentity);
  const path = resolveAuthoredTarget(root, normalized);
  try {
    return {
      root,
      relativePath: normalized,
      path,
      parentPath: currentPath,
      parentDescriptor,
      parentIdentity,
      ancestors,
      target: openTargetEntry(path),
    };
  } catch (error) {
    closeSync(parentDescriptor);
    throw error;
  }
}

function closeBoundAuthoredTarget(authority: BoundAuthoredTarget): void {
  if (authority.target !== null) closeSync(authority.target.descriptor);
  closeSync(authority.parentDescriptor);
}

function currentDirectoryIdentity(path: string, description: string): AuthoredEntryIdentity {
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    authoredTransactionFailure(`${description} is missing or unreadable`, error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    authoredTransactionFailure(`${description} is no longer a real directory`);
  }
  assertSafeAuthoredOwnerMode(stat, description);
  return authoredEntryIdentity(stat);
}

function assertPinnedParentAndAncestors(authority: BoundAuthoredTarget): void {
  assertStableAuthoredRoot(authority.root);
  for (const ancestor of authority.ancestors) {
    const current = currentDirectoryIdentity(ancestor.path, 'an authored target ancestor');
    if (!sameAuthoredDirectoryAuthority(ancestor.identity, current)) {
      authoredTransactionFailure('an authored target ancestor changed before mutation');
    }
  }
  const openedParent = fstatSync(authority.parentDescriptor, { bigint: true });
  if (
    !openedParent.isDirectory() ||
    openedParent.isSymbolicLink() ||
    !sameAuthoredDirectoryAuthority(authority.parentIdentity, authoredEntryIdentity(openedParent))
  ) {
    authoredTransactionFailure('the pinned authored target parent changed before mutation');
  }
  const pathParent = currentDirectoryIdentity(
    authority.parentPath,
    'the authored target parent path',
  );
  if (!sameAuthoredDirectoryAuthority(authority.parentIdentity, pathParent)) {
    authoredTransactionFailure('the authored target parent path changed before mutation');
  }
}

function assertPinnedTarget(authority: BoundAuthoredTarget): void {
  assertPinnedParentAndAncestors(authority);
  const expected = authority.target;
  let current: BigIntStats;
  try {
    current = lstatSync(authority.path, { bigint: true });
  } catch (error) {
    if (expected === null && hasCode(error, 'ENOENT')) return;
    authoredTransactionFailure('the authored target changed before mutation', error);
  }
  if (expected === null) {
    authoredTransactionFailure('an absent authored target appeared before mutation');
  }
  assertSafeTargetStat(current, 'an authored target');
  if (
    entryType(current) !== expected.type ||
    !sameAuthoredEntryIdentity(expected.identity, authoredEntryIdentity(current))
  ) {
    authoredTransactionFailure('the authored target changed before mutation');
  }
  const opened = fstatSync(expected.descriptor, { bigint: true });
  if (
    entryType(opened) !== expected.type ||
    !sameAuthoredEntryIdentity(expected.identity, authoredEntryIdentity(opened))
  ) {
    authoredTransactionFailure('the pinned authored target changed before mutation');
  }
}

function sameFilesystemObject(left: AuthoredEntryIdentity, right: AuthoredEntryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function refreshTarget(
  authority: BoundAuthoredTarget,
  expectedObject?: AuthoredEntryIdentity,
): void {
  const previous = authority.target;
  authority.target = null;
  if (previous !== null) closeSync(previous.descriptor);
  authority.target = openTargetEntry(authority.path);
  if (
    expectedObject !== undefined &&
    (authority.target === null || !sameFilesystemObject(expectedObject, authority.target.identity))
  ) {
    authoredTransactionFailure('an authored target was replaced during mutation');
  }
  assertPinnedParentAndAncestors(authority);
}

function fsyncPinnedParent(authority: BoundAuthoredTarget): void {
  try {
    fsyncSync(authority.parentDescriptor);
  } catch (error) {
    if (
      process.platform === 'win32' &&
      (hasCode(error, 'EINVAL') || hasCode(error, 'ENOTSUP') || hasCode(error, 'EPERM'))
    ) {
      return;
    }
    throw error;
  }
}

export function observeBoundAuthoredTarget(authority: BoundAuthoredTarget): InitAuthoredPathState {
  assertPinnedTarget(authority);
  const observed = observeAuthoredPath(authority.root, authority.relativePath);
  assertPinnedTarget(authority);
  return observed;
}

export function withBoundAuthoredTarget<T>(
  root: StableAuthoredRoot,
  relativePath: string,
  callback: (authority: BoundAuthoredTarget, current: InitAuthoredPathState) => T,
): T {
  const authority = bindAuthoredTarget(root, relativePath);
  try {
    return callback(authority, observeBoundAuthoredTarget(authority));
  } finally {
    closeBoundAuthoredTarget(authority);
  }
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
    if (hasCode(error, 'ENOENT')) return null;
    authoredTransactionFailure(`${description} could not be inspected`, error);
  }
  return bindStableAuthoredEntry(path, 'file', description);
}

function assertAuthoredPathAbsent(path: string, description: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
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
    try {
      fchmodSync(current.descriptor, mode);
      fsyncSync(current.descriptor);
    } catch (error) {
      authoredTransactionFailure('an authored directory mode could not be committed', error);
    }
    refreshTarget(authority, current.identity);
    return;
  }
  mutationBoundary(authority, 'create-directory', hooks);
  try {
    mkdirSync(authority.path, { recursive: false, mode });
  } catch (error) {
    authoredTransactionFailure('an authored directory could not be created exclusively', error);
  }
  const created = openTargetEntry(authority.path);
  if (created?.type !== 'directory') {
    if (created !== null) closeSync(created.descriptor);
    authoredTransactionFailure('a newly created authored directory has the wrong type');
  }
  let createdIdentity: AuthoredEntryIdentity;
  try {
    fchmodSync(created.descriptor, mode);
    fsyncSync(created.descriptor);
    createdIdentity = authoredEntryIdentity(fstatSync(created.descriptor, { bigint: true }));
  } catch (error) {
    authoredTransactionFailure('a newly created authored directory could not be finalized', error);
  } finally {
    closeSync(created.descriptor);
  }
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
    closeSync(authority.target.descriptor);
    authority.target = null;
  }
  assertPinnedParentAndAncestors(authority);
  try {
    lstatSync(authority.path);
    authoredTransactionFailure('an authored target remained after removal');
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

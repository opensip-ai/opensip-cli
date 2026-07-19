import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  assertSafeAuthoredOwnerMode,
  assertStableAuthoredRoot,
  authoredEntryIdentity,
  authoredTransactionFailure,
  resolveAuthoredTarget,
  sameAuthoredDirectoryAuthority,
  sameAuthoredEntryIdentity,
  type AuthoredEntryIdentity,
  type StableAuthoredRoot,
} from './authored-state-transaction-fs.js';
import { observeAuthoredPath } from './authored-state-transaction-observation.js';
import { hasErrorCode } from './error-code.js';
import { normalizeProjectRelativePath } from './init-authored-plan-types.js';
import { isWindowsDirectoryHandleFallback } from './runtime-directory-handle-fallback.js';

import type { InitAuthoredPathState } from './init-authored-plan.js';
import type { BigIntStats } from 'node:fs';

interface BoundAuthoredAncestor {
  readonly path: string;
  readonly identity: AuthoredEntryIdentity;
}

export interface BoundAuthoredTargetEntry {
  readonly descriptor: number | null;
  readonly identity: AuthoredEntryIdentity;
  readonly type: 'directory' | 'file';
}

export interface AuthoredTargetFilesystemDependencies {
  readonly platform?: NodeJS.Platform;
  readonly open?: (path: string, flags: number) => number;
  readonly chmodDirectoryPath?: (path: string, mode: number) => void;
  readonly fchmodDirectory?: (descriptor: number, mode: number) => void;
  readonly fsyncDirectoryDescriptor?: (descriptor: number) => void;
}

export interface ResolvedAuthoredTargetFilesystemDependencies {
  readonly platform: NodeJS.Platform;
  readonly open: (path: string, flags: number) => number;
  readonly chmodDirectoryPath: (path: string, mode: number) => void;
  readonly fchmodDirectory: (descriptor: number, mode: number) => void;
  readonly fsyncDirectoryDescriptor: (descriptor: number) => void;
}

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
  readonly parentDescriptor: number | null;
  readonly parentIdentity: AuthoredEntryIdentity;
  readonly ancestors: readonly BoundAuthoredAncestor[];
  readonly filesystem: ResolvedAuthoredTargetFilesystemDependencies;
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

export function entryType(stat: BigIntStats): 'directory' | 'file' {
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

function resolveFilesystemDependencies(
  dependencies: AuthoredTargetFilesystemDependencies,
): ResolvedAuthoredTargetFilesystemDependencies {
  return {
    platform: dependencies.platform ?? process.platform,
    open: dependencies.open ?? openSync,
    chmodDirectoryPath: dependencies.chmodDirectoryPath ?? chmodSync,
    fchmodDirectory: dependencies.fchmodDirectory ?? fchmodSync,
    fsyncDirectoryDescriptor: dependencies.fsyncDirectoryDescriptor ?? fsyncSync,
  };
}

function bindWindowsDirectoryTargetFallback(
  path: string,
  before: BigIntStats,
): BoundAuthoredTargetEntry {
  let after: BigIntStats;
  try {
    after = lstatSync(path, { bigint: true });
  } catch (error) {
    authoredTransactionFailure(
      'an authored directory target changed during Windows handle fallback',
      error,
    );
  }
  assertSafeTargetStat(after, 'an authored directory target');
  if (
    entryType(after) !== 'directory' ||
    !sameAuthoredEntryIdentity(authoredEntryIdentity(before), authoredEntryIdentity(after))
  ) {
    authoredTransactionFailure(
      'an authored directory target changed during Windows handle fallback',
    );
  }
  return {
    descriptor: null,
    identity: authoredEntryIdentity(after),
    type: 'directory',
  };
}

export function openTargetEntry(
  path: string,
  filesystem: ResolvedAuthoredTargetFilesystemDependencies,
): BoundAuthoredTargetEntry | null {
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    authoredTransactionFailure('an authored target could not be inspected', error);
  }
  assertSafeTargetStat(before, 'an authored target');
  const type = entryType(before);
  let descriptor: number | undefined;
  try {
    descriptor = filesystem.open(
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
    const openFailed = descriptor === undefined;
    if (descriptor !== undefined) closeSync(descriptor);
    if (
      openFailed &&
      type === 'directory' &&
      isWindowsDirectoryHandleFallback(error, filesystem.platform)
    ) {
      return bindWindowsDirectoryTargetFallback(path, before);
    }
    authoredTransactionFailure('an authored target could not be pinned', error);
  }
}

function openParentDescriptor(
  path: string,
  identity: AuthoredEntryIdentity,
  filesystem: ResolvedAuthoredTargetFilesystemDependencies,
): number | null {
  let descriptor: number | undefined;
  try {
    descriptor = filesystem.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
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
    const openFailed = descriptor === undefined;
    if (descriptor !== undefined) closeSync(descriptor);
    if (openFailed && isWindowsDirectoryHandleFallback(error, filesystem.platform)) {
      const after = currentDirectoryIdentity(path, 'an authored target parent');
      if (!sameAuthoredDirectoryAuthority(identity, after)) {
        authoredTransactionFailure(
          'an authored target parent changed during Windows handle fallback',
        );
      }
      return null;
    }
    authoredTransactionFailure('an authored target parent could not be pinned', error);
  }
}

function bindAuthoredTarget(
  root: StableAuthoredRoot,
  relativePath: string,
  dependencies: AuthoredTargetFilesystemDependencies,
): BoundAuthoredTarget {
  const filesystem = resolveFilesystemDependencies(dependencies);
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
  const parentDescriptor = openParentDescriptor(currentPath, parentIdentity, filesystem);
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
      filesystem,
      target: openTargetEntry(path, filesystem),
    };
  } catch (error) {
    if (parentDescriptor !== null) closeSync(parentDescriptor);
    throw error;
  }
}

function closeBoundAuthoredTarget(authority: BoundAuthoredTarget): void {
  closeTargetDescriptor(authority.target);
  if (authority.parentDescriptor !== null) closeSync(authority.parentDescriptor);
}

export function closeTargetDescriptor(target: BoundAuthoredTargetEntry | null): void {
  if (target?.descriptor !== null && target !== null) closeSync(target.descriptor);
}

export function currentDirectoryIdentity(path: string, description: string): AuthoredEntryIdentity {
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

export function assertPinnedParentAndAncestors(authority: BoundAuthoredTarget): void {
  assertStableAuthoredRoot(authority.root);
  for (const ancestor of authority.ancestors) {
    const current = currentDirectoryIdentity(ancestor.path, 'an authored target ancestor');
    if (!sameAuthoredDirectoryAuthority(ancestor.identity, current)) {
      authoredTransactionFailure('an authored target ancestor changed before mutation');
    }
  }
  if (authority.parentDescriptor !== null) {
    const openedParent = fstatSync(authority.parentDescriptor, { bigint: true });
    if (
      !openedParent.isDirectory() ||
      openedParent.isSymbolicLink() ||
      !sameAuthoredDirectoryAuthority(authority.parentIdentity, authoredEntryIdentity(openedParent))
    ) {
      authoredTransactionFailure('the pinned authored target parent changed before mutation');
    }
  }
  const pathParent = currentDirectoryIdentity(
    authority.parentPath,
    'the authored target parent path',
  );
  if (!sameAuthoredDirectoryAuthority(authority.parentIdentity, pathParent)) {
    authoredTransactionFailure('the authored target parent path changed before mutation');
  }
}

export function assertPinnedTarget(authority: BoundAuthoredTarget): void {
  assertPinnedParentAndAncestors(authority);
  const expected = authority.target;
  let current: BigIntStats;
  try {
    current = lstatSync(authority.path, { bigint: true });
  } catch (error) {
    if (expected === null && hasErrorCode(error, 'ENOENT')) return;
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
  if (expected.descriptor !== null) {
    const opened = fstatSync(expected.descriptor, { bigint: true });
    if (
      entryType(opened) !== expected.type ||
      !sameAuthoredEntryIdentity(expected.identity, authoredEntryIdentity(opened))
    ) {
      authoredTransactionFailure('the pinned authored target changed before mutation');
    }
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
  dependencies: AuthoredTargetFilesystemDependencies = {},
): T {
  const authority = bindAuthoredTarget(root, relativePath, dependencies);
  try {
    return callback(authority, observeBoundAuthoredTarget(authority));
  } finally {
    closeBoundAuthoredTarget(authority);
  }
}

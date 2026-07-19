import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  realpathSync,
  renameSync,
  rmdirSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { isWindowsDirectoryHandleFallback } from './runtime-directory-handle-fallback.js';
import {
  assertPromotionPathIdentity,
  assertPromotionRootIdentity,
  assertSafePromotionDirectory,
  capturePromotionPathIdentity,
  classifyRuntimePromotionPath,
  promotionIdentityOf,
  runtimePromotionFilesystemFailure,
  samePromotionDirectoryAuthority,
  samePromotionDirectoryObject,
  samePromotionEntryIdentity,
  type PromotionEntryIdentity,
} from './runtime-promotion-filesystem-identity.js';

import type {
  RuntimePromotionArtifactMarker,
  RuntimePromotionFilesystemDependencies,
  RuntimePromotionFilesystemMutation,
} from './runtime-promotion-filesystem-types.js';
import type { BigIntStats } from 'node:fs';

export * from './runtime-promotion-filesystem-identity.js';

const OPERATION_CREATED_DIRECTORY = 'an operation-created directory';

export interface StablePromotionDirectory {
  readonly path: string;
  readonly identity: PromotionEntryIdentity;
  readonly descriptor?: number;
}

export function promotionFilesystemCheckpoint(
  dependencies: RuntimePromotionFilesystemDependencies,
  boundary: 'before' | 'after',
  effect: 'mutation' | 'fsync',
  operation: RuntimePromotionFilesystemMutation | 'file' | 'directory',
): void {
  dependencies.checkpoint?.({ boundary, effect, operation });
}

export function withPromotionMutation<T>(
  dependencies: RuntimePromotionFilesystemDependencies,
  operation: RuntimePromotionFilesystemMutation,
  mutation: () => T,
): T {
  promotionFilesystemCheckpoint(dependencies, 'before', 'mutation', operation);
  const result = mutation();
  promotionFilesystemCheckpoint(dependencies, 'after', 'mutation', operation);
  return result;
}

export function openStablePromotionDirectory(
  requestedPath: string,
  description: string,
): StablePromotionDirectory {
  const requested = resolve(requestedPath);
  let requestedStat: BigIntStats;
  try {
    requestedStat = lstatSync(requested, { bigint: true });
  } catch (error) {
    runtimePromotionFilesystemFailure(`${description} could not be opened`, error);
  }
  assertSafePromotionDirectory(requestedStat, description);
  const canonical = realpathSync(requested);
  const canonicalStat = lstatSync(canonical, { bigint: true });
  if (
    !samePromotionEntryIdentity(
      promotionIdentityOf(requestedStat),
      promotionIdentityOf(canonicalStat),
    )
  ) {
    runtimePromotionFilesystemFailure(`${description} changed while it was opened`);
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      canonical,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    assertSafePromotionDirectory(opened, description);
    if (
      !samePromotionEntryIdentity(promotionIdentityOf(canonicalStat), promotionIdentityOf(opened))
    ) {
      runtimePromotionFilesystemFailure(`${description} changed while its handle was opened`);
    }
  } catch (error) {
    if (!isWindowsDirectoryHandleFallback(error)) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error;
    }
    if (descriptor !== undefined) closeSync(descriptor);
    descriptor = undefined;
  }
  return {
    path: canonical,
    identity: promotionIdentityOf(canonicalStat),
    descriptor,
  };
}

export function assertStablePromotionDirectory(
  directory: StablePromotionDirectory,
  description: string,
): void {
  let current: BigIntStats;
  try {
    current = lstatSync(directory.path, { bigint: true });
  } catch (error) {
    runtimePromotionFilesystemFailure(`${description} disappeared`, error);
  }
  assertSafePromotionDirectory(current, description);
  if (!samePromotionDirectoryAuthority(directory.identity, promotionIdentityOf(current))) {
    runtimePromotionFilesystemFailure(`${description} was replaced`);
  }
  if (directory.descriptor === undefined) return;
  const opened = fstatSync(directory.descriptor, { bigint: true });
  if (!samePromotionDirectoryAuthority(directory.identity, promotionIdentityOf(opened))) {
    runtimePromotionFilesystemFailure(`${description} handle was replaced`);
  }
}

export function closeStablePromotionDirectory(directory: StablePromotionDirectory): void {
  if (directory.descriptor !== undefined) closeSync(directory.descriptor);
}

/**
 * Scope one stable directory handle so a later open or callback failure cannot
 * strand its descriptor.
 */
export function withStablePromotionDirectory<T>(
  requestedPath: string,
  description: string,
  use: (directory: StablePromotionDirectory) => T,
): T {
  const directory = openStablePromotionDirectory(requestedPath, description);
  return withOpenedStablePromotionDirectory(directory, use);
}

export function withOpenedStablePromotionDirectory<T>(
  directory: StablePromotionDirectory,
  use: (directory: StablePromotionDirectory) => T,
): T {
  try {
    return use(directory);
  } finally {
    closeStablePromotionDirectory(directory);
  }
}

export function fsyncPromotionDirectory(
  directory: StablePromotionDirectory,
  dependencies: RuntimePromotionFilesystemDependencies,
): void {
  assertStablePromotionDirectory(directory, 'a promotion directory');
  promotionFilesystemCheckpoint(dependencies, 'before', 'fsync', 'directory');
  if (directory.descriptor === undefined) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        directory.path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      fsyncSync(descriptor);
    } catch (error) {
      if (!isWindowsDirectoryHandleFallback(error)) {
        throw error;
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  } else {
    fsyncSync(directory.descriptor);
  }
  promotionFilesystemCheckpoint(dependencies, 'after', 'fsync', 'directory');
  assertStablePromotionDirectory(directory, 'a promotion directory');
}

/**
 * Create a private direct child and return an inode-bound handle before the
 * after-mutation checkpoint can expose a deterministic replacement window.
 */
export function createStableExactPromotionDirectory(
  parent: StablePromotionDirectory,
  path: string,
  dependencies: RuntimePromotionFilesystemDependencies,
  initialize?: (directory: StablePromotionDirectory) => void,
): StablePromotionDirectory {
  if (dirname(path) !== parent.path) {
    runtimePromotionFilesystemFailure('a created directory is not a direct child');
  }
  promotionFilesystemCheckpoint(dependencies, 'before', 'mutation', 'destination-parent-mkdir');
  let directory: StablePromotionDirectory | undefined;
  try {
    assertStablePromotionDirectory(parent, 'a created directory parent');
    if (classifyRuntimePromotionPath(path).status !== 'absent') {
      runtimePromotionFilesystemFailure('a created directory path is no longer absent');
    }
    mkdirSync(path, { recursive: false, mode: 0o700 });
    directory = openStablePromotionDirectory(path, OPERATION_CREATED_DIRECTORY);
    assertStablePromotionDirectory(parent, 'a created directory parent');
    initialize?.(directory);
    assertStablePromotionDirectory(parent, 'a created directory parent');
    assertStablePromotionDirectory(directory, OPERATION_CREATED_DIRECTORY);
    promotionFilesystemCheckpoint(dependencies, 'after', 'mutation', 'destination-parent-mkdir');
    assertStablePromotionDirectory(parent, 'a created directory parent');
    assertStablePromotionDirectory(directory, OPERATION_CREATED_DIRECTORY);
    return directory;
  } catch (error) {
    if (directory !== undefined) closeStablePromotionDirectory(directory);
    throw error;
  }
}

/**
 * Complete a private-mkdir → authored-mode transition while retaining the
 * already-bound directory handle. The returned snapshot owns the same
 * descriptor and reflects the intentional mode change.
 */
export function finalizeStablePromotionDirectoryMode(
  parent: StablePromotionDirectory,
  directory: StablePromotionDirectory,
  finalMode: number,
  dependencies: RuntimePromotionFilesystemDependencies,
): StablePromotionDirectory {
  if (dirname(directory.path) !== parent.path) {
    runtimePromotionFilesystemFailure('a finalized directory is not a direct child');
  }
  const initialMode = Number(directory.identity.mode & 0o777n);
  if (initialMode !== 0o700 && initialMode !== finalMode) {
    runtimePromotionFilesystemFailure('an operation-created directory has an unexpected mode');
  }
  if (initialMode === finalMode) {
    fsyncPromotionDirectory(directory, dependencies);
    fsyncPromotionDirectory(parent, dependencies);
    return directory;
  }
  withPromotionMutation(dependencies, 'destination-parent-chmod', () => {
    assertStablePromotionDirectory(parent, 'an operation-created directory parent');
    assertStablePromotionDirectory(directory, OPERATION_CREATED_DIRECTORY);
    if (directory.descriptor === undefined) chmodSync(directory.path, finalMode);
    else fchmodSync(directory.descriptor, finalMode);
  });
  const observed =
    directory.descriptor === undefined
      ? capturePromotionPathIdentity(directory.path, 'a finalized operation-created directory')
      : promotionIdentityOf(fstatSync(directory.descriptor, { bigint: true }));
  if (
    !samePromotionDirectoryObject(directory.identity, observed) ||
    Number(observed.mode & 0o777n) !== finalMode
  ) {
    runtimePromotionFilesystemFailure('the finalized operation-created directory changed identity');
  }
  const finalized: StablePromotionDirectory = {
    path: directory.path,
    identity: observed,
    ...(directory.descriptor === undefined ? {} : { descriptor: directory.descriptor }),
  };
  fsyncPromotionDirectory(finalized, dependencies);
  fsyncPromotionDirectory(parent, dependencies);
  return finalized;
}

export function renamePromotionEntry(
  parent: StablePromotionDirectory,
  source: string,
  destination: string,
  dependencies: RuntimePromotionFilesystemDependencies,
  operation: RuntimePromotionFilesystemMutation,
  revalidateSource: () => void,
): void {
  if (dirname(source) !== parent.path || dirname(destination) !== parent.path) {
    runtimePromotionFilesystemFailure('a promotion rename is not same-parent');
  }
  assertStablePromotionDirectory(parent, 'a promotion rename parent');
  const sourceIdentity = capturePromotionPathIdentity(source, 'a promotion rename source');
  if (classifyRuntimePromotionPath(destination).status !== 'absent') {
    runtimePromotionFilesystemFailure('a promotion rename destination is no longer absent');
  }
  withPromotionMutation(dependencies, operation, () => {
    assertStablePromotionDirectory(parent, 'a promotion rename parent');
    assertPromotionPathIdentity(source, sourceIdentity, 'a promotion rename source');
    if (classifyRuntimePromotionPath(destination).status !== 'absent') {
      runtimePromotionFilesystemFailure('a promotion rename destination is no longer absent');
    }
    revalidateSource();
    assertPromotionPathIdentity(source, sourceIdentity, 'a promotion rename source');
    renameSync(source, destination);
  });
  fsyncPromotionDirectory(parent, dependencies);
}

export function removeEmptyPromotionDirectory(
  parent: StablePromotionDirectory,
  path: string,
  dependencies: RuntimePromotionFilesystemDependencies,
  operation: RuntimePromotionFilesystemMutation,
  boundRootIdentity?: NonNullable<RuntimePromotionArtifactMarker['rootIdentity']>,
): void {
  if (dirname(path) !== parent.path) {
    runtimePromotionFilesystemFailure('a removed directory is not a direct child');
  }
  const directory = openStablePromotionDirectory(path, OPERATION_CREATED_DIRECTORY);
  const observedRootIdentity: NonNullable<RuntimePromotionArtifactMarker['rootIdentity']> = {
    device: directory.identity.dev.toString(),
    inode: directory.identity.ino.toString(),
  };
  if (
    boundRootIdentity !== undefined &&
    (boundRootIdentity.device !== observedRootIdentity.device ||
      boundRootIdentity.inode !== observedRootIdentity.inode)
  ) {
    closeStablePromotionDirectory(directory);
    runtimePromotionFilesystemFailure('an operation-created directory was replaced');
  }
  try {
    const scan = opendirSync(directory.path);
    try {
      if (scan.readSync() !== null) {
        runtimePromotionFilesystemFailure('an operation-created directory is not empty');
      }
    } finally {
      scan.closeSync();
    }
  } finally {
    closeStablePromotionDirectory(directory);
  }
  promotionFilesystemCheckpoint(dependencies, 'before', 'mutation', operation);
  assertStablePromotionDirectory(parent, 'an operation-created directory parent');
  assertPromotionRootIdentity(path, observedRootIdentity);
  rmdirSync(path);
  promotionFilesystemCheckpoint(dependencies, 'after', 'mutation', operation);
  fsyncPromotionDirectory(parent, dependencies);
}

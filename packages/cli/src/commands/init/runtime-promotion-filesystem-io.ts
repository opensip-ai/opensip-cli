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

import { SystemError } from '@opensip-cli/core';

import { isWindowsDirectoryHandleFallback } from './runtime-directory-handle-fallback.js';
import { isRuntimeManifestReleaseUnsafe } from './runtime-manifest-model.js';

import type {
  RuntimePromotionArtifactMarker,
  RuntimePromotionFilesystemDependencies,
  RuntimePromotionFilesystemMutation,
  RuntimePromotionPathClassification,
} from './runtime-promotion-filesystem-types.js';
import type { BigIntStats } from 'node:fs';

const FILESYSTEM_ERROR_CODE = 'SYSTEM.INIT.RUNTIME_PROMOTION_FILESYSTEM';
const OPERATION_CREATED_DIRECTORY = 'an operation-created directory';

export interface PromotionEntryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface StablePromotionDirectory {
  readonly path: string;
  readonly identity: PromotionEntryIdentity;
  readonly descriptor?: number;
}

export function runtimePromotionFilesystemFailure(message: string, cause?: unknown): never {
  // Do not erase the native-handle release disposition behind a generic
  // filesystem wrapper. The orchestration boundary must see this exact typed
  // failure and retain its process-owned lease.
  if (isRuntimeManifestReleaseUnsafe(cause)) throw cause;
  throw new SystemError(`Init runtime promotion filesystem failed: ${message}`, {
    code: FILESYSTEM_ERROR_CODE,
    ...(cause === undefined ? {} : { cause }),
  });
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export function promotionCurrentUid(): bigint | undefined {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
}

export function promotionIdentityOf(stat: BigIntStats): PromotionEntryIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

export function samePromotionEntryIdentity(
  left: PromotionEntryIdentity,
  right: PromotionEntryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameDirectoryAuthority(
  left: PromotionEntryIdentity,
  right: PromotionEntryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode
  );
}

function sameDirectoryObject(left: PromotionEntryIdentity, right: PromotionEntryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

export function capturePromotionPathIdentity(
  path: string,
  description: string,
): PromotionEntryIdentity {
  try {
    return promotionIdentityOf(lstatSync(path, { bigint: true }));
  } catch (error) {
    runtimePromotionFilesystemFailure(`${description} could not be observed`, error);
  }
}

export function assertPromotionPathIdentity(
  path: string,
  expected: PromotionEntryIdentity,
  description: string,
): void {
  const observed = capturePromotionPathIdentity(path, description);
  if (!samePromotionEntryIdentity(expected, observed)) {
    runtimePromotionFilesystemFailure(`${description} was replaced or changed`);
  }
}

export function assertPromotionDirectoryObjectIdentity(
  path: string,
  expected: PromotionEntryIdentity,
  description: string,
): void {
  const observed = capturePromotionPathIdentity(path, description);
  if (!sameDirectoryObject(expected, observed)) {
    runtimePromotionFilesystemFailure(`${description} was replaced`);
  }
}

export function assertPromotionCurrentOwner(stat: BigIntStats, description: string): void {
  const uid = promotionCurrentUid();
  if (uid !== undefined && stat.uid !== uid) {
    runtimePromotionFilesystemFailure(`${description} is not owned by the current user`);
  }
}

function assertSafeDirectory(stat: BigIntStats, description: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    runtimePromotionFilesystemFailure(`${description} is not a real directory`);
  }
  assertPromotionCurrentOwner(stat, description);
  const mode = Number(stat.mode & 0o7777n);
  if (
    process.platform !== 'win32' &&
    ((mode & 0o7000) !== 0 || (mode & 0o022) !== 0 || (mode & 0o700) !== 0o700)
  ) {
    runtimePromotionFilesystemFailure(`${description} has an unsafe mode`);
  }
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

export function classifyRuntimePromotionPath(path: string): RuntimePromotionPathClassification {
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { status: 'absent' };
    runtimePromotionFilesystemFailure('a filesystem path could not be classified', error);
  }
  if (stat.isSymbolicLink()) return { status: 'symlink' };
  const uid = promotionCurrentUid();
  const owner = uid === undefined || stat.uid === uid ? ('current' as const) : ('unknown' as const);
  const mode = Number(stat.mode & 0o777n);
  if (stat.isDirectory()) return { status: 'directory', mode, owner };
  if (stat.isFile()) return { status: 'file', mode, links: Number(stat.nlink), owner };
  return { status: 'special' };
}

export function capturePromotionRootIdentity(
  path: string,
): NonNullable<RuntimePromotionArtifactMarker['rootIdentity']> {
  const stat = lstatSync(path, { bigint: true });
  assertSafeDirectory(stat, 'an operation-owned root');
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

export function assertPromotionRootIdentity(
  path: string,
  expected: NonNullable<RuntimePromotionArtifactMarker['rootIdentity']>,
): void {
  const observed = capturePromotionRootIdentity(path);
  if (observed.device !== expected.device || observed.inode !== expected.inode) {
    runtimePromotionFilesystemFailure('an operation-owned root was replaced');
  }
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
  assertSafeDirectory(requestedStat, description);
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
    assertSafeDirectory(opened, description);
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
  assertSafeDirectory(current, description);
  if (!sameDirectoryAuthority(directory.identity, promotionIdentityOf(current))) {
    runtimePromotionFilesystemFailure(`${description} was replaced`);
  }
  if (directory.descriptor === undefined) return;
  const opened = fstatSync(directory.descriptor, { bigint: true });
  if (!sameDirectoryAuthority(directory.identity, promotionIdentityOf(opened))) {
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
    !sameDirectoryObject(directory.identity, observed) ||
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

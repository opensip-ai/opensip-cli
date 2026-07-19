import { lstatSync } from 'node:fs';

import { SystemError } from '@opensip-cli/core';

import { hasErrorCode } from './error-code.js';
import { isRuntimeManifestReleaseUnsafe } from './runtime-manifest-model.js';

import type {
  RuntimePromotionArtifactMarker,
  RuntimePromotionPathClassification,
} from './runtime-promotion-filesystem-types.js';
import type { BigIntStats } from 'node:fs';

const FILESYSTEM_ERROR_CODE = 'SYSTEM.INIT.RUNTIME_PROMOTION_FILESYSTEM';

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

/** @throws {SystemError} Always; constructs the canonical runtime-promotion filesystem failure. */
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

export function samePromotionDirectoryAuthority(
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

export function samePromotionDirectoryObject(
  left: PromotionEntryIdentity,
  right: PromotionEntryIdentity,
): boolean {
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
  if (!samePromotionDirectoryObject(expected, observed)) {
    runtimePromotionFilesystemFailure(`${description} was replaced`);
  }
}

export function assertPromotionCurrentOwner(stat: BigIntStats, description: string): void {
  const uid = promotionCurrentUid();
  if (uid !== undefined && stat.uid !== uid) {
    runtimePromotionFilesystemFailure(`${description} is not owned by the current user`);
  }
}

export function assertSafePromotionDirectory(stat: BigIntStats, description: string): void {
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

export function classifyRuntimePromotionPath(path: string): RuntimePromotionPathClassification {
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { status: 'absent' };
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
  assertSafePromotionDirectory(stat, 'an operation-owned root');
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

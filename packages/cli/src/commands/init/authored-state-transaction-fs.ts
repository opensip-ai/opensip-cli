import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { projectCoordinationKey, SystemError } from '@opensip-cli/core';

import { normalizeAuthoredPathMode } from './authored-path-mode.js';
import { hasErrorCode } from './error-code.js';
import {
  INIT_AUTHORED_PLAN_CAPS,
  normalizeProjectRelativePath,
} from './init-authored-plan-types.js';
import { isPathContained } from './path-containment.js';
import { isWindowsDirectoryHandleFallback } from './runtime-directory-handle-fallback.js';

import type { RuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';
import type { BigIntStats } from 'node:fs';

const READ_CHUNK_BYTES = 64 * 1024;
const ERROR_CODE = 'SYSTEM.INIT.AUTHORED_TRANSACTION';

export interface AuthoredEntryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface StableAuthoredRoot {
  readonly path: string;
  readonly identity: AuthoredEntryIdentity;
}

export interface StableAuthoredEntry {
  readonly path: string;
  readonly type: 'directory' | 'file';
  readonly identity: AuthoredEntryIdentity;
}

export type DurableFileWriteCheckpoint = 'opened' | 'partial-written' | 'fsynced';

export function readBoundedAuthoredDirectory(
  path: string,
  maxEntries: number,
  maxNameBytes: number,
  description: string,
): readonly string[] {
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 0 ||
    !Number.isSafeInteger(maxNameBytes) ||
    maxNameBytes < 0
  ) {
    authoredTransactionFailure(`${description} has invalid scan bounds`);
  }
  const directory = opendirSync(path);
  const entries: string[] = [];
  let nameBytes = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) return entries;
      entries.push(entry.name);
      nameBytes += Buffer.byteLength(entry.name, 'utf8');
      if (entries.length > maxEntries || nameBytes > maxNameBytes) {
        authoredTransactionFailure(`${description} exceeds its entry bound`);
      }
    }
  } finally {
    directory.closeSync();
  }
}

export function authoredTransactionFailure(message: string, cause?: unknown): never {
  throw new SystemError(`Init authored transaction failed: ${message}`, {
    code: ERROR_CODE,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function authoredEntryIdentity(stat: BigIntStats): AuthoredEntryIdentity {
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

export function sameAuthoredEntryIdentity(
  left: AuthoredEntryIdentity,
  right: AuthoredEntryIdentity,
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

export function sameAuthoredDirectoryAuthority(
  left: AuthoredEntryIdentity,
  right: AuthoredEntryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode
  );
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
}

export function assertSafeAuthoredOwnerMode(stat: BigIntStats, field: string): void {
  const uid = currentUid();
  const mode = Number(stat.mode & 0o7777n);
  if (uid !== undefined && stat.uid !== uid) {
    authoredTransactionFailure(`${field} is not owned by the current user`);
  }
  // Scoped group-controlled posture: the uid check above pins ownership, so
  // group-write (umask 002 layout) is accepted; other-write and special bits
  // remain hard refusals (matches isSafeAuthoredPathMode).
  if (process.platform !== 'win32' && ((mode & 0o7000) !== 0 || (mode & 0o002) !== 0)) {
    authoredTransactionFailure(`${field} has an unsafe mode`);
  }
}

export function openStableAuthoredRoot(projectRoot: string): StableAuthoredRoot {
  const requested = resolve(projectRoot);
  let requestedStat: BigIntStats;
  try {
    requestedStat = lstatSync(requested, { bigint: true });
  } catch (error) {
    authoredTransactionFailure('the project root is unreadable', error);
  }
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    authoredTransactionFailure('the project root must be a real directory');
  }
  assertSafeAuthoredOwnerMode(requestedStat, 'the project root');
  const canonical = realpathSync(requested);
  const canonicalStat = lstatSync(canonical, { bigint: true });
  if (
    !sameAuthoredEntryIdentity(
      authoredEntryIdentity(requestedStat),
      authoredEntryIdentity(canonicalStat),
    )
  ) {
    authoredTransactionFailure('the project root changed while it was opened');
  }
  return { path: canonical, identity: authoredEntryIdentity(canonicalStat) };
}

export function assertStableAuthoredRoot(root: StableAuthoredRoot): void {
  const current = lstatSync(root.path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameAuthoredDirectoryAuthority(root.identity, authoredEntryIdentity(current))
  ) {
    authoredTransactionFailure('the project root changed during the transaction');
  }
  assertSafeAuthoredOwnerMode(current, 'the project root');
}

export function bindStableAuthoredEntry(
  path: string,
  type: StableAuthoredEntry['type'],
  description: string,
): StableAuthoredEntry {
  const stat = lstatSync(path, { bigint: true });
  const validType = type === 'directory' ? stat.isDirectory() : stat.isFile();
  if (!validType || stat.isSymbolicLink() || (type === 'file' && stat.nlink !== 1n)) {
    authoredTransactionFailure(`${description} has an unsafe type or link count`);
  }
  assertSafeAuthoredOwnerMode(stat, description);
  return { path, type, identity: authoredEntryIdentity(stat) };
}

export function assertStableAuthoredEntry(entry: StableAuthoredEntry, description: string): void {
  let current: BigIntStats;
  try {
    current = lstatSync(entry.path, { bigint: true });
  } catch (error) {
    authoredTransactionFailure(`${description} changed while it was being removed`, error);
  }
  const validType = entry.type === 'directory' ? current.isDirectory() : current.isFile();
  const sameEntry =
    entry.type === 'directory'
      ? sameAuthoredDirectoryAuthority(entry.identity, authoredEntryIdentity(current))
      : sameAuthoredEntryIdentity(entry.identity, authoredEntryIdentity(current));
  if (
    !validType ||
    current.isSymbolicLink() ||
    (entry.type === 'file' && current.nlink !== 1n) ||
    !sameEntry
  ) {
    authoredTransactionFailure(`${description} changed while it was being removed`);
  }
  assertSafeAuthoredOwnerMode(current, description);
}

function fsyncStableDirectoryAuthority(
  path: string,
  identity: AuthoredEntryIdentity,
  description: string,
): void {
  const assertPathAuthority = (): void => {
    const current = lstatSync(path, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameAuthoredDirectoryAuthority(identity, authoredEntryIdentity(current))
    ) {
      authoredTransactionFailure(`${description} path changed while it was synced`);
    }
    assertSafeAuthoredOwnerMode(current, description);
  };
  assertPathAuthority();
  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (!isWindowsDirectoryHandleFallback(error)) throw error;
      assertPathAuthority();
      return;
    }
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isDirectory() ||
      opened.isSymbolicLink() ||
      !sameAuthoredDirectoryAuthority(identity, authoredEntryIdentity(opened))
    ) {
      authoredTransactionFailure(`${description} changed before it was synced`);
    }
    try {
      fsyncSync(descriptor);
    } catch (error) {
      if (!isWindowsDirectoryHandleFallback(error)) throw error;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameAuthoredDirectoryAuthority(identity, authoredEntryIdentity(after))) {
      authoredTransactionFailure(`${description} changed while it was synced`);
    }
    assertPathAuthority();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function fsyncStableAuthoredRoot(root: StableAuthoredRoot): void {
  fsyncStableDirectoryAuthority(root.path, root.identity, 'the project root');
}

export function fsyncStableAuthoredDirectory(
  directory: StableAuthoredEntry,
  description: string,
): void {
  if (directory.type !== 'directory') {
    authoredTransactionFailure(`${description} is not a directory authority`);
  }
  fsyncStableDirectoryAuthority(directory.path, directory.identity, description);
}

export function assertAuthoredRootMatchesPromotionAuthority(
  root: StableAuthoredRoot,
  authority: RuntimePromotionProjectRootAuthority,
): void {
  if (
    root.path !== authority.projectRoot ||
    root.identity.dev.toString() !== authority.identity.dev ||
    root.identity.ino.toString() !== authority.identity.ino ||
    root.identity.uid.toString() !== authority.identity.uid ||
    root.identity.mode.toString() !== authority.identity.mode
  ) {
    authoredTransactionFailure('the project root does not match its promotion authority');
  }
}

/** Bind one transaction handle to the canonical root selected by its lease. */
export function bindStableAuthoredRoot(
  projectRoot: string,
  coordinationKey: string,
): StableAuthoredRoot {
  const root = openStableAuthoredRoot(projectRoot);
  if (projectCoordinationKey(root.path) !== coordinationKey) {
    authoredTransactionFailure('the project root does not match the journal coordination key');
  }
  return root;
}

/** Reuse the initially opened root only while its directory authority is exact. */
export function transactionAuthoredRoot(root: StableAuthoredRoot): StableAuthoredRoot {
  assertStableAuthoredRoot(root);
  return root;
}

export function resolveAuthoredTarget(root: StableAuthoredRoot, relativePath: string): string {
  const normalized = normalizeProjectRelativePath(relativePath);
  const target = join(root.path, ...normalized.split('/'));
  if (!isPathContained(root.path, target)) {
    authoredTransactionFailure('a target escaped the project');
  }
  return target;
}

export function assertSafeAuthoredAncestors(
  root: StableAuthoredRoot,
  relativePath: string,
  nonDirectoryMeansAbsent = false,
): boolean {
  assertStableAuthoredRoot(root);
  const segments = normalizeProjectRelativePath(relativePath).split('/');
  let current = root.path;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let stat: BigIntStats;
    try {
      stat = lstatSync(current, { bigint: true });
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return false;
      authoredTransactionFailure('a target ancestor could not be inspected', error);
    }
    if (stat.isSymbolicLink()) {
      authoredTransactionFailure('a target ancestor is not a real directory');
    }
    if (!stat.isDirectory()) {
      if (nonDirectoryMeansAbsent && stat.isFile()) return false;
      authoredTransactionFailure('a target ancestor is not a real directory');
    }
    assertSafeAuthoredOwnerMode(stat, 'a target ancestor');
  }
  return true;
}

export function readStableArtifactFile(path: string): {
  readonly digest: string;
  readonly bytes: Buffer;
  readonly mode: number;
} {
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(INIT_AUTHORED_PLAN_CAPS.maxFileBytes)
  ) {
    authoredTransactionFailure('a file has an unsafe type, link count, or size');
  }
  assertSafeAuthoredOwnerMode(before, 'a file');
  const size = Number(before.size);
  if (!Number.isSafeInteger(size)) authoredTransactionFailure('a file size is unsupported');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameAuthoredEntryIdentity(authoredEntryIdentity(before), authoredEntryIdentity(opened))) {
      authoredTransactionFailure('a file changed before it was read');
    }
    const bytes = Buffer.alloc(size);
    const digest = createHash('sha256');
    let offset = 0;
    while (offset < size) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        Math.min(READ_CHUNK_BYTES, size - offset),
        null,
      );
      if (count === 0) authoredTransactionFailure('a file changed while it was read');
      digest.update(bytes.subarray(offset, offset + count));
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameAuthoredEntryIdentity(authoredEntryIdentity(opened), authoredEntryIdentity(after))) {
      authoredTransactionFailure('a file changed while it was read');
    }
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      !sameAuthoredEntryIdentity(authoredEntryIdentity(before), authoredEntryIdentity(pathAfter))
    ) {
      authoredTransactionFailure('a file path changed while it was read');
    }
    return {
      digest: digest.digest('hex'),
      bytes,
      mode: normalizeAuthoredPathMode(before.mode, 'file'),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

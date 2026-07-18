import { createHash } from 'node:crypto';
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
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { SystemError } from '@opensip-cli/core';

import {
  INIT_AUTHORED_PLAN_CAPS,
  directoryDigest,
  normalizeProjectRelativePath,
} from './init-authored-plan-types.js';

import type { InitAuthoredPathState } from './init-authored-plan.js';
import type { BigIntStats } from 'node:fs';

const READ_CHUNK_BYTES = 64 * 1024;
const ERROR_CODE = 'SYSTEM.INIT.AUTHORED_TRANSACTION';

interface EntryIdentity {
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
  readonly identity: EntryIdentity;
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

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function identityOf(stat: BigIntStats): EntryIdentity {
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

function sameIdentity(left: EntryIdentity, right: EntryIdentity): boolean {
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

function sameDirectoryAuthority(left: EntryIdentity, right: EntryIdentity): boolean {
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

function assertSafeOwnerMode(stat: BigIntStats, field: string): void {
  const uid = currentUid();
  const mode = Number(stat.mode & 0o7777n);
  if (uid !== undefined && stat.uid !== uid) {
    authoredTransactionFailure(`${field} is not owned by the current user`);
  }
  if (process.platform !== 'win32' && ((mode & 0o7000) !== 0 || (mode & 0o022) !== 0)) {
    authoredTransactionFailure(`${field} has an unsafe mode`);
  }
}

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  );
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
  assertSafeOwnerMode(requestedStat, 'the project root');
  const canonical = realpathSync(requested);
  const canonicalStat = lstatSync(canonical, { bigint: true });
  if (!sameIdentity(identityOf(requestedStat), identityOf(canonicalStat))) {
    authoredTransactionFailure('the project root changed while it was opened');
  }
  return { path: canonical, identity: identityOf(canonicalStat) };
}

export function assertStableAuthoredRoot(root: StableAuthoredRoot): void {
  const current = lstatSync(root.path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameDirectoryAuthority(root.identity, identityOf(current))
  ) {
    authoredTransactionFailure('the project root changed during the transaction');
  }
  assertSafeOwnerMode(current, 'the project root');
}

export function resolveAuthoredTarget(root: StableAuthoredRoot, relativePath: string): string {
  const normalized = normalizeProjectRelativePath(relativePath);
  const target = join(root.path, ...normalized.split('/'));
  if (!isContained(root.path, target)) authoredTransactionFailure('a target escaped the project');
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
      if (hasCode(error, 'ENOENT')) return false;
      authoredTransactionFailure('a target ancestor could not be inspected', error);
    }
    if (stat.isSymbolicLink()) {
      authoredTransactionFailure('a target ancestor is not a real directory');
    }
    if (!stat.isDirectory()) {
      if (nonDirectoryMeansAbsent && stat.isFile()) return false;
      authoredTransactionFailure('a target ancestor is not a real directory');
    }
    assertSafeOwnerMode(stat, 'a target ancestor');
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
  assertSafeOwnerMode(before, 'a file');
  const size = Number(before.size);
  if (!Number.isSafeInteger(size)) authoredTransactionFailure('a file size is unsupported');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identityOf(before), identityOf(opened))) {
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
    if (!sameIdentity(identityOf(opened), identityOf(after))) {
      authoredTransactionFailure('a file changed while it was read');
    }
    const pathAfter = lstatSync(path, { bigint: true });
    if (!sameIdentity(identityOf(before), identityOf(pathAfter))) {
      authoredTransactionFailure('a file path changed while it was read');
    }
    return {
      digest: digest.digest('hex'),
      bytes,
      mode: Number(before.mode & 0o777n),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function observeAuthoredPath(
  root: StableAuthoredRoot,
  relativePath: string,
): InitAuthoredPathState {
  if (!assertSafeAuthoredAncestors(root, relativePath, true)) {
    return { exists: false, type: null, mode: null, digest: null };
  }
  const path = resolveAuthoredTarget(root, relativePath);
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return { exists: false, type: null, mode: null, digest: null };
    }
    authoredTransactionFailure('a target could not be inspected', error);
  }
  if (stat.isSymbolicLink()) authoredTransactionFailure('a target is a symbolic link');
  assertSafeOwnerMode(stat, 'a target');
  const mode = Number(stat.mode & 0o777n);
  if (stat.isDirectory()) {
    return {
      exists: true,
      type: 'directory',
      mode,
      digest: directoryDigest(mode),
    };
  }
  if (!stat.isFile()) authoredTransactionFailure('a target has an unsupported type');
  const file = readStableArtifactFile(path);
  return { exists: true, type: 'file', mode, digest: file.digest };
}

export function sameAuthoredPathState(
  left: InitAuthoredPathState,
  right: InitAuthoredPathState,
): boolean {
  return (
    left.exists === right.exists &&
    left.type === right.type &&
    left.mode === right.mode &&
    left.digest === right.digest
  );
}

export function writeExclusiveDurableFile(
  path: string,
  bytes: Uint8Array,
  mode = 0o600,
  checkpoint?: (checkpoint: DurableFileWriteCheckpoint) => void,
): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    checkpoint?.('opened');
    if (bytes.length > 0 && checkpoint !== undefined) {
      const partialLength = Math.max(1, Math.floor(bytes.length / 2));
      writeAll(descriptor, bytes, 0, partialLength);
      checkpoint('partial-written');
      writeAll(descriptor, bytes, partialLength, bytes.length);
    } else {
      writeAll(descriptor, bytes, 0, bytes.length);
    }
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    checkpoint?.('fsynced');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeAll(descriptor: number, bytes: Uint8Array, start: number, end: number): void {
  let offset = start;
  while (offset < end) {
    const count = writeSync(descriptor, bytes, offset, end - offset);
    if (count < 1) {
      authoredTransactionFailure('an artifact write made no progress');
    }
    offset += count;
  }
}

export function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(descriptor);
  } catch (error) {
    if (
      process.platform === 'win32' &&
      (hasCode(error, 'EINVAL') || hasCode(error, 'ENOTSUP') || hasCode(error, 'EPERM'))
    ) {
      return;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function createDurableDirectory(path: string): void {
  mkdirSync(path, { recursive: false, mode: 0o700 });
  chmodSync(path, 0o700);
  fsyncDirectory(dirname(path));
  fsyncDirectory(path);
}

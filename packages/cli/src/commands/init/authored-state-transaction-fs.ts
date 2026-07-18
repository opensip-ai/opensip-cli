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
  opendirSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { projectCoordinationKey, SystemError } from '@opensip-cli/core';

import { normalizeAuthoredPathMode } from './authored-path-mode.js';
import {
  INIT_AUTHORED_PLAN_CAPS,
  directoryDigest,
  normalizeProjectRelativePath,
} from './init-authored-plan-types.js';
import { isWindowsDirectoryHandleFallback } from './runtime-directory-handle-fallback.js';

import type { InitAuthoredPathState } from './init-authored-plan.js';
import type { RuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';
import type { BigIntStats } from 'node:fs';

const READ_CHUNK_BYTES = 64 * 1024;
const ERROR_CODE = 'SYSTEM.INIT.AUTHORED_TRANSACTION';
const DURABLE_DIRECTORY_PARENT_DESCRIPTION = 'the durable directory parent';

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

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
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
  assertSafeAuthoredOwnerMode(stat, 'a target');
  const mode = normalizeAuthoredPathMode(stat.mode, stat.isDirectory() ? 'directory' : 'file');
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
  const before = lstatSync(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    authoredTransactionFailure('a directory sync target is not a real directory');
  }
  assertSafeAuthoredOwnerMode(before, 'a directory sync target');
  const identity = authoredEntryIdentity(before);
  const assertPathAuthority = (): void => {
    const current = lstatSync(path, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameAuthoredDirectoryAuthority(identity, authoredEntryIdentity(current))
    ) {
      authoredTransactionFailure('a directory sync target changed');
    }
    assertSafeAuthoredOwnerMode(current, 'a directory sync target');
  };
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
      authoredTransactionFailure('a directory sync target changed before it was synced');
    }
    try {
      fsyncSync(descriptor);
    } catch (error) {
      if (!isWindowsDirectoryHandleFallback(error)) throw error;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameAuthoredDirectoryAuthority(identity, authoredEntryIdentity(after))) {
      authoredTransactionFailure('a directory sync target changed while it was synced');
    }
    assertPathAuthority();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

interface DurableDirectoryFinalizationDependencies {
  readonly platform?: NodeJS.Platform;
  readonly openDirectory?: (path: string, flags: number) => number;
  readonly fchmodDirectory?: (descriptor: number, mode: number) => void;
  readonly fsyncDirectoryDescriptor?: (descriptor: number) => void;
}

function isWindowsDirectoryCapabilityError(error: unknown, platform: NodeJS.Platform): boolean {
  return isWindowsDirectoryHandleFallback(error, platform);
}

function assertCreatedDirectoryObject(
  stat: BigIntStats,
  created: AuthoredEntryIdentity,
  platform: NodeJS.Platform,
  description: string,
): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.nlink < 1n ||
    stat.dev !== created.dev ||
    stat.ino !== created.ino ||
    stat.uid !== created.uid ||
    (platform !== 'win32' && Number(stat.mode & 0o777n) !== 0o700)
  ) {
    authoredTransactionFailure(`${description} changed identity`);
  }
  assertSafeAuthoredOwnerMode(stat, description);
}

function finalizeCreatedDirectoryWithoutDescriptor(
  path: string,
  parent: StableAuthoredEntry,
  created: AuthoredEntryIdentity,
  platform: NodeJS.Platform,
): StableAuthoredEntry {
  assertStableAuthoredEntry(parent, DURABLE_DIRECTORY_PARENT_DESCRIPTION);
  const before = lstatSync(path, { bigint: true });
  assertCreatedDirectoryObject(
    before,
    created,
    platform,
    'the Windows durable directory fallback path',
  );
  fsyncDirectory(path);
  fsyncStableAuthoredDirectory(parent, DURABLE_DIRECTORY_PARENT_DESCRIPTION);
  const after = lstatSync(path, { bigint: true });
  assertCreatedDirectoryObject(
    after,
    created,
    platform,
    'the Windows durable directory fallback path',
  );
  return { path, type: 'directory', identity: authoredEntryIdentity(after) };
}

/**
 * Create and finalize one private directory through its descriptor. Node does
 * not expose mkdirat(2) with a returned descriptor, so the mkdir-to-first-stat
 * interval remains an irreducible path race. Once the created identity is
 * captured, every deterministic finalization window is descriptor-bound.
 */
export function createDurableDirectory(
  path: string,
  afterMkdir?: () => void,
  dependencies: DurableDirectoryFinalizationDependencies = {},
): StableAuthoredEntry {
  const platform = dependencies.platform ?? process.platform;
  const openDirectory = dependencies.openDirectory ?? openSync;
  const fchmodDirectory = dependencies.fchmodDirectory ?? fchmodSync;
  const fsyncDirectoryDescriptor = dependencies.fsyncDirectoryDescriptor ?? fsyncSync;
  const parentPath = dirname(path);
  const parent = bindStableAuthoredEntry(
    parentPath,
    'directory',
    DURABLE_DIRECTORY_PARENT_DESCRIPTION,
  );
  assertStableAuthoredEntry(parent, DURABLE_DIRECTORY_PARENT_DESCRIPTION);
  mkdirSync(path, { recursive: false, mode: 0o700 });
  const created = lstatSync(path, { bigint: true });
  if (!created.isDirectory() || created.isSymbolicLink() || created.nlink < 1n) {
    authoredTransactionFailure('a newly created durable directory has an unsafe type');
  }
  assertSafeAuthoredOwnerMode(created, 'a newly created durable directory');
  const createdIdentity = authoredEntryIdentity(created);
  afterMkdir?.();
  assertStableAuthoredEntry(parent, DURABLE_DIRECTORY_PARENT_DESCRIPTION);
  let descriptor: number | undefined;
  try {
    try {
      descriptor = openDirectory(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isWindowsDirectoryCapabilityError(error, platform)) {
        return finalizeCreatedDirectoryWithoutDescriptor(path, parent, createdIdentity, platform);
      }
      throw error;
    }
    const opened = fstatSync(descriptor, { bigint: true });
    assertCreatedDirectoryObject(
      opened,
      createdIdentity,
      platform,
      'a newly created durable directory',
    );
    try {
      fchmodDirectory(descriptor, 0o700);
    } catch (error) {
      if (!isWindowsDirectoryCapabilityError(error, platform)) throw error;
    }
    try {
      fsyncDirectoryDescriptor(descriptor);
    } catch (error) {
      if (!isWindowsDirectoryCapabilityError(error, platform)) throw error;
    }
    const finalized = fstatSync(descriptor, { bigint: true });
    assertCreatedDirectoryObject(
      finalized,
      createdIdentity,
      platform,
      'the finalized durable directory',
    );
    const finalizedIdentity = authoredEntryIdentity(finalized);
    const pathAfter = lstatSync(path, { bigint: true });
    assertCreatedDirectoryObject(
      pathAfter,
      createdIdentity,
      platform,
      'the finalized durable directory path',
    );
    if (!sameAuthoredDirectoryAuthority(finalizedIdentity, authoredEntryIdentity(pathAfter))) {
      authoredTransactionFailure('a durable directory path changed');
    }
    fsyncStableAuthoredDirectory(parent, DURABLE_DIRECTORY_PARENT_DESCRIPTION);
    return { path, type: 'directory', identity: finalizedIdentity };
  } catch (error) {
    return authoredTransactionFailure(
      'a newly created durable directory could not be finalized safely',
      error,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  assertSafeAuthoredOwnerMode,
  assertStableAuthoredEntry,
  authoredEntryIdentity,
  authoredTransactionFailure,
  bindStableAuthoredEntry,
  fsyncStableAuthoredDirectory,
  sameAuthoredDirectoryAuthority,
  type AuthoredEntryIdentity,
  type DurableFileWriteCheckpoint,
  type StableAuthoredEntry,
} from './authored-state-transaction-fs.js';
import { isWindowsDirectoryHandleFallback } from './runtime-directory-handle-fallback.js';

import type { BigIntStats } from 'node:fs';

const DURABLE_DIRECTORY_PARENT_DESCRIPTION = 'a durable directory parent';

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

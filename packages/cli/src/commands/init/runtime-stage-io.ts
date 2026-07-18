/**
 * Create and durably populate one journal-owned destination-sibling stage.
 */

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
  readlinkSync,
  readSync,
  realpathSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { RuntimeManifestError } from './runtime-manifest-model.js';
import {
  assertRuntimeStageOwnershipMarker,
  createRuntimeStageOwnershipMarker,
  encodeRuntimeStageOwnershipMarker,
} from './runtime-stage-ownership.js';

import type { RuntimeTreeManifest } from './runtime-manifest-model.js';
import type {
  RuntimeStageOwnershipCheckpoint,
  RuntimeStageOwnershipIdentity,
} from './runtime-stage-ownership.js';
import type { BigIntStats } from 'node:fs';

const READ_CHUNK_BYTES = 64 * 1024;

export type RuntimeStageIoCheckpoint =
  | RuntimeStageOwnershipCheckpoint
  | 'after-stage-mkdir'
  | 'after-marker-stage-fsync'
  | 'after-marker-parent-fsync'
  | 'before-first-source-entry';

export interface RuntimeStageIoDependencies {
  readonly checkpoint?: (checkpoint: RuntimeStageIoCheckpoint) => void;
}

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

interface StableDirectory {
  readonly path: string;
  readonly descriptor?: number;
  readonly identity: EntryIdentity;
}

function fail(reason: ConstructorParameters<typeof RuntimeManifestError>[0]): never {
  throw new RuntimeManifestError(reason);
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

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  );
}

function assertSafeDirectoryStat(stat: BigIntStats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('special-entry');
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
  if (uid !== undefined && stat.uid !== uid) fail('unsafe-owner');
  const mode = Number(stat.mode & 0o7777n);
  if (
    process.platform !== 'win32' &&
    ((mode & 0o7000) !== 0 || (mode & 0o022) !== 0 || (mode & 0o700) !== 0o700)
  ) {
    fail('mode');
  }
}

function openStableParent(path: string): StableDirectory {
  const canonical = realpathSync(path);
  const stat = lstatSync(path, { bigint: true });
  assertSafeDirectoryStat(stat);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      canonical,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    assertSafeDirectoryStat(opened);
    if (!sameIdentity(identityOf(stat), identityOf(opened))) fail('changed');
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      (!hasCode(error, 'EINVAL') && !hasCode(error, 'ENOTSUP') && !hasCode(error, 'EPERM'))
    ) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error;
    }
    if (descriptor !== undefined) closeSync(descriptor);
    descriptor = undefined;
  }
  return { path: canonical, descriptor, identity: identityOf(stat) };
}

function assertStableDirectory(directory: StableDirectory): void {
  const current = lstatSync(directory.path, { bigint: true });
  assertSafeDirectoryStat(current);
  if (!sameDirectoryAuthority(directory.identity, identityOf(current))) fail('changed');
  if (directory.descriptor === undefined) return;
  const opened = fstatSync(directory.descriptor, { bigint: true });
  if (!sameDirectoryAuthority(directory.identity, identityOf(opened))) fail('changed');
}

function observeCreatedDirectory(path: string): StableDirectory {
  const stat = lstatSync(path, { bigint: true });
  assertSafeDirectoryStat(stat);
  return { path, identity: identityOf(stat) };
}

function requireStableDestinationParent(
  path: string,
  directories: ReadonlyMap<string, StableDirectory>,
): StableDirectory {
  const parent = directories.get(dirname(path));
  if (parent === undefined) fail('changed');
  assertStableDirectory(parent);
  return parent;
}

function assertSafeStageBasename(value: string): void {
  if (
    value.length === 0 ||
    value.length > 128 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    fail('invalid-path');
  }
}

function assertSafeSourceSymlink(root: string, path: string, expectedTarget: string): void {
  const before = lstatSync(path, { bigint: true });
  if (!before.isSymbolicLink()) fail('changed');
  const target = readlinkSync(path);
  if (
    target !== expectedTarget ||
    target.length === 0 ||
    target.includes('\0') ||
    isAbsolute(target)
  ) {
    fail('changed');
  }
  const targetPath = resolve(join(path, '..'), target);
  if (!isContained(root, targetPath)) fail('symlink-escape');
  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(targetPath);
  } catch {
    fail('symlink-invalid');
  }
  if (!isContained(root, canonicalTarget)) fail('symlink-escape');
  const after = lstatSync(path, { bigint: true });
  if (!after.isSymbolicLink() || !sameIdentity(identityOf(before), identityOf(after))) {
    fail('changed');
  }
}

function writeFileFromSource(source: string, destination: string, mode: number): void {
  const sourceBefore = lstatSync(source, { bigint: true });
  if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink() || sourceBefore.nlink !== 1n) {
    fail('changed');
  }
  let sourceFd: number | undefined;
  let destinationFd: number | undefined;
  try {
    sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    destinationFd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const bytesRead = readSync(sourceFd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        const written = writeSync(destinationFd, chunk, offset, bytesRead - offset);
        if (written < 1) fail('changed');
        offset += written;
      }
    }
    const sourceAfter = fstatSync(sourceFd, { bigint: true });
    if (!sameIdentity(identityOf(sourceBefore), identityOf(sourceAfter))) fail('changed');
    fchmodSync(destinationFd, mode);
    fsyncSync(destinationFd);
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
  }
  const sourcePathAfter = lstatSync(source, { bigint: true });
  if (!sameIdentity(identityOf(sourceBefore), identityOf(sourcePathAfter))) fail('changed');
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isDirectory()) fail('special-entry');
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

function fsyncStableParent(parent: StableDirectory): void {
  assertStableDirectory(parent);
  if (parent.descriptor === undefined) fsyncDirectory(parent.path);
  else fsyncSync(parent.descriptor);
  assertStableDirectory(parent);
}

function assertStageOwnershipBinding(
  stageBasename: string,
  ownership: RuntimeStageOwnershipIdentity,
): void {
  if (ownership.stageBasename !== stageBasename) fail('stage-ownership');
  encodeRuntimeStageOwnershipMarker(ownership);
}

function createDurableOwnedStage(
  parent: StableDirectory,
  stageDir: string,
  ownership: RuntimeStageOwnershipIdentity,
  dependencies: RuntimeStageIoDependencies,
): void {
  assertStableDirectory(parent);
  mkdirSync(stageDir, { recursive: false, mode: 0o700 });
  assertStableDirectory(parent);
  dependencies.checkpoint?.('after-stage-mkdir');
  createRuntimeStageOwnershipMarker(stageDir, ownership, {
    checkpoint: dependencies.checkpoint,
  });
  fsyncDirectory(stageDir);
  dependencies.checkpoint?.('after-marker-stage-fsync');
  fsyncStableParent(parent);
  dependencies.checkpoint?.('after-marker-parent-fsync');
  assertRuntimeStageOwnershipMarker(stageDir, ownership);
}

/**
 * Materialize a source manifest into an absent stage. Partial output remains
 * owned by the journal when any step fails.
 */
export function materializeRuntimeStage(
  sourceDir: string,
  destinationParent: string,
  stageBasename: string,
  source: RuntimeTreeManifest,
  ownership: RuntimeStageOwnershipIdentity,
  dependencies: RuntimeStageIoDependencies = {},
): string {
  assertSafeStageBasename(stageBasename);
  assertStageOwnershipBinding(stageBasename, ownership);
  const canonicalSource = realpathSync(sourceDir);
  const parent = openStableParent(destinationParent);
  const stageDir = join(parent.path, stageBasename);
  try {
    createDurableOwnedStage(parent, stageDir, ownership, dependencies);

    const stableDirectories = new Map<string, StableDirectory>([
      [stageDir, observeCreatedDirectory(stageDir)],
    ]);
    const directories: { readonly path: string; readonly mode: number }[] = [
      { path: stageDir, mode: source.rootMode },
    ];
    dependencies.checkpoint?.('before-first-source-entry');
    for (const entry of source.entries) {
      const sourcePath = join(canonicalSource, ...entry.path.split('/'));
      const destinationPath = join(stageDir, ...entry.path.split('/'));
      if (!isContained(canonicalSource, sourcePath) || !isContained(stageDir, destinationPath)) {
        fail('invalid-path');
      }
      assertStableDirectory(parent);
      const destinationEntryParent = requireStableDestinationParent(
        destinationPath,
        stableDirectories,
      );
      if (entry.kind === 'directory') {
        mkdirSync(destinationPath, { recursive: false, mode: 0o700 });
        assertStableDirectory(destinationEntryParent);
        stableDirectories.set(destinationPath, observeCreatedDirectory(destinationPath));
        directories.push({ path: destinationPath, mode: entry.mode });
        continue;
      }
      if (entry.kind === 'file') {
        writeFileFromSource(sourcePath, destinationPath, entry.mode);
        assertStableDirectory(destinationEntryParent);
        continue;
      }
      assertSafeSourceSymlink(canonicalSource, sourcePath, entry.target);
      symlinkSync(entry.target, destinationPath);
      assertStableDirectory(destinationEntryParent);
      const installedLink = lstatSync(destinationPath, { bigint: true });
      if (!installedLink.isSymbolicLink() || readlinkSync(destinationPath) !== entry.target) {
        fail('changed');
      }
    }

    for (let index = directories.length - 1; index >= 0; index -= 1) {
      const directory = directories[index];
      if (directory === undefined) continue;
      chmodSync(directory.path, directory.mode);
      fsyncDirectory(directory.path);
    }
    fsyncStableParent(parent);
    assertRuntimeStageOwnershipMarker(stageDir, ownership);
    return stageDir;
  } finally {
    if (parent.descriptor !== undefined) closeSync(parent.descriptor);
  }
}

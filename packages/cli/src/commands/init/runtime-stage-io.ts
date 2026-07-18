/**
 * Create and durably populate one journal-owned destination-sibling stage.
 */

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
  readlinkSync,
  readSync,
  realpathSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { isWindowsDirectoryHandleFallback } from './runtime-directory-handle-fallback.js';
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
  | 'before-first-source-entry'
  | 'before-source-entry'
  | 'after-source-file-chunk'
  | 'after-source-entry';

export interface RuntimeStageIoDependencies {
  readonly checkpoint?: (checkpoint: RuntimeStageIoCheckpoint, entryIndex?: number) => void;
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
    if (!isWindowsDirectoryHandleFallback(error)) {
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
  return openStableParent(path);
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

function writeChunk(descriptor: number, chunk: Buffer, bytes: number): void {
  let offset = 0;
  while (offset < bytes) {
    const written = writeSync(descriptor, chunk, offset, bytes - offset);
    if (written < 1) fail('changed');
    offset += written;
  }
}

function writeFileFromSource(
  source: string,
  destination: string,
  expected: Extract<RuntimeTreeManifest['entries'][number], { readonly kind: 'file' }>,
  dependencies: RuntimeStageIoDependencies,
  entryIndex: number,
): void {
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
    const digest = createHash('sha256');
    let totalBytes = 0;
    for (;;) {
      const bytesRead = readSync(sourceFd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      if (totalBytes + bytesRead > expected.sizeBytes) fail('changed');
      writeChunk(destinationFd, chunk, bytesRead);
      digest.update(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
      dependencies.checkpoint?.('after-source-file-chunk', entryIndex);
    }
    if (totalBytes !== expected.sizeBytes || digest.digest('hex') !== expected.sha256) {
      fail('changed');
    }
    const sourceAfter = fstatSync(sourceFd, { bigint: true });
    if (!sameIdentity(identityOf(sourceBefore), identityOf(sourceAfter))) fail('changed');
    fchmodSync(destinationFd, expected.mode);
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
    if (isWindowsDirectoryHandleFallback(error)) {
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

function finalizeStableDirectoryMode(directory: StableDirectory, mode: number): StableDirectory {
  assertStableDirectory(directory);
  if (directory.descriptor === undefined) {
    // This is the guarded Windows fallback reached only when directory
    // O_DIRECTORY/O_NOFOLLOW handles are unsupported. Reassert the exact path
    // identity immediately around the unavoidable path-based operations.
    assertStableDirectory(directory);
    chmodSync(directory.path, mode);
    const changedMode = lstatSync(directory.path, { bigint: true });
    if (
      directory.identity.dev !== changedMode.dev ||
      directory.identity.ino !== changedMode.ino ||
      directory.identity.uid !== changedMode.uid
    ) {
      fail('changed');
    }
    fsyncDirectory(directory.path);
  } else {
    fchmodSync(directory.descriptor, mode);
    fsyncSync(directory.descriptor);
  }
  const observed =
    directory.descriptor === undefined
      ? lstatSync(directory.path, { bigint: true })
      : fstatSync(directory.descriptor, { bigint: true });
  assertSafeDirectoryStat(observed);
  const observedIdentity = identityOf(observed);
  if (
    directory.identity.dev !== observedIdentity.dev ||
    directory.identity.ino !== observedIdentity.ino ||
    directory.identity.uid !== observedIdentity.uid ||
    Number(observed.mode & 0o777n) !== mode
  ) {
    fail('changed');
  }
  const finalized: StableDirectory = {
    path: directory.path,
    identity: observedIdentity,
    ...(directory.descriptor === undefined ? {} : { descriptor: directory.descriptor }),
  };
  assertStableDirectory(finalized);
  return finalized;
}

function closeStableDirectories(directories: ReadonlyMap<string, StableDirectory>): void {
  const descriptors = new Set<number>();
  for (const directory of directories.values()) {
    if (directory.descriptor !== undefined) descriptors.add(directory.descriptor);
  }
  for (const descriptor of descriptors) closeSync(descriptor);
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
): StableDirectory {
  assertStableDirectory(parent);
  mkdirSync(stageDir, { recursive: false, mode: 0o700 });
  const stage = observeCreatedDirectory(stageDir);
  try {
    assertStableDirectory(parent);
    dependencies.checkpoint?.('after-stage-mkdir');
    assertStableDirectory(parent);
    assertStableDirectory(stage);
    createRuntimeStageOwnershipMarker(stageDir, ownership, {
      checkpoint: dependencies.checkpoint,
      assertRootStable: () => {
        assertStableDirectory(parent);
        assertStableDirectory(stage);
      },
    });
    fsyncStableParent(stage);
    dependencies.checkpoint?.('after-marker-stage-fsync');
    assertStableDirectory(stage);
    fsyncStableParent(parent);
    dependencies.checkpoint?.('after-marker-parent-fsync');
    assertStableDirectory(parent);
    assertStableDirectory(stage);
    assertRuntimeStageOwnershipMarker(stageDir, ownership);
    assertStableDirectory(stage);
    return stage;
  } catch (error) {
    if (stage.descriptor !== undefined) closeSync(stage.descriptor);
    throw error;
  }
}

interface MaterializeStageEntryInput {
  readonly canonicalSource: string;
  readonly entry: RuntimeTreeManifest['entries'][number];
  readonly entryIndex: number;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly destinationEntryParent: StableDirectory;
  readonly stableDirectories: Map<string, StableDirectory>;
  readonly directories: { readonly path: string; readonly mode: number }[];
  readonly dependencies: RuntimeStageIoDependencies;
}

function materializeDirectoryEntry(input: MaterializeStageEntryInput): void {
  if (input.entry.kind !== 'directory') fail('changed');
  mkdirSync(input.destinationPath, { recursive: false, mode: 0o700 });
  const created = observeCreatedDirectory(input.destinationPath);
  try {
    assertStableDirectory(input.destinationEntryParent);
  } catch (error) {
    if (created.descriptor !== undefined) closeSync(created.descriptor);
    throw error;
  }
  input.stableDirectories.set(input.destinationPath, created);
  input.directories.push({
    path: input.destinationPath,
    mode: input.entry.mode,
  });
  input.dependencies.checkpoint?.('after-source-entry', input.entryIndex);
  assertStableDirectory(input.destinationEntryParent);
  assertStableDirectory(created);
}

function materializeFileEntry(input: MaterializeStageEntryInput): void {
  if (input.entry.kind !== 'file') fail('changed');
  writeFileFromSource(
    input.sourcePath,
    input.destinationPath,
    input.entry,
    input.dependencies,
    input.entryIndex,
  );
  assertStableDirectory(input.destinationEntryParent);
  input.dependencies.checkpoint?.('after-source-entry', input.entryIndex);
  assertStableDirectory(input.destinationEntryParent);
}

function materializeSymlinkEntry(input: MaterializeStageEntryInput): void {
  if (input.entry.kind !== 'symlink') fail('changed');
  assertSafeSourceSymlink(input.canonicalSource, input.sourcePath, input.entry.target);
  symlinkSync(input.entry.target, input.destinationPath);
  assertStableDirectory(input.destinationEntryParent);
  const installedLink = lstatSync(input.destinationPath, { bigint: true });
  if (
    !installedLink.isSymbolicLink() ||
    readlinkSync(input.destinationPath) !== input.entry.target
  ) {
    fail('changed');
  }
  input.dependencies.checkpoint?.('after-source-entry', input.entryIndex);
  assertStableDirectory(input.destinationEntryParent);
}

function materializeStageEntry(input: MaterializeStageEntryInput): void {
  if (input.entry.kind === 'directory') {
    materializeDirectoryEntry(input);
    return;
  }
  if (input.entry.kind === 'file') {
    materializeFileEntry(input);
    return;
  }
  materializeSymlinkEntry(input);
}

function finalizeStageDirectoryModes(
  directories: readonly { readonly path: string; readonly mode: number }[],
  stableDirectories: Map<string, StableDirectory>,
): void {
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    const directory = directories[index];
    if (directory === undefined) continue;
    const stable = stableDirectories.get(directory.path);
    if (stable === undefined) fail('changed');
    stableDirectories.set(directory.path, finalizeStableDirectoryMode(stable, directory.mode));
  }
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
  const stableDirectories = new Map<string, StableDirectory>();
  try {
    stableDirectories.set(
      stageDir,
      createDurableOwnedStage(parent, stageDir, ownership, dependencies),
    );
    const directories: { readonly path: string; readonly mode: number }[] = [
      { path: stageDir, mode: source.rootMode },
    ];
    dependencies.checkpoint?.('before-first-source-entry');
    for (const [entryIndex, entry] of source.entries.entries()) {
      dependencies.checkpoint?.('before-source-entry', entryIndex);
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
      materializeStageEntry({
        canonicalSource,
        entry,
        entryIndex,
        sourcePath,
        destinationPath,
        destinationEntryParent,
        stableDirectories,
        directories,
        dependencies,
      });
    }

    finalizeStageDirectoryModes(directories, stableDirectories);
    fsyncStableParent(parent);
    const stableStage = stableDirectories.get(stageDir);
    if (stableStage === undefined) fail('changed');
    assertStableDirectory(stableStage);
    assertRuntimeStageOwnershipMarker(stageDir, ownership);
    assertStableDirectory(stableStage);
    return stageDir;
  } finally {
    closeStableDirectories(stableDirectories);
    if (parent.descriptor !== undefined) closeSync(parent.descriptor);
  }
}

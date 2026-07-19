/**
 * Create and durably populate one journal-owned destination-sibling stage.
 */

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
  readlinkSync,
  readSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  assertRuntimeStageOwnershipMarker,
  createRuntimeStageOwnershipMarker,
  encodeRuntimeStageOwnershipMarker,
} from './runtime-stage-ownership.js';
import {
  assertSafeSourceSymlink,
  assertSafeStageBasename,
  runtimeStagePathIsContained as isContained,
} from './runtime-stage-path-policy.js';
import {
  assertStableRuntimeStageDirectory as assertStableDirectory,
  closeStableRuntimeStageDirectories as closeStableDirectories,
  finalizeStableRuntimeStageDirectoryMode as finalizeStableDirectoryMode,
  fsyncStableRuntimeStageParent as fsyncStableParent,
  openStableRuntimeStageDirectory as openStableParent,
  requireStableRuntimeStageParent as requireStableDestinationParent,
  runtimeStageFail as fail,
  runtimeStageIdentity as identityOf,
  sameRuntimeStageIdentity as sameIdentity,
  type StableRuntimeStageDirectory as StableDirectory,
} from './runtime-stage-stable-directory.js';

import type { RuntimeTreeManifest } from './runtime-manifest-model.js';
import type { RuntimePromotionRootIdentity } from './runtime-promotion-journal-types.js';
import type {
  RuntimeStageOwnershipCheckpoint,
  RuntimeStageOwnershipIdentity,
} from './runtime-stage-ownership.js';

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
  readonly expectedSourceRootIdentity?: RuntimePromotionRootIdentity;
}

function assertExpectedSourceRootIdentity(
  sourceRoot: StableDirectory,
  expected: RuntimePromotionRootIdentity | undefined,
): void {
  if (
    expected !== undefined &&
    (sourceRoot.identity.dev.toString() !== expected.device ||
      sourceRoot.identity.ino.toString() !== expected.inode)
  ) {
    fail('changed');
  }
}

function guardSourceRootCheckpoints(
  dependencies: RuntimeStageIoDependencies,
  sourceRoot: StableDirectory,
): RuntimeStageIoDependencies {
  return {
    ...dependencies,
    checkpoint: (checkpoint, entryIndex) => {
      assertStableDirectory(sourceRoot);
      dependencies.checkpoint?.(checkpoint, entryIndex);
      assertStableDirectory(sourceRoot);
    },
  };
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
  sourceRoot: StableDirectory,
  dependencies: RuntimeStageIoDependencies,
  entryIndex: number,
): void {
  assertStableDirectory(sourceRoot);
  const sourceBefore = lstatSync(source, { bigint: true });
  if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink() || sourceBefore.nlink !== 1n) {
    fail('changed');
  }
  assertStableDirectory(sourceRoot);
  let sourceFd: number | undefined;
  let destinationFd: number | undefined;
  try {
    sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    assertStableDirectory(sourceRoot);
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
      assertStableDirectory(sourceRoot);
    }
    if (totalBytes !== expected.sizeBytes || digest.digest('hex') !== expected.sha256) {
      fail('changed');
    }
    const sourceAfter = fstatSync(sourceFd, { bigint: true });
    if (!sameIdentity(identityOf(sourceBefore), identityOf(sourceAfter))) fail('changed');
    assertStableDirectory(sourceRoot);
    fchmodSync(destinationFd, expected.mode);
    fsyncSync(destinationFd);
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
  }
  assertStableDirectory(sourceRoot);
  const sourcePathAfter = lstatSync(source, { bigint: true });
  if (!sameIdentity(identityOf(sourceBefore), identityOf(sourcePathAfter))) fail('changed');
  assertStableDirectory(sourceRoot);
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
  const stage = openStableParent(stageDir);
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
  readonly sourceRoot: StableDirectory;
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
  assertStableDirectory(input.sourceRoot);
  mkdirSync(input.destinationPath, { recursive: false, mode: 0o700 });
  const created = openStableParent(input.destinationPath);
  try {
    assertStableDirectory(input.sourceRoot);
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
  assertStableDirectory(input.sourceRoot);
  assertStableDirectory(input.destinationEntryParent);
  assertStableDirectory(created);
}

function materializeFileEntry(input: MaterializeStageEntryInput): void {
  if (input.entry.kind !== 'file') fail('changed');
  writeFileFromSource(
    input.sourcePath,
    input.destinationPath,
    input.entry,
    input.sourceRoot,
    input.dependencies,
    input.entryIndex,
  );
  assertStableDirectory(input.sourceRoot);
  assertStableDirectory(input.destinationEntryParent);
  input.dependencies.checkpoint?.('after-source-entry', input.entryIndex);
  assertStableDirectory(input.sourceRoot);
  assertStableDirectory(input.destinationEntryParent);
}

function materializeSymlinkEntry(input: MaterializeStageEntryInput): void {
  if (input.entry.kind !== 'symlink') fail('changed');
  assertStableDirectory(input.sourceRoot);
  assertSafeSourceSymlink(input.canonicalSource, input.sourcePath, input.entry.target);
  assertStableDirectory(input.sourceRoot);
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
  assertStableDirectory(input.sourceRoot);
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
  const sourceRoot = openStableParent(sourceDir);
  try {
    assertExpectedSourceRootIdentity(sourceRoot, dependencies.expectedSourceRootIdentity);
    assertStableDirectory(sourceRoot);
  } catch (error) {
    if (sourceRoot.descriptor !== undefined) closeSync(sourceRoot.descriptor);
    throw error;
  }
  const canonicalSource = sourceRoot.path;
  let parent: StableDirectory;
  try {
    parent = openStableParent(destinationParent);
  } catch (error) {
    if (sourceRoot.descriptor !== undefined) closeSync(sourceRoot.descriptor);
    throw error;
  }
  const guardedDependencies = guardSourceRootCheckpoints(dependencies, sourceRoot);
  const stageDir = join(parent.path, stageBasename);
  const stableDirectories = new Map<string, StableDirectory>();
  try {
    assertStableDirectory(sourceRoot);
    stableDirectories.set(
      stageDir,
      createDurableOwnedStage(parent, stageDir, ownership, guardedDependencies),
    );
    const directories: { readonly path: string; readonly mode: number }[] = [
      { path: stageDir, mode: source.rootMode },
    ];
    guardedDependencies.checkpoint?.('before-first-source-entry');
    for (const [entryIndex, entry] of source.entries.entries()) {
      guardedDependencies.checkpoint?.('before-source-entry', entryIndex);
      assertStableDirectory(sourceRoot);
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
        sourceRoot,
        entry,
        entryIndex,
        sourcePath,
        destinationPath,
        destinationEntryParent,
        stableDirectories,
        directories,
        dependencies: guardedDependencies,
      });
      assertStableDirectory(sourceRoot);
    }

    assertStableDirectory(sourceRoot);
    finalizeStageDirectoryModes(directories, stableDirectories);
    assertStableDirectory(sourceRoot);
    fsyncStableParent(parent);
    const stableStage = stableDirectories.get(stageDir);
    if (stableStage === undefined) fail('changed');
    assertStableDirectory(stableStage);
    assertRuntimeStageOwnershipMarker(stageDir, ownership);
    assertStableDirectory(stableStage);
    assertStableDirectory(sourceRoot);
    return stageDir;
  } finally {
    try {
      closeStableDirectories(stableDirectories);
    } finally {
      try {
        if (parent.descriptor !== undefined) closeSync(parent.descriptor);
      } finally {
        if (sourceRoot.descriptor !== undefined) closeSync(sourceRoot.descriptor);
      }
    }
  }
}

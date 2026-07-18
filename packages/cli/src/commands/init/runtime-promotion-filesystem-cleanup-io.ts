import { lstatSync, opendirSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  RUNTIME_MANIFEST_MAX_ENTRIES,
  RUNTIME_MANIFEST_MAX_FILE_BYTES,
  RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES,
  RUNTIME_MANIFEST_MAX_PATH_BYTES,
} from './runtime-manifest.js';
import {
  assertPromotionCurrentOwner,
  assertPromotionDirectoryObjectIdentity,
  assertPromotionPathIdentity,
  assertPromotionRootIdentity,
  assertStablePromotionDirectory,
  capturePromotionPathIdentity,
  classifyRuntimePromotionPath,
  closeStablePromotionDirectory,
  fsyncPromotionDirectory,
  openStablePromotionDirectory,
  promotionIdentityOf,
  runtimePromotionFilesystemFailure,
  withPromotionMutation,
} from './runtime-promotion-filesystem-io.js';

import type { StablePromotionDirectory } from './runtime-promotion-filesystem-io.js';
import type {
  RuntimePromotionArtifactMarker,
  RuntimePromotionFilesystemDependencies,
} from './runtime-promotion-filesystem-types.js';
import type { BigIntStats } from 'node:fs';

interface CleanupBudget {
  entries: number;
  pathBytes: number;
}

function assertSafeCleanupDirectory(stat: BigIntStats): void {
  assertPromotionCurrentOwner(stat, 'an owned cleanup directory');
  const mode = Number(stat.mode & 0o7777n);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      ((mode & 0o7000) !== 0 || (mode & 0o022) !== 0 || (mode & 0o700) !== 0o700))
  ) {
    runtimePromotionFilesystemFailure('an owned cleanup directory has an unsafe identity');
  }
}

function assertSafeCleanupFile(stat: BigIntStats): void {
  assertPromotionCurrentOwner(stat, 'an owned cleanup file');
  const mode = Number(stat.mode & 0o7777n);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size > BigInt(RUNTIME_MANIFEST_MAX_FILE_BYTES) ||
    (process.platform !== 'win32' && ((mode & 0o7000) !== 0 || (mode & 0o022) !== 0))
  ) {
    runtimePromotionFilesystemFailure('an owned cleanup file has an unsafe identity');
  }
}

function assertSafeEntryName(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    runtimePromotionFilesystemFailure('an owned tree contains an unsafe entry name');
  }
}

function chargeCleanupPath(relativePath: string, budget: CleanupBudget): void {
  const bytes = Buffer.byteLength(relativePath, 'utf8');
  budget.entries += 1;
  budget.pathBytes += bytes;
  if (
    bytes < 1 ||
    bytes > RUNTIME_MANIFEST_MAX_PATH_BYTES ||
    budget.entries > RUNTIME_MANIFEST_MAX_ENTRIES ||
    budget.pathBytes > RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES
  ) {
    runtimePromotionFilesystemFailure('owned cleanup exceeded its deterministic bounds');
  }
}

function readBoundedNames(path: string): readonly string[] {
  const names: string[] = [];
  const directory = opendirSync(path);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      assertSafeEntryName(entry.name);
      names.push(entry.name);
      if (names.length > RUNTIME_MANIFEST_MAX_ENTRIES) {
        runtimePromotionFilesystemFailure('owned cleanup exceeded its entry bound');
      }
    }
  } finally {
    directory.closeSync();
  }
  names.sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
  return names;
}

function removeOwnedDirectoryContents(
  root: string,
  directoryPath: string,
  relativeDirectory: string,
  budget: CleanupBudget,
  dependencies: RuntimePromotionFilesystemDependencies,
  revalidateBeforeMutation: (() => void) | undefined,
  heldRoot?: StablePromotionDirectory,
): void {
  const directory =
    heldRoot ?? openStablePromotionDirectory(directoryPath, 'an owned cleanup directory');
  try {
    for (const name of readBoundedNames(directory.path)) {
      const relativePath = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
      chargeCleanupPath(relativePath, budget);
      const child = resolve(directory.path, name);
      const fromRoot = relative(root, child);
      if (
        isAbsolute(fromRoot) ||
        fromRoot === '..' ||
        fromRoot.startsWith(`..${sep}`) ||
        dirname(child) !== directory.path
      ) {
        runtimePromotionFilesystemFailure('owned cleanup escaped its root');
      }
      const stat = lstatSync(child, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        assertSafeCleanupDirectory(stat);
        removeOwnedDirectoryContents(
          root,
          child,
          relativePath,
          budget,
          dependencies,
          revalidateBeforeMutation,
        );
        assertPromotionDirectoryObjectIdentity(
          child,
          promotionIdentityOf(stat),
          'an emptied owned cleanup directory',
        );
        const emptiedIdentity = capturePromotionPathIdentity(
          child,
          'an emptied owned cleanup directory',
        );
        withPromotionMutation(dependencies, 'owned-directory-remove', () => {
          revalidateBeforeMutation?.();
          assertStablePromotionDirectory(directory, 'an owned cleanup parent');
          assertPromotionPathIdentity(child, emptiedIdentity, 'an emptied owned cleanup directory');
          rmdirSync(child);
        });
        fsyncPromotionDirectory(directory, dependencies);
        continue;
      }
      if (stat.isSymbolicLink()) {
        assertPromotionCurrentOwner(stat, 'an owned cleanup symbolic link');
      } else {
        assertSafeCleanupFile(stat);
      }
      const childIdentity = promotionIdentityOf(stat);
      withPromotionMutation(dependencies, 'owned-entry-unlink', () => {
        revalidateBeforeMutation?.();
        assertStablePromotionDirectory(directory, 'an owned cleanup parent');
        assertPromotionPathIdentity(child, childIdentity, 'an owned cleanup entry');
        unlinkSync(child);
      });
      fsyncPromotionDirectory(directory, dependencies);
    }
  } finally {
    if (heldRoot === undefined) closeStablePromotionDirectory(directory);
  }
}

/**
 * Remove one already-owned tree without following links. The caller must
 * publish a durable cleanup marker before invoking this function.
 */
export function removeBoundedOwnedTree(
  parent: StablePromotionDirectory,
  root: string,
  dependencies: RuntimePromotionFilesystemDependencies,
  expectedRootIdentity: NonNullable<RuntimePromotionArtifactMarker['rootIdentity']>,
  revalidateBeforeMutation?: () => void,
): boolean {
  const classification = classifyRuntimePromotionPath(root);
  if (classification.status === 'absent') {
    fsyncPromotionDirectory(parent, dependencies);
    return false;
  }
  if (
    classification.status !== 'directory' ||
    classification.owner !== 'current' ||
    dirname(root) !== parent.path
  ) {
    runtimePromotionFilesystemFailure('an owned cleanup root has an unsafe identity');
  }
  assertPromotionRootIdentity(root, expectedRootIdentity);
  const heldRoot = openStablePromotionDirectory(root, 'an owned cleanup root');
  try {
    if (
      heldRoot.identity.dev.toString() !== expectedRootIdentity.device ||
      heldRoot.identity.ino.toString() !== expectedRootIdentity.inode
    ) {
      runtimePromotionFilesystemFailure('an owned cleanup root was replaced before traversal');
    }
    removeOwnedDirectoryContents(
      root,
      root,
      '',
      { entries: 0, pathBytes: 0 },
      dependencies,
      revalidateBeforeMutation,
      heldRoot,
    );
    assertStablePromotionDirectory(heldRoot, 'an owned cleanup root');
  } finally {
    closeStablePromotionDirectory(heldRoot);
  }
  withPromotionMutation(dependencies, 'owned-directory-remove', () => {
    revalidateBeforeMutation?.();
    assertStablePromotionDirectory(parent, 'an owned cleanup parent');
    assertPromotionRootIdentity(root, expectedRootIdentity);
    rmdirSync(root);
  });
  fsyncPromotionDirectory(parent, dependencies);
  return true;
}

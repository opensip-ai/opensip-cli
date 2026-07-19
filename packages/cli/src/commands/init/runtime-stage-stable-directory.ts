import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { isWindowsDirectoryHandleFallback } from './runtime-directory-handle-fallback.js';
import { RuntimeManifestError } from './runtime-manifest-model.js';

import type { BigIntStats } from 'node:fs';

export interface RuntimeStageEntryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface StableRuntimeStageDirectory {
  readonly path: string;
  readonly descriptor?: number;
  readonly identity: RuntimeStageEntryIdentity;
}

/** @throws {RuntimeManifestError} Always; the stable stage proof failed. */
export function runtimeStageFail(
  reason: ConstructorParameters<typeof RuntimeManifestError>[0],
): never {
  throw new RuntimeManifestError(reason);
}

/** Capture the identity fields required by stage mutation proofs. */
export function runtimeStageIdentity(stat: BigIntStats): RuntimeStageEntryIdentity {
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

/** Compare complete entry identity before and after a bounded operation. */
export function sameRuntimeStageIdentity(
  left: RuntimeStageEntryIdentity,
  right: RuntimeStageEntryIdentity,
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
  left: RuntimeStageEntryIdentity,
  right: RuntimeStageEntryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode
  );
}

function assertSafeDirectoryStat(stat: BigIntStats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) runtimeStageFail('special-entry');
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
  if (uid !== undefined && stat.uid !== uid) runtimeStageFail('unsafe-owner');
  const mode = Number(stat.mode & 0o7777n);
  if (
    process.platform !== 'win32' &&
    ((mode & 0o7000) !== 0 || (mode & 0o022) !== 0 || (mode & 0o700) !== 0o700)
  ) {
    runtimeStageFail('mode');
  }
}

/**
 * Open and pin a safe directory when the platform supports directory handles.
 *
 * @throws {Error} When the path cannot be proven to be a stable safe directory.
 */
export function openStableRuntimeStageDirectory(path: string): StableRuntimeStageDirectory {
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
    if (!sameRuntimeStageIdentity(runtimeStageIdentity(stat), runtimeStageIdentity(opened))) {
      runtimeStageFail('changed');
    }
  } catch (error) {
    if (!isWindowsDirectoryHandleFallback(error)) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error;
    }
    if (descriptor !== undefined) closeSync(descriptor);
    descriptor = undefined;
  }
  return { path: canonical, descriptor, identity: runtimeStageIdentity(stat) };
}

/** Revalidate a pinned directory's path and optional descriptor authority. */
export function assertStableRuntimeStageDirectory(directory: StableRuntimeStageDirectory): void {
  const current = lstatSync(directory.path, { bigint: true });
  assertSafeDirectoryStat(current);
  if (!sameDirectoryAuthority(directory.identity, runtimeStageIdentity(current))) {
    runtimeStageFail('changed');
  }
  if (directory.descriptor === undefined) return;
  const opened = fstatSync(directory.descriptor, { bigint: true });
  if (!sameDirectoryAuthority(directory.identity, runtimeStageIdentity(opened))) {
    runtimeStageFail('changed');
  }
}

/** Require and revalidate the stable parent already registered for a path. */
export function requireStableRuntimeStageParent(
  path: string,
  directories: ReadonlyMap<string, StableRuntimeStageDirectory>,
): StableRuntimeStageDirectory {
  const parent = directories.get(dirname(path));
  if (parent === undefined) runtimeStageFail('changed');
  assertStableRuntimeStageDirectory(parent);
  return parent;
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isDirectory()) runtimeStageFail('special-entry');
    fsyncSync(descriptor);
  } catch (error) {
    if (isWindowsDirectoryHandleFallback(error)) return;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Durably sync a stable directory without weakening the Windows fallback. */
export function fsyncStableRuntimeStageParent(directory: StableRuntimeStageDirectory): void {
  assertStableRuntimeStageDirectory(directory);
  if (directory.descriptor === undefined) fsyncDirectory(directory.path);
  else fsyncSync(directory.descriptor);
  assertStableRuntimeStageDirectory(directory);
}

/**
 * Finalize a staged directory's mode while retaining its pinned identity.
 *
 * @throws {Error} When the directory changes or cannot be durably finalized.
 */
export function finalizeStableRuntimeStageDirectoryMode(
  directory: StableRuntimeStageDirectory,
  mode: number,
): StableRuntimeStageDirectory {
  assertStableRuntimeStageDirectory(directory);
  if (directory.descriptor === undefined) {
    assertStableRuntimeStageDirectory(directory);
    chmodSync(directory.path, mode);
    const changedMode = lstatSync(directory.path, { bigint: true });
    if (
      directory.identity.dev !== changedMode.dev ||
      directory.identity.ino !== changedMode.ino ||
      directory.identity.uid !== changedMode.uid
    ) {
      runtimeStageFail('changed');
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
  const observedIdentity = runtimeStageIdentity(observed);
  if (
    directory.identity.dev !== observedIdentity.dev ||
    directory.identity.ino !== observedIdentity.ino ||
    directory.identity.uid !== observedIdentity.uid ||
    Number(observed.mode & 0o777n) !== mode
  ) {
    runtimeStageFail('changed');
  }
  const finalized: StableRuntimeStageDirectory = {
    path: directory.path,
    identity: observedIdentity,
    ...(directory.descriptor === undefined ? {} : { descriptor: directory.descriptor }),
  };
  assertStableRuntimeStageDirectory(finalized);
  return finalized;
}

/** Close each unique directory descriptor exactly once. */
export function closeStableRuntimeStageDirectories(
  directories: ReadonlyMap<string, StableRuntimeStageDirectory>,
): void {
  const descriptors = new Set<number>();
  for (const directory of directories.values()) {
    if (directory.descriptor !== undefined) descriptors.add(directory.descriptor);
  }
  for (const descriptor of descriptors) closeSync(descriptor);
}

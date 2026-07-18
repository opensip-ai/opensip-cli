/**
 * Portable no-follow directory preparation for the user-owned ephemeral cache.
 *
 * Node does not expose mkdirat(2), so this cannot provide isolation from a
 * malicious same-UID process racing pathname components. It does reject static
 * symlinks/non-directories, unexpected owners, unsafe permissions, containment
 * escapes, and parent replacement observed across each bounded creation step.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveUserPaths, type EphemeralProjectPaths, type UserPaths } from './paths.js';

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface OpenDirectory {
  readonly fd: number;
  readonly identity: DirectoryIdentity;
  readonly canonicalPath: string;
}

const CACHE_KEY_PATTERN = /^[a-f0-9]{24}$/u;

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectDirectory(path: string): {
  readonly identity: DirectoryIdentity;
  readonly canonicalPath: string;
} {
  const stat = lstatSync(path, { bigint: true });
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.nlink < 1n ||
    (uid !== undefined && stat.uid !== BigInt(uid)) ||
    (process.platform !== 'win32' && Number(stat.mode & 0o022n) !== 0)
  ) {
    throw new Error('Ephemeral cache directory has an unsafe identity or permission posture');
  }
  return {
    identity: { dev: stat.dev, ino: stat.ino },
    canonicalPath: realpathSync(path),
  };
}

function openDirectory(path: string, expectedCanonicalParent?: string): OpenDirectory {
  const inspected = inspectDirectory(path);
  const fd = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    const openedIdentity = { dev: opened.dev, ino: opened.ino };
    if (
      !opened.isDirectory() ||
      !sameIdentity(inspected.identity, openedIdentity) ||
      (expectedCanonicalParent !== undefined &&
        dirname(inspected.canonicalPath) !== expectedCanonicalParent)
    ) {
      throw new Error('Ephemeral cache directory changed or escaped its expected parent');
    }
    return { fd, identity: openedIdentity, canonicalPath: inspected.canonicalPath };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertOpenDirectoryUnchanged(path: string, opened: OpenDirectory): void {
  const handle = fstatSync(opened.fd, { bigint: true });
  const current = inspectDirectory(path);
  if (
    !sameIdentity(opened.identity, { dev: handle.dev, ino: handle.ino }) ||
    !sameIdentity(opened.identity, current.identity) ||
    current.canonicalPath !== opened.canonicalPath
  ) {
    throw new Error('Ephemeral cache parent changed during directory preparation');
  }
}

function ensureDirectChild(parentDir: string, childDir: string): void {
  if (dirname(childDir) !== parentDir) {
    throw new Error('Ephemeral cache directory is not a direct child of its expected parent');
  }
  const parent = openDirectory(parentDir);
  try {
    try {
      mkdirSync(childDir, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const child = openDirectory(childDir, parent.canonicalPath);
    closeSync(child.fd);
    assertOpenDirectoryUnchanged(parentDir, parent);
  } finally {
    closeSync(parent.fd);
  }
}

function prepareEphemeralRoot(create: boolean): UserPaths | undefined {
  const paths = resolveUserPaths();
  const homeDir = dirname(paths.userHomeDir);
  const directories = [paths.userHomeDir, paths.cacheDir, paths.ephemeralProjectsDir];
  let parentDir = homeDir;
  const home = openDirectory(homeDir);
  closeSync(home.fd);
  for (const directory of directories) {
    if (create) {
      ensureDirectChild(parentDir, directory);
    } else {
      const parent = openDirectory(parentDir);
      try {
        const child = openDirectory(directory, parent.canonicalPath);
        closeSync(child.fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      } finally {
        closeSync(parent.fd);
      }
    }
    parentDir = directory;
  }
  return paths;
}

/** Create and prove the fixed user-cache hierarchy without recursive mkdir. */
export function ensureEphemeralRuntimeRoot(): UserPaths {
  const paths = prepareEphemeralRoot(true);
  if (paths === undefined) throw new Error('Ephemeral cache root could not be prepared');
  return paths;
}

/** Prove an already-existing fixed user-cache hierarchy without creating it. */
export function inspectEphemeralRuntimeRoot(): UserPaths | undefined {
  return prepareEphemeralRoot(false);
}

/** Create and prove one exact cache-key directory under the fixed hierarchy. */
export function ensureEphemeralRuntimeDirectory(paths: EphemeralProjectPaths): UserPaths {
  const userPaths = ensureEphemeralRuntimeRoot();
  const expectedRuntimeDir = join(userPaths.ephemeralProjectsDir, paths.cacheKey);
  if (!CACHE_KEY_PATTERN.test(paths.cacheKey) || paths.runtimeDir !== expectedRuntimeDir) {
    throw new Error('Ephemeral runtime path does not match its cache identity');
  }
  ensureDirectChild(userPaths.ephemeralProjectsDir, paths.runtimeDir);
  return userPaths;
}

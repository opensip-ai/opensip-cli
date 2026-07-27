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

import { coreSystemErrorCatalog } from './error-definition.js';
import { coreErrorCatalog } from './errors/core-error-catalog.js';
import { createToolError } from './errors.js';
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

/**
 * Which hop of the fixed cache hierarchy a refusal happened at.
 *
 * This is the ONLY location detail that leaves the process. The absolute path is deliberately
 * withheld: it contains the user's home directory, and these definitions are `exposure:
 * 'public'` precisely so the refusal is actionable — a public field that carries `$HOME` is
 * how a public exposure becomes a leak.
 */
type CacheHop = 'home' | 'cache' | 'projects' | 'runtime';

const UNSAFE_POSTURE = coreErrorCatalog.require('CORE.EPHEMERAL_CACHE.UNSAFE_POSTURE');
const IDENTITY_CHANGED = coreErrorCatalog.require('CORE.EPHEMERAL_CACHE.IDENTITY_CHANGED');
const PREPARE_FAILED = coreErrorCatalog.require('CORE.EPHEMERAL_CACHE.PREPARE_FAILED');
const PERMISSION = coreSystemErrorCatalog.require('CORE.SYSTEM.PERMISSION');
const RESOURCE = coreSystemErrorCatalog.require('CORE.SYSTEM.RESOURCE');

/** Errnos that mean "the environment refused", not "the cache is unsafe". */
const PERMISSION_ERRNOS = new Set(['EACCES', 'EPERM']);
const RESOURCE_ERRNOS = new Set(['EMFILE', 'ENFILE', 'ENOMEM', 'ENOSPC', 'EIO']);

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Inspect and prove a directory's ownership, type, permissions, and canonical identity.
 *
 * @throws {ToolError} `CORE.EPHEMERAL_CACHE.UNSAFE_POSTURE` when the directory fails its
 * ownership, type or permission posture. `security` kind: refusing IS the guard working, and
 * it must be distinguishable from an I/O fault so an operator knows to inspect rather than
 * retry.
 */
function inspectDirectory(
  path: string,
  hop: CacheHop,
): {
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
    throw createToolError(
      UNSAFE_POSTURE,
      'Ephemeral cache directory has an unsafe identity or permission posture',
      { metadata: { hop, condition: 'unsafe-posture' } },
    );
  }
  return {
    identity: { dev: stat.dev, ino: stat.ino },
    canonicalPath: realpathSync(path),
  };
}

/**
 * Open a proven directory without following a final-component symlink.
 *
 * @throws {ToolError} `CORE.EPHEMERAL_CACHE.IDENTITY_CHANGED` when the opened directory
 * changes identity or escapes its expected parent — a TOCTOU detection, which is the one
 * condition an operator most needs told apart from a plain I/O fault because it can mean
 * another process is racing the cache root.
 */
function openDirectory(
  path: string,
  hop: CacheHop,
  expectedCanonicalParent?: string,
): OpenDirectory {
  const inspected = inspectDirectory(path, hop);
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
      throw createToolError(
        IDENTITY_CHANGED,
        'Ephemeral cache directory changed or escaped its expected parent',
        { metadata: { hop, condition: 'escaped-parent' } },
      );
    }
    return {
      fd,
      identity: openedIdentity,
      canonicalPath: inspected.canonicalPath,
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Confirm that a directory still resolves to the identity held by an open descriptor.
 *
 * @throws {ToolError} `CORE.EPHEMERAL_CACHE.IDENTITY_CHANGED` when the directory or its open
 * handle changes during preparation.
 */
function assertOpenDirectoryUnchanged(path: string, hop: CacheHop, opened: OpenDirectory): void {
  const handle = fstatSync(opened.fd, { bigint: true });
  const current = inspectDirectory(path, hop);
  if (
    !sameIdentity(opened.identity, { dev: handle.dev, ino: handle.ino }) ||
    !sameIdentity(opened.identity, current.identity) ||
    current.canonicalPath !== opened.canonicalPath
  ) {
    throw createToolError(
      IDENTITY_CHANGED,
      'Ephemeral cache parent changed during directory preparation',
      { metadata: { hop, condition: 'parent-replaced' } },
    );
  }
}

/**
 * Create or validate one direct child under a proven parent directory.
 *
 * @throws {ToolError} `CORE.EPHEMERAL_CACHE.IDENTITY_CHANGED` when the child is not direct or
 * cannot be proven, or `CORE.SYSTEM.PERMISSION` / `CORE.SYSTEM.RESOURCE` when the environment
 * refused the creation.
 */
function ensureDirectChild(
  parentDir: string,
  parentHop: CacheHop,
  childDir: string,
  childHop: CacheHop,
): void {
  if (dirname(childDir) !== parentDir) {
    throw createToolError(
      IDENTITY_CHANGED,
      'Ephemeral cache directory is not a direct child of its expected parent',
      { metadata: { hop: childHop, condition: 'not-direct-child' } },
    );
  }
  const parent = openDirectory(parentDir, parentHop);
  try {
    try {
      mkdirSync(childDir, { recursive: false, mode: 0o700 });
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno !== 'EEXIST') throw classifyCacheErrno(error, childHop);
    }
    const child = openDirectory(childDir, childHop, parent.canonicalPath);
    closeSync(child.fd);
    assertOpenDirectoryUnchanged(parentDir, parentHop, parent);
  } finally {
    closeSync(parent.fd);
  }
}

/**
 * Turn a filesystem errno into a registered failure, keeping the three outcomes distinct.
 *
 * Collapsing them into one verdict is what made a full disk, a permission denial and a
 * genuinely unsafe cache posture indistinguishable — and only one of the three is worth
 * inspecting the directory over.
 */
function classifyCacheErrno(error: unknown, hop: CacheHop): unknown {
  const errno = (error as NodeJS.ErrnoException).code;
  if (typeof errno !== 'string') return error;
  let definition;
  if (PERMISSION_ERRNOS.has(errno)) definition = PERMISSION;
  else if (RESOURCE_ERRNOS.has(errno)) definition = RESOURCE;
  else return error;
  // The platform's own message is RETAINED, not replaced. It is the part that says what
  // actually failed ("EACCES: permission denied, mkdir '…'"); a generic sentence plus a
  // buried `cause` would classify the failure while making it less diagnosable than before,
  // which is the opposite of the point. Classification is additive here.
  const message = error instanceof Error ? error.message : `mkdir failed (${errno})`;
  return createToolError(definition, message, { cause: error, metadata: { hop, errno } });
}

/**
 * Resolve — and when `create`, materialize — the ephemeral runtime root.
 * @throws {ToolError} When the root cannot be prepared, or its ownership/permission posture is refused.
 */
function prepareEphemeralRoot(create: boolean): UserPaths | undefined {
  const paths = resolveUserPaths();
  const homeDir = dirname(paths.userHomeDir);
  const hops: readonly (readonly [string, CacheHop])[] = [
    [paths.userHomeDir, 'home'],
    [paths.cacheDir, 'cache'],
    [paths.ephemeralProjectsDir, 'projects'],
  ];
  let parentDir = homeDir;
  let parentHop: CacheHop = 'home';
  const home = openDirectory(homeDir, 'home');
  closeSync(home.fd);
  for (const [directory, hop] of hops) {
    if (create) {
      ensureDirectChild(parentDir, parentHop, directory, hop);
    } else {
      const parent = openDirectory(parentDir, parentHop);
      try {
        const child = openDirectory(directory, hop, parent.canonicalPath);
        closeSync(child.fd);
      } catch (error) {
        // ENOENT keeps its "absent ⇒ undefined" meaning: inspection of a cache that was
        // never created is not a failure. Everything else is classified rather than
        // re-thrown raw, so a permission denial and an exhausted descriptor table stop
        // arriving as the same unclassified value.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw classifyCacheErrno(error, hop);
      } finally {
        closeSync(parent.fd);
      }
    }
    parentDir = directory;
    parentHop = hop;
  }
  return paths;
}

/**
 * Create and prove the fixed user-cache hierarchy without recursive mkdir.
 *
 * @throws {ToolError} `CORE.EPHEMERAL_CACHE.PREPARE_FAILED` when preparation returned no
 * paths, plus any refusal raised by the hops themselves.
 */
export function ensureEphemeralRuntimeRoot(): UserPaths {
  const paths = prepareEphemeralRoot(true);
  if (paths === undefined) {
    throw createToolError(PREPARE_FAILED, 'Ephemeral cache root could not be prepared', {
      metadata: { condition: 'no-paths-after-create' },
    });
  }
  return paths;
}

/** Prove an already-existing fixed user-cache hierarchy without creating it. */
export function inspectEphemeralRuntimeRoot(): UserPaths | undefined {
  return prepareEphemeralRoot(false);
}

/**
 * Create and prove one exact cache-key directory under the fixed hierarchy.
 *
 * @throws {ToolError} `CORE.EPHEMERAL_CACHE.IDENTITY_CHANGED` when the cache key/path pair is
 * inconsistent, plus any refusal raised while proving the directory.
 */
export function ensureEphemeralRuntimeDirectory(paths: EphemeralProjectPaths): UserPaths {
  const userPaths = ensureEphemeralRuntimeRoot();
  const expectedRuntimeDir = join(userPaths.ephemeralProjectsDir, paths.cacheKey);
  if (!CACHE_KEY_PATTERN.test(paths.cacheKey) || paths.runtimeDir !== expectedRuntimeDir) {
    throw createToolError(
      IDENTITY_CHANGED,
      'Ephemeral runtime path does not match its cache identity',
      { metadata: { hop: 'runtime', condition: 'cache-identity-mismatch' } },
    );
  }
  ensureDirectChild(userPaths.ephemeralProjectsDir, 'projects', paths.runtimeDir, 'runtime');
  return userPaths;
}

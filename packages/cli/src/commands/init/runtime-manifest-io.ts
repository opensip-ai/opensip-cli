/** Low-level bounded runtime-tree inspection; journal authority lives in the facade. */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { EPHEMERAL_MARKER_FILE } from '@opensip-cli/core';

import {
  RUNTIME_MANIFEST_MAX_DIGEST_BYTES,
  RUNTIME_MANIFEST_MAX_ENTRIES,
  RUNTIME_MANIFEST_MAX_FILE_BYTES,
  RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES,
  RUNTIME_MANIFEST_MAX_PATH_BYTES,
  RUNTIME_MANIFEST_MAX_SQLITE_SHM_BYTES,
  RUNTIME_MANIFEST_MAX_TOTAL_BYTES,
  RuntimeManifestError,
} from './runtime-manifest-model.js';
import { RuntimePathQueue } from './runtime-path-queue.js';
import {
  assertRuntimeStageOwnershipMarker,
  RUNTIME_STAGE_OWNERSHIP_FILE,
} from './runtime-stage-ownership.js';

import type {
  RuntimeManifestEntry,
  RuntimeTreeManifest,
  RuntimeTreePosture,
} from './runtime-manifest-model.js';
import type { RuntimeStageOwnershipIdentity } from './runtime-stage-ownership.js';
import type { BigIntStats } from 'node:fs';

const READ_CHUNK_BYTES = 64 * 1024;
const DATASTORE_FILE = 'datastore.sqlite';
const DATASTORE_WAL_FILE = `${DATASTORE_FILE}-wal`;
const DATASTORE_SHM_FILE = `${DATASTORE_FILE}-shm`;
const DATASTORE_SIDECARS = new Set([DATASTORE_WAL_FILE, DATASTORE_SHM_FILE]);
const FIXED_TRANSIENT_LOCKS = new Set(['.project-marker.lock', `${DATASTORE_FILE}.write.lock`]);

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

interface DirectoryObservation {
  readonly path: string;
  readonly identity: EntryIdentity;
  readonly children: readonly string[];
}

interface ManifestBudget {
  entries: number;
  discoveredEntries: number;
  totalBytes: number;
  pathBytes: number;
  digestBytes: number;
}

export interface RuntimeManifestIoDependencies {
  readonly enumerateDirectoryNames: (path: string) => Iterable<string>;
}

function fail(reason: ConstructorParameters<typeof RuntimeManifestError>[0]): never {
  throw new RuntimeManifestError(reason);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
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

function safeMode(stat: BigIntStats): number {
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) fail('unsafe-owner');
  const mode = Number(stat.mode & 0o7777n);
  if (stat.isSymbolicLink()) return mode & 0o777;
  if (
    !Number.isSafeInteger(mode) ||
    (process.platform !== 'win32' &&
      ((mode & 0o7000) !== 0 ||
        (mode & 0o022) !== 0 ||
        (stat.isDirectory() && (mode & 0o700) !== 0o700) ||
        (stat.isFile() && (mode & 0o400) === 0)))
  ) {
    fail('mode');
  }
  return mode & 0o777;
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function* enumerateDirectoryNames(path: string): Iterable<string> {
  const directory = opendirSync(path);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      yield entry.name;
    }
  } finally {
    directory.closeSync();
  }
}

const DEFAULT_DEPENDENCIES: RuntimeManifestIoDependencies = Object.freeze({
  enumerateDirectoryNames,
});

function assertSafeEntryName(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    fail('invalid-path');
  }
}

function chargeDiscoveredPath(path: string, budget: ManifestBudget): void {
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes < 1 || bytes > RUNTIME_MANIFEST_MAX_PATH_BYTES) fail('path-cap');
  budget.discoveredEntries += 1;
  if (budget.discoveredEntries > RUNTIME_MANIFEST_MAX_ENTRIES) fail('entry-cap');
  budget.pathBytes += bytes;
  if (budget.pathBytes > RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES) fail('path-cap');
}

function readChildren(
  path: string,
  relativeDirectoryPath: string,
  budget: ManifestBudget,
  dependencies: RuntimeManifestIoDependencies,
  unchargedPath?: string,
): readonly string[] {
  const names: string[] = [];
  for (const name of dependencies.enumerateDirectoryNames(path)) {
    assertSafeEntryName(name);
    const relativePath =
      relativeDirectoryPath.length === 0 ? name : `${relativeDirectoryPath}/${name}`;
    if (relativePath !== unchargedPath) chargeDiscoveredPath(relativePath, budget);
    names.push(name);
  }
  names.sort(bytewise);
  return names;
}

function readChildrenForValidation(
  path: string,
  expectedCount: number,
  dependencies: RuntimeManifestIoDependencies,
): readonly string[] {
  const names: string[] = [];
  for (const name of dependencies.enumerateDirectoryNames(path)) {
    assertSafeEntryName(name);
    names.push(name);
    if (names.length > expectedCount) fail('changed');
  }
  names.sort(bytewise);
  return names;
}

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  );
}

function isOwnedArtifactLock(path: string): boolean {
  return path.startsWith('artifacts/') && path.endsWith('.artifact.lock');
}

function omissionFor(
  path: string,
  posture: RuntimeTreePosture,
  stat: BigIntStats,
  stageOwnership: RuntimeStageOwnershipIdentity | undefined,
): 'omit' | 'include' {
  const marker =
    (posture === 'cache-source' && path === EPHEMERAL_MARKER_FILE) ||
    (posture === 'promotion-stage' &&
      stageOwnership !== undefined &&
      path === RUNTIME_STAGE_OWNERSHIP_FILE);
  const lock = FIXED_TRANSIENT_LOCKS.has(path) || isOwnedArtifactLock(path);
  const sidecar = DATASTORE_SIDECARS.has(path);
  if (!marker && !lock && !sidecar) return 'include';
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail('special-entry');
  safeMode(stat);
  if (
    (path === DATASTORE_WAL_FILE && stat.size !== 0n) ||
    (path === DATASTORE_SHM_FILE &&
      (stat.size < 0n || stat.size > BigInt(RUNTIME_MANIFEST_MAX_SQLITE_SHM_BYTES)))
  ) {
    fail('sqlite-sidecar-nonempty');
  }
  return 'omit';
}

function chargeFileBudget(expected: BigIntStats, budget: ManifestBudget): number {
  if (expected.nlink !== 1n) fail('hardlink');
  if (expected.size > BigInt(RUNTIME_MANIFEST_MAX_FILE_BYTES)) fail('size-cap');
  const sizeBytes = Number(expected.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) fail('size-cap');
  budget.totalBytes += sizeBytes;
  budget.digestBytes += sizeBytes;
  if (budget.totalBytes > RUNTIME_MANIFEST_MAX_TOTAL_BYTES) fail('size-cap');
  if (budget.digestBytes > RUNTIME_MANIFEST_MAX_DIGEST_BYTES) fail('digest-cap');
  return sizeBytes;
}

function hashOpenedFile(descriptor: number, expected: BigIntStats, sizeBytes: number): string {
  const opened = fstatSync(descriptor, { bigint: true });
  if (
    !opened.isFile() ||
    opened.nlink !== 1n ||
    !sameIdentity(identityOf(expected), identityOf(opened))
  ) {
    fail('changed');
  }
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let observed = 0;
  for (;;) {
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    observed += bytesRead;
    digest.update(chunk.subarray(0, bytesRead));
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (observed !== sizeBytes || !sameIdentity(identityOf(opened), identityOf(after))) {
    fail('changed');
  }
  return digest.digest('hex');
}

function readStableFile(
  path: string,
  expected: BigIntStats,
  budget: ManifestBudget,
): {
  readonly sizeBytes: number;
  readonly sha256: string;
} {
  const sizeBytes = chargeFileBudget(expected, budget);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return {
      sizeBytes,
      sha256: hashOpenedFile(descriptor, expected, sizeBytes),
    };
  } catch (error) {
    if (error instanceof RuntimeManifestError) throw error;
    if (hasCode(error, 'ELOOP')) fail('special-entry');
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readSafeSymlink(root: string, path: string, expected: BigIntStats): string {
  const target = readlinkSync(path);
  if (target.length === 0 || target.includes('\0') || isAbsolute(target)) fail('symlink-invalid');
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
  if (!after.isSymbolicLink() || !sameIdentity(identityOf(expected), identityOf(after))) {
    fail('changed');
  }
  return target;
}

function addDigestEntry(hash: ReturnType<typeof createHash>, entry: RuntimeManifestEntry): void {
  const body = Buffer.from(JSON.stringify(entry), 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(body.length);
  hash.update(length).update(body);
}

function assertDirectoriesStable(
  observations: readonly DirectoryObservation[],
  dependencies: RuntimeManifestIoDependencies,
): void {
  for (const observation of observations) {
    const stat = lstatSync(observation.path, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !sameIdentity(observation.identity, identityOf(stat))
    ) {
      fail('changed');
    }
    const children = readChildrenForValidation(
      observation.path,
      observation.children.length,
      dependencies,
    );
    if (
      children.length !== observation.children.length ||
      children.some((child, index) => child !== observation.children[index])
    ) {
      fail('changed');
    }
  }
}

interface RuntimeWalkState {
  readonly canonicalRoot: string;
  readonly posture: RuntimeTreePosture;
  readonly stageOwnership?: RuntimeStageOwnershipIdentity;
  readonly dependencies: RuntimeManifestIoDependencies;
  readonly queue: RuntimePathQueue;
  readonly directories: DirectoryObservation[];
  readonly entries: RuntimeManifestEntry[];
  readonly budget: ManifestBudget;
}

function inspectNextEntry(state: RuntimeWalkState): boolean {
  const next = state.queue.pop();
  if (next === undefined) return false;
  const stat = lstatSync(next.absolutePath, { bigint: true });
  if (omissionFor(next.relativePath, state.posture, stat, state.stageOwnership) === 'omit')
    return true;
  state.budget.entries += 1;
  if (state.budget.entries > RUNTIME_MANIFEST_MAX_ENTRIES) fail('entry-cap');
  const mode = safeMode(stat);

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    const children = readChildren(
      next.absolutePath,
      next.relativePath,
      state.budget,
      state.dependencies,
    );
    state.directories.push({
      path: next.absolutePath,
      identity: identityOf(stat),
      children,
    });
    state.entries.push({ path: next.relativePath, kind: 'directory', mode });
    for (const child of children) {
      state.queue.push({
        relativePath: `${next.relativePath}/${child}`,
        absolutePath: join(next.absolutePath, child),
      });
    }
    return true;
  }
  if (stat.isFile() && !stat.isSymbolicLink()) {
    const content = readStableFile(next.absolutePath, stat, state.budget);
    state.entries.push({
      path: next.relativePath,
      kind: 'file',
      mode,
      ...content,
    });
    return true;
  }
  if (stat.isSymbolicLink()) {
    const target = readSafeSymlink(state.canonicalRoot, next.absolutePath, stat);
    state.entries.push({
      path: next.relativePath,
      kind: 'symlink',
      mode,
      target,
      targetSha256: createHash('sha256').update(target, 'utf8').digest('hex'),
    });
    return true;
  }
  fail('special-entry');
}

/** Inspect one stable runtime tree without following filesystem entries. */
export function inspectRuntimeTree(
  runtimeDir: string,
  posture: RuntimeTreePosture,
  dependencyOverrides: Partial<RuntimeManifestIoDependencies> = {},
  stageOwnership?: RuntimeStageOwnershipIdentity,
): RuntimeTreeManifest {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  if ((posture === 'promotion-stage') !== (stageOwnership !== undefined)) {
    fail('stage-ownership');
  }
  const canonicalRoot = realpathSync(runtimeDir);
  const initialRoot = lstatSync(runtimeDir, { bigint: true });
  if (!initialRoot.isDirectory() || initialRoot.isSymbolicLink()) fail('special-entry');
  const rootMode = safeMode(initialRoot);
  if (stageOwnership !== undefined) {
    assertRuntimeStageOwnershipMarker(canonicalRoot, stageOwnership);
  }
  const budget: ManifestBudget = {
    entries: 0,
    discoveredEntries: 0,
    totalBytes: 0,
    pathBytes: 0,
    digestBytes: 0,
  };
  const rootChildren = readChildren(
    canonicalRoot,
    '',
    budget,
    dependencies,
    stageOwnership === undefined ? undefined : RUNTIME_STAGE_OWNERSHIP_FILE,
  );
  const state: RuntimeWalkState = {
    canonicalRoot,
    posture,
    ...(stageOwnership === undefined ? {} : { stageOwnership }),
    dependencies,
    queue: new RuntimePathQueue(
      rootChildren.map((name) => ({
        relativePath: name,
        absolutePath: join(canonicalRoot, name),
      })),
    ),
    directories: [
      {
        path: canonicalRoot,
        identity: identityOf(initialRoot),
        children: rootChildren,
      },
    ],
    entries: [],
    budget,
  };
  while (inspectNextEntry(state)) {
    // The bounded priority queue establishes bytewise relative-path order.
  }

  assertDirectoriesStable(state.directories, dependencies);
  if (stageOwnership !== undefined) {
    assertRuntimeStageOwnershipMarker(canonicalRoot, stageOwnership);
  }
  const digest = createHash('sha256').update('opensip-runtime-manifest\0v1\0');
  digest.update(String(rootMode)).update('\0');
  for (const entry of state.entries) addDigestEntry(digest, entry);
  return {
    version: 1,
    rootMode,
    sha256: digest.digest('hex'),
    entryCount: state.entries.length,
    fileCount: state.entries.filter((entry) => entry.kind === 'file').length,
    directoryCount: state.entries.filter((entry) => entry.kind === 'directory').length,
    symlinkCount: state.entries.filter((entry) => entry.kind === 'symlink').length,
    totalBytes: state.budget.totalBytes,
    entries: state.entries,
  };
}

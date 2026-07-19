/** Low-level bounded runtime-tree inspection; journal authority lives in the facade. */

import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { EPHEMERAL_MARKER_FILE } from '@opensip-cli/core';

import {
  readSafeRuntimeManifestSymlink,
  readStableRuntimeManifestFile,
  runtimeManifestEntryIdentity,
  safeRuntimeManifestMode,
  sameRuntimeManifestEntryIdentity,
  type RuntimeManifestBudget,
  type RuntimeManifestEntryIdentity,
} from './runtime-manifest-entry-io.js';
import {
  RUNTIME_MANIFEST_MAX_ENTRIES,
  RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES,
  RUNTIME_MANIFEST_MAX_PATH_BYTES,
  RUNTIME_MANIFEST_MAX_SQLITE_SHM_BYTES,
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

const DATASTORE_FILE = 'datastore.sqlite';
const DATASTORE_WAL_FILE = `${DATASTORE_FILE}-wal`;
const DATASTORE_SHM_FILE = `${DATASTORE_FILE}-shm`;
const DATASTORE_SIDECARS = new Set([DATASTORE_WAL_FILE, DATASTORE_SHM_FILE]);
const FIXED_TRANSIENT_LOCKS = new Set(['.project-marker.lock', `${DATASTORE_FILE}.write.lock`]);

interface DirectoryObservation {
  readonly path: string;
  readonly identity: RuntimeManifestEntryIdentity;
  readonly children: readonly string[];
}

export interface RuntimeManifestIoDependencies {
  readonly enumerateDirectoryNames: (path: string) => Iterable<string>;
}

/** @throws {RuntimeManifestError} Always; runtime-tree inspection cannot remain authoritative. */
function fail(reason: ConstructorParameters<typeof RuntimeManifestError>[0]): never {
  throw new RuntimeManifestError(reason);
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

function chargeDiscoveredPath(path: string, budget: RuntimeManifestBudget): void {
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
  budget: RuntimeManifestBudget,
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
  safeRuntimeManifestMode(stat);
  if (
    (path === DATASTORE_WAL_FILE && stat.size !== 0n) ||
    (path === DATASTORE_SHM_FILE &&
      (stat.size < 0n || stat.size > BigInt(RUNTIME_MANIFEST_MAX_SQLITE_SHM_BYTES)))
  ) {
    fail('sqlite-sidecar-nonempty');
  }
  return 'omit';
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
      !sameRuntimeManifestEntryIdentity(observation.identity, runtimeManifestEntryIdentity(stat))
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
  readonly budget: RuntimeManifestBudget;
}

function inspectNextEntry(state: RuntimeWalkState): boolean {
  const next = state.queue.pop();
  if (next === undefined) return false;
  const stat = lstatSync(next.absolutePath, { bigint: true });
  if (omissionFor(next.relativePath, state.posture, stat, state.stageOwnership) === 'omit')
    return true;
  state.budget.entries += 1;
  if (state.budget.entries > RUNTIME_MANIFEST_MAX_ENTRIES) fail('entry-cap');
  const mode = safeRuntimeManifestMode(stat);

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    const children = readChildren(
      next.absolutePath,
      next.relativePath,
      state.budget,
      state.dependencies,
    );
    state.directories.push({
      path: next.absolutePath,
      identity: runtimeManifestEntryIdentity(stat),
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
    const content = readStableRuntimeManifestFile(next.absolutePath, stat, state.budget);
    state.entries.push({
      path: next.relativePath,
      kind: 'file',
      mode,
      ...content,
    });
    return true;
  }
  if (stat.isSymbolicLink()) {
    const target = readSafeRuntimeManifestSymlink(state.canonicalRoot, next.absolutePath, stat);
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
  const rootMode = safeRuntimeManifestMode(initialRoot);
  if (stageOwnership !== undefined) {
    assertRuntimeStageOwnershipMarker(canonicalRoot, stageOwnership);
  }
  const budget: RuntimeManifestBudget = {
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
        identity: runtimeManifestEntryIdentity(initialRoot),
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

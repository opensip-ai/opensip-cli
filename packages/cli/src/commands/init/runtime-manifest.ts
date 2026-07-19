/**
 * Verified whole-runtime manifests and journal-authorized stage copies.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { resolveUserPaths } from '@opensip-cli/core';
import { inspectSqliteFile, type SqliteIntegrityResult } from '@opensip-cli/datastore';

import {
  compareRuntimeManifests,
  runtimeManifestIdentityEqual,
  sameRuntimeManifestEntry,
} from './runtime-manifest-comparison.js';
import { inspectRuntimeTree } from './runtime-manifest-io.js';
import { RuntimeManifestError } from './runtime-manifest-model.js';
import { RUNTIME_PROMOTION_CACHE_KEY_PATTERN } from './runtime-promotion-journal-types.js';
import { assertRuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';
import { materializeRuntimeStage } from './runtime-stage-io.js';
import { RUNTIME_STAGE_OWNERSHIP_FILE } from './runtime-stage-ownership.js';

import type {
  RuntimeManifestEntry,
  RuntimeTreeManifest,
  RuntimeTreePosture,
} from './runtime-manifest-model.js';
import type { RuntimeManifestIdentity } from './runtime-promotion-journal-schema.js';
import type { RuntimePromotionRootIdentity } from './runtime-promotion-journal-types.js';
import type {
  DurableOpenPromotionJournal,
  RuntimePromotionJournalController,
  RuntimeStageMaterializationIdentity,
} from './runtime-promotion-journal.js';
import type { RuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';
import type { RuntimeStageOwnershipIdentity } from './runtime-stage-ownership.js';
import type { RuntimeExclusiveLease } from '@opensip-cli/core';

export {
  RUNTIME_MANIFEST_DIFF_SAMPLE_LIMIT,
  RUNTIME_MANIFEST_MAX_DIGEST_BYTES,
  RUNTIME_MANIFEST_MAX_ENTRIES,
  RUNTIME_MANIFEST_MAX_FILE_BYTES,
  RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES,
  RUNTIME_MANIFEST_MAX_PATH_BYTES,
  RUNTIME_MANIFEST_MAX_SQLITE_SHM_BYTES,
  RUNTIME_MANIFEST_MAX_TOTAL_BYTES,
  isRuntimeManifestReleaseUnsafe,
  RuntimeManifestError,
} from './runtime-manifest-model.js';
export {
  assertRuntimeStageOwnershipMarker,
  encodeRuntimeStageOwnershipMarker,
  RUNTIME_STAGE_OWNERSHIP_FILE,
} from './runtime-stage-ownership.js';
export type {
  RuntimeManifestEntry,
  RuntimeManifestFailureReason,
  RuntimeTreePosture,
} from './runtime-manifest-model.js';
export type { RuntimeStageOwnershipIdentity } from './runtime-stage-ownership.js';
export type { RuntimeManifestIdentity } from './runtime-promotion-journal-schema.js';
export {
  compareRuntimeManifests,
  runtimeManifestIdentityEqual,
} from './runtime-manifest-comparison.js';
export type { RuntimeManifestDifference } from './runtime-manifest-comparison.js';

const DATASTORE_FILE = 'datastore.sqlite';
const INVALID_PATH = 'invalid-path';

export interface VerifiedRuntimeManifest {
  readonly identity: RuntimeManifestIdentity;
  /** Bounded by {@link RUNTIME_MANIFEST_MAX_ENTRIES}; never journaled or rendered. */
  readonly entries: readonly RuntimeManifestEntry[];
}

export type RuntimeManifestCheckpoint =
  | 'after-source-inspection'
  | 'before-stage-materialization'
  | 'after-stage-materialization'
  | 'after-source-reinspection';

export interface RuntimeManifestDependencies {
  readonly inspectTree: (
    runtimeDir: string,
    posture: RuntimeTreePosture,
    stageOwnership?: RuntimeStageOwnershipIdentity,
  ) => RuntimeTreeManifest;
  readonly inspectSqlite: (path: string) => SqliteIntegrityResult;
  readonly materialize: (
    sourceDir: string,
    destinationParent: string,
    stageBasename: string,
    source: RuntimeTreeManifest,
    ownership: RuntimeStageMaterializationIdentity,
    sourceRootIdentity: RuntimePromotionRootIdentity,
  ) => string;
  readonly checkpoint?: (checkpoint: RuntimeManifestCheckpoint) => void;
}

export interface CopyRuntimeToStageInput {
  readonly controller: RuntimePromotionJournalController;
  readonly receipt: DurableOpenPromotionJournal;
  readonly sourceDir: string;
  readonly sourcePosture: 'cache-source';
  readonly destinationParent: string;
  readonly stageBasename: string;
  readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
  readonly lease: RuntimeExclusiveLease;
}

export interface VerifiedRuntimeStage {
  readonly stageDir: string;
  readonly source: VerifiedRuntimeManifest;
  readonly stage: VerifiedRuntimeManifest;
}

const DEFAULT_DEPENDENCIES: RuntimeManifestDependencies = Object.freeze({
  inspectTree: (
    runtimeDir: string,
    posture: RuntimeTreePosture,
    stageOwnership?: RuntimeStageOwnershipIdentity,
  ) => inspectRuntimeTree(runtimeDir, posture, {}, stageOwnership),
  inspectSqlite: inspectSqliteFile,
  materialize: (
    sourceDir: string,
    destinationParent: string,
    stageBasename: string,
    source: RuntimeTreeManifest,
    ownership: RuntimeStageMaterializationIdentity,
    sourceRootIdentity: RuntimePromotionRootIdentity,
  ) =>
    materializeRuntimeStage(sourceDir, destinationParent, stageBasename, source, ownership, {
      expectedSourceRootIdentity: sourceRootIdentity,
    }),
});

/** @throws {RuntimeManifestError} Always; runtime-manifest authority cannot be established. */
function fail(reason: ConstructorParameters<typeof RuntimeManifestError>[0]): never {
  throw new RuntimeManifestError(reason);
}

function assertCopyProjectRoot(input: CopyRuntimeToStageInput): void {
  assertRuntimePromotionProjectRootAuthority({
    lease: input.lease,
    authority: input.projectRootAuthority,
  });
}

function copyDestinationParent(input: CopyRuntimeToStageInput): string {
  const expected = join(input.projectRootAuthority.projectRoot, 'opensip-cli');
  if (input.destinationParent !== expected) fail(INVALID_PATH);
  return expected;
}

async function copySourceAuthority(input: CopyRuntimeToStageInput): Promise<{
  readonly sourceDir: string;
  readonly manifest: RuntimeManifestIdentity;
  readonly rootIdentity: RuntimePromotionRootIdentity;
}> {
  const journal = await input.controller.verifyOpen(input.receipt);
  if (
    journal.route !== 'promote-cache' ||
    journal.source.cacheKey === null ||
    journal.source.classification === 'none' ||
    !RUNTIME_PROMOTION_CACHE_KEY_PATTERN.test(journal.source.cacheKey)
  ) {
    fail(INVALID_PATH);
  }
  if (journal.source.rootIdentity === null) fail('changed');
  let canonicalCacheRoot: string;
  try {
    canonicalCacheRoot = realpathSync(resolveUserPaths().ephemeralProjectsDir);
  } catch {
    fail(INVALID_PATH);
  }
  const expected = join(canonicalCacheRoot, journal.source.cacheKey);
  if (input.sourceDir !== expected) fail(INVALID_PATH);

  let before: ReturnType<typeof lstatSync>;
  let canonicalExpected: string;
  let after: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(expected, { bigint: true });
    canonicalExpected = realpathSync(expected);
    after = lstatSync(expected, { bigint: true });
  } catch {
    fail(INVALID_PATH);
  }
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    canonicalExpected !== expected ||
    !after.isDirectory() ||
    after.isSymbolicLink()
  ) {
    fail(INVALID_PATH);
  }
  const rootIdentity = journal.source.rootIdentity;
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.dev.toString() !== rootIdentity.device ||
    before.ino.toString() !== rootIdentity.inode
  ) {
    fail('changed');
  }
  if (journal.manifests.source === null) fail('changed');
  return {
    sourceDir: canonicalExpected,
    manifest: journal.manifests.source,
    rootIdentity,
  };
}

function verifiedRuntimeTree(manifest: VerifiedRuntimeManifest): RuntimeTreeManifest {
  return {
    version: 1,
    rootMode: manifest.identity.rootMode,
    sha256: manifest.identity.digest,
    entryCount: manifest.entries.length,
    fileCount: manifest.identity.fileCount,
    directoryCount: manifest.identity.directoryCount,
    symlinkCount: manifest.identity.symlinkCount,
    totalBytes: manifest.identity.totalBytes,
    entries: manifest.entries,
  };
}

function assertNoReservedStageMarker(manifest: VerifiedRuntimeManifest): void {
  if (manifest.entries.some((entry) => entry.path === RUNTIME_STAGE_OWNERSHIP_FILE)) {
    fail('stage-ownership');
  }
}

function allSidecarsAbsent(result: SqliteIntegrityResult): boolean {
  const sidecars = result.sidecars;
  return (
    sidecars.before.wal === 'absent' &&
    sidecars.before.shm === 'absent' &&
    sidecars.after.wal === 'absent' &&
    sidecars.after.shm === 'absent'
  );
}

/** @throws {RuntimeManifestError} When SQLite integrity or close authority cannot be proven. */
function sqliteIdentity(
  runtimeDir: string,
  tree: RuntimeTreeManifest,
  inspect: RuntimeManifestDependencies['inspectSqlite'],
): RuntimeManifestIdentity['sqlite'] {
  let result: SqliteIntegrityResult;
  try {
    result = inspect(join(runtimeDir, DATASTORE_FILE));
  } catch (error) {
    // A foreign/future inspector can throw after acquiring its native handle.
    // Without an explicit close result, retaining the lifecycle lease is the
    // only conservative disposition.
    throw new RuntimeManifestError('sqlite-close-unproven', {
      cause: error,
      releaseSafe: false,
    });
  }
  const entry = tree.entries.find((candidate) => candidate.path === DATASTORE_FILE);
  if (result.status === 'absent') {
    if (entry !== undefined || !allSidecarsAbsent(result)) fail('sqlite-absent-with-sidecar');
    return { status: 'absent' };
  }
  if (result.status === 'unsupported') fail('sqlite-unsupported');
  if (result.status === 'unreadable' && result.reason === 'native-close-failed') {
    throw new RuntimeManifestError('sqlite-native-close-failed', {
      releaseSafe: false,
    });
  }
  if (result.status !== 'valid') fail('sqlite-invalid');
  if (
    entry?.kind !== 'file' ||
    entry.sizeBytes !== result.sizeBytes ||
    entry.sha256 !== result.sha256
  ) {
    fail('sqlite-mismatch');
  }
  return {
    status: 'verified',
    sha256: result.sha256,
    userVersion: result.userVersion,
  };
}

function sameTree(left: RuntimeTreeManifest, right: RuntimeTreeManifest): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.rootMode === right.rootMode &&
    left.entryCount === right.entryCount &&
    left.fileCount === right.fileCount &&
    left.directoryCount === right.directoryCount &&
    left.symlinkCount === right.symlinkCount &&
    left.totalBytes === right.totalBytes &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => {
      const other = right.entries[index];
      return other !== undefined && sameRuntimeManifestEntry(entry, other);
    })
  );
}

function toIdentity(
  tree: RuntimeTreeManifest,
  sqlite: RuntimeManifestIdentity['sqlite'],
): RuntimeManifestIdentity {
  return {
    digest: tree.sha256,
    rootMode: tree.rootMode,
    fileCount: tree.fileCount,
    directoryCount: tree.directoryCount,
    symlinkCount: tree.symlinkCount,
    totalBytes: tree.totalBytes,
    sqlite,
  };
}

/** Inspect a stable tree and prove its SQLite file is valid, closed, and supported. */
export function inspectVerifiedRuntimeManifest(
  runtimeDir: string,
  posture: RuntimeTreePosture,
  dependencyOverrides: Partial<RuntimeManifestDependencies> = {},
  stageOwnership?: RuntimeStageOwnershipIdentity,
): VerifiedRuntimeManifest {
  if ((posture === 'promotion-stage') !== (stageOwnership !== undefined)) {
    fail('stage-ownership');
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const before = dependencies.inspectTree(runtimeDir, posture, stageOwnership);
  const sqlite = sqliteIdentity(runtimeDir, before, dependencies.inspectSqlite);
  const after = dependencies.inspectTree(runtimeDir, posture, stageOwnership);
  if (!sameTree(before, after)) fail('changed');
  return { identity: toIdentity(after, sqlite), entries: after.entries };
}

/**
 * Copy and verify a runtime stage only after the controller proves a matching
 * durable write-ahead intent.
 */
export async function copyRuntimeToStage(
  input: CopyRuntimeToStageInput,
  dependencyOverrides: Partial<RuntimeManifestDependencies> = {},
): Promise<VerifiedRuntimeStage> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  input.controller.assertBoundLease(input.lease);
  assertCopyProjectRoot(input);
  const destinationParent = copyDestinationParent(input);
  const sourceAuthority = await copySourceAuthority(input);
  const { sourceDir } = sourceAuthority;
  assertCopyProjectRoot(input);
  const source = inspectVerifiedRuntimeManifest(sourceDir, input.sourcePosture, dependencies);
  if (!runtimeManifestIdentityEqual(sourceAuthority.manifest, source.identity)) {
    fail('changed');
  }
  assertNoReservedStageMarker(source);
  dependencies.checkpoint?.('after-source-inspection');
  assertCopyProjectRoot(input);
  const authority = await input.controller.authorizeRuntimeStage(
    input.receipt,
    input.stageBasename,
  );
  const ownership = input.controller.assertRuntimeStageAuthority(authority, input.stageBasename);
  dependencies.checkpoint?.('before-stage-materialization');
  assertCopyProjectRoot(input);
  const sourceTree = verifiedRuntimeTree(source);
  const stageDir = dependencies.materialize(
    sourceDir,
    destinationParent,
    input.stageBasename,
    sourceTree,
    ownership,
    sourceAuthority.rootIdentity,
  );
  assertCopyProjectRoot(input);
  dependencies.checkpoint?.('after-stage-materialization');
  assertCopyProjectRoot(input);
  const sourceAfter = inspectVerifiedRuntimeManifest(sourceDir, input.sourcePosture, dependencies);
  dependencies.checkpoint?.('after-source-reinspection');
  assertCopyProjectRoot(input);
  if (!runtimeManifestIdentityEqual(source.identity, sourceAfter.identity)) fail('changed');
  const stage = inspectVerifiedRuntimeManifest(
    stageDir,
    'promotion-stage',
    dependencies,
    ownership,
  );
  if (!compareRuntimeManifests(sourceAfter, stage).equal) fail('changed');
  assertCopyProjectRoot(input);
  return { stageDir, source: sourceAfter, stage };
}

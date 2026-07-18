/**
 * Verified whole-runtime manifests and journal-authorized stage copies.
 */

import { join } from 'node:path';

import { inspectSqliteFile, type SqliteIntegrityResult } from '@opensip-cli/datastore';

import { inspectRuntimeTree } from './runtime-manifest-io.js';
import {
  RUNTIME_MANIFEST_DIFF_SAMPLE_LIMIT,
  RuntimeManifestError,
} from './runtime-manifest-model.js';
import { materializeRuntimeStage } from './runtime-stage-io.js';
import { RUNTIME_STAGE_OWNERSHIP_FILE } from './runtime-stage-ownership.js';

import type {
  RuntimeManifestEntry,
  RuntimeTreeManifest,
  RuntimeTreePosture,
} from './runtime-manifest-model.js';
import type { RuntimeManifestIdentity } from './runtime-promotion-journal-schema.js';
import type {
  DurableOpenPromotionJournal,
  RuntimePromotionJournalController,
  RuntimeStageMaterializationIdentity,
} from './runtime-promotion-journal.js';
import type { RuntimeStageOwnershipIdentity } from './runtime-stage-ownership.js';

export {
  RUNTIME_MANIFEST_DIFF_SAMPLE_LIMIT,
  RUNTIME_MANIFEST_MAX_DIGEST_BYTES,
  RUNTIME_MANIFEST_MAX_ENTRIES,
  RUNTIME_MANIFEST_MAX_FILE_BYTES,
  RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES,
  RUNTIME_MANIFEST_MAX_PATH_BYTES,
  RUNTIME_MANIFEST_MAX_SQLITE_SHM_BYTES,
  RUNTIME_MANIFEST_MAX_TOTAL_BYTES,
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

const DATASTORE_FILE = 'datastore.sqlite';

export interface VerifiedRuntimeManifest {
  readonly identity: RuntimeManifestIdentity;
  /** Bounded by {@link RUNTIME_MANIFEST_MAX_ENTRIES}; never journaled or rendered. */
  readonly entries: readonly RuntimeManifestEntry[];
}

export interface RuntimeManifestDifference {
  readonly equal: boolean;
  readonly onlyLeft: number;
  readonly onlyRight: number;
  readonly changed: number;
  readonly truncated: boolean;
  readonly samples: readonly {
    readonly path: string;
    readonly difference: 'only-left' | 'only-right' | 'changed';
  }[];
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
  ) => string;
  readonly checkpoint?: (checkpoint: RuntimeManifestCheckpoint) => void;
}

export interface CopyRuntimeToStageInput {
  readonly controller: RuntimePromotionJournalController;
  readonly receipt: DurableOpenPromotionJournal;
  readonly sourceDir: string;
  readonly sourcePosture: Extract<RuntimeTreePosture, 'cache-source' | 'project-runtime'>;
  readonly destinationParent: string;
  readonly stageBasename: string;
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
  materialize: materializeRuntimeStage,
});

function fail(reason: ConstructorParameters<typeof RuntimeManifestError>[0]): never {
  throw new RuntimeManifestError(reason);
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

function sqliteIdentity(
  runtimeDir: string,
  tree: RuntimeTreeManifest,
  inspect: RuntimeManifestDependencies['inspectSqlite'],
): RuntimeManifestIdentity['sqlite'] {
  const result = inspect(join(runtimeDir, DATASTORE_FILE));
  const entry = tree.entries.find((candidate) => candidate.path === DATASTORE_FILE);
  if (result.status === 'absent') {
    if (entry !== undefined || !allSidecarsAbsent(result)) fail('sqlite-absent-with-sidecar');
    return { status: 'absent' };
  }
  if (result.status === 'unsupported') fail('sqlite-unsupported');
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

function sameEntry(left: RuntimeManifestEntry, right: RuntimeManifestEntry): boolean {
  if (left.kind !== right.kind || left.path !== right.path || left.mode !== right.mode)
    return false;
  if (left.kind === 'directory' || right.kind === 'directory') {
    return left.kind === 'directory' && right.kind === 'directory';
  }
  if (left.kind === 'file' || right.kind === 'file') {
    return (
      left.kind === 'file' &&
      right.kind === 'file' &&
      left.sizeBytes === right.sizeBytes &&
      left.sha256 === right.sha256
    );
  }
  return left.target === right.target && left.targetSha256 === right.targetSha256;
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
      return other !== undefined && sameEntry(entry, other);
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

export function runtimeManifestIdentityEqual(
  left: RuntimeManifestIdentity,
  right: RuntimeManifestIdentity,
): boolean {
  return (
    left.digest === right.digest &&
    left.rootMode === right.rootMode &&
    left.fileCount === right.fileCount &&
    left.directoryCount === right.directoryCount &&
    left.symlinkCount === right.symlinkCount &&
    left.totalBytes === right.totalBytes &&
    (left.sqlite.status === 'absent'
      ? right.sqlite.status === 'absent'
      : right.sqlite.status === 'verified' &&
        left.sqlite.sha256 === right.sqlite.sha256 &&
        left.sqlite.userVersion === right.sqlite.userVersion)
  );
}

/** Return only bounded path samples even when the complete manifests are large. */
export function compareRuntimeManifests(
  left: VerifiedRuntimeManifest,
  right: VerifiedRuntimeManifest,
): RuntimeManifestDifference {
  let onlyLeft = 0;
  let onlyRight = 0;
  let changed = 0;
  const samples: RuntimeManifestDifference['samples'][number][] = [];
  const sample = (
    path: string,
    difference: RuntimeManifestDifference['samples'][number]['difference'],
  ): void => {
    if (samples.length < RUNTIME_MANIFEST_DIFF_SAMPLE_LIMIT) samples.push({ path, difference });
  };

  const leftByPath = new Map(left.entries.map((entry) => [entry.path, entry]));
  const rightByPath = new Map(right.entries.map((entry) => [entry.path, entry]));
  for (const leftEntry of left.entries) {
    const rightEntry = rightByPath.get(leftEntry.path);
    if (rightEntry === undefined) {
      onlyLeft += 1;
      sample(leftEntry.path, 'only-left');
      continue;
    }
    if (!sameEntry(leftEntry, rightEntry)) {
      changed += 1;
      sample(leftEntry.path, 'changed');
    }
  }
  for (const rightEntry of right.entries) {
    if (leftByPath.has(rightEntry.path)) continue;
    onlyRight += 1;
    sample(rightEntry.path, 'only-right');
  }
  const differenceCount = onlyLeft + onlyRight + changed;
  const equal =
    differenceCount === 0 && runtimeManifestIdentityEqual(left.identity, right.identity);
  return {
    equal,
    onlyLeft,
    onlyRight,
    changed,
    truncated: differenceCount > samples.length,
    samples,
  };
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
  const source = inspectVerifiedRuntimeManifest(input.sourceDir, input.sourcePosture, dependencies);
  assertNoReservedStageMarker(source);
  dependencies.checkpoint?.('after-source-inspection');
  const authority = await input.controller.authorizeRuntimeStage(
    input.receipt,
    input.stageBasename,
  );
  const ownership = input.controller.assertRuntimeStageAuthority(authority, input.stageBasename);
  dependencies.checkpoint?.('before-stage-materialization');
  const sourceTree = dependencies.inspectTree(input.sourceDir, input.sourcePosture);
  const stageDir = dependencies.materialize(
    input.sourceDir,
    input.destinationParent,
    input.stageBasename,
    sourceTree,
    ownership,
  );
  dependencies.checkpoint?.('after-stage-materialization');
  const sourceAfter = inspectVerifiedRuntimeManifest(
    input.sourceDir,
    input.sourcePosture,
    dependencies,
  );
  dependencies.checkpoint?.('after-source-reinspection');
  if (!runtimeManifestIdentityEqual(source.identity, sourceAfter.identity)) fail('changed');
  const stage = inspectVerifiedRuntimeManifest(
    stageDir,
    'promotion-stage',
    dependencies,
    ownership,
  );
  if (!compareRuntimeManifests(sourceAfter, stage).equal) fail('changed');
  return { stageDir, source: sourceAfter, stage };
}

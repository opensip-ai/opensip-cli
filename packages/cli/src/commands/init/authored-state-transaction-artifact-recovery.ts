import { lstatSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  encodeOwner,
  expectedBlobNames,
  ownerFor,
  pathPresent,
} from './authored-state-transaction-artifacts.js';
import {
  assertStableAuthoredRoot,
  authoredTransactionFailure,
  fsyncDirectory,
  readBoundedAuthoredDirectory,
  readStableArtifactFile,
  type StableAuthoredRoot,
} from './authored-state-transaction-fs.js';
import { AUTHORED_ARTIFACT_OWNER_FILE } from './authored-state-transaction-types.js';
import { INIT_AUTHORED_PLAN_CAPS } from './init-authored-plan-types.js';

import type {
  AuthoredArtifactOwner,
  AuthoredArtifactPaths,
  AuthoredArtifactRole,
} from './authored-state-transaction-types.js';
import type { AuthoredReplayManifest } from './init-authored-plan.js';
import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';

type MarkerState = 'absent' | 'partial' | 'exact';

interface RecoverableBlobRoot {
  readonly marker: MarkerState;
  readonly hasBlobDirectory: boolean;
  readonly blobNames: readonly string[];
}

function assertRecoverableRoot(rootPath: string): void {
  const root = lstatSync(rootPath, { bigint: true });
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    Number(root.mode & 0o777n) !== 0o700 ||
    (uid !== undefined && root.uid !== uid)
  ) {
    authoredTransactionFailure('an incomplete authored root is unsafe');
  }
}

function inspectRecoverableMarker(
  rootPath: string,
  expected: AuthoredArtifactOwner,
  rootNames: Set<string>,
): MarkerState {
  if (!rootNames.delete(AUTHORED_ARTIFACT_OWNER_FILE)) {
    if (rootNames.size > 0) {
      authoredTransactionFailure('an ownerless authored root has unexpected entries');
    }
    return 'absent';
  }
  const marker = readStableArtifactFile(join(rootPath, AUTHORED_ARTIFACT_OWNER_FILE));
  const expectedBytes = encodeOwner(expected);
  const observedBytes = marker.bytes.toString('utf8');
  if (
    marker.bytes.length > Buffer.byteLength(expectedBytes, 'utf8') ||
    !expectedBytes.startsWith(observedBytes)
  ) {
    authoredTransactionFailure('an incomplete authored owner marker is not a canonical prefix');
  }
  if (observedBytes !== expectedBytes) {
    if (rootNames.size > 0) {
      authoredTransactionFailure('a partial authored owner marker has unexpected siblings');
    }
    return 'partial';
  }
  return 'exact';
}

function inspectRecoverableBlobDirectory(
  rootPath: string,
  kind: 'desired' | 'preimage',
  manifest: AuthoredReplayManifest,
): readonly string[] {
  const directoryPath = join(rootPath, kind);
  const directory = lstatSync(directoryPath, { bigint: true });
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    Number(directory.mode & 0o777n) !== 0o700 ||
    (uid !== undefined && directory.uid !== uid)
  ) {
    authoredTransactionFailure('an incomplete authored blob directory is unsafe');
  }
  const expected = expectedBlobNames(manifest, kind);
  if (expected.size === 0) {
    authoredTransactionFailure('an incomplete authored root has an unexpected blob directory');
  }
  const blobNames = readBoundedAuthoredDirectory(
    directoryPath,
    expected.size,
    expected.size * INIT_AUTHORED_PLAN_CAPS.maxBlobNameBytes,
    'incomplete authored blob directory',
  );
  let totalBytes = 0;
  for (const basename of blobNames) {
    if (!expected.has(basename)) {
      authoredTransactionFailure('an incomplete authored artifact has an unowned blob');
    }
    const file = readStableArtifactFile(join(directoryPath, basename));
    totalBytes += file.bytes.length;
    if (totalBytes > INIT_AUTHORED_PLAN_CAPS.maxAggregateBlobBytes) {
      authoredTransactionFailure('incomplete authored blobs exceed their recovery cap');
    }
  }
  return blobNames;
}

function inspectRecoverableBlobRoot(
  rootPath: string,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest | null,
  role: AuthoredArtifactRole,
): RecoverableBlobRoot {
  assertRecoverableRoot(rootPath);
  const kind = role === 'stage' ? 'desired' : 'preimage';
  const rootNames = new Set(
    readBoundedAuthoredDirectory(
      rootPath,
      2,
      2 * INIT_AUTHORED_PLAN_CAPS.maxBlobNameBytes,
      'incomplete authored root',
    ),
  );
  const marker = inspectRecoverableMarker(rootPath, ownerFor(journal, role), rootNames);
  if (marker !== 'exact') {
    return { marker, hasBlobDirectory: false, blobNames: [] };
  }
  const hasBlobDirectory = rootNames.delete(kind);
  if (rootNames.size > 0) {
    authoredTransactionFailure('an incomplete authored artifact has unowned entries');
  }
  if (!hasBlobDirectory) {
    return { marker, hasBlobDirectory: false, blobNames: [] };
  }
  if (manifest === null) {
    authoredTransactionFailure('an incomplete authored blob directory has no replay manifest');
  }
  return {
    marker,
    hasBlobDirectory: true,
    blobNames: inspectRecoverableBlobDirectory(rootPath, kind, manifest),
  };
}

function removeRecoverableBlobRoot(
  rootPath: string,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest | null,
  role: AuthoredArtifactRole,
): void {
  const kind = role === 'stage' ? 'desired' : 'preimage';
  const inspected = inspectRecoverableBlobRoot(rootPath, journal, manifest, role);
  if (inspected.hasBlobDirectory) {
    const directoryPath = join(rootPath, kind);
    for (const basename of inspected.blobNames) {
      unlinkSync(join(directoryPath, basename));
    }
    fsyncDirectory(directoryPath);
    rmdirSync(directoryPath);
  }
  if (inspected.marker !== 'absent') {
    unlinkSync(join(rootPath, AUTHORED_ARTIFACT_OWNER_FILE));
  }
  fsyncDirectory(rootPath);
  rmdirSync(rootPath);
  fsyncDirectory(dirname(rootPath));
}

function assertPendingPreparation(journal: RuntimePromotionJournal): void {
  if (journal.progress.pendingIntent?.kind !== 'authored-prepare') {
    authoredTransactionFailure('partial authored recovery requires its durable preparation intent');
  }
}

function validateReplay(
  journal: RuntimePromotionJournal,
  manifestBytes: string,
  path: string,
): void {
  const replay = readStableArtifactFile(path);
  if (
    replay.mode !== 0o600 ||
    replay.digest !== journal.plan.replayDigest ||
    replay.bytes.toString('utf8') !== manifestBytes
  ) {
    authoredTransactionFailure('an incomplete replay manifest is changed');
  }
}

export function validateIncompleteAuthoredArtifacts(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest | null,
  manifestBytes: string | null,
  paths: AuthoredArtifactPaths,
): void {
  assertPendingPreparation(journal);
  const replayPresent = pathPresent(paths.replayManifest);
  const stagePresent = pathPresent(paths.stageRoot);
  const backupPresent = pathPresent(paths.backupRoot);
  if ((stagePresent || backupPresent) && !replayPresent) {
    authoredTransactionFailure('authored artifacts exist without their durable replay manifest');
  }
  if (replayPresent) {
    if (manifest === null || manifestBytes === null) {
      authoredTransactionFailure('the durable replay manifest could not be loaded');
    }
    validateReplay(journal, manifestBytes, paths.replayManifest);
  }
  if (stagePresent) {
    inspectRecoverableBlobRoot(paths.stageRoot, journal, manifest, 'stage');
  }
  if (backupPresent) {
    inspectRecoverableBlobRoot(paths.backupRoot, journal, manifest, 'backup');
  }
  assertStableAuthoredRoot(root);
}

export function resetIncompleteAuthoredArtifacts(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest,
  manifestBytes: string,
  paths: AuthoredArtifactPaths,
): void {
  validateIncompleteAuthoredArtifacts(root, journal, manifest, manifestBytes, paths);
  if (pathPresent(paths.stageRoot)) {
    removeRecoverableBlobRoot(paths.stageRoot, journal, manifest, 'stage');
  }
  if (pathPresent(paths.backupRoot)) {
    removeRecoverableBlobRoot(paths.backupRoot, journal, manifest, 'backup');
  }
  if (pathPresent(paths.replayManifest)) {
    validateReplay(journal, manifestBytes, paths.replayManifest);
    unlinkSync(paths.replayManifest);
    fsyncDirectory(root.path);
  }
  assertStableAuthoredRoot(root);
}

export function discardIncompleteAuthoredArtifacts(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest | null,
  manifestBytes: string | null,
  paths: AuthoredArtifactPaths,
): void {
  validateIncompleteAuthoredArtifacts(root, journal, manifest, manifestBytes, paths);
  if (pathPresent(paths.stageRoot)) {
    removeRecoverableBlobRoot(paths.stageRoot, journal, manifest, 'stage');
  }
  if (pathPresent(paths.backupRoot)) {
    removeRecoverableBlobRoot(paths.backupRoot, journal, manifest, 'backup');
  }
  if (pathPresent(paths.replayManifest)) {
    if (manifestBytes === null) {
      authoredTransactionFailure('partial replay cleanup requires its exact manifest bytes');
    }
    validateReplay(journal, manifestBytes, paths.replayManifest);
    unlinkSync(paths.replayManifest);
    fsyncDirectory(root.path);
  }
  assertStableAuthoredRoot(root);
}

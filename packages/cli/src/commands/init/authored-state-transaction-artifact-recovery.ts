import { lstatSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import {
  encodeOwner,
  expectedBlobNames,
  ownerFor,
  pathPresent,
} from './authored-state-transaction-artifacts.js';
import {
  assertAuthoredCleanupEvidenceAbsent,
  assertAuthoredCleanupEvidenceArtifact,
  readAuthoredCleanupEvidence,
  removeAuthoredCleanupEvidence,
  settleAuthoredCleanupEvidence,
  type AuthoredCleanupEvidence,
  type AuthoredCleanupEvidenceSlot,
} from './authored-state-transaction-cleanup-evidence.js';
import {
  assertStableAuthoredEntry,
  assertStableAuthoredRoot,
  authoredTransactionFailure,
  bindStableAuthoredEntry,
  fsyncStableAuthoredDirectory,
  fsyncStableAuthoredRoot,
  readBoundedAuthoredDirectory,
  readStableArtifactFile,
  type StableAuthoredEntry,
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

const INCOMPLETE_ROOT_DESCRIPTION = 'an incomplete authored root';
const INCOMPLETE_MARKER_DESCRIPTION = 'an incomplete authored owner marker';
const INCOMPLETE_BLOB_DIRECTORY_DESCRIPTION = 'an incomplete authored blob directory';
const INCOMPLETE_BLOB_DESCRIPTION = 'an incomplete authored blob';
const INCOMPLETE_REPLAY_DESCRIPTION = 'the incomplete authored replay manifest';

interface RecoverableFileAuthority {
  readonly entry: StableAuthoredEntry;
  readonly digest: string;
  readonly mode: number;
}

interface RecoverableBlobRoot {
  readonly root: StableAuthoredEntry;
  readonly marker: MarkerState;
  readonly markerEntry: RecoverableFileAuthority | null;
  readonly blobDirectory: StableAuthoredEntry | null;
  readonly blobs: readonly RecoverableFileAuthority[];
}

export interface IncompleteAuthoredArtifactAuthority {
  readonly replay: RecoverableFileAuthority | null;
  readonly stage: RecoverableBlobRoot | null;
  readonly backup: RecoverableBlobRoot | null;
  readonly evidence: Readonly<Record<AuthoredCleanupEvidenceSlot, AuthoredCleanupEvidence | null>>;
}

function bindRecoverableRoot(rootPath: string): StableAuthoredEntry {
  const root = bindStableAuthoredEntry(rootPath, 'directory', INCOMPLETE_ROOT_DESCRIPTION);
  if (Number(root.identity.mode & 0o777n) !== 0o700) {
    authoredTransactionFailure('an incomplete authored root is unsafe');
  }
  return root;
}

function inspectRecoverableMarker(
  rootPath: string,
  expected: AuthoredArtifactOwner,
  rootNames: Set<string>,
): {
  readonly state: MarkerState;
  readonly entry: RecoverableFileAuthority | null;
} {
  if (!rootNames.delete(AUTHORED_ARTIFACT_OWNER_FILE)) {
    if (rootNames.size > 0) {
      authoredTransactionFailure('an ownerless authored root has unexpected entries');
    }
    return { state: 'absent', entry: null };
  }
  const markerPath = join(rootPath, AUTHORED_ARTIFACT_OWNER_FILE);
  const entry = bindStableAuthoredEntry(markerPath, 'file', INCOMPLETE_MARKER_DESCRIPTION);
  const marker = readStableArtifactFile(markerPath);
  assertStableAuthoredEntry(entry, INCOMPLETE_MARKER_DESCRIPTION);
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
    return {
      state: 'partial',
      entry: { entry, digest: marker.digest, mode: marker.mode },
    };
  }
  return {
    state: 'exact',
    entry: { entry, digest: marker.digest, mode: marker.mode },
  };
}

function inspectRecoverableBlobDirectory(
  rootPath: string,
  kind: 'desired' | 'preimage',
  manifest: AuthoredReplayManifest,
): {
  readonly directory: StableAuthoredEntry;
  readonly blobs: readonly RecoverableFileAuthority[];
} {
  const directoryPath = join(rootPath, kind);
  const directory = bindStableAuthoredEntry(
    directoryPath,
    'directory',
    INCOMPLETE_BLOB_DIRECTORY_DESCRIPTION,
  );
  if (Number(directory.identity.mode & 0o777n) !== 0o700) {
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
  const blobs: RecoverableFileAuthority[] = [];
  for (const basename of blobNames) {
    const mutation = expected.get(basename);
    if (mutation === undefined) {
      authoredTransactionFailure('an incomplete authored artifact has an unowned blob');
    }
    const blobPath = join(directoryPath, basename);
    const blob = bindStableAuthoredEntry(blobPath, 'file', INCOMPLETE_BLOB_DESCRIPTION);
    const file = readStableArtifactFile(blobPath);
    const state = kind === 'desired' ? mutation.desired : mutation.preimage;
    if (file.mode !== state.mode) {
      authoredTransactionFailure('an incomplete authored blob has a changed mode');
    }
    assertStableAuthoredEntry(blob, INCOMPLETE_BLOB_DESCRIPTION);
    blobs.push({ entry: blob, digest: file.digest, mode: file.mode });
    totalBytes += file.bytes.length;
    if (totalBytes > INIT_AUTHORED_PLAN_CAPS.maxAggregateBlobBytes) {
      authoredTransactionFailure('incomplete authored blobs exceed their recovery cap');
    }
  }
  assertStableAuthoredEntry(directory, INCOMPLETE_BLOB_DIRECTORY_DESCRIPTION);
  return { directory, blobs };
}

function inspectRecoverableBlobRoot(
  rootPath: string,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest | null,
  role: AuthoredArtifactRole,
): RecoverableBlobRoot {
  const root = bindRecoverableRoot(rootPath);
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
  if (marker.state !== 'exact') {
    assertStableAuthoredEntry(root, INCOMPLETE_ROOT_DESCRIPTION);
    return {
      root,
      marker: marker.state,
      markerEntry: marker.entry,
      blobDirectory: null,
      blobs: [],
    };
  }
  const hasBlobDirectory = rootNames.delete(kind);
  if (rootNames.size > 0) {
    authoredTransactionFailure('an incomplete authored artifact has unowned entries');
  }
  if (!hasBlobDirectory) {
    assertStableAuthoredEntry(root, INCOMPLETE_ROOT_DESCRIPTION);
    return {
      root,
      marker: marker.state,
      markerEntry: marker.entry,
      blobDirectory: null,
      blobs: [],
    };
  }
  if (manifest === null) {
    authoredTransactionFailure('an incomplete authored blob directory has no replay manifest');
  }
  const inspected = inspectRecoverableBlobDirectory(rootPath, kind, manifest);
  assertStableAuthoredEntry(root, INCOMPLETE_ROOT_DESCRIPTION);
  return {
    root,
    marker: marker.state,
    markerEntry: marker.entry,
    blobDirectory: inspected.directory,
    blobs: inspected.blobs,
  };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function assertPathAbsent(path: string, description: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  authoredTransactionFailure(`${description} was replaced during incomplete cleanup`);
}

function unlinkRecoverableFile(
  file: RecoverableFileAuthority,
  parent: StableAuthoredEntry,
  description: string,
): void {
  assertStableAuthoredEntry(parent, `${description} parent`);
  assertStableAuthoredEntry(file.entry, description);
  const observed = readStableArtifactFile(file.entry.path);
  assertStableAuthoredEntry(file.entry, description);
  if (observed.mode !== file.mode || observed.digest !== file.digest) {
    authoredTransactionFailure(`${description} changed after its cleanup authority was captured`);
  }
  unlinkSync(file.entry.path);
  assertStableAuthoredEntry(parent, `${description} parent`);
  assertPathAbsent(file.entry.path, description);
  fsyncStableAuthoredDirectory(parent, `${description} parent`);
}

function removeRecoverableBlobRoot(
  projectRoot: StableAuthoredRoot,
  inspected: RecoverableBlobRoot,
): void {
  assertStableAuthoredRoot(projectRoot);
  assertStableAuthoredEntry(inspected.root, INCOMPLETE_ROOT_DESCRIPTION);
  if (inspected.blobDirectory !== null) {
    assertStableAuthoredEntry(inspected.blobDirectory, INCOMPLETE_BLOB_DIRECTORY_DESCRIPTION);
    for (const blob of inspected.blobs) {
      unlinkRecoverableFile(blob, inspected.blobDirectory, INCOMPLETE_BLOB_DESCRIPTION);
    }
    assertStableAuthoredEntry(inspected.root, INCOMPLETE_ROOT_DESCRIPTION);
    assertStableAuthoredEntry(inspected.blobDirectory, INCOMPLETE_BLOB_DIRECTORY_DESCRIPTION);
    rmdirSync(inspected.blobDirectory.path);
    assertPathAbsent(inspected.blobDirectory.path, INCOMPLETE_BLOB_DIRECTORY_DESCRIPTION);
    fsyncStableAuthoredDirectory(inspected.root, INCOMPLETE_ROOT_DESCRIPTION);
  }
  if (inspected.markerEntry !== null) {
    unlinkRecoverableFile(inspected.markerEntry, inspected.root, INCOMPLETE_MARKER_DESCRIPTION);
  }
  assertStableAuthoredRoot(projectRoot);
  assertStableAuthoredEntry(inspected.root, INCOMPLETE_ROOT_DESCRIPTION);
  rmdirSync(inspected.root.path);
  assertPathAbsent(inspected.root.path, INCOMPLETE_ROOT_DESCRIPTION);
  fsyncStableAuthoredRoot(projectRoot);
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
): RecoverableFileAuthority {
  const stable = bindStableAuthoredEntry(path, 'file', INCOMPLETE_REPLAY_DESCRIPTION);
  const replay = readStableArtifactFile(path);
  if (
    replay.mode !== 0o600 ||
    replay.digest !== journal.plan.replayDigest ||
    replay.bytes.toString('utf8') !== manifestBytes
  ) {
    authoredTransactionFailure('an incomplete replay manifest is changed');
  }
  assertStableAuthoredEntry(stable, INCOMPLETE_REPLAY_DESCRIPTION);
  return { entry: stable, digest: replay.digest, mode: replay.mode };
}

function settleIncompleteCleanupEvidence(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  slot: AuthoredCleanupEvidenceSlot,
  artifact: StableAuthoredEntry | null,
): AuthoredCleanupEvidence | null {
  if (artifact === null) {
    return readAuthoredCleanupEvidence(root, journal, slot);
  }
  return settleAuthoredCleanupEvidence(root, journal, slot, artifact);
}

export function validateIncompleteAuthoredArtifacts(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest | null,
  manifestBytes: string | null,
  paths: AuthoredArtifactPaths,
): IncompleteAuthoredArtifactAuthority {
  assertPendingPreparation(journal);
  const replayPresent = pathPresent(paths.replayManifest);
  const stagePresent = pathPresent(paths.stageRoot);
  const backupPresent = pathPresent(paths.backupRoot);
  if ((stagePresent || backupPresent) && !replayPresent) {
    authoredTransactionFailure('authored artifacts exist without their durable replay manifest');
  }
  let replay: RecoverableFileAuthority | null = null;
  if (replayPresent) {
    if (manifest === null || manifestBytes === null) {
      authoredTransactionFailure('the durable replay manifest could not be loaded');
    }
    replay = validateReplay(journal, manifestBytes, paths.replayManifest);
  }
  const stage = stagePresent
    ? inspectRecoverableBlobRoot(paths.stageRoot, journal, manifest, 'stage')
    : null;
  const backup = backupPresent
    ? inspectRecoverableBlobRoot(paths.backupRoot, journal, manifest, 'backup')
    : null;
  const evidence = {
    authoredStage: settleIncompleteCleanupEvidence(
      root,
      journal,
      'authoredStage',
      stage?.root ?? null,
    ),
    authoredBackup: settleIncompleteCleanupEvidence(
      root,
      journal,
      'authoredBackup',
      backup?.root ?? null,
    ),
    replayManifest: settleIncompleteCleanupEvidence(
      root,
      journal,
      'replayManifest',
      replay?.entry ?? null,
    ),
  } as const;
  if (stage !== null && evidence.authoredStage !== null) {
    assertAuthoredCleanupEvidenceArtifact(evidence.authoredStage, stage.root);
  }
  if (backup !== null && evidence.authoredBackup !== null) {
    assertAuthoredCleanupEvidenceArtifact(evidence.authoredBackup, backup.root);
  }
  if (replay !== null && evidence.replayManifest !== null) {
    assertAuthoredCleanupEvidenceArtifact(evidence.replayManifest, replay.entry);
  }
  assertStableAuthoredRoot(root);
  return { replay, stage, backup, evidence };
}

function discardIncompleteAuthority(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  authority: IncompleteAuthoredArtifactAuthority,
): void {
  if (authority.stage !== null) removeRecoverableBlobRoot(root, authority.stage);
  if (authority.backup !== null) removeRecoverableBlobRoot(root, authority.backup);
  if (authority.replay !== null) {
    assertStableAuthoredRoot(root);
    assertStableAuthoredEntry(authority.replay.entry, INCOMPLETE_REPLAY_DESCRIPTION);
    const replay = readStableArtifactFile(authority.replay.entry.path);
    assertStableAuthoredEntry(authority.replay.entry, INCOMPLETE_REPLAY_DESCRIPTION);
    if (replay.mode !== authority.replay.mode || replay.digest !== authority.replay.digest) {
      authoredTransactionFailure(
        'the incomplete authored replay manifest changed after cleanup authority was captured',
      );
    }
    unlinkSync(authority.replay.entry.path);
    assertPathAbsent(authority.replay.entry.path, INCOMPLETE_REPLAY_DESCRIPTION);
    fsyncStableAuthoredRoot(root);
  }
  for (const slot of [
    'authoredStage',
    'authoredBackup',
    'replayManifest',
  ] as const satisfies readonly AuthoredCleanupEvidenceSlot[]) {
    const evidence = authority.evidence[slot];
    if (evidence !== null) {
      removeAuthoredCleanupEvidence(root, journal, slot, evidence);
    }
    assertAuthoredCleanupEvidenceAbsent(root, journal, slot);
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
  const authority = validateIncompleteAuthoredArtifacts(
    root,
    journal,
    manifest,
    manifestBytes,
    paths,
  );
  discardIncompleteAuthority(root, journal, authority);
}

export function discardIncompleteAuthoredArtifacts(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest | null,
  manifestBytes: string | null,
  paths: AuthoredArtifactPaths,
  authority?: IncompleteAuthoredArtifactAuthority,
): void {
  const bound =
    authority ?? validateIncompleteAuthoredArtifacts(root, journal, manifest, manifestBytes, paths);
  discardIncompleteAuthority(root, journal, bound);
}

export function assertIncompleteAuthoredArtifactsAbsent(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  paths: AuthoredArtifactPaths,
): void {
  assertStableAuthoredRoot(root);
  for (const path of [paths.stageRoot, paths.backupRoot, paths.replayManifest]) {
    if (pathPresent(path)) {
      authoredTransactionFailure('an aborted authored preparation left an owned artifact path');
    }
  }
  for (const slot of [
    'authoredStage',
    'authoredBackup',
    'replayManifest',
  ] as const satisfies readonly AuthoredCleanupEvidenceSlot[]) {
    assertAuthoredCleanupEvidenceAbsent(root, journal, slot);
  }
  assertStableAuthoredRoot(root);
}

import { lstatSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  expectedBlobNames,
  expectedOwner,
  ownerFor,
} from './authored-state-transaction-artifacts.js';
import {
  assertAuthoredCleanupEvidenceArtifact,
  readAuthoredCleanupEvidence,
  type AuthoredCleanupEvidence,
} from './authored-state-transaction-cleanup-evidence.js';
import {
  assertStableAuthoredEntry,
  authoredTransactionFailure,
  bindStableAuthoredEntry,
  fsyncStableAuthoredDirectory,
  readBoundedAuthoredDirectory,
  readStableArtifactFile,
  type StableAuthoredEntry,
  type StableAuthoredRoot,
} from './authored-state-transaction-fs.js';
import { AUTHORED_ARTIFACT_OWNER_FILE } from './authored-state-transaction-types.js';
import { hasErrorCode } from './error-code.js';
import { INIT_AUTHORED_PLAN_CAPS } from './init-authored-plan-types.js';

import type {
  AuthoredArtifactPaths,
  AuthoredStateCheckpoint,
} from './authored-state-transaction-types.js';
import type { AuthoredReplayManifest, InitAuthoredMutation } from './init-authored-plan.js';
import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';

interface ExactBlobRoot {
  readonly root: StableAuthoredEntry;
  readonly marker: StableAuthoredEntry | null;
  readonly blobDirectory: StableAuthoredEntry | null;
  readonly blobs: readonly StableAuthoredEntry[];
}

const OWNED_ROOT_DESCRIPTION = 'an owned authored root';

function inspectExactBlobDirectory(
  blobDirectory: string,
  expected: ReadonlyMap<string, InitAuthoredMutation>,
  kind: 'desired' | 'preimage',
): {
  readonly directory: StableAuthoredEntry;
  readonly blobs: readonly StableAuthoredEntry[];
} {
  const directory = bindStableAuthoredEntry(
    blobDirectory,
    'directory',
    'an owned authored blob directory',
  );
  if (Number(directory.identity.mode & 0o777n) !== 0o700) {
    authoredTransactionFailure('an incomplete authored blob directory is unsafe');
  }
  const blobNames = readBoundedAuthoredDirectory(
    blobDirectory,
    expected.size,
    expected.size * INIT_AUTHORED_PLAN_CAPS.maxBlobNameBytes,
    'owned authored blob directory',
  );
  const blobs: StableAuthoredEntry[] = [];
  for (const basename of blobNames) {
    const mutation = expected.get(basename);
    if (mutation === undefined) {
      authoredTransactionFailure('an incomplete authored artifact has an unowned blob');
    }
    const state = kind === 'desired' ? mutation.desired : mutation.preimage;
    const blobPath = join(blobDirectory, basename);
    const blob = bindStableAuthoredEntry(blobPath, 'file', 'an owned authored blob');
    const file = readStableArtifactFile(blobPath);
    if (file.mode !== state.mode || file.digest !== state.digest) {
      authoredTransactionFailure('an incomplete authored blob is changed');
    }
    assertStableAuthoredEntry(blob, 'an owned authored blob');
    blobs.push(blob);
  }
  assertStableAuthoredEntry(directory, 'an owned authored blob directory');
  return { directory, blobs };
}

function inspectExactBlobRoot(
  rootPath: string,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest,
  role: 'stage' | 'backup',
  checkpoint: CleanupCheckpoint,
  evidence: AuthoredCleanupEvidence | null,
): ExactBlobRoot {
  const kind = role === 'stage' ? 'desired' : 'preimage';
  const root = bindStableAuthoredEntry(rootPath, 'directory', OWNED_ROOT_DESCRIPTION);
  if (evidence !== null) assertAuthoredCleanupEvidenceArtifact(evidence, root);
  checkpoint('after-cleanup-artifact-observation');
  assertStableAuthoredEntry(root, OWNED_ROOT_DESCRIPTION);
  const markerPath = join(rootPath, AUTHORED_ARTIFACT_OWNER_FILE);
  const expected = expectedBlobNames(manifest, kind);
  const rootNames = new Set(
    readBoundedAuthoredDirectory(
      rootPath,
      2,
      2 * INIT_AUTHORED_PLAN_CAPS.maxBlobNameBytes,
      'owned authored root',
    ),
  );
  const hasMarker = rootNames.delete(AUTHORED_ARTIFACT_OWNER_FILE);
  if (!hasMarker && evidence === null) {
    authoredTransactionFailure('an incomplete authored artifact has no ownership marker');
  }
  const marker = hasMarker
    ? bindStableAuthoredEntry(markerPath, 'file', 'an authored owner marker')
    : null;
  if (marker !== null) {
    expectedOwner(rootPath, ownerFor(journal, role));
    assertStableAuthoredEntry(marker, 'an authored owner marker');
  }
  const hasBlobDirectory = rootNames.delete(kind);
  if (rootNames.size > 0) {
    authoredTransactionFailure('an incomplete authored artifact has unowned entries');
  }
  assertStableAuthoredEntry(root, OWNED_ROOT_DESCRIPTION);
  if (!hasBlobDirectory) return { root, marker, blobDirectory: null, blobs: [] };
  const inspected = inspectExactBlobDirectory(join(rootPath, kind), expected, kind);
  assertStableAuthoredEntry(root, OWNED_ROOT_DESCRIPTION);
  return {
    root,
    marker,
    blobDirectory: inspected.directory,
    blobs: inspected.blobs,
  };
}

type CleanupCheckpoint = (checkpoint: AuthoredStateCheckpoint) => void;

function assertPathAbsent(path: string, description: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  authoredTransactionFailure(`${description} was replaced while it was being removed`);
}

function unlinkBoundFile(
  file: StableAuthoredEntry,
  parent: StableAuthoredEntry,
  checkpoint: CleanupCheckpoint,
  description: string,
): void {
  assertStableAuthoredEntry(parent, `${description} parent`);
  assertStableAuthoredEntry(file, description);
  checkpoint('before-cleanup-entry-unlink');
  assertStableAuthoredEntry(parent, `${description} parent`);
  assertStableAuthoredEntry(file, description);
  unlinkSync(file.path);
  checkpoint('after-cleanup-entry-unlink');
  assertStableAuthoredEntry(parent, `${description} parent`);
  assertPathAbsent(file.path, description);
  fsyncStableAuthoredDirectory(parent, `${description} parent`);
}

function removeBoundDirectory(
  directory: StableAuthoredEntry,
  parent: StableAuthoredEntry,
  checkpoint: CleanupCheckpoint,
  description: string,
): void {
  assertStableAuthoredEntry(parent, `${description} parent`);
  assertStableAuthoredEntry(directory, description);
  checkpoint('before-cleanup-directory-removal');
  assertStableAuthoredEntry(parent, `${description} parent`);
  assertStableAuthoredEntry(directory, description);
  rmdirSync(directory.path);
  checkpoint('after-cleanup-directory-removal');
  assertStableAuthoredEntry(parent, `${description} parent`);
  assertPathAbsent(directory.path, description);
  fsyncStableAuthoredDirectory(parent, `${description} parent`);
}

function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

interface CleanupEvidenceInput {
  readonly authoredRoot: StableAuthoredRoot;
  readonly journal: RuntimePromotionJournal;
  readonly manifest: AuthoredReplayManifest;
  readonly role: 'stage' | 'backup';
  readonly rootPath: string;
  readonly slot: 'authoredStage' | 'authoredBackup';
  readonly checkpoint: CleanupCheckpoint;
}

function evidenceForCleanupRoot(input: CleanupEvidenceInput): AuthoredCleanupEvidence {
  const existing = readAuthoredCleanupEvidence(input.authoredRoot, input.journal, input.slot);
  if (existing === null) {
    authoredTransactionFailure('an authored cleanup root has no durable identity evidence');
  }
  return existing;
}

function removeInspectedBlobRoot(
  inspected: ExactBlobRoot,
  projectRoot: StableAuthoredEntry,
  checkpoint: CleanupCheckpoint,
): void {
  assertStableAuthoredEntry(projectRoot, 'the authored artifact parent');
  assertStableAuthoredEntry(inspected.root, OWNED_ROOT_DESCRIPTION);
  if (inspected.marker !== null) {
    assertStableAuthoredEntry(inspected.marker, 'an authored owner marker');
  }
  if (inspected.blobDirectory !== null) {
    assertStableAuthoredEntry(inspected.blobDirectory, 'an owned authored blob directory');
    for (const blob of inspected.blobs) {
      unlinkBoundFile(blob, inspected.blobDirectory, checkpoint, 'an owned authored blob');
    }
    removeBoundDirectory(
      inspected.blobDirectory,
      inspected.root,
      checkpoint,
      'an owned authored blob directory',
    );
  }
  if (inspected.marker !== null) {
    unlinkBoundFile(inspected.marker, inspected.root, checkpoint, 'an authored owner marker');
  }
  removeBoundDirectory(inspected.root, projectRoot, checkpoint, OWNED_ROOT_DESCRIPTION);
}

export function removeOwnedAuthoredBlobRoot(
  authoredRoot: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest,
  paths: AuthoredArtifactPaths,
  slot: 'authoredStage' | 'authoredBackup',
  checkpoint: CleanupCheckpoint,
): 'removed' | 'absent' {
  const role = slot === 'authoredStage' ? 'stage' : 'backup';
  const rootPath = slot === 'authoredStage' ? paths.stageRoot : paths.backupRoot;
  if (dirname(rootPath) !== authoredRoot.path) {
    authoredTransactionFailure('an authored artifact parent escaped its bound project root');
  }
  const projectRoot = bindStableAuthoredEntry(
    authoredRoot.path,
    'directory',
    'the authored artifact parent',
  );
  if (!pathPresent(rootPath)) {
    checkpoint('after-cleanup-artifact-observation');
    const evidence = readAuthoredCleanupEvidence(authoredRoot, journal, slot);
    if (evidence === null) {
      authoredTransactionFailure(
        'an absent authored cleanup root has no durable identity evidence',
      );
    }
    return 'removed';
  }
  const evidence = evidenceForCleanupRoot({
    authoredRoot,
    journal,
    manifest,
    role,
    rootPath,
    slot,
    checkpoint,
  });
  checkpoint('after-cleanup-evidence-published');
  const inspected = inspectExactBlobRoot(rootPath, journal, manifest, role, checkpoint, evidence);
  checkpoint('after-cleanup-artifact-read');
  removeInspectedBlobRoot(inspected, projectRoot, checkpoint);
  return 'removed';
}

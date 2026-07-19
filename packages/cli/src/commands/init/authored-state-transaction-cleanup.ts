import { lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  assertAuthoredCleanupEvidenceArtifact,
  assertAuthoredCleanupEvidenceAbsent,
  readAuthoredCleanupEvidence,
  removeAuthoredCleanupEvidence,
} from './authored-state-transaction-cleanup-evidence.js';
import {
  assertStableAuthoredEntry,
  assertStableAuthoredRoot,
  authoredTransactionFailure,
  bindStableAuthoredEntry,
  fsyncStableAuthoredRoot,
  readStableArtifactFile,
  type StableAuthoredRoot,
} from './authored-state-transaction-fs.js';
import { removeOwnedAuthoredBlobRoot } from './authored-state-transaction-owned-artifact-cleanup.js';
import { hasErrorCode } from './error-code.js';

import type {
  AuthoredArtifactPaths,
  AuthoredStateCheckpoint,
} from './authored-state-transaction-types.js';
import type { AuthoredReplayManifest } from './init-authored-plan.js';
import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';

type AuthoredArtifactSlot = 'authoredStage' | 'authoredBackup' | 'replayManifest';

function artifactPath(paths: AuthoredArtifactPaths, slot: AuthoredArtifactSlot): string {
  if (slot === 'authoredStage') return paths.stageRoot;
  if (slot === 'authoredBackup') return paths.backupRoot;
  return paths.replayManifest;
}

function assertDirectAuthoredArtifact(root: StableAuthoredRoot, path: string): void {
  if (dirname(path) !== root.path) {
    authoredTransactionFailure('an authored artifact escaped its bound project root');
  }
}

export function assertAuthoredArtifactAbsent(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  paths: AuthoredArtifactPaths,
  slot: AuthoredArtifactSlot,
): void {
  assertAuthoredArtifactPathAbsent(root, paths, slot);
  assertAuthoredCleanupEvidenceAbsent(root, journal, slot);
}

export function assertAuthoredArtifactPathAbsent(
  root: StableAuthoredRoot,
  paths: AuthoredArtifactPaths,
  slot: AuthoredArtifactSlot,
): void {
  const path = artifactPath(paths, slot);
  assertStableAuthoredRoot(root);
  assertDirectAuthoredArtifact(root, path);
  try {
    lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      assertStableAuthoredRoot(root);
      return;
    }
    throw error;
  }
  authoredTransactionFailure('a cleaned authored artifact path is no longer absent');
}

export function finalizeAuthoredCleanupEvidence(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  paths: AuthoredArtifactPaths,
  slot: AuthoredArtifactSlot,
  checkpoint: (checkpoint: AuthoredStateCheckpoint) => void,
): void {
  assertAuthoredArtifactPathAbsent(root, paths, slot);
  const evidence = readAuthoredCleanupEvidence(root, journal, slot);
  if (evidence === null) return;
  checkpoint('before-cleanup-evidence-unlink');
  assertAuthoredArtifactPathAbsent(root, paths, slot);
  removeAuthoredCleanupEvidence(root, journal, slot, evidence);
  checkpoint('after-cleanup-evidence-unlink');
  assertAuthoredArtifactPathAbsent(root, paths, slot);
  assertAuthoredCleanupEvidenceAbsent(root, journal, slot);
}

export function removeAuthoredArtifact(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest | null,
  paths: AuthoredArtifactPaths,
  slot: AuthoredArtifactSlot,
  checkpoint: (checkpoint: AuthoredStateCheckpoint) => void,
): 'removed' | 'absent' {
  const path = artifactPath(paths, slot);
  assertStableAuthoredRoot(root);
  assertDirectAuthoredArtifact(root, path);
  if (slot === 'authoredStage' || slot === 'authoredBackup') {
    if (manifest === null) {
      authoredTransactionFailure('cleanup requires the replay manifest for artifact directories');
    }
    return removeOwnedAuthoredBlobRoot(root, journal, manifest, paths, slot, checkpoint);
  }
  try {
    lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      checkpoint('after-cleanup-artifact-observation');
      assertAuthoredArtifactPathAbsent(root, paths, slot);
      const evidence = readAuthoredCleanupEvidence(root, journal, slot);
      if (evidence === null) {
        authoredTransactionFailure('an absent authored artifact has no durable identity evidence');
      }
      return 'absent';
    }
    throw error;
  }
  if (slot === 'replayManifest') {
    const replayIdentity = bindStableAuthoredEntry(path, 'file', 'the authored replay manifest');
    const evidence = readAuthoredCleanupEvidence(root, journal, slot);
    if (evidence === null) {
      authoredTransactionFailure('the authored replay manifest has no durable identity evidence');
    }
    assertAuthoredCleanupEvidenceArtifact(evidence, replayIdentity);
    checkpoint('after-cleanup-artifact-observation');
    assertStableAuthoredRoot(root);
    assertStableAuthoredEntry(replayIdentity, 'the authored replay manifest');
    assertAuthoredCleanupEvidenceArtifact(evidence, replayIdentity);
    const replay = readStableArtifactFile(path);
    if (replay.mode !== 0o600 || replay.digest !== journal.plan.replayDigest) {
      authoredTransactionFailure('cleanup refused a changed replay manifest');
    }
    checkpoint('after-cleanup-artifact-read');
    assertStableAuthoredRoot(root);
    assertStableAuthoredEntry(replayIdentity, 'the authored replay manifest');
    assertAuthoredCleanupEvidenceArtifact(evidence, replayIdentity);
    checkpoint('before-cleanup-entry-unlink');
    assertStableAuthoredRoot(root);
    assertStableAuthoredEntry(replayIdentity, 'the authored replay manifest');
    unlinkSync(path);
    checkpoint('after-cleanup-entry-unlink');
    assertAuthoredArtifactPathAbsent(root, paths, slot);
    fsyncStableAuthoredRoot(root);
    return 'removed';
  }
  authoredTransactionFailure('the authored cleanup slot is unsupported');
}

import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';

import {
  ANCHORED_CREATE_RECOVERY_MAX_ENTRIES,
  ANCHORED_RECORD_MAX_BYTES,
  anchoredRecordTemporaryBasename,
  mutateAnchoredRecord,
  readAnchoredRecord,
  SystemError,
} from '@opensip-cli/core';

import {
  assertStableAuthoredRoot,
  authoredTransactionFailure,
  type StableAuthoredRoot,
} from './authored-state-transaction-fs.js';
import { INIT_AUTHORED_PLAN_CAPS, sha256Bytes } from './init-authored-plan-types.js';

import type { AuthoredArtifactPaths } from './authored-state-transaction-types.js';
import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';
import type { AnchoredRecordReadResult } from '@opensip-cli/core';

function replayCreateIdentity(journal: RuntimePromotionJournal): string {
  return journal.owned.replayManifest.ownershipId;
}

function exactReplayTemporaryBasename(journal: RuntimePromotionJournal): string {
  return anchoredRecordTemporaryBasename(
    journal.owned.replayManifest.basename,
    replayCreateIdentity(journal),
  );
}

function assertNoForeignReplayTemporaries(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
): void {
  const targetBasename = journal.owned.replayManifest.basename;
  const prefix = `.${targetBasename}.tmp-`;
  const exactTemporary = exactReplayTemporaryBasename(journal);
  const directory = opendirSync(root.path);
  let entries = 0;
  let nameBytes = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) return;
      entries += 1;
      nameBytes += Buffer.byteLength(entry.name, 'utf8');
      if (
        entries > ANCHORED_CREATE_RECOVERY_MAX_ENTRIES ||
        nameBytes > ANCHORED_CREATE_RECOVERY_MAX_ENTRIES * 255
      ) {
        authoredTransactionFailure('the replay publication parent exceeds its scan bound');
      }
      if (entry.name.startsWith(prefix) && entry.name !== exactTemporary) {
        authoredTransactionFailure('a foreign replay publication temporary is present');
      }
    }
  } finally {
    directory.closeSync();
  }
}

function assertReplayCapacity(): void {
  if (INIT_AUTHORED_PLAN_CAPS.maxManifestBytes !== ANCHORED_RECORD_MAX_BYTES) {
    authoredTransactionFailure('the replay manifest and anchored record caps disagree');
  }
}

function assertReplayPath(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  paths: AuthoredArtifactPaths,
): void {
  if (
    paths.projectRoot !== root.path ||
    paths.replayManifest !== join(root.path, journal.owned.replayManifest.basename)
  ) {
    authoredTransactionFailure('the replay manifest path does not match its durable identity');
  }
}

function replayPathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export function assertAuthoredReplayPublicationAbsent(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  paths: AuthoredArtifactPaths,
): void {
  assertReplayPath(root, journal, paths);
  assertStableAuthoredRoot(root);
  assertNoForeignReplayTemporaries(root, journal);
  const exactTemporary = join(root.path, exactReplayTemporaryBasename(journal));
  if (replayPathPresent(paths.replayManifest) || replayPathPresent(exactTemporary)) {
    authoredTransactionFailure('an aborted authored preparation left a replay publication path');
  }
  assertStableAuthoredRoot(root);
}

export function settleAuthoredReplayPublication(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  paths: AuthoredArtifactPaths,
): AnchoredRecordReadResult {
  assertReplayCapacity();
  assertReplayPath(root, journal, paths);
  assertStableAuthoredRoot(root);
  assertNoForeignReplayTemporaries(root, journal);
  const observed = readAnchoredRecord({
    trustedAnchorDir: root.path,
    parentDir: root.path,
    basename: journal.owned.replayManifest.basename,
    maxBytes: INIT_AUTHORED_PLAN_CAPS.maxManifestBytes,
    permissionPosture: 'owner-controlled',
    recordPosture: 'private',
    linkedCreateRecovery: {
      effect: 'settle-or-discard-owned-temporary',
      expectedContentSha256: journal.plan.replayDigest,
      createIdentity: replayCreateIdentity(journal),
      maxEntries: ANCHORED_CREATE_RECOVERY_MAX_ENTRIES,
    },
  });
  assertNoForeignReplayTemporaries(root, journal);
  assertStableAuthoredRoot(root);
  return observed;
}

function isAnchoredCreateConflict(error: unknown): boolean {
  return error instanceof SystemError && error.code === 'CORE.RUNTIME_COORDINATION.EXISTS';
}

function assertExactReplay(observed: AnchoredRecordReadResult, manifestBytes: string): void {
  if (
    observed.status !== 'present' ||
    observed.content !== manifestBytes ||
    observed.sha256 !== sha256Bytes(manifestBytes)
  ) {
    authoredTransactionFailure('the published replay manifest is not its exact planned content');
  }
}

export function publishAuthoredReplayManifest(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  paths: AuthoredArtifactPaths,
  manifestBytes: string,
): 'applied' | 'already-satisfied' {
  if (sha256Bytes(manifestBytes) !== journal.plan.replayDigest) {
    authoredTransactionFailure('the replay manifest bytes disagree with the durable journal');
  }
  const before = settleAuthoredReplayPublication(root, journal, paths);
  if (before.status === 'present') {
    assertExactReplay(before, manifestBytes);
    return 'already-satisfied';
  }
  let created = true;
  try {
    mutateAnchoredRecord({
      trustedAnchorDir: root.path,
      parentDir: root.path,
      basename: journal.owned.replayManifest.basename,
      operation: 'create',
      content: manifestBytes,
      maxBytes: INIT_AUTHORED_PLAN_CAPS.maxManifestBytes,
      permissionPosture: 'owner-controlled',
      recordPosture: 'private',
      createIdentity: replayCreateIdentity(journal),
    });
  } catch (error) {
    if (!isAnchoredCreateConflict(error)) throw error;
    created = false;
  }
  const after = settleAuthoredReplayPublication(root, journal, paths);
  assertExactReplay(after, manifestBytes);
  return created ? 'applied' : 'already-satisfied';
}

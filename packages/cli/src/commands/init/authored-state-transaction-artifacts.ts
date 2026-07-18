import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import { settleAuthoredReplayPublication } from './authored-state-replay-publication.js';
import {
  assertStableAuthoredRoot,
  authoredTransactionFailure,
  readBoundedAuthoredDirectory,
  readStableArtifactFile,
  type StableAuthoredRoot,
} from './authored-state-transaction-fs.js';
import {
  AUTHORED_ARTIFACT_OWNER_FILE,
  AUTHORED_ARTIFACT_OWNER_KIND,
  AUTHORED_ARTIFACT_OWNER_VERSION,
  type AuthoredArtifactOwner,
  type AuthoredArtifactPaths,
  type AuthoredArtifactRole,
  type AuthoredBlobAvailability,
} from './authored-state-transaction-types.js';
import { sha256Bytes } from './init-authored-plan-types.js';
import {
  encodeAuthoredReplayManifest,
  INIT_AUTHORED_PLAN_CAPS,
  parseAuthoredReplayManifest,
} from './init-authored-plan.js';
import { isSafeRuntimePromotionBasename } from './runtime-promotion-journal-schema.js';

import type { AuthoredReplayManifest, InitAuthoredMutation } from './init-authored-plan.js';
import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';

const OWNER_KEYS = ['kind', 'version', 'operationId', 'ownershipId', 'role'] as const;

export function encodeOwner(owner: AuthoredArtifactOwner): string {
  return JSON.stringify({
    kind: AUTHORED_ARTIFACT_OWNER_KIND,
    version: AUTHORED_ARTIFACT_OWNER_VERSION,
    operationId: owner.operationId,
    ownershipId: owner.ownershipId,
    role: owner.role,
  });
}

function parseOwner(raw: string): AuthoredArtifactOwner {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    authoredTransactionFailure('an authored artifact owner marker is malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    authoredTransactionFailure('an authored artifact owner marker has the wrong shape');
  }
  const owner = value as Record<string, unknown>;
  const keys = Object.keys(owner);
  if (
    keys.length !== OWNER_KEYS.length ||
    OWNER_KEYS.some((key, index) => keys[index] !== key) ||
    owner.kind !== AUTHORED_ARTIFACT_OWNER_KIND ||
    owner.version !== AUTHORED_ARTIFACT_OWNER_VERSION ||
    typeof owner.operationId !== 'string' ||
    typeof owner.ownershipId !== 'string' ||
    (owner.role !== 'stage' && owner.role !== 'backup')
  ) {
    authoredTransactionFailure('an authored artifact owner marker is invalid');
  }
  const canonical = {
    kind: AUTHORED_ARTIFACT_OWNER_KIND,
    version: AUTHORED_ARTIFACT_OWNER_VERSION,
    operationId: owner.operationId,
    ownershipId: owner.ownershipId,
    role: owner.role,
  } as const;
  if (encodeOwner(canonical) !== raw) {
    authoredTransactionFailure('an authored artifact owner marker is noncanonical');
  }
  return canonical;
}

export function ownerFor(
  journal: RuntimePromotionJournal,
  role: AuthoredArtifactRole,
): AuthoredArtifactOwner {
  const slot = role === 'stage' ? journal.owned.authoredStage : journal.owned.authoredBackup;
  return {
    kind: AUTHORED_ARTIFACT_OWNER_KIND,
    version: AUTHORED_ARTIFACT_OWNER_VERSION,
    operationId: journal.operationId,
    ownershipId: slot.ownershipId,
    role,
  };
}

export function authoredArtifactPaths(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
): AuthoredArtifactPaths {
  const basenames = [
    journal.owned.authoredStage.basename,
    journal.owned.authoredBackup.basename,
    journal.owned.replayManifest.basename,
  ];
  if (!basenames.every(isSafeRuntimePromotionBasename) || new Set(basenames).size !== 3) {
    authoredTransactionFailure('authored artifact basenames are unsafe or collide');
  }
  return {
    projectRoot: root.path,
    stageRoot: join(root.path, basenames[0]),
    backupRoot: join(root.path, basenames[1]),
    replayManifest: join(root.path, basenames[2]),
  };
}

export function expectedOwner(rootPath: string, expected: AuthoredArtifactOwner): void {
  const root = lstatSync(rootPath, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink() || Number(root.mode & 0o777n) !== 0o700) {
    authoredTransactionFailure('an authored artifact root has unsafe identity');
  }
  let marker: ReturnType<typeof readStableArtifactFile>;
  try {
    marker = readStableArtifactFile(join(rootPath, AUTHORED_ARTIFACT_OWNER_FILE));
  } catch (error) {
    authoredTransactionFailure(
      'an authored artifact ownership marker is missing or unreadable',
      error,
    );
  }
  if (
    marker.mode !== 0o600 ||
    parseOwner(marker.bytes.toString('utf8')).ownershipId !== expected.ownershipId
  ) {
    authoredTransactionFailure('an authored artifact owner marker does not match the journal');
  }
  if (marker.bytes.toString('utf8') !== encodeOwner(expected)) {
    authoredTransactionFailure('an authored artifact belongs to another operation');
  }
}

export function expectedBlobNames(
  manifest: AuthoredReplayManifest,
  kind: 'desired' | 'preimage',
): ReadonlyMap<string, InitAuthoredMutation> {
  const expected = new Map<string, InitAuthoredMutation>();
  for (const mutation of manifest.mutations) {
    const name = kind === 'desired' ? mutation.desiredBlob : mutation.preimageBlob;
    if (name === null) continue;
    const basename = name.split('/')[1];
    if (basename === undefined || expected.has(basename)) {
      authoredTransactionFailure('the replay manifest has colliding blob references');
    }
    expected.set(basename, mutation);
  }
  return expected;
}

function assertBlobRootLayout(
  rootPath: string,
  kind: 'desired' | 'preimage',
  hasBlobs: boolean,
): void {
  const expectedEntryCount = hasBlobs ? 2 : 1;
  const rootNames = [
    ...readBoundedAuthoredDirectory(
      rootPath,
      expectedEntryCount,
      expectedEntryCount * INIT_AUTHORED_PLAN_CAPS.maxBlobNameBytes,
      'authored artifact root',
    ),
  ].sort();
  const expectedRootNames = hasBlobs
    ? [AUTHORED_ARTIFACT_OWNER_FILE, kind].sort()
    : [AUTHORED_ARTIFACT_OWNER_FILE];
  if (
    rootNames.length !== expectedRootNames.length ||
    rootNames.some((name, index) => name !== expectedRootNames[index])
  ) {
    authoredTransactionFailure('an authored artifact root has unexpected entries');
  }
}

function assertBlobDirectory(rootPath: string, kind: string): void {
  const directory = lstatSync(join(rootPath, kind), { bigint: true });
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    Number(directory.mode & 0o777n) !== 0o700
  ) {
    authoredTransactionFailure('an authored blob directory has unsafe identity');
  }
}

function validateExpectedBlobs(
  rootPath: string,
  kind: 'desired' | 'preimage',
  expected: ReadonlyMap<string, InitAuthoredMutation>,
  allowedMissing: ReadonlySet<number>,
): number {
  const observed = new Set(
    readBoundedAuthoredDirectory(
      join(rootPath, kind),
      expected.size,
      expected.size * INIT_AUTHORED_PLAN_CAPS.maxBlobNameBytes,
      'authored blob directory',
    ),
  );
  let totalBytes = 0;
  for (const [basename, mutation] of expected) {
    if (!observed.delete(basename)) {
      if (!allowedMissing.has(mutation.sequence)) {
        authoredTransactionFailure('a required authored blob is missing');
      }
      continue;
    }
    const state = kind === 'desired' ? mutation.desired : mutation.preimage;
    const file = readStableArtifactFile(join(rootPath, kind, basename));
    if (file.mode !== state.mode || file.digest !== state.digest) {
      authoredTransactionFailure('an authored blob was changed after preparation');
    }
    totalBytes += file.bytes.length;
    if (totalBytes > INIT_AUTHORED_PLAN_CAPS.maxAggregateBlobBytes) {
      authoredTransactionFailure('authored blob validation exceeded its aggregate cap');
    }
  }
  if (observed.size > 0) {
    authoredTransactionFailure('an authored blob directory has extra files');
  }
  return totalBytes;
}

function validateBlobRoot(
  rootPath: string,
  owner: AuthoredArtifactOwner,
  manifest: AuthoredReplayManifest,
  kind: 'desired' | 'preimage',
  allowedMissing: ReadonlySet<number>,
): number {
  expectedOwner(rootPath, owner);
  const expected = expectedBlobNames(manifest, kind);
  assertBlobRootLayout(rootPath, kind, expected.size > 0);
  if (expected.size === 0) return 0;
  assertBlobDirectory(rootPath, kind);
  return validateExpectedBlobs(rootPath, kind, expected, allowedMissing);
}

export function validateAuthoredArtifacts(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  manifest: AuthoredReplayManifest,
  manifestBytes: string,
  paths: AuthoredArtifactPaths,
  availability: AuthoredBlobAvailability,
): void {
  assertStableAuthoredRoot(root);
  const preparing = journal.progress.pendingIntent?.kind === 'authored-prepare';
  const cleanupSlot =
    journal.progress.pendingIntent?.kind === 'owned-slot-cleanup'
      ? journal.progress.pendingIntent.slot
      : null;
  let aggregateBytes = 0;
  if (
    (preparing || journal.cleanup.replayManifest === 'pending') &&
    cleanupSlot !== 'replayManifest'
  ) {
    const replay = readStableArtifactFile(paths.replayManifest);
    if (
      replay.mode !== 0o600 ||
      replay.bytes.toString('utf8') !== manifestBytes ||
      replay.digest !== journal.plan.replayDigest
    ) {
      authoredTransactionFailure('the stored replay manifest does not match the journal');
    }
  }
  if (
    (preparing || journal.cleanup.authoredStage === 'pending') &&
    cleanupSlot !== 'authoredStage'
  ) {
    aggregateBytes += validateBlobRoot(
      paths.stageRoot,
      ownerFor(journal, 'stage'),
      manifest,
      'desired',
      availability.desiredConsumed,
    );
  }
  if (
    (preparing || journal.cleanup.authoredBackup === 'pending') &&
    cleanupSlot !== 'authoredBackup'
  ) {
    aggregateBytes += validateBlobRoot(
      paths.backupRoot,
      ownerFor(journal, 'backup'),
      manifest,
      'preimage',
      availability.preimageConsumed,
    );
  }
  if (aggregateBytes > INIT_AUTHORED_PLAN_CAPS.maxAggregateBlobBytes) {
    authoredTransactionFailure('authored artifacts exceed their aggregate blob cap');
  }
  assertStableAuthoredRoot(root);
}

function authoredPlanDigest(manifestBytes: string, manifest: AuthoredReplayManifest): string {
  return sha256Bytes(
    Buffer.concat([
      Buffer.from('opensip-init-authored-plan\0v1\0', 'utf8'),
      Buffer.from(JSON.stringify(manifest.inputs), 'utf8'),
      Buffer.from('\0', 'utf8'),
      Buffer.from(manifestBytes, 'utf8'),
    ]),
  );
}

export function loadAuthoredReplayManifest(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  paths: AuthoredArtifactPaths,
): { readonly manifest: AuthoredReplayManifest; readonly bytes: string } {
  assertStableAuthoredRoot(root);
  const settled = settleAuthoredReplayPublication(root, journal, paths);
  if (settled.status !== 'present') {
    authoredTransactionFailure('the replay manifest is absent');
  }
  const replay = readStableArtifactFile(paths.replayManifest);
  if (replay.mode !== 0o600 || replay.digest !== journal.plan.replayDigest) {
    authoredTransactionFailure('the replay manifest identity is invalid');
  }
  const bytes = replay.bytes.toString('utf8');
  const manifest = parseAuthoredReplayManifest(bytes);
  if (
    encodeAuthoredReplayManifest(manifest) !== bytes ||
    manifest.mutations.length !== journal.plan.mutationCount ||
    authoredPlanDigest(bytes, manifest) !== journal.plan.authoredDigest
  ) {
    authoredTransactionFailure('the replay manifest does not match the durable plan identity');
  }
  return { manifest, bytes };
}

export function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

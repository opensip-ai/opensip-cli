import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  ANCHORED_CREATE_RECOVERY_MAX_ENTRIES,
  mutateAnchoredRecord,
  readAnchoredRecord,
  SystemError,
} from '@opensip-cli/core';

import {
  assertStableAuthoredEntry,
  assertStableAuthoredRoot,
  authoredTransactionFailure,
  bindStableAuthoredEntry,
  readStableArtifactFile,
  type AuthoredEntryIdentity,
  type StableAuthoredEntry,
  type StableAuthoredRoot,
} from './authored-state-transaction-fs.js';

import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';

const CLEANUP_EVIDENCE_KIND = 'opensip-init-authored-cleanup-evidence' as const;
const CLEANUP_EVIDENCE_VERSION = 1 as const;
const CLEANUP_EVIDENCE_MAX_BYTES = 2048;
const EVIDENCE_KEYS = [
  'kind',
  'version',
  'operationId',
  'ownershipId',
  'slot',
  'artifactBasename',
  'artifactIdentity',
] as const;
const IDENTITY_KEYS = ['dev', 'ino', 'uid', 'mode'] as const;
const CANONICAL_NONNEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/u;

type AuthoredBlobSlot = 'authoredStage' | 'authoredBackup';

interface AuthoredCleanupEvidenceRecord {
  readonly kind: typeof CLEANUP_EVIDENCE_KIND;
  readonly version: typeof CLEANUP_EVIDENCE_VERSION;
  readonly operationId: string;
  readonly ownershipId: string;
  readonly slot: AuthoredBlobSlot;
  readonly artifactBasename: string;
  readonly artifactIdentity: {
    readonly dev: string;
    readonly ino: string;
    readonly uid: string;
    readonly mode: string;
  };
}

export interface AuthoredCleanupEvidence {
  readonly path: string;
  readonly basename: string;
  readonly bytes: string;
  readonly digest: string;
  readonly entry: StableAuthoredEntry;
  readonly record: AuthoredCleanupEvidenceRecord;
}

function slotIdentity(
  journal: RuntimePromotionJournal,
  slot: AuthoredBlobSlot,
): RuntimePromotionJournal['owned']['authoredStage'] {
  return slot === 'authoredStage' ? journal.owned.authoredStage : journal.owned.authoredBackup;
}

function evidenceDigest(
  journal: RuntimePromotionJournal,
  slot: AuthoredBlobSlot,
  domain: string,
): string {
  const owned = slotIdentity(journal, slot);
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(journal.operationId)
    .update('\0')
    .update(slot)
    .update('\0')
    .update(owned.ownershipId)
    .digest('hex');
}

export function authoredCleanupEvidenceBasename(
  journal: RuntimePromotionJournal,
  slot: AuthoredBlobSlot,
): string {
  return `.opensip-init-authored-cleanup-${evidenceDigest(
    journal,
    slot,
    'opensip:init-authored-cleanup-evidence-basename:v1',
  )}.json`;
}

function cleanupEvidenceCreateIdentity(
  journal: RuntimePromotionJournal,
  slot: AuthoredBlobSlot,
): string {
  return `authored-cleanup-${evidenceDigest(
    journal,
    slot,
    'opensip:init-authored-cleanup-evidence-create:v1',
  )}`;
}

function rootIdentity(
  identity: AuthoredEntryIdentity,
): AuthoredCleanupEvidenceRecord['artifactIdentity'] {
  return {
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    uid: identity.uid.toString(),
    mode: identity.mode.toString(),
  };
}

function recordFor(
  journal: RuntimePromotionJournal,
  slot: AuthoredBlobSlot,
  artifactRoot: StableAuthoredEntry,
): AuthoredCleanupEvidenceRecord {
  if (artifactRoot.type !== 'directory') {
    authoredTransactionFailure('authored cleanup evidence requires a directory authority');
  }
  const owned = slotIdentity(journal, slot);
  return {
    kind: CLEANUP_EVIDENCE_KIND,
    version: CLEANUP_EVIDENCE_VERSION,
    operationId: journal.operationId,
    ownershipId: owned.ownershipId,
    slot,
    artifactBasename: owned.basename,
    artifactIdentity: rootIdentity(artifactRoot.identity),
  };
}

function encodeCleanupEvidence(record: AuthoredCleanupEvidenceRecord): string {
  return JSON.stringify(record);
}

function parseCleanupEvidence(
  raw: string,
  journal: RuntimePromotionJournal,
  slot: AuthoredBlobSlot,
): AuthoredCleanupEvidenceRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    authoredTransactionFailure('authored cleanup evidence is malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    authoredTransactionFailure('authored cleanup evidence has the wrong shape');
  }
  const candidate = value as Record<string, unknown>;
  const identity = candidate.artifactIdentity;
  const owned = slotIdentity(journal, slot);
  if (
    Object.keys(candidate).length !== EVIDENCE_KEYS.length ||
    EVIDENCE_KEYS.some((key, index) => Object.keys(candidate)[index] !== key) ||
    candidate.kind !== CLEANUP_EVIDENCE_KIND ||
    candidate.version !== CLEANUP_EVIDENCE_VERSION ||
    candidate.operationId !== journal.operationId ||
    candidate.ownershipId !== owned.ownershipId ||
    candidate.slot !== slot ||
    candidate.artifactBasename !== owned.basename ||
    typeof identity !== 'object' ||
    identity === null ||
    Array.isArray(identity)
  ) {
    authoredTransactionFailure('authored cleanup evidence does not match the journal');
  }
  const identityRecord = identity as Record<string, unknown>;
  if (
    Object.keys(identityRecord).length !== IDENTITY_KEYS.length ||
    IDENTITY_KEYS.some((key, index) => Object.keys(identityRecord)[index] !== key) ||
    IDENTITY_KEYS.some((key) => {
      const component = identityRecord[key];
      return typeof component !== 'string' || !CANONICAL_NONNEGATIVE_INTEGER.test(component);
    })
  ) {
    authoredTransactionFailure('authored cleanup evidence has an invalid root identity');
  }
  const record = candidate as unknown as AuthoredCleanupEvidenceRecord;
  if (encodeCleanupEvidence(record) !== raw) {
    authoredTransactionFailure('authored cleanup evidence is noncanonical');
  }
  return record;
}

function evidenceFromBytes(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  slot: AuthoredBlobSlot,
  bytes: string,
  digest: string,
): AuthoredCleanupEvidence {
  const basename = authoredCleanupEvidenceBasename(journal, slot);
  const path = join(root.path, basename);
  const entry = bindStableAuthoredEntry(path, 'file', 'the authored cleanup evidence');
  const observed = readStableArtifactFile(path);
  assertStableAuthoredEntry(entry, 'the authored cleanup evidence');
  if (
    observed.mode !== 0o600 ||
    observed.digest !== digest ||
    observed.bytes.toString('utf8') !== bytes
  ) {
    authoredTransactionFailure('authored cleanup evidence changed while its identity was bound');
  }
  return {
    path,
    basename,
    bytes,
    digest,
    entry,
    record: parseCleanupEvidence(bytes, journal, slot),
  };
}

function readEvidenceRecord(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  slot: AuthoredBlobSlot,
  expected?: { readonly bytes: string; readonly digest: string },
): AuthoredCleanupEvidence | null {
  assertStableAuthoredRoot(root);
  const basename = authoredCleanupEvidenceBasename(journal, slot);
  const observed = readAnchoredRecord({
    trustedAnchorDir: root.path,
    parentDir: root.path,
    basename,
    maxBytes: CLEANUP_EVIDENCE_MAX_BYTES,
    permissionPosture: 'owner-controlled',
    recordPosture: 'private',
    ...(expected === undefined
      ? {}
      : {
          linkedCreateRecovery: {
            effect: 'settle-or-discard-owned-temporary' as const,
            expectedContentSha256: expected.digest,
            createIdentity: cleanupEvidenceCreateIdentity(journal, slot),
            maxEntries: ANCHORED_CREATE_RECOVERY_MAX_ENTRIES,
          },
        }),
  });
  assertStableAuthoredRoot(root);
  if (observed.status === 'absent') return null;
  if (
    expected !== undefined &&
    (observed.content !== expected.bytes || observed.sha256 !== expected.digest)
  ) {
    authoredTransactionFailure('authored cleanup evidence changed after publication');
  }
  return evidenceFromBytes(root, journal, slot, observed.content, observed.sha256);
}

function isAnchoredCreateConflict(error: unknown): boolean {
  return error instanceof SystemError && error.code === 'SYSTEM.RUNTIME_COORDINATION.EXISTS';
}

export function ensureAuthoredCleanupEvidence(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  slot: AuthoredBlobSlot,
  artifactRoot: StableAuthoredEntry,
): AuthoredCleanupEvidence {
  assertStableAuthoredRoot(root);
  assertStableAuthoredEntry(artifactRoot, 'the authored cleanup artifact root');
  const bytes = encodeCleanupEvidence(recordFor(journal, slot, artifactRoot));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const expected = { bytes, digest };
  const existing = readEvidenceRecord(root, journal, slot, expected);
  if (existing !== null) {
    assertAuthoredCleanupEvidenceRoot(existing, artifactRoot);
    return existing;
  }
  try {
    mutateAnchoredRecord({
      trustedAnchorDir: root.path,
      parentDir: root.path,
      basename: authoredCleanupEvidenceBasename(journal, slot),
      operation: 'create',
      content: bytes,
      maxBytes: CLEANUP_EVIDENCE_MAX_BYTES,
      permissionPosture: 'owner-controlled',
      recordPosture: 'private',
      createIdentity: cleanupEvidenceCreateIdentity(journal, slot),
    });
  } catch (error) {
    if (!isAnchoredCreateConflict(error)) throw error;
  }
  assertStableAuthoredEntry(artifactRoot, 'the authored cleanup artifact root');
  const created = readEvidenceRecord(root, journal, slot, expected);
  if (created === null) {
    authoredTransactionFailure('authored cleanup evidence was not durably published');
  }
  assertAuthoredCleanupEvidenceRoot(created, artifactRoot);
  return created;
}

export function readAuthoredCleanupEvidence(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  slot: AuthoredBlobSlot,
): AuthoredCleanupEvidence | null {
  return readEvidenceRecord(root, journal, slot);
}

export function assertAuthoredCleanupEvidenceAbsent(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  slot: AuthoredBlobSlot,
): void {
  if (readEvidenceRecord(root, journal, slot) !== null) {
    authoredTransactionFailure('authored cleanup evidence remained after cleanup');
  }
}

export function assertAuthoredCleanupEvidenceRoot(
  evidence: AuthoredCleanupEvidence,
  artifactRoot: StableAuthoredEntry,
): void {
  const expected = evidence.record.artifactIdentity;
  const observed = rootIdentity(artifactRoot.identity);
  if (
    artifactRoot.type !== 'directory' ||
    expected.dev !== observed.dev ||
    expected.ino !== observed.ino ||
    expected.uid !== observed.uid ||
    expected.mode !== observed.mode
  ) {
    authoredTransactionFailure('the authored cleanup artifact root was replaced');
  }
}

export function removeAuthoredCleanupEvidence(
  root: StableAuthoredRoot,
  journal: RuntimePromotionJournal,
  slot: AuthoredBlobSlot,
  evidence: AuthoredCleanupEvidence,
): void {
  assertStableAuthoredRoot(root);
  assertStableAuthoredEntry(evidence.entry, 'the authored cleanup evidence');
  mutateAnchoredRecord({
    trustedAnchorDir: root.path,
    parentDir: root.path,
    basename: evidence.basename,
    operation: 'unlink',
    expectedContentSha256: evidence.digest,
    maxBytes: CLEANUP_EVIDENCE_MAX_BYTES,
    permissionPosture: 'owner-controlled',
    recordPosture: 'private',
  });
  assertStableAuthoredRoot(root);
  if (readEvidenceRecord(root, journal, slot) !== null) {
    authoredTransactionFailure('authored cleanup evidence remained after removal');
  }
}

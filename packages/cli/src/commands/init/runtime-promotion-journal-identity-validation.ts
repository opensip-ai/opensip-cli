/** Bounded runtime-identity and write-ahead intent validators. */

import {
  RUNTIME_PROMOTION_DIGEST_PATTERN,
  RUNTIME_PROMOTION_INTENT_KINDS,
  RUNTIME_PROMOTION_JOURNAL_CAPS,
  RUNTIME_PROMOTION_OWNED_SLOT_NAMES,
  RUNTIME_PROMOTION_POSTCONDITION_OUTCOMES,
  type RuntimeManifestIdentity,
  type RuntimeManifestSqliteIdentity,
  type RuntimePromotionPendingIntent,
  type RuntimePromotionPostcondition,
} from './runtime-promotion-journal-types.js';
import {
  journalChoice,
  journalFailure,
  journalInteger,
  journalKeys,
  journalObject,
  journalPattern,
} from './runtime-promotion-journal-validation-helpers.js';

function validateSqlite(value: unknown, field: string): void {
  const sqlite = journalObject(value, field);
  if (sqlite.status === 'absent') {
    journalKeys(sqlite, ['status'], field);
    return;
  }
  if (sqlite.status !== 'verified') journalFailure(`${field}.status is unsupported`);
  journalKeys(sqlite, ['status', 'sha256', 'userVersion'], field);
  journalPattern(sqlite.sha256, RUNTIME_PROMOTION_DIGEST_PATTERN, `${field}.sha256`);
  journalInteger(
    sqlite.userVersion,
    `${field}.userVersion`,
    RUNTIME_PROMOTION_JOURNAL_CAPS.maxSqliteUserVersion,
  );
}

export function assertRuntimeManifestIdentity(
  value: unknown,
  field = 'runtimeManifest',
): asserts value is RuntimeManifestIdentity {
  const identity = journalObject(value, field);
  journalKeys(
    identity,
    ['digest', 'fileCount', 'directoryCount', 'symlinkCount', 'rootMode', 'totalBytes', 'sqlite'],
    field,
  );
  journalPattern(identity.digest, RUNTIME_PROMOTION_DIGEST_PATTERN, `${field}.digest`);
  const counts = ['fileCount', 'directoryCount', 'symlinkCount'].map((name) =>
    journalInteger(
      identity[name],
      `${field}.${name}`,
      RUNTIME_PROMOTION_JOURNAL_CAPS.maxRuntimeEntries,
    ),
  );
  if (
    counts.reduce((sum, count) => sum + count, 0) > RUNTIME_PROMOTION_JOURNAL_CAPS.maxRuntimeEntries
  ) {
    journalFailure(`${field} exceeds the aggregate entry cap`);
  }
  journalInteger(identity.rootMode, `${field}.rootMode`, 0o777);
  journalInteger(
    identity.totalBytes,
    `${field}.totalBytes`,
    RUNTIME_PROMOTION_JOURNAL_CAPS.maxRuntimeBytes,
  );
  validateSqlite(identity.sqlite, `${field}.sqlite`);
}

export function validateManifests(value: unknown): void {
  const manifests = journalObject(value, 'manifests');
  journalKeys(manifests, ['source', 'destination', 'runtimeStage'], 'manifests');
  for (const name of ['source', 'destination', 'runtimeStage'] as const) {
    if (manifests[name] !== null) {
      assertRuntimeManifestIdentity(manifests[name], `manifests.${name}`);
    }
  }
}

function requiredIntentSlot(kind: RuntimePromotionPendingIntent['kind']) {
  const slots: Partial<
    Record<RuntimePromotionPendingIntent['kind'], RuntimePromotionPendingIntent['slot']>
  > = {
    'runtime-stage-create': 'runtimeStage',
    'destination-parent-create': 'destinationParent',
    'destination-backup-create': 'destinationBackup',
    'destination-install': 'destinationParent',
    'authored-prepare': 'authoredStage',
    'authored-target-commit': 'replayManifest',
    'source-retire': 'sourceTombstone',
    'runtime-rollback': 'destinationBackup',
    'authored-target-rollback': 'replayManifest',
  };
  return slots[kind];
}

export function validateIntent(value: unknown, field: string): RuntimePromotionPendingIntent {
  const intent = journalObject(value, field);
  journalKeys(intent, ['sequence', 'kind', 'slot', 'cursor', 'recordedAt'], field);
  const kind = journalChoice(intent.kind, RUNTIME_PROMOTION_INTENT_KINDS, `${field}.kind`);
  const slot =
    intent.slot === null
      ? null
      : journalChoice(intent.slot, RUNTIME_PROMOTION_OWNED_SLOT_NAMES, `${field}.slot`);
  const cursor =
    intent.cursor === null
      ? null
      : journalInteger(
          intent.cursor,
          `${field}.cursor`,
          RUNTIME_PROMOTION_JOURNAL_CAPS.maxAuthoredMutations,
        );
  const cursorKind = kind === 'authored-target-commit' || kind === 'authored-target-rollback';
  if (cursorKind !== (cursor !== null)) {
    journalFailure(`${field}.cursor does not match its intent kind`);
  }
  const requiredSlot = requiredIntentSlot(kind);
  if (
    (requiredSlot !== undefined && slot !== requiredSlot) ||
    (kind === 'owned-slot-cleanup' && slot === null)
  ) {
    journalFailure(`${field}.slot does not match its intent kind`);
  }
  return {
    sequence: journalInteger(
      intent.sequence,
      `${field}.sequence`,
      RUNTIME_PROMOTION_JOURNAL_CAPS.maxRevision,
      1,
    ),
    kind,
    slot,
    cursor,
    recordedAt: journalInteger(
      intent.recordedAt,
      `${field}.recordedAt`,
      RUNTIME_PROMOTION_JOURNAL_CAPS.maxTimestamp,
    ),
  };
}

export function validatePostcondition(
  value: unknown,
  field: string,
): RuntimePromotionPostcondition {
  const post = journalObject(value, field);
  journalKeys(post, ['sequence', 'kind', 'slot', 'cursor', 'outcome', 'recordedAt'], field);
  const base = validateIntent(
    {
      sequence: post.sequence,
      kind: post.kind,
      slot: post.slot,
      cursor: post.cursor,
      recordedAt: post.recordedAt,
    },
    field,
  );
  return {
    ...base,
    outcome: journalChoice(
      post.outcome,
      RUNTIME_PROMOTION_POSTCONDITION_OUTCOMES,
      `${field}.outcome`,
    ),
  };
}

export function canonicalSqliteIdentity(
  identity: RuntimeManifestSqliteIdentity,
): RuntimeManifestSqliteIdentity {
  return identity.status === 'absent'
    ? { status: 'absent' }
    : {
        status: 'verified',
        sha256: identity.sha256,
        userVersion: identity.userVersion,
      };
}

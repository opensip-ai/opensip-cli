/**
 * Public canonical codec for Init's bounded, path-neutral promotion journal.
 * No journal payload contains absolute paths, entry lists, or authored bytes.
 */

import {
  RUNTIME_PROMOTION_JOURNAL_KIND,
  RUNTIME_PROMOTION_JOURNAL_MAX_BYTES,
  RUNTIME_PROMOTION_JOURNAL_VERSION,
  type CreateRuntimePromotionJournalInput,
  type RuntimeManifestIdentity,
  type RuntimePromotionIntentKind,
  type RuntimePromotionJournal,
  type RuntimePromotionJournalBinding,
  type RuntimePromotionOwnedSlot,
  type RuntimePromotionOwnedSlotName,
  type RuntimePromotionPendingIntent,
  type RuntimePromotionPostcondition,
  type RuntimePromotionTerminal,
} from './runtime-promotion-journal-types.js';
import {
  assertRuntimePromotionJournalShape,
  canonicalSqliteIdentity,
  isRuntimePromotionJournalShape,
} from './runtime-promotion-journal-validation.js';

export * from './runtime-promotion-journal-types.js';
export {
  assertRuntimeManifestIdentity,
  isRuntimePromotionCoordinationKey,
  isRuntimePromotionDigest,
  isSafeRuntimePromotionBasename,
} from './runtime-promotion-journal-validation.js';
export {
  createRuntimePromotionOwnedSlots,
  runtimePromotionOwnedBasename,
  runtimePromotionOwnershipId,
} from './runtime-promotion-owned-identities.js';

function canonicalManifest(identity: RuntimeManifestIdentity): RuntimeManifestIdentity {
  return {
    digest: identity.digest,
    fileCount: identity.fileCount,
    directoryCount: identity.directoryCount,
    symlinkCount: identity.symlinkCount,
    rootMode: identity.rootMode,
    totalBytes: identity.totalBytes,
    sqlite: canonicalSqliteIdentity(identity.sqlite),
  };
}

function nullableManifest(
  identity: RuntimeManifestIdentity | null,
): RuntimeManifestIdentity | null {
  return identity === null ? null : canonicalManifest(identity);
}

function ownedSlot(slot: RuntimePromotionOwnedSlot): RuntimePromotionOwnedSlot {
  return { basename: slot.basename, ownershipId: slot.ownershipId };
}

function intent(value: RuntimePromotionPendingIntent): RuntimePromotionPendingIntent {
  return {
    sequence: value.sequence,
    kind: value.kind,
    slot: value.slot,
    cursor: value.cursor,
    recordedAt: value.recordedAt,
  };
}

function postcondition(value: RuntimePromotionPostcondition): RuntimePromotionPostcondition {
  return {
    sequence: value.sequence,
    kind: value.kind,
    slot: value.slot,
    cursor: value.cursor,
    outcome: value.outcome,
    recordedAt: value.recordedAt,
  };
}

function terminal(value: RuntimePromotionTerminal | null): RuntimePromotionTerminal | null {
  return value === null
    ? null
    : {
        outcome: value.outcome,
        authority: value.authority,
        runtimeManifest: nullableManifest(value.runtimeManifest),
        authoredVerified: value.authoredVerified,
        sourcePreserved: value.sourcePreserved,
        verifiedAt: value.verifiedAt,
      };
}

/** Validate the complete v1 shape and all static field combinations. */
export function assertRuntimePromotionJournal(
  value: unknown,
): asserts value is RuntimePromotionJournal {
  assertRuntimePromotionJournalShape(value);
}

export function isRuntimePromotionJournal(value: unknown): value is RuntimePromotionJournal {
  return isRuntimePromotionJournalShape(value);
}

/** Return a deep copy with the one accepted v1 key order. */
export function canonicalRuntimePromotionJournal(
  journal: RuntimePromotionJournal,
): RuntimePromotionJournal {
  assertRuntimePromotionJournal(journal);
  return {
    kind: RUNTIME_PROMOTION_JOURNAL_KIND,
    version: RUNTIME_PROMOTION_JOURNAL_VERSION,
    coordinationKey: journal.coordinationKey,
    operationId: journal.operationId,
    state: journal.state,
    revision: journal.revision,
    recoveryOwnerToken: journal.recoveryOwnerToken,
    recoveryAttempt: journal.recoveryAttempt,
    route: journal.route,
    destinationParentPreexisting: journal.destinationParentPreexisting,
    destinationRuntimePreexisting: journal.destinationRuntimePreexisting,
    source: {
      classification: journal.source.classification,
      cacheKey: journal.source.cacheKey,
      generationDigest: journal.source.generationDigest,
      markerSha256: journal.source.markerSha256,
    },
    inputs: {
      conflict: journal.inputs.conflict,
      authoredMode: journal.inputs.authoredMode,
      languages: [...journal.inputs.languages],
      languageExplicit: journal.inputs.languageExplicit,
    },
    plan: {
      authoredDigest: journal.plan.authoredDigest,
      replayDigest: journal.plan.replayDigest,
      mutationCount: journal.plan.mutationCount,
    },
    owned: {
      destinationParent: ownedSlot(journal.owned.destinationParent),
      runtimeStage: ownedSlot(journal.owned.runtimeStage),
      destinationBackup: ownedSlot(journal.owned.destinationBackup),
      sourceTombstone: ownedSlot(journal.owned.sourceTombstone),
      authoredStage: ownedSlot(journal.owned.authoredStage),
      authoredBackup: ownedSlot(journal.owned.authoredBackup),
      replayManifest: ownedSlot(journal.owned.replayManifest),
    },
    manifests: {
      source: nullableManifest(journal.manifests.source),
      destination: nullableManifest(journal.manifests.destination),
      runtimeStage: nullableManifest(journal.manifests.runtimeStage),
    },
    progress: {
      phase: journal.progress.phase,
      direction: journal.progress.direction,
      runtimeInstallState: journal.progress.runtimeInstallState,
      authoredCursor: journal.progress.authoredCursor,
      rollbackCursor: journal.progress.rollbackCursor,
      pendingIntent:
        journal.progress.pendingIntent === null ? null : intent(journal.progress.pendingIntent),
      lastPostcondition:
        journal.progress.lastPostcondition === null
          ? null
          : postcondition(journal.progress.lastPostcondition),
    },
    terminal: terminal(journal.terminal),
    cleanup: {
      destinationParent: journal.cleanup.destinationParent,
      runtimeStage: journal.cleanup.runtimeStage,
      destinationBackup: journal.cleanup.destinationBackup,
      sourceTombstone: journal.cleanup.sourceTombstone,
      authoredStage: journal.cleanup.authoredStage,
      authoredBackup: journal.cleanup.authoredBackup,
      replayManifest: journal.cleanup.replayManifest,
    },
    counts: {
      intentCount: journal.counts.intentCount,
      postconditionCount: journal.counts.postconditionCount,
      authoredCompleted: journal.counts.authoredCompleted,
      authoredRolledBack: journal.counts.authoredRolledBack,
      cleanupCompleted: journal.counts.cleanupCompleted,
    },
    timestamps: {
      createdAt: journal.timestamps.createdAt,
      updatedAt: journal.timestamps.updatedAt,
      closedAt: journal.timestamps.closedAt,
    },
    ...(journal.reason === undefined ? {} : { reason: journal.reason }),
  };
}

/** Compact canonical JSON with no trailing newline. */
export function encodeRuntimePromotionJournal(journal: RuntimePromotionJournal): string {
  const encoded = JSON.stringify(canonicalRuntimePromotionJournal(journal));
  if (Buffer.byteLength(encoded, 'utf8') > RUNTIME_PROMOTION_JOURNAL_MAX_BYTES) {
    throw new Error(
      `Runtime promotion journal exceeds ${RUNTIME_PROMOTION_JOURNAL_MAX_BYTES} bytes`,
    );
  }
  return encoded;
}

/**
 * Parse only exact canonical bytes. Re-encoding catches duplicate keys,
 * reordered fields, alternate escapes, whitespace, and unknown additions.
 */
export function parseRuntimePromotionJournal(
  raw: string,
  expected: RuntimePromotionJournalBinding = {},
): RuntimePromotionJournal {
  if (Buffer.byteLength(raw, 'utf8') > RUNTIME_PROMOTION_JOURNAL_MAX_BYTES) {
    throw new Error(
      `Runtime promotion journal exceeds ${RUNTIME_PROMOTION_JOURNAL_MAX_BYTES} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Runtime promotion journal is not valid JSON');
  }
  assertRuntimePromotionJournal(parsed);
  const canonical = canonicalRuntimePromotionJournal(parsed);
  if (raw !== encodeRuntimePromotionJournal(canonical)) {
    throw new Error('Runtime promotion journal is not canonical v1 JSON');
  }
  if (
    (expected.coordinationKey !== undefined &&
      canonical.coordinationKey !== expected.coordinationKey) ||
    (expected.operationId !== undefined && canonical.operationId !== expected.operationId) ||
    (expected.state !== undefined && canonical.state !== expected.state)
  ) {
    throw new Error('Runtime promotion journal does not match the expected authority');
  }
  return canonical;
}

/** Construct the only legal revision-zero record. */
export function createInitialRuntimePromotionJournal(
  input: CreateRuntimePromotionJournalInput,
): RuntimePromotionJournal {
  return canonicalRuntimePromotionJournal({
    kind: RUNTIME_PROMOTION_JOURNAL_KIND,
    version: RUNTIME_PROMOTION_JOURNAL_VERSION,
    coordinationKey: input.coordinationKey,
    operationId: input.operationId,
    state: 'open',
    revision: 0,
    recoveryOwnerToken: input.recoveryOwnerToken,
    recoveryAttempt: 1,
    route: input.route,
    destinationParentPreexisting: input.destinationParentPreexisting,
    destinationRuntimePreexisting: input.destinationRuntimePreexisting,
    source: input.source,
    inputs: input.inputs,
    plan: input.plan,
    owned: input.owned,
    manifests: { source: null, destination: null, runtimeStage: null },
    progress: {
      phase: 'prepared',
      direction: 'forward',
      runtimeInstallState: 'not-installed',
      authoredCursor: 0,
      rollbackCursor: 0,
      pendingIntent: null,
      lastPostcondition: null,
    },
    terminal: null,
    cleanup: {
      destinationParent: 'unmaterialized',
      runtimeStage: 'unmaterialized',
      destinationBackup: 'unmaterialized',
      sourceTombstone: 'unmaterialized',
      authoredStage: 'unmaterialized',
      authoredBackup: 'unmaterialized',
      replayManifest: 'unmaterialized',
    },
    counts: {
      intentCount: 0,
      postconditionCount: 0,
      authoredCompleted: 0,
      authoredRolledBack: 0,
      cleanupCompleted: 0,
    },
    timestamps: {
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      closedAt: null,
    },
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

/** Exact predicate used by materializers before consuming durable authority. */
export function hasRuntimePromotionIntent(
  journal: RuntimePromotionJournal,
  kind: RuntimePromotionIntentKind,
  slot?: RuntimePromotionOwnedSlotName,
): boolean {
  const pending = journal.progress.pendingIntent;
  return (
    pending?.kind === kind &&
    (slot === undefined || pending.slot === slot) &&
    pending.sequence === journal.counts.intentCount
  );
}

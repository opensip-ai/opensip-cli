import { describe, expect, it } from 'vitest';

import { runtimePromotionPendingIntentAllowed } from '../runtime-promotion-intent-policy.js';
import { assertRuntimePromotionTransition } from '../runtime-promotion-journal-machine.js';
import {
  canonicalRuntimePromotionJournal,
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  type RuntimeManifestIdentity,
  type RuntimePromotionJournal,
} from '../runtime-promotion-journal-schema.js';

const PROJECT_KEY = 'a'.repeat(24);
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const OPERATION_ID = 'recovery-state-operation-0001';

function manifest(digest = DIGEST_A): RuntimeManifestIdentity {
  return {
    digest,
    fileCount: 1,
    directoryCount: 1,
    symlinkCount: 0,
    rootMode: 0o700,
    totalBytes: 42,
    sqlite: { status: 'verified', sha256: DIGEST_B, userVersion: 4 },
  };
}

function initial(): RuntimePromotionJournal {
  return createInitialRuntimePromotionJournal({
    coordinationKey: PROJECT_KEY,
    operationId: OPERATION_ID,
    recoveryOwnerToken: 'recovery-state-owner-000001',
    route: 'authored-only',
    destinationParentPreexisting: false,
    destinationRuntimePreexisting: false,
    source: {
      classification: 'none',
      cacheKey: null,
      generationDigest: null,
      markerSha256: null,
    },
    inputs: {
      conflict: 'abort',
      authoredMode: 'fresh',
      languages: ['typescript'],
      languageExplicit: false,
    },
    plan: {
      authoredDigest: DIGEST_A,
      replayDigest: DIGEST_B,
      mutationCount: 1,
    },
    owned: createRuntimePromotionOwnedSlots(OPERATION_ID),
    createdAt: 100,
  });
}

function promote(): RuntimePromotionJournal {
  const journal = initial();
  return canonicalRuntimePromotionJournal({
    ...journal,
    destinationParentPreexisting: true,
    route: 'promote-cache',
    source: {
      classification: 'generation-bound',
      cacheKey: 'c'.repeat(24),
      generationDigest: 'c'.repeat(64),
      markerSha256: 'd'.repeat(64),
    },
    inputs: { ...journal.inputs, conflict: 'use-cache' },
  });
}

function authoredPrepared(): RuntimePromotionJournal {
  const journal = initial();
  return canonicalRuntimePromotionJournal({
    ...journal,
    revision: 2,
    progress: {
      ...journal.progress,
      phase: 'authored-prepared',
      lastPostcondition: {
        sequence: 1,
        kind: 'authored-prepare',
        slot: 'authoredStage',
        cursor: null,
        outcome: 'applied',
        recordedAt: 102,
      },
    },
    cleanup: {
      ...journal.cleanup,
      authoredStage: 'pending',
      authoredBackup: 'pending',
      replayManifest: 'pending',
    },
    counts: { ...journal.counts, intentCount: 1, postconditionCount: 1 },
    timestamps: { ...journal.timestamps, updatedAt: 102 },
  });
}

function runtimeInstalled(): RuntimePromotionJournal {
  const journal = promote();
  return canonicalRuntimePromotionJournal({
    ...journal,
    revision: 6,
    manifests: {
      ...journal.manifests,
      source: manifest(),
      runtimeStage: manifest(DIGEST_B),
    },
    progress: {
      ...journal.progress,
      phase: 'runtime-installed',
      runtimeInstallState: 'installed',
      lastPostcondition: {
        sequence: 2,
        kind: 'destination-install',
        slot: 'destinationParent',
        cursor: null,
        outcome: 'applied',
        recordedAt: 106,
      },
    },
    cleanup: {
      ...journal.cleanup,
      runtimeStage: 'removed',
      authoredStage: 'pending',
      authoredBackup: 'pending',
      replayManifest: 'pending',
    },
    counts: { ...journal.counts, intentCount: 2, postconditionCount: 2 },
    timestamps: { ...journal.timestamps, updatedAt: 106 },
  });
}

function runtimeBackedUpBeforeInstall(): RuntimePromotionJournal {
  const journal = promote();
  return canonicalRuntimePromotionJournal({
    ...journal,
    destinationRuntimePreexisting: true,
    revision: 6,
    manifests: {
      source: manifest(),
      destination: manifest(DIGEST_B),
      runtimeStage: manifest(),
    },
    progress: {
      ...journal.progress,
      phase: 'destination-backed-up',
      lastPostcondition: {
        sequence: 3,
        kind: 'destination-backup-create',
        slot: 'destinationBackup',
        cursor: null,
        outcome: 'applied',
        recordedAt: 106,
      },
    },
    cleanup: {
      ...journal.cleanup,
      runtimeStage: 'pending',
      destinationBackup: 'pending',
      authoredStage: 'pending',
      authoredBackup: 'pending',
      replayManifest: 'pending',
    },
    counts: { ...journal.counts, intentCount: 3, postconditionCount: 3 },
    timestamps: { ...journal.timestamps, updatedAt: 106 },
  });
}

function beginRollback(record: RuntimePromotionJournal): RuntimePromotionJournal {
  return canonicalRuntimePromotionJournal({
    ...record,
    revision: record.revision + 1,
    progress: {
      ...record.progress,
      phase: 'rollback-started',
      direction: 'rollback',
    },
    timestamps: {
      ...record.timestamps,
      updatedAt: record.timestamps.updatedAt + 1,
    },
  });
}

function abortAuthoredPreparation(record: RuntimePromotionJournal): {
  readonly intent: RuntimePromotionJournal;
  readonly aborted: RuntimePromotionJournal;
} {
  const recordedAt = record.timestamps.updatedAt + 1;
  const sequence = record.counts.intentCount + 1;
  const intent = canonicalRuntimePromotionJournal({
    ...record,
    revision: record.revision + 1,
    progress: {
      ...record.progress,
      pendingIntent: {
        sequence,
        kind: 'authored-prepare',
        slot: 'authoredStage',
        cursor: null,
        recordedAt,
      },
    },
    counts: { ...record.counts, intentCount: sequence },
    timestamps: { ...record.timestamps, updatedAt: recordedAt },
  });
  const aborted = canonicalRuntimePromotionJournal({
    ...intent,
    revision: intent.revision + 1,
    progress: {
      ...intent.progress,
      pendingIntent: null,
      lastPostcondition: {
        ...intent.progress.pendingIntent!,
        outcome: 'aborted',
        recordedAt: recordedAt + 1,
      },
    },
    counts: { ...intent.counts, postconditionCount: sequence },
    timestamps: { ...intent.timestamps, updatedAt: recordedAt + 1 },
  });
  return { intent, aborted };
}

describe('runtime promotion rollback and closed evidence', () => {
  it('records an aborted authored preparation and carries it through closed rollback', () => {
    const prepared = initial();
    const { intent, aborted } = abortAuthoredPreparation(prepared);
    expect(() => assertRuntimePromotionTransition(prepared, intent)).not.toThrow();
    expect(() => assertRuntimePromotionTransition(intent, aborted)).not.toThrow();
    expect(aborted.progress.phase).toBe('prepared');
    expect([
      aborted.cleanup.authoredStage,
      aborted.cleanup.authoredBackup,
      aborted.cleanup.replayManifest,
    ]).toEqual(['unmaterialized', 'unmaterialized', 'unmaterialized']);

    const rollbackStarted = beginRollback(aborted);
    expect(() => assertRuntimePromotionTransition(aborted, rollbackStarted)).not.toThrow();
    const authoredRolledBack = canonicalRuntimePromotionJournal({
      ...rollbackStarted,
      revision: rollbackStarted.revision + 1,
      progress: {
        ...rollbackStarted.progress,
        phase: 'authored-rolled-back',
      },
      timestamps: {
        ...rollbackStarted.timestamps,
        updatedAt: rollbackStarted.timestamps.updatedAt + 1,
      },
    });
    expect(() =>
      assertRuntimePromotionTransition(rollbackStarted, authoredRolledBack),
    ).not.toThrow();
    const sealed = canonicalRuntimePromotionJournal({
      ...authoredRolledBack,
      revision: authoredRolledBack.revision + 1,
      progress: { ...authoredRolledBack.progress, phase: 'rolled-back' },
      terminal: {
        outcome: 'rolled-back',
        authority: 'none',
        runtimeManifest: null,
        authoredVerified: true,
        sourcePreserved: false,
        verifiedAt: authoredRolledBack.timestamps.updatedAt + 1,
      },
      timestamps: {
        ...authoredRolledBack.timestamps,
        updatedAt: authoredRolledBack.timestamps.updatedAt + 1,
      },
    });
    expect(() => assertRuntimePromotionTransition(authoredRolledBack, sealed)).not.toThrow();
    const closed = canonicalRuntimePromotionJournal({
      ...sealed,
      state: 'closed',
      revision: sealed.revision + 1,
      progress: { ...sealed.progress, phase: 'closed', direction: 'cleanup' },
      timestamps: {
        ...sealed.timestamps,
        updatedAt: sealed.timestamps.updatedAt + 1,
        closedAt: sealed.timestamps.updatedAt + 1,
      },
    });
    expect(() => assertRuntimePromotionTransition(sealed, closed)).not.toThrow();
  });

  it('rejects aborted outcomes outside a zero-progress authored preparation', () => {
    const { aborted } = abortAuthoredPreparation(initial());
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...aborted,
        progress: {
          ...aborted.progress,
          authoredCursor: 1,
        },
        counts: { ...aborted.counts, authoredCompleted: 1 },
      }),
    ).toThrow(/intent history|postcondition|evidence/iu);

    expect(() =>
      canonicalRuntimePromotionJournal({
        ...aborted,
        manifests: { ...aborted.manifests, runtimeStage: manifest() },
        cleanup: { ...aborted.cleanup, runtimeStage: 'pending' },
      }),
    ).toThrow(/intent history|postcondition|evidence/iu);

    expect(() =>
      canonicalRuntimePromotionJournal({
        ...aborted,
        revision: aborted.revision + 2,
        progress: {
          ...aborted.progress,
          lastPostcondition: {
            ...aborted.progress.lastPostcondition!,
            sequence: 2,
          },
        },
        counts: {
          ...aborted.counts,
          intentCount: 2,
          postconditionCount: 2,
        },
      }),
    ).toThrow(/intent history|postcondition|evidence/iu);

    const prepared = authoredPrepared();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...prepared,
        revision: prepared.revision + 2,
        progress: {
          ...prepared.progress,
          lastPostcondition: {
            sequence: 2,
            kind: 'authored-target-commit',
            slot: 'replayManifest',
            cursor: 0,
            outcome: 'aborted',
            recordedAt: prepared.timestamps.updatedAt + 2,
          },
        },
        counts: {
          ...prepared.counts,
          intentCount: 2,
          postconditionCount: 2,
        },
        timestamps: {
          ...prepared.timestamps,
          updatedAt: prepared.timestamps.updatedAt + 2,
        },
      }),
    ).toThrow(/intent history|postcondition|evidence/iu);
  });

  it('returns a non-authored aborted preparation to destination-verified only', () => {
    const journal = initial();
    const destinationVerified = canonicalRuntimePromotionJournal({
      ...journal,
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: true,
      route: 'project-authority',
      revision: 1,
      manifests: { ...journal.manifests, destination: manifest() },
      progress: { ...journal.progress, phase: 'destination-verified' },
      timestamps: { ...journal.timestamps, updatedAt: 101 },
    });
    const { intent, aborted } = abortAuthoredPreparation(destinationVerified);
    expect(() => assertRuntimePromotionTransition(destinationVerified, intent)).not.toThrow();
    expect(() => assertRuntimePromotionTransition(intent, aborted)).not.toThrow();
    expect(aborted.progress.phase).toBe('destination-verified');
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...aborted,
        manifests: { ...aborted.manifests, destination: null },
        progress: { ...aborted.progress, phase: 'source-verified' },
      }),
    ).toThrow(/intent history|destination|route|evidence/iu);
  });

  it('rejects non-authored rollback before destination verification', () => {
    const prepared = promote();
    const sourceVerified = canonicalRuntimePromotionJournal({
      ...prepared,
      revision: 1,
      manifests: { ...prepared.manifests, source: manifest() },
      progress: { ...prepared.progress, phase: 'source-verified' },
      timestamps: { ...prepared.timestamps, updatedAt: 101 },
    });
    const rollback = canonicalRuntimePromotionJournal({
      ...sourceVerified,
      revision: 2,
      progress: {
        ...sourceVerified.progress,
        phase: 'rollback-started',
        direction: 'rollback',
      },
      timestamps: { ...sourceVerified.timestamps, updatedAt: 102 },
    });
    expect(() => assertRuntimePromotionTransition(sourceVerified, rollback)).toThrow(
      /rollback must begin|destination-verified|terminal authority/iu,
    );
  });

  it('accepts rollback after authored preparation with its forward history intact', () => {
    const prepared = authoredPrepared();
    const rollback = beginRollback(prepared);
    expect(() => assertRuntimePromotionTransition(prepared, rollback)).not.toThrow();
  });

  it('requires an installed runtime to pass through its rollback postcondition', () => {
    const installed = runtimeInstalled();
    const rollbackStarted = beginRollback(installed);
    expect(() => assertRuntimePromotionTransition(installed, rollbackStarted)).not.toThrow();

    const forgedSeal = canonicalRuntimePromotionJournal({
      ...rollbackStarted,
      revision: rollbackStarted.revision + 1,
      progress: {
        ...rollbackStarted.progress,
        phase: 'rolled-back',
        runtimeInstallState: 'rolled-back',
      },
      terminal: {
        outcome: 'rolled-back',
        authority: 'cache',
        runtimeManifest: installed.manifests.source,
        authoredVerified: true,
        sourcePreserved: true,
        verifiedAt: 108,
      },
      timestamps: { ...rollbackStarted.timestamps, updatedAt: 108 },
    });
    expect(() => assertRuntimePromotionTransition(rollbackStarted, forgedSeal)).toThrow(
      /postcondition|execution|runtime install/iu,
    );

    const rollbackIntent = canonicalRuntimePromotionJournal({
      ...rollbackStarted,
      revision: rollbackStarted.revision + 1,
      progress: {
        ...rollbackStarted.progress,
        pendingIntent: {
          sequence: 3,
          kind: 'runtime-rollback',
          slot: 'destinationBackup',
          cursor: null,
          recordedAt: 108,
        },
      },
      counts: { ...rollbackStarted.counts, intentCount: 3 },
      timestamps: { ...rollbackStarted.timestamps, updatedAt: 108 },
    });
    expect(() => assertRuntimePromotionTransition(rollbackStarted, rollbackIntent)).not.toThrow();

    const runtimeRolledBack = canonicalRuntimePromotionJournal({
      ...rollbackIntent,
      revision: rollbackIntent.revision + 1,
      progress: {
        ...rollbackIntent.progress,
        phase: 'runtime-rolled-back',
        runtimeInstallState: 'rolled-back',
        pendingIntent: null,
        lastPostcondition: {
          ...rollbackIntent.progress.pendingIntent!,
          outcome: 'applied',
          recordedAt: 109,
        },
      },
      counts: { ...rollbackIntent.counts, postconditionCount: 3 },
      timestamps: { ...rollbackIntent.timestamps, updatedAt: 109 },
    });
    expect(() => assertRuntimePromotionTransition(rollbackIntent, runtimeRolledBack)).not.toThrow();

    const directSeal = canonicalRuntimePromotionJournal({
      ...runtimeRolledBack,
      revision: runtimeRolledBack.revision + 1,
      progress: { ...runtimeRolledBack.progress, phase: 'rolled-back' },
      terminal: {
        outcome: 'rolled-back',
        authority: 'cache',
        runtimeManifest: runtimeRolledBack.manifests.source,
        authoredVerified: true,
        sourcePreserved: true,
        verifiedAt: 110,
      },
      timestamps: { ...runtimeRolledBack.timestamps, updatedAt: 110 },
    });
    expect(() => assertRuntimePromotionTransition(runtimeRolledBack, directSeal)).toThrow(
      /terminal requires exact|authored-rolled-back/iu,
    );

    const authoredRolledBack = canonicalRuntimePromotionJournal({
      ...runtimeRolledBack,
      revision: runtimeRolledBack.revision + 1,
      progress: {
        ...runtimeRolledBack.progress,
        phase: 'authored-rolled-back',
      },
      timestamps: { ...runtimeRolledBack.timestamps, updatedAt: 110 },
    });
    expect(() =>
      assertRuntimePromotionTransition(runtimeRolledBack, authoredRolledBack),
    ).not.toThrow();
    const sealed = canonicalRuntimePromotionJournal({
      ...directSeal,
      revision: authoredRolledBack.revision + 1,
      timestamps: { ...directSeal.timestamps, updatedAt: 111 },
    });
    expect(() => assertRuntimePromotionTransition(authoredRolledBack, sealed)).not.toThrow();
  });

  it('restores a preinstall destination backup before rollback can seal', () => {
    const backedUp = runtimeBackedUpBeforeInstall();
    const rollbackStarted = beginRollback(backedUp);
    expect(() => assertRuntimePromotionTransition(backedUp, rollbackStarted)).not.toThrow();
    expect(
      runtimePromotionPendingIntentAllowed(rollbackStarted, {
        sequence: 4,
        kind: 'authored-target-rollback',
        slot: 'replayManifest',
        cursor: -1,
        recordedAt: 108,
      }),
    ).toBe(false);
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...rollbackStarted,
        revision: rollbackStarted.revision + 1,
        progress: {
          ...rollbackStarted.progress,
          phase: 'authored-rolled-back',
        },
        timestamps: { ...rollbackStarted.timestamps, updatedAt: 108 },
      }),
    ).toThrow(/route|runtime install|backup|evidence/iu);
    const rollbackIntent = canonicalRuntimePromotionJournal({
      ...rollbackStarted,
      revision: rollbackStarted.revision + 1,
      progress: {
        ...rollbackStarted.progress,
        pendingIntent: {
          sequence: 4,
          kind: 'runtime-rollback',
          slot: 'destinationBackup',
          cursor: null,
          recordedAt: 108,
        },
      },
      counts: { ...rollbackStarted.counts, intentCount: 4 },
      timestamps: { ...rollbackStarted.timestamps, updatedAt: 108 },
    });
    expect(() => assertRuntimePromotionTransition(rollbackStarted, rollbackIntent)).not.toThrow();
    const restored = canonicalRuntimePromotionJournal({
      ...rollbackIntent,
      revision: rollbackIntent.revision + 1,
      progress: {
        ...rollbackIntent.progress,
        phase: 'runtime-rolled-back',
        runtimeInstallState: 'backup-restored',
        pendingIntent: null,
        lastPostcondition: {
          ...rollbackIntent.progress.pendingIntent!,
          outcome: 'applied',
          recordedAt: 109,
        },
      },
      cleanup: {
        ...rollbackIntent.cleanup,
        runtimeStage: 'removed',
        destinationBackup: 'removed',
      },
      counts: { ...rollbackIntent.counts, postconditionCount: 4 },
      timestamps: { ...rollbackIntent.timestamps, updatedAt: 109 },
    });
    expect(() => assertRuntimePromotionTransition(rollbackIntent, restored)).not.toThrow();
    expect(restored.cleanup.runtimeStage).toBe('removed');

    const forgedSeal = canonicalRuntimePromotionJournal({
      ...restored,
      revision: restored.revision + 1,
      progress: { ...restored.progress, phase: 'rolled-back' },
      terminal: {
        outcome: 'rolled-back',
        authority: 'project',
        runtimeManifest: restored.manifests.destination,
        authoredVerified: true,
        sourcePreserved: true,
        verifiedAt: 110,
      },
      timestamps: { ...restored.timestamps, updatedAt: 110 },
    });
    expect(() => assertRuntimePromotionTransition(restored, forgedSeal)).toThrow(
      /terminal requires exact|authored-rolled-back/iu,
    );
    const authoredRolledBack = canonicalRuntimePromotionJournal({
      ...restored,
      revision: restored.revision + 1,
      progress: { ...restored.progress, phase: 'authored-rolled-back' },
      timestamps: { ...restored.timestamps, updatedAt: 110 },
    });
    const sealed = canonicalRuntimePromotionJournal({
      ...forgedSeal,
      revision: authoredRolledBack.revision + 1,
      timestamps: { ...forgedSeal.timestamps, updatedAt: 111 },
    });
    expect(() => assertRuntimePromotionTransition(authoredRolledBack, sealed)).not.toThrow();
  });

  it('forbids rollback after source retirement', () => {
    const installed = runtimeInstalled();
    const retired = canonicalRuntimePromotionJournal({
      ...installed,
      revision: 8,
      progress: {
        ...installed.progress,
        phase: 'source-retired',
        authoredCursor: 1,
        lastPostcondition: {
          sequence: 3,
          kind: 'source-retire',
          slot: 'sourceTombstone',
          cursor: null,
          outcome: 'applied',
          recordedAt: 108,
        },
      },
      cleanup: { ...installed.cleanup, sourceTombstone: 'pending' },
      counts: {
        ...installed.counts,
        intentCount: 3,
        postconditionCount: 3,
        authoredCompleted: 1,
      },
      timestamps: { ...installed.timestamps, updatedAt: 108 },
    });
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...retired,
        revision: 9,
        progress: {
          ...retired.progress,
          phase: 'rollback-started',
          direction: 'rollback',
        },
        timestamps: { ...retired.timestamps, updatedAt: 109 },
      }),
    ).toThrow(/intent history|route|source|evidence/iu);
  });

  it('enforces exact open rollback ownership windows', () => {
    const journal = promote();
    const rollback = {
      ...journal,
      revision: 2,
      manifests: {
        ...journal.manifests,
        source: manifest(),
        runtimeStage: manifest(DIGEST_B),
      },
      progress: {
        ...journal.progress,
        phase: 'rollback-started' as const,
        direction: 'rollback' as const,
      },
      cleanup: { ...journal.cleanup, runtimeStage: 'pending' as const },
      timestamps: { ...journal.timestamps, updatedAt: 102 },
    };
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...rollback,
        cleanup: { ...rollback.cleanup, runtimeStage: 'removed' },
      }),
    ).toThrow(/route|owned-artifact|evidence/iu);
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...rollback,
        destinationParentPreexisting: false,
      }),
    ).toThrow(/route|owned-artifact|evidence/iu);
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...rollback,
        manifests: {
          ...rollback.manifests,
          destination: manifest(),
          runtimeStage: null,
        },
        cleanup: {
          ...rollback.cleanup,
          runtimeStage: 'unmaterialized',
          destinationBackup: 'pending',
        },
      }),
    ).toThrow(/route|owned-artifact|evidence/iu);
  });

  it('requires exact grouped authored and verified source rollback evidence', () => {
    const journal = initial();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        state: 'closed',
        revision: 4,
        progress: {
          ...journal.progress,
          phase: 'closed',
          direction: 'cleanup',
        },
        terminal: {
          outcome: 'rolled-back',
          authority: 'none',
          runtimeManifest: null,
          authoredVerified: true,
          sourcePreserved: false,
          verifiedAt: 104,
        },
        cleanup: { ...journal.cleanup, authoredStage: 'pending' },
        timestamps: { ...journal.timestamps, updatedAt: 104, closedAt: 104 },
      }),
    ).toThrow(/terminal history|cleanup/iu);

    const source = promote();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...source,
        revision: 2,
        progress: {
          ...source.progress,
          phase: 'rolled-back',
          direction: 'rollback',
        },
        terminal: {
          outcome: 'rolled-back',
          authority: 'none',
          runtimeManifest: null,
          authoredVerified: true,
          sourcePreserved: true,
          verifiedAt: 102,
        },
        timestamps: { ...source.timestamps, updatedAt: 102 },
      }),
    ).toThrow(/source authority|source manifest|cache authority|route lacks/iu);
  });

  it('rejects forged closed commit history and inexact cleanup counts', () => {
    const journal = initial();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        state: 'closed',
        revision: 5,
        progress: {
          ...journal.progress,
          phase: 'closed',
          direction: 'cleanup',
          authoredCursor: 1,
        },
        terminal: {
          outcome: 'committed',
          authority: 'none',
          runtimeManifest: null,
          authoredVerified: true,
          sourcePreserved: false,
          verifiedAt: 105,
        },
        counts: { ...journal.counts, authoredCompleted: 1 },
        timestamps: { ...journal.timestamps, updatedAt: 105, closedAt: 105 },
      }),
    ).toThrow(/terminal history|cleanup/iu);

    const prepared = authoredPrepared();
    const closed = canonicalRuntimePromotionJournal({
      ...prepared,
      state: 'closed',
      revision: 7,
      progress: {
        ...prepared.progress,
        phase: 'cleanup',
        direction: 'cleanup',
        authoredCursor: 1,
        lastPostcondition: {
          sequence: 2,
          kind: 'owned-slot-cleanup',
          slot: 'authoredStage',
          cursor: null,
          outcome: 'applied',
          recordedAt: 107,
        },
      },
      terminal: {
        outcome: 'committed',
        authority: 'none',
        runtimeManifest: null,
        authoredVerified: true,
        sourcePreserved: false,
        verifiedAt: 106,
      },
      cleanup: { ...prepared.cleanup, authoredStage: 'removed' },
      counts: {
        ...prepared.counts,
        intentCount: 2,
        postconditionCount: 2,
        authoredCompleted: 1,
        cleanupCompleted: 1,
      },
      timestamps: { ...prepared.timestamps, updatedAt: 107, closedAt: 106 },
    });
    expect(closed.counts.cleanupCompleted).toBe(1);
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...closed,
        counts: { ...closed.counts, cleanupCompleted: 0 },
      }),
    ).toThrow(/cleanup count|terminal history/iu);
  });

  it('freezes the terminal reason during closed cleanup', () => {
    const prepared = authoredPrepared();
    const committed = canonicalRuntimePromotionJournal({
      ...prepared,
      state: 'closed',
      revision: 6,
      progress: {
        ...prepared.progress,
        phase: 'closed',
        direction: 'cleanup',
        authoredCursor: 1,
      },
      terminal: {
        outcome: 'committed',
        authority: 'none',
        runtimeManifest: null,
        authoredVerified: true,
        sourcePreserved: false,
        verifiedAt: 106,
      },
      counts: { ...prepared.counts, authoredCompleted: 1 },
      timestamps: { ...prepared.timestamps, updatedAt: 106, closedAt: 106 },
      reason: 'stable terminal reason',
    });
    const rewritten = canonicalRuntimePromotionJournal({
      ...committed,
      revision: committed.revision + 1,
      timestamps: { ...committed.timestamps, updatedAt: 107 },
      reason: 'rewritten terminal reason',
    });
    expect(() => assertRuntimePromotionTransition(committed, rewritten)).toThrow(
      /cleanup-only|reason/iu,
    );
  });
});

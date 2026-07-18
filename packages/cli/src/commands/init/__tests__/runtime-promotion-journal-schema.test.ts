import { describe, expect, it } from 'vitest';

import { runtimePromotionPendingIntentAllowed } from '../runtime-promotion-intent-policy.js';
import { assertRuntimePromotionTransition } from '../runtime-promotion-journal-machine.js';
import {
  canonicalRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  createInitialRuntimePromotionJournal,
  encodeRuntimePromotionJournal,
  parseRuntimePromotionJournal,
  RUNTIME_PROMOTION_JOURNAL_MAX_BYTES,
  type RuntimeManifestIdentity,
  type RuntimePromotionJournal,
  type RuntimePromotionOwnedSlots,
} from '../runtime-promotion-journal-schema.js';

const PROJECT_KEY = 'a'.repeat(24);
const OPERATION_ID = 'schema-operation-000000000001';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function ownedSlots(): RuntimePromotionOwnedSlots {
  return createRuntimePromotionOwnedSlots(OPERATION_ID);
}

function initial(): RuntimePromotionJournal {
  return createInitialRuntimePromotionJournal({
    coordinationKey: PROJECT_KEY,
    operationId: OPERATION_ID,
    recoveryOwnerToken: 'schema-owner-000000000000001',
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
      languages: ['typescript', 'rust'],
      languageExplicit: true,
    },
    plan: {
      authoredDigest: DIGEST_A,
      replayDigest: DIGEST_B,
      mutationCount: 2,
    },
    owned: ownedSlots(),
    createdAt: 100,
  });
}

function manifest(digest = DIGEST_A): RuntimeManifestIdentity {
  return {
    digest,
    fileCount: 2,
    directoryCount: 1,
    symlinkCount: 1,
    rootMode: 0o700,
    totalBytes: 42,
    sqlite: { status: 'verified', sha256: DIGEST_B, userVersion: 4 },
  };
}

function promoteCache(): RuntimePromotionJournal {
  return canonicalRuntimePromotionJournal({
    ...initial(),
    route: 'promote-cache',
    source: {
      classification: 'generation-bound',
      cacheKey: 'c'.repeat(24),
      generationDigest: 'c'.repeat(64),
      markerSha256: 'd'.repeat(64),
    },
    inputs: {
      conflict: 'use-cache',
      authoredMode: 'fresh',
      languages: ['typescript'],
      languageExplicit: false,
    },
  });
}

describe('runtime promotion journal canonical schema', () => {
  it('round-trips exact compact canonical bytes', () => {
    const journal = initial();
    const encoded = encodeRuntimePromotionJournal(journal);

    expect(encoded.endsWith('\n')).toBe(false);
    expect(parseRuntimePromotionJournal(encoded)).toEqual(journal);
    expect(
      parseRuntimePromotionJournal(encoded, {
        coordinationKey: PROJECT_KEY,
        operationId: journal.operationId,
        state: 'open',
      }),
    ).toEqual(journal);
  });

  it('rejects reordered, duplicated, unknown, and padded JSON', () => {
    const encoded = encodeRuntimePromotionJournal(initial());
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    const { kind, version, ...rest } = parsed;
    const reordered = JSON.stringify({ version, kind, ...rest });
    const duplicate = encoded.replace(
      '{"kind":"init-promotion"',
      '{"kind":"init-promotion","kind":"init-promotion"',
    );
    const unknown = encoded.replace(/\}$/u, ',"unknown":true}');

    for (const invalid of [reordered, duplicate, unknown, `${encoded}\n`]) {
      expect(() => parseRuntimePromotionJournal(invalid)).toThrow(/canonical|invalid/iu);
    }
  });

  it('rejects oversize content before parsing', () => {
    expect(() =>
      parseRuntimePromotionJournal(' '.repeat(RUNTIME_PROMOTION_JOURNAL_MAX_BYTES + 1)),
    ).toThrow(/exceeds/iu);
  });

  it('rejects unsafe or operation-foreign owned identities', () => {
    const journal = initial();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        owned: {
          ...journal.owned,
          runtimeStage: {
            ...journal.owned.runtimeStage,
            basename: '../escape',
          },
        },
      }),
    ).toThrow(/unsafe/iu);
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        owned: {
          ...journal.owned,
          runtimeStage: {
            ...journal.owned.runtimeStage,
            ownershipId: journal.owned.authoredStage.ownershipId,
          },
        },
      }),
    ).toThrow(/bound|operation/iu);
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        owned: {
          ...journal.owned,
          runtimeStage: {
            ...journal.owned.runtimeStage,
            basename: '.gitignore',
          },
        },
      }),
    ).toThrow(/bound|operation/iu);
  });

  it('binds every full-digest owned identity to its operation and slot', () => {
    const journal = initial();
    for (const slot of Object.values(journal.owned)) {
      expect(slot.basename).toMatch(/-[a-f0-9]{64}$/u);
      expect(slot.ownershipId).toMatch(/-[a-f0-9]{64}$/u);
    }
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        operationId: 'schema-operation-000000000002',
      }),
    ).toThrow(/bound|operation/iu);
  });

  it('rejects noncanonical languages and malformed source proof', () => {
    const journal = initial();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        inputs: { ...journal.inputs, languages: ['rust', 'typescript'] },
      }),
    ).toThrow(/canonical order/iu);
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...promoteCache(),
        source: { ...promoteCache().source, markerSha256: null },
      }),
    ).toThrow(/marker/iu);
  });

  it('bounds manifest counts and accepts only the closed SQLite union', () => {
    const journal = initial();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        manifests: {
          ...journal.manifests,
          source: { ...manifest(), fileCount: 100_000, directoryCount: 1 },
        },
      }),
    ).toThrow(/entry cap/iu);
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        manifests: {
          ...journal.manifests,
          source: {
            ...manifest(),
            sqlite: { status: 'verified', sha256: DIGEST_A, userVersion: 1.5 },
          },
        },
      }),
    ).toThrow(/integer/iu);
  });

  it('rejects a canonical but impossible pending runtime-stage intent', () => {
    const journal = promoteCache();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 1,
        progress: {
          ...journal.progress,
          pendingIntent: {
            sequence: 1,
            kind: 'runtime-stage-create',
            slot: 'runtimeStage',
            cursor: null,
            recordedAt: 101,
          },
        },
        counts: { ...journal.counts, intentCount: 1 },
        timestamps: { ...journal.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/impossible|phase/iu);
  });

  it('rejects creation intent after its slot claims materialization', () => {
    const journal = promoteCache();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 1,
        progress: {
          ...journal.progress,
          phase: 'destination-ready',
          pendingIntent: {
            sequence: 1,
            kind: 'runtime-stage-create',
            slot: 'runtimeStage',
            cursor: null,
            recordedAt: 101,
          },
        },
        cleanup: {
          ...journal.cleanup,
          destinationParent: 'pending',
          runtimeStage: 'pending',
          authoredStage: 'pending',
          authoredBackup: 'pending',
          replayManifest: 'pending',
        },
        counts: { ...journal.counts, intentCount: 1 },
        timestamps: { ...journal.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/impossible/iu);
  });

  it('rejects future intent and terminal timestamps', () => {
    const journal = initial();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 1,
        progress: {
          ...journal.progress,
          pendingIntent: {
            sequence: 1,
            kind: 'authored-prepare',
            slot: 'authoredStage',
            cursor: null,
            recordedAt: 102,
          },
        },
        counts: { ...journal.counts, intentCount: 1 },
        timestamps: { ...journal.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/temporally/iu);
  });

  it('binds a committed terminal manifest to the selected project authority', () => {
    const journal = promoteCache();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 1,
        manifests: {
          source: manifest(),
          destination: null,
          runtimeStage: manifest(),
        },
        progress: {
          ...journal.progress,
          phase: 'committed',
          runtimeInstallState: 'installed',
          authoredCursor: 2,
        },
        cleanup: {
          ...journal.cleanup,
          destinationParent: 'removed',
          runtimeStage: 'removed',
          sourceTombstone: 'pending',
          authoredStage: 'pending',
          authoredBackup: 'pending',
          replayManifest: 'pending',
        },
        counts: { ...journal.counts, authoredCompleted: 2 },
        terminal: {
          outcome: 'committed',
          authority: 'project',
          runtimeManifest: manifest(DIGEST_B),
          authoredVerified: true,
          sourcePreserved: false,
          verifiedAt: 101,
        },
        timestamps: { ...journal.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/terminal manifest/iu);
  });

  it('requires complete authored cursors at terminal forward and rollback phases', () => {
    const journal = initial();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 1,
        progress: {
          ...journal.progress,
          phase: 'authored-committed',
          authoredCursor: 1,
        },
        cleanup: {
          ...journal.cleanup,
          authoredStage: 'pending',
          authoredBackup: 'pending',
          replayManifest: 'pending',
        },
        counts: { ...journal.counts, authoredCompleted: 1 },
        timestamps: { ...journal.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/phase|evidence/iu);

    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 1,
        progress: {
          ...journal.progress,
          phase: 'authored-rolled-back',
          direction: 'rollback',
          authoredCursor: 2,
          rollbackCursor: 1,
        },
        counts: {
          ...journal.counts,
          authoredCompleted: 2,
          authoredRolledBack: 1,
        },
        timestamps: { ...journal.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/phase|evidence/iu);
  });

  it('requires a verified destination backup to remain pending after backup', () => {
    const journal = promoteCache();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 1,
        destinationParentPreexisting: true,
        manifests: {
          source: manifest(),
          destination: manifest(DIGEST_B),
          runtimeStage: manifest(),
        },
        progress: { ...journal.progress, phase: 'runtime-installed' },
        cleanup: {
          ...journal.cleanup,
          runtimeStage: 'removed',
          destinationBackup: 'removed',
          authoredStage: 'pending',
          authoredBackup: 'pending',
          replayManifest: 'pending',
        },
        timestamps: { ...journal.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/phase|evidence/iu);
  });

  it('binds the last authored and runtime rollback postconditions to exact progress', () => {
    const journal = initial();
    const authoredCleanup = {
      ...journal.cleanup,
      authoredStage: 'pending' as const,
      authoredBackup: 'pending' as const,
      replayManifest: 'pending' as const,
    };
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 2,
        progress: {
          ...journal.progress,
          phase: 'authored-committed',
          authoredCursor: 2,
          lastPostcondition: {
            sequence: 1,
            kind: 'authored-target-commit',
            slot: 'replayManifest',
            cursor: 0,
            outcome: 'applied',
            recordedAt: 101,
          },
        },
        cleanup: authoredCleanup,
        counts: {
          ...journal.counts,
          intentCount: 1,
          postconditionCount: 1,
          authoredCompleted: 2,
        },
        timestamps: { ...journal.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/intent history/iu);

    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 2,
        progress: {
          ...journal.progress,
          phase: 'authored-rolled-back',
          direction: 'rollback',
          authoredCursor: 2,
          rollbackCursor: 2,
          lastPostcondition: {
            sequence: 1,
            kind: 'authored-target-rollback',
            slot: 'replayManifest',
            cursor: 1,
            outcome: 'applied',
            recordedAt: 101,
          },
        },
        counts: {
          ...journal.counts,
          intentCount: 1,
          postconditionCount: 1,
          authoredCompleted: 2,
          authoredRolledBack: 2,
        },
        timestamps: { ...journal.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/intent history/iu);

    const promoted = promoteCache();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...promoted,
        revision: 2,
        progress: {
          ...promoted.progress,
          phase: 'rollback-started',
          direction: 'rollback',
          lastPostcondition: {
            sequence: 1,
            kind: 'runtime-rollback',
            slot: 'destinationBackup',
            cursor: null,
            outcome: 'applied',
            recordedAt: 101,
          },
        },
        counts: { ...promoted.counts, intentCount: 1, postconditionCount: 1 },
        timestamps: { ...promoted.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/intent history/iu);
  });

  it('rejects a revision lower than its distinct durable history transitions', () => {
    const journal = initial();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 2,
        progress: {
          ...journal.progress,
          phase: 'authored-prepared',
          pendingIntent: {
            sequence: 2,
            kind: 'authored-target-commit',
            slot: 'replayManifest',
            cursor: 0,
            recordedAt: 102,
          },
          lastPostcondition: {
            sequence: 1,
            kind: 'authored-prepare',
            slot: 'authoredStage',
            cursor: null,
            outcome: 'applied',
            recordedAt: 101,
          },
        },
        cleanup: {
          ...journal.cleanup,
          authoredStage: 'pending',
          authoredBackup: 'pending',
          replayManifest: 'pending',
        },
        counts: { ...journal.counts, intentCount: 2, postconditionCount: 1 },
        timestamps: { ...journal.timestamps, updatedAt: 102 },
      }),
    ).toThrow(/revision|history/iu);
  });

  it('restricts runtime phases to promotion and source retirement to a real source', () => {
    const journal = initial();
    const durableAuthoredArtifacts = {
      ...journal.cleanup,
      authoredStage: 'pending' as const,
      authoredBackup: 'pending' as const,
      replayManifest: 'pending' as const,
    };
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 1,
        progress: { ...journal.progress, phase: 'runtime-installed' },
        cleanup: durableAuthoredArtifacts,
        timestamps: { ...journal.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/phase|evidence/iu);

    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 1,
        progress: {
          ...journal.progress,
          phase: 'source-retired',
          authoredCursor: journal.plan.mutationCount,
        },
        cleanup: durableAuthoredArtifacts,
        counts: {
          ...journal.counts,
          authoredCompleted: journal.plan.mutationCount,
        },
        timestamps: { ...journal.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/phase|evidence/iu);

    expect(
      runtimePromotionPendingIntentAllowed(
        { ...journal, route: 'promote-cache' },
        {
          sequence: 1,
          kind: 'source-retire',
          slot: 'sourceTombstone',
          cursor: null,
          recordedAt: 101,
        },
      ),
    ).toBe(false);
  });

  it('requires destination install to consume its runtime stage', () => {
    const journal = promoteCache();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...journal,
        revision: 2,
        destinationParentPreexisting: true,
        manifests: { ...journal.manifests, runtimeStage: manifest() },
        progress: {
          ...journal.progress,
          phase: 'runtime-installed',
          lastPostcondition: {
            sequence: 1,
            kind: 'destination-install',
            slot: 'destinationParent',
            cursor: null,
            outcome: 'applied',
            recordedAt: 101,
          },
        },
        cleanup: {
          ...journal.cleanup,
          runtimeStage: 'pending',
          authoredStage: 'pending',
          authoredBackup: 'pending',
          replayManifest: 'pending',
        },
        counts: { ...journal.counts, intentCount: 1, postconditionCount: 1 },
        timestamps: { ...journal.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/phase|evidence/iu);
  });

  it('rejects execution-derived cursor and cleanup changes without postconditions', () => {
    const journal = initial();
    const authoredBypass = canonicalRuntimePromotionJournal({
      ...journal,
      revision: 1,
      progress: { ...journal.progress, authoredCursor: 1 },
      counts: { ...journal.counts, authoredCompleted: 1 },
      timestamps: { ...journal.timestamps, updatedAt: 101 },
    });
    expect(() => assertRuntimePromotionTransition(journal, authoredBypass)).toThrow(
      /postcondition|execution/iu,
    );
  });
});

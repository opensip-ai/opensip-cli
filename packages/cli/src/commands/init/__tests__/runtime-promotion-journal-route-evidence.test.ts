import { describe, expect, it } from 'vitest';

import { runtimePromotionPendingIntentAllowed } from '../runtime-promotion-intent-policy.js';
import { assertRuntimePromotionTransition } from '../runtime-promotion-journal-machine.js';
import {
  canonicalRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  createInitialRuntimePromotionJournal,
  type RuntimeManifestIdentity,
  type RuntimePromotionJournal,
  type RuntimePromotionOwnedSlots,
  type RuntimePromotionRoute,
} from '../runtime-promotion-journal-schema.js';

const PROJECT_KEY = 'a'.repeat(24);
const OPERATION_ID = 'route-evidence-operation-0001';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function ownedSlots(): RuntimePromotionOwnedSlots {
  return createRuntimePromotionOwnedSlots(OPERATION_ID);
}

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
    recoveryOwnerToken: 'route-evidence-owner-000001',
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
    owned: ownedSlots(),
    createdAt: 100,
  });
}

function promote(destinationRuntimePreexisting = false): RuntimePromotionJournal {
  return canonicalRuntimePromotionJournal({
    ...initial(),
    destinationParentPreexisting: true,
    destinationRuntimePreexisting,
    route: 'promote-cache',
    source: {
      classification: 'generation-bound',
      cacheKey: 'c'.repeat(24),
      generationDigest: 'c'.repeat(64),
      markerSha256: 'd'.repeat(64),
    },
    inputs: { ...initial().inputs, conflict: 'use-cache' },
  });
}

function destinationReady(): RuntimePromotionJournal {
  const journal = promote();
  return canonicalRuntimePromotionJournal({
    ...journal,
    revision: 3,
    manifests: { ...journal.manifests, source: manifest() },
    progress: { ...journal.progress, phase: 'destination-ready' },
    cleanup: {
      ...journal.cleanup,
      authoredStage: 'pending',
      authoredBackup: 'pending',
      replayManifest: 'pending',
    },
    timestamps: { ...journal.timestamps, updatedAt: 103 },
  });
}

function rolledBackReceipt(
  route: RuntimePromotionRoute,
  destinationRuntimePreexisting: boolean,
): RuntimePromotionJournal {
  const sourceRoute = ['promote-cache', 'keep-project', 'deduplicate-cache'].includes(route);
  const sourceManifest = sourceRoute ? manifest() : null;
  let destinationManifest: RuntimeManifestIdentity | null = null;
  if (destinationRuntimePreexisting) {
    destinationManifest = route === 'deduplicate-cache' ? sourceManifest : manifest(DIGEST_B);
  }
  let conflict: RuntimePromotionJournal['inputs']['conflict'] = 'abort';
  if (route === 'keep-project') conflict = 'keep-project';
  if (route === 'promote-cache') conflict = 'use-cache';
  let authority: NonNullable<RuntimePromotionJournal['terminal']>['authority'] = 'none';
  if (sourceRoute) authority = 'cache';
  if (destinationRuntimePreexisting) authority = 'project';
  const runtimeManifest = authority === 'project' ? destinationManifest : sourceManifest;
  const journal = initial();
  return canonicalRuntimePromotionJournal({
    ...journal,
    destinationParentPreexisting: destinationRuntimePreexisting,
    destinationRuntimePreexisting,
    route,
    revision: 2,
    source: sourceRoute
      ? {
          classification: 'generation-bound',
          cacheKey: 'c'.repeat(24),
          generationDigest: 'c'.repeat(64),
          markerSha256: 'd'.repeat(64),
        }
      : journal.source,
    inputs: { ...journal.inputs, conflict },
    manifests: {
      source: sourceManifest,
      destination: destinationManifest,
      runtimeStage: null,
    },
    progress: {
      ...journal.progress,
      phase: 'rolled-back',
      direction: 'rollback',
    },
    terminal: {
      outcome: 'rolled-back',
      authority,
      runtimeManifest,
      authoredVerified: true,
      sourcePreserved: sourceRoute,
      verifiedAt: 102,
    },
    timestamps: { ...journal.timestamps, updatedAt: 102 },
  });
}

describe('runtime promotion journal route evidence', () => {
  it('seals open and closed rollback authority for every route and destination case', () => {
    const cases: readonly (readonly [RuntimePromotionRoute, boolean])[] = [
      ['authored-only', false],
      ['project-authority', true],
      ['keep-project', true],
      ['deduplicate-cache', true],
      ['promote-cache', false],
      ['promote-cache', true],
    ];
    for (const [route, destinationRuntimePreexisting] of cases) {
      const open = rolledBackReceipt(route, destinationRuntimePreexisting);
      let expectedAuthority = 'none';
      if (open.source.classification !== 'none') expectedAuthority = 'cache';
      if (destinationRuntimePreexisting) expectedAuthority = 'project';
      expect(open.terminal?.authority).toBe(expectedAuthority);

      const closed = canonicalRuntimePromotionJournal({
        ...open,
        state: 'closed',
        revision: open.revision + 1,
        progress: { ...open.progress, phase: 'closed', direction: 'cleanup' },
        timestamps: { ...open.timestamps, updatedAt: 103, closedAt: 103 },
      });
      expect(closed.terminal).toEqual(open.terminal);

      if (destinationRuntimePreexisting) {
        expect(() =>
          canonicalRuntimePromotionJournal({
            ...open,
            manifests: { ...open.manifests, destination: null },
          }),
        ).toThrow(/destination|route|authority|manifest/iu);
      } else {
        expect(() =>
          canonicalRuntimePromotionJournal({
            ...closed,
            manifests: {
              ...closed.manifests,
              destination: manifest(DIGEST_B),
            },
          }),
        ).toThrow(/destination|route|authority|manifest/iu);
      }
    }
  });

  it('rejects manifests that cannot exist on the selected route', () => {
    const journal = initial();
    const invalid = [
      {
        ...journal,
        manifests: { ...journal.manifests, source: manifest() },
      },
      {
        ...journal,
        manifests: { ...journal.manifests, runtimeStage: manifest() },
        cleanup: { ...journal.cleanup, runtimeStage: 'pending' as const },
      },
      {
        ...journal,
        manifests: { ...journal.manifests, destination: manifest() },
      },
    ];
    for (const candidate of invalid) {
      expect(() => canonicalRuntimePromotionJournal(candidate)).toThrow(
        /route|manifest|evidence/iu,
      );
    }
  });

  it('requires source and destination authority evidence by their verification phases', () => {
    const source = promote();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...source,
        revision: 1,
        progress: { ...source.progress, phase: 'source-verified' },
        timestamps: { ...source.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/route|manifest|evidence/iu);

    const project = initial();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...project,
        destinationParentPreexisting: true,
        destinationRuntimePreexisting: true,
        route: 'project-authority',
        revision: 1,
        progress: { ...project.progress, phase: 'destination-verified' },
        timestamps: { ...project.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/route|manifest|evidence/iu);
  });

  it('requires exact verified manifest equality for cache deduplication', () => {
    const base = canonicalRuntimePromotionJournal({
      ...initial(),
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: true,
      route: 'deduplicate-cache',
      source: {
        classification: 'generation-bound',
        cacheKey: 'c'.repeat(24),
        generationDigest: 'c'.repeat(64),
        markerSha256: 'd'.repeat(64),
      },
    });
    const deduplicated = canonicalRuntimePromotionJournal({
      ...base,
      revision: 2,
      manifests: {
        ...base.manifests,
        source: manifest(),
        destination: manifest(),
      },
      progress: { ...base.progress, phase: 'destination-verified' },
      timestamps: { ...base.timestamps, updatedAt: 102 },
    });
    expect(deduplicated.manifests.source).toEqual(deduplicated.manifests.destination);
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...deduplicated,
        manifests: {
          ...deduplicated.manifests,
          destination: manifest(DIGEST_B),
        },
      }),
    ).toThrow(/deduplicated|manifests must match/iu);
  });

  it('requires explicit use-cache authority for destructive or weak cache promotion', () => {
    const sourceOnly = canonicalRuntimePromotionJournal({
      ...promote(),
      inputs: { ...promote().inputs, conflict: 'abort' },
    });
    expect(sourceOnly.destinationRuntimePreexisting).toBe(false);

    expect(() =>
      canonicalRuntimePromotionJournal({
        ...sourceOnly,
        destinationRuntimePreexisting: true,
      }),
    ).toThrow(/use-cache|conflict authority/iu);
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...sourceOnly,
        source: {
          classification: 'path-only',
          cacheKey: 'c'.repeat(24),
          generationDigest: null,
          markerSha256: 'd'.repeat(64),
        },
      }),
    ).toThrow(/use-cache|conflict authority/iu);
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...promote(true),
        destinationParentPreexisting: false,
      }),
    ).toThrow(/preexisting parent/iu);
  });

  it('admits authored preparation only at the route-specific verification boundary', () => {
    const authored = initial();
    const authoredIntent = {
      sequence: 1,
      kind: 'authored-prepare' as const,
      slot: 'authoredStage' as const,
      cursor: null,
      recordedAt: 101,
    };
    expect(runtimePromotionPendingIntentAllowed(authored, authoredIntent)).toBe(true);

    const cache = promote();
    expect(runtimePromotionPendingIntentAllowed(cache, authoredIntent)).toBe(false);
    const destinationVerified = canonicalRuntimePromotionJournal({
      ...cache,
      revision: 2,
      manifests: { ...cache.manifests, source: manifest() },
      progress: { ...cache.progress, phase: 'destination-verified' },
      timestamps: { ...cache.timestamps, updatedAt: 102 },
    });
    expect(runtimePromotionPendingIntentAllowed(destinationVerified, authoredIntent)).toBe(true);
  });

  it('enforces exact open forward ownership windows', () => {
    const authored = initial();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...authored,
        revision: 1,
        cleanup: { ...authored.cleanup, authoredStage: 'pending' },
        timestamps: { ...authored.timestamps, updatedAt: 101 },
      }),
    ).toThrow(/route|owned-artifact|evidence/iu);

    const ready = destinationReady();
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...ready,
        cleanup: { ...ready.cleanup, runtimeStage: 'removed' },
        manifests: { ...ready.manifests, runtimeStage: manifest() },
      }),
    ).toThrow(/route|owned-artifact|evidence/iu);

    const beforeParent = canonicalRuntimePromotionJournal({
      ...promote(),
      destinationParentPreexisting: false,
      revision: 3,
      manifests: { ...promote().manifests, source: manifest() },
      progress: { ...promote().progress, phase: 'authored-prepared' },
      cleanup: {
        ...promote().cleanup,
        authoredStage: 'pending',
        authoredBackup: 'pending',
        replayManifest: 'pending',
      },
      timestamps: { ...promote().timestamps, updatedAt: 103 },
    });
    expect(() =>
      canonicalRuntimePromotionJournal({
        ...beforeParent,
        cleanup: { ...beforeParent.cleanup, destinationParent: 'pending' },
      }),
    ).toThrow(/route|owned-artifact|evidence/iu);
  });

  it('rejects owned cleanup slots that are inapplicable to the route', () => {
    const journal = initial();
    for (const cleanup of [
      { ...journal.cleanup, runtimeStage: 'pending' as const },
      { ...journal.cleanup, destinationBackup: 'pending' as const },
      { ...journal.cleanup, sourceTombstone: 'pending' as const },
      {
        ...journal.cleanup,
        destinationParent: 'pending' as const,
      },
    ]) {
      expect(() =>
        canonicalRuntimePromotionJournal({
          ...journal,
          destinationParentPreexisting: true,
          cleanup,
        }),
      ).toThrow(/route|owned-artifact|evidence/iu);
    }
  });

  it('accepts source then destination manifest verification in exact order', () => {
    const prepared = promote(true);
    const sourceVerified = canonicalRuntimePromotionJournal({
      ...prepared,
      revision: 1,
      manifests: { ...prepared.manifests, source: manifest() },
      progress: { ...prepared.progress, phase: 'source-verified' },
      timestamps: { ...prepared.timestamps, updatedAt: 101 },
    });
    expect(() => assertRuntimePromotionTransition(prepared, sourceVerified)).not.toThrow();

    const destinationVerified = canonicalRuntimePromotionJournal({
      ...sourceVerified,
      revision: 2,
      manifests: {
        ...sourceVerified.manifests,
        destination: manifest(DIGEST_B),
      },
      progress: { ...sourceVerified.progress, phase: 'destination-verified' },
      timestamps: { ...sourceVerified.timestamps, updatedAt: 102 },
    });
    expect(() =>
      assertRuntimePromotionTransition(sourceVerified, destinationVerified),
    ).not.toThrow();
  });

  it('rejects manifest publication outside its exact transition', () => {
    const prepared = promote(true);
    const skippedSourceVerification = canonicalRuntimePromotionJournal({
      ...prepared,
      revision: 1,
      manifests: {
        ...prepared.manifests,
        source: manifest(),
        destination: manifest(DIGEST_B),
      },
      progress: { ...prepared.progress, phase: 'destination-verified' },
      timestamps: { ...prepared.timestamps, updatedAt: 101 },
    });
    expect(() => assertRuntimePromotionTransition(prepared, skippedSourceVerification)).toThrow(
      /source manifest|verification transition/iu,
    );

    const ready = destinationReady();
    const unjournaledStage = canonicalRuntimePromotionJournal({
      ...ready,
      revision: ready.revision + 1,
      manifests: { ...ready.manifests, runtimeStage: manifest() },
      progress: { ...ready.progress, phase: 'runtime-staged' },
      cleanup: { ...ready.cleanup, runtimeStage: 'pending' },
      timestamps: {
        ...ready.timestamps,
        updatedAt: ready.timestamps.updatedAt + 1,
      },
    });
    expect(() => assertRuntimePromotionTransition(ready, unjournaledStage)).toThrow(
      /runtime-stage manifest|postcondition|verification transition/iu,
    );
  });

  it('accepts runtime-stage publication from its matching postcondition', () => {
    const ready = destinationReady();
    const withIntent = canonicalRuntimePromotionJournal({
      ...ready,
      revision: ready.revision + 1,
      progress: {
        ...ready.progress,
        pendingIntent: {
          sequence: 1,
          kind: 'runtime-stage-create',
          slot: 'runtimeStage',
          cursor: null,
          recordedAt: 104,
        },
      },
      counts: { ...ready.counts, intentCount: 1 },
      timestamps: { ...ready.timestamps, updatedAt: 104 },
    });
    const staged = canonicalRuntimePromotionJournal({
      ...withIntent,
      revision: withIntent.revision + 1,
      manifests: { ...withIntent.manifests, runtimeStage: manifest() },
      progress: {
        ...withIntent.progress,
        phase: 'runtime-staged',
        pendingIntent: null,
        lastPostcondition: {
          ...withIntent.progress.pendingIntent!,
          outcome: 'applied',
          recordedAt: 105,
        },
      },
      cleanup: { ...withIntent.cleanup, runtimeStage: 'pending' },
      counts: { ...withIntent.counts, postconditionCount: 1 },
      timestamps: { ...withIntent.timestamps, updatedAt: 105 },
    });

    expect(() => assertRuntimePromotionTransition(withIntent, staged)).not.toThrow();
  });
});

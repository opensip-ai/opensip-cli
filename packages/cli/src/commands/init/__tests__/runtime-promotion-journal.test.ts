import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RUNTIME_RECOVERY_RECORD_MAX_BYTES,
  type AnchoredRecordReadResult,
  type RuntimeExclusiveLease,
  type RuntimeRecoveryRecordMutation,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import {
  canonicalRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  createInitialRuntimePromotionJournal,
  encodeRuntimePromotionJournal,
  type RuntimeManifestIdentity,
  type RuntimePromotionJournal,
  type RuntimePromotionOwnedSlots,
} from '../runtime-promotion-journal-schema.js';
import {
  createRuntimePromotionJournalController,
  handoffRuntimePromotionRecoveryOwner,
  RUNTIME_PROMOTION_JOURNAL_FILE,
  type PromotionJournalIdentity,
  type RuntimePromotionJournalCheckpoint,
  type RuntimePromotionJournalControllerDependencies,
} from '../runtime-promotion-journal.js';

const PROJECT_KEY = 'a'.repeat(24);
const OTHER_PROJECT_KEY = 'b'.repeat(24);
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function ownedSlots(operationId: string): RuntimePromotionOwnedSlots {
  return createRuntimePromotionOwnedSlots(operationId);
}

function initialJournal(
  identity: PromotionJournalIdentity,
  coordinationKey = PROJECT_KEY,
): RuntimePromotionJournal {
  return createInitialRuntimePromotionJournal({
    coordinationKey,
    operationId: identity.operationId,
    recoveryOwnerToken: identity.recoveryOwnerToken,
    destinationParentPreexisting: false,
    destinationRuntimePreexisting: false,
    route: 'authored-only',
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
    owned: ownedSlots(identity.operationId),
    createdAt: identity.createdAt,
  });
}

function promoteCacheJournal(identity: PromotionJournalIdentity): RuntimePromotionJournal {
  return canonicalRuntimePromotionJournal({
    ...initialJournal(identity),
    destinationParentPreexisting: true,
    destinationRuntimePreexisting: false,
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

function authorityVerifiedJournal(
  identity: PromotionJournalIdentity,
  options: {
    readonly route?: 'authored-only' | 'project-authority';
  } = {},
): RuntimePromotionJournal {
  const route = options.route ?? 'authored-only';
  const initial = initialJournal(identity);
  const updatedAt = initial.timestamps.createdAt + 5;
  return canonicalRuntimePromotionJournal({
    ...initial,
    destinationParentPreexisting: true,
    destinationRuntimePreexisting: route === 'project-authority',
    route,
    revision: 5,
    manifests: {
      ...initial.manifests,
      destination: route === 'project-authority' ? runtimeManifest() : null,
    },
    progress: {
      ...initial.progress,
      phase: 'authority-verified',
      authoredCursor: 1,
      lastPostcondition: {
        sequence: 2,
        kind: 'authored-target-commit',
        slot: 'replayManifest',
        cursor: 0,
        outcome: 'applied',
        recordedAt: updatedAt - 1,
      },
    },
    cleanup: {
      ...initial.cleanup,
      authoredStage: 'pending',
      authoredBackup: 'pending',
      replayManifest: 'pending',
    },
    counts: {
      ...initial.counts,
      intentCount: 2,
      postconditionCount: 2,
      authoredCompleted: 1,
    },
    timestamps: {
      ...initial.timestamps,
      updatedAt,
    },
  });
}

function committedJournal(record: RuntimePromotionJournal): RuntimePromotionJournal {
  let runtimeManifest: RuntimeManifestIdentity | null = null;
  if (record.route === 'promote-cache') {
    runtimeManifest = record.manifests.runtimeStage;
  } else if (record.route !== 'authored-only') {
    runtimeManifest = record.manifests.destination;
  }
  return canonicalRuntimePromotionJournal({
    ...record,
    revision: record.revision + 1,
    progress: {
      ...record.progress,
      phase: 'committed',
    },
    terminal: {
      outcome: 'committed',
      authority: record.route === 'authored-only' ? 'none' : 'project',
      runtimeManifest,
      authoredVerified: true,
      sourcePreserved: false,
      verifiedAt: record.timestamps.updatedAt + 1,
    },
    timestamps: {
      ...record.timestamps,
      updatedAt: record.timestamps.updatedAt + 1,
    },
  });
}

function rolledBackJournal(record: RuntimePromotionJournal): RuntimePromotionJournal {
  return canonicalRuntimePromotionJournal({
    ...record,
    revision: record.revision + 2,
    progress: {
      ...record.progress,
      phase: 'rolled-back',
      direction: 'rollback',
    },
    terminal: {
      outcome: 'rolled-back',
      authority: 'none',
      runtimeManifest: null,
      authoredVerified: true,
      sourcePreserved: false,
      verifiedAt: record.timestamps.updatedAt + 2,
    },
    timestamps: {
      ...record.timestamps,
      updatedAt: record.timestamps.updatedAt + 2,
    },
  });
}

function runtimeManifest(digest = 'e'.repeat(64)): RuntimeManifestIdentity {
  return {
    digest,
    fileCount: 0,
    directoryCount: 1,
    symlinkCount: 0,
    rootMode: 0o700,
    totalBytes: 0,
    sqlite: { status: 'absent' },
  };
}

function runtimeStageIntentJournal(identity: PromotionJournalIdentity): RuntimePromotionJournal {
  const initial = promoteCacheJournal(identity);
  const updatedAt = initial.timestamps.createdAt + 4;
  return canonicalRuntimePromotionJournal({
    ...initial,
    revision: 4,
    manifests: {
      ...initial.manifests,
      source: runtimeManifest(),
    },
    progress: {
      ...initial.progress,
      phase: 'destination-ready',
      pendingIntent: {
        sequence: 2,
        kind: 'runtime-stage-create',
        slot: 'runtimeStage',
        cursor: null,
        recordedAt: updatedAt,
      },
      lastPostcondition: {
        sequence: 1,
        kind: 'authored-prepare',
        slot: 'authoredStage',
        cursor: null,
        outcome: 'applied',
        recordedAt: updatedAt - 2,
      },
    },
    cleanup: {
      ...initial.cleanup,
      authoredStage: 'pending',
      authoredBackup: 'pending',
      replayManifest: 'pending',
    },
    counts: {
      ...initial.counts,
      intentCount: 2,
      postconditionCount: 1,
    },
    timestamps: {
      ...initial.timestamps,
      updatedAt,
    },
  });
}

function closedJournal(record: RuntimePromotionJournal): RuntimePromotionJournal {
  const updatedAt = record.timestamps.updatedAt + 1;
  return canonicalRuntimePromotionJournal({
    ...record,
    state: 'closed',
    revision: record.revision + 1,
    progress: {
      ...record.progress,
      phase: 'closed',
      direction: 'cleanup',
    },
    timestamps: {
      ...record.timestamps,
      updatedAt,
      closedAt: updatedAt,
    },
  });
}

function closedJournalWithOnePendingAuthored(
  identity: PromotionJournalIdentity,
): RuntimePromotionJournal {
  const closed = closedJournal(committedJournal(authorityVerifiedJournal(identity)));
  const updatedAt = closed.timestamps.updatedAt + 4;
  return canonicalRuntimePromotionJournal({
    ...closed,
    revision: closed.revision + 4,
    progress: {
      ...closed.progress,
      phase: 'cleanup',
      lastPostcondition: {
        sequence: 4,
        kind: 'owned-slot-cleanup',
        slot: 'replayManifest',
        cursor: null,
        outcome: 'applied',
        recordedAt: updatedAt,
      },
    },
    cleanup: {
      ...closed.cleanup,
      authoredBackup: 'removed',
      replayManifest: 'removed',
    },
    counts: {
      ...closed.counts,
      intentCount: 4,
      postconditionCount: 4,
      cleanupCompleted: 2,
    },
    timestamps: {
      ...closed.timestamps,
      updatedAt,
    },
  });
}

type MutationFault = 'success' | 'throw-before' | 'apply-then-throw';

interface JournalHarness {
  readonly lease: RuntimeExclusiveLease;
  readonly controller: ReturnType<typeof createRuntimePromotionJournalController>;
  readonly mutations: RuntimeRecoveryRecordMutation[];
  readonly checkpoints: RuntimePromotionJournalCheckpoint[];
  readonly corruptNextReadDigest: () => void;
  readonly setContent: (content: string | undefined) => void;
  readonly getContent: () => string | undefined;
  readonly faults: MutationFault[];
}

function createHarness(initialContent?: string): JournalHarness {
  let content = initialContent;
  let clock = 99;
  let recoveryOwnerSequence = 0;
  const mutations: RuntimeRecoveryRecordMutation[] = [];
  const checkpoints: RuntimePromotionJournalCheckpoint[] = [];
  const faults: MutationFault[] = [];
  let corruptNextReadDigest = false;
  const lease = Object.freeze({
    kind: 'runtime-exclusive',
    coordinationKey: PROJECT_KEY,
    posture: 'normal',
    ownerToken: 'lease-owner-0000000000000000',
    acquiredAt: 1,
    release: () => undefined,
  }) satisfies RuntimeExclusiveLease;

  const read = (): Promise<AnchoredRecordReadResult> => {
    const observed =
      content === undefined
        ? ({ status: 'absent' } as const)
        : ({
            status: 'present',
            content,
            sha256: corruptNextReadDigest ? 'f'.repeat(64) : sha256(content),
          } as const);
    corruptNextReadDigest = false;
    return Promise.resolve(observed);
  };

  const applyMutation = (mutation: RuntimeRecoveryRecordMutation): void => {
    if (mutation.operation === 'create') {
      if (content !== undefined) throw new Error('exclusive create conflict');
      content = mutation.content;
      return;
    }
    if (mutation.operation === 'replace') {
      if (content === undefined || sha256(content) !== mutation.expectedContentSha256) {
        throw new Error('replace compare-and-swap conflict');
      }
      content = mutation.content;
      return;
    }
    if (content !== undefined && sha256(content) !== mutation.expectedContentSha256) {
      throw new Error('unlink compare-and-swap conflict');
    }
    content = undefined;
  };

  const dependencies: RuntimePromotionJournalControllerDependencies = {
    now: () => ++clock,
    generateOperationId: () => 'operation-0000000000000001',
    generateRecoveryOwnerToken: () =>
      `recovery-owner-${(++recoveryOwnerSequence).toString().padStart(12, '0')}`,
    read: async (actualLease) => {
      expect(actualLease).toBe(lease);
      return read();
    },
    mutate: (actualLease, mutation) => {
      expect(actualLease).toBe(lease);
      mutations.push(mutation);
      const fault = faults.shift() ?? 'success';
      if (fault === 'throw-before') throw new Error('injected pre-apply failure');
      applyMutation(mutation);
      if (fault === 'apply-then-throw') {
        throw new Error('injected post-apply durability ambiguity');
      }
      return Promise.resolve({ strategy: 'portable-anchored' });
    },
    checkpoint: (checkpoint) => checkpoints.push(checkpoint),
  };

  return {
    lease,
    controller: createRuntimePromotionJournalController(lease, dependencies),
    mutations,
    checkpoints,
    corruptNextReadDigest: () => {
      corruptNextReadDigest = true;
    },
    setContent: (next) => {
      content = next;
    },
    getContent: () => content,
    faults,
  };
}

async function createOpen(harness: JournalHarness) {
  const allocation = harness.controller.allocate((identity) => initialJournal(identity));
  return harness.controller.create(allocation);
}

describe('runtime promotion journal controller', () => {
  it('creates one exclusive, durable open journal without a second barrier', async () => {
    const harness = createHarness();
    const receipt = await createOpen(harness);

    expect(receipt).toMatchObject({
      state: 'open',
      coordinationKey: PROJECT_KEY,
      operationId: 'operation-0000000000000001',
      revision: 0,
    });
    expect(harness.mutations).toHaveLength(1);
    expect(harness.mutations[0]?.operation).toBe('create');
    expect(harness.checkpoints).toEqual(['after-create-mutation']);
    await expect(harness.controller.verifyOpen(receipt)).resolves.toMatchObject({
      progress: { phase: 'prepared' },
    });
  });

  it('fails closed when an anchored verification digest disagrees with exact bytes', async () => {
    const harness = createHarness();
    const allocation = harness.controller.allocate((identity) => initialJournal(identity));
    harness.corruptNextReadDigest();

    await expect(harness.controller.create(allocation)).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_RECOVERY_REQUIRED',
    });
    expect(harness.getContent()).toBeDefined();
    expect(harness.mutations).toHaveLength(1);
  });

  it('retires allocations and receipts before transition attempts', async () => {
    const harness = createHarness();
    const allocation = harness.controller.allocate((identity) => initialJournal(identity));
    const receipt = await harness.controller.create(allocation);

    await expect(harness.controller.create(allocation)).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_JOURNAL',
    });
    await harness.controller.verifyOpen(receipt);
    harness.faults.push('throw-before', 'throw-before');
    await expect(
      harness.controller.handoffRecoveryOwner(receipt, (record, identity) => ({
        ...record,
        revision: record.revision + 1,
        recoveryOwnerToken: identity.recoveryOwnerToken,
        recoveryAttempt: record.recoveryAttempt + 1,
        timestamps: {
          ...record.timestamps,
          updatedAt: identity.claimedAt,
        },
      })),
    ).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_RECOVERY_REQUIRED',
    });
    await expect(harness.controller.verifyOpen(receipt)).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_JOURNAL',
    });
  });

  it('keeps only the newest in-memory allocation before durable creation', async () => {
    const harness = createHarness();
    const first = harness.controller.allocate((identity) => initialJournal(identity));
    const second = harness.controller.allocate((identity) => initialJournal(identity));

    await expect(harness.controller.create(first)).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_JOURNAL',
    });
    await expect(harness.controller.create(second)).resolves.toMatchObject({
      state: 'open',
    });
    expect(harness.mutations).toHaveLength(1);
  });

  it('recovers create ambiguity by durably replacing desired bytes with themselves', async () => {
    const harness = createHarness();
    harness.faults.push('apply-then-throw');

    const receipt = await createOpen(harness);

    expect(receipt.state).toBe('open');
    expect(harness.mutations.map((mutation) => mutation.operation)).toEqual(['create', 'replace']);
    const replacement = harness.mutations[1];
    expect(replacement).toMatchObject({
      operation: 'replace',
      expectedContentSha256: sha256(harness.getContent() ?? ''),
    });
  });

  it('retries the original create when a failed attempt left the file absent', async () => {
    const harness = createHarness();
    harness.faults.push('throw-before');

    await expect(createOpen(harness)).resolves.toMatchObject({ state: 'open' });
    expect(harness.mutations.map((mutation) => mutation.operation)).toEqual(['create', 'create']);
  });

  it('fails closed on unrelated exclusive-create content', async () => {
    const existing = encodeRuntimePromotionJournal(
      initialJournal(
        {
          operationId: 'other-operation-000000000001',
          recoveryOwnerToken: 'other-owner-000000000000001',
          createdAt: 100,
        },
        PROJECT_KEY,
      ),
    );
    const harness = createHarness(existing);

    await expect(createOpen(harness)).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_RECOVERY_REQUIRED',
    });
    expect(harness.getContent()).toBe(existing);
    expect(harness.mutations).toHaveLength(1);
  });

  it('claims only a canonical journal for the exact key and operation', async () => {
    const record = initialJournal({
      operationId: 'claim-operation-000000000001',
      recoveryOwnerToken: 'claim-owner-000000000000001',
      createdAt: 100,
    });
    const harness = createHarness(encodeRuntimePromotionJournal(record));

    await expect(harness.controller.claim(record.operationId)).resolves.toMatchObject({
      operationId: record.operationId,
      state: 'open',
    });
    await expect(harness.controller.claim('wrong-operation-000000000001')).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_RECOVERY_REQUIRED',
    });
  });

  it.each([
    ['malformed', '{}'],
    ['oversize', 'x'.repeat(RUNTIME_RECOVERY_RECORD_MAX_BYTES + 1)],
    [
      'key mismatch',
      encodeRuntimePromotionJournal(
        initialJournal(
          {
            operationId: 'key-operation-00000000000001',
            recoveryOwnerToken: 'key-owner-00000000000000001',
            createdAt: 100,
          },
          OTHER_PROJECT_KEY,
        ),
      ),
    ],
  ])('fails closed on %s journal bytes', async (_name, content) => {
    const harness = createHarness(content);
    await expect(harness.controller.claim()).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_RECOVERY_REQUIRED',
    });
  });

  it('canonically hands an open journal to one new recovery owner', async () => {
    const harness = createHarness();
    const receipt = await createOpen(harness);
    const current = await harness.controller.verifyOpen(receipt);
    const next = await handoffRuntimePromotionRecoveryOwner(harness.controller, receipt);

    await expect(harness.controller.verifyReceipt(next)).resolves.toStrictEqual({
      ...current,
      revision: current.revision + 1,
      recoveryOwnerToken: 'recovery-owner-000000000002',
      recoveryAttempt: current.recoveryAttempt + 1,
      timestamps: {
        ...current.timestamps,
        updatedAt: 101,
      },
    });
    await expect(harness.controller.verifyOpen(receipt)).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_JOURNAL',
    });
  });

  it('canonically hands a closed journal to one new recovery owner', async () => {
    const closed = closedJournal(
      committedJournal(
        authorityVerifiedJournal({
          operationId: 'closed-handoff-operation-0001',
          recoveryOwnerToken: 'closed-handoff-owner-0000001',
          createdAt: 1,
        }),
      ),
    );
    const harness = createHarness(encodeRuntimePromotionJournal(closed));
    const receipt = await harness.controller.claim(closed.operationId);
    if (receipt.state !== 'closed') throw new Error('expected closed test receipt');
    const next = await handoffRuntimePromotionRecoveryOwner(harness.controller, receipt);

    expect(next.state).toBe('closed');
    await expect(harness.controller.verifyReceipt(next)).resolves.toStrictEqual({
      ...closed,
      revision: closed.revision + 1,
      recoveryOwnerToken: 'recovery-owner-000000000001',
      recoveryAttempt: closed.recoveryAttempt + 1,
      timestamps: {
        ...closed.timestamps,
        updatedAt: 100,
      },
    });
    await expect(harness.controller.verifyReceipt(receipt)).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_JOURNAL',
    });
  });

  it('rejects impossible transitions without mutating durable bytes', async () => {
    const harness = createHarness();
    const receipt = await createOpen(harness);
    const current = await harness.controller.verifyOpen(receipt);

    await expect(harness.controller.replace(receipt, current)).rejects.toThrow(
      /transition|revision/iu,
    );
    expect(harness.mutations).toHaveLength(1);
    await expect(harness.controller.verifyOpen(receipt)).resolves.toEqual(current);
  });

  it('rejects authored or cleanup execution changes without matching intent lifecycle', async () => {
    const harness = createHarness();
    const receipt = await createOpen(harness);
    const current = await harness.controller.verifyOpen(receipt);
    const authoredBypass = canonicalRuntimePromotionJournal({
      ...current,
      revision: current.revision + 1,
      progress: {
        ...current.progress,
        authoredCursor: 1,
      },
      counts: {
        ...current.counts,
        authoredCompleted: 1,
      },
      timestamps: {
        ...current.timestamps,
        updatedAt: current.timestamps.updatedAt + 1,
      },
    });

    await expect(harness.controller.replace(receipt, authoredBypass)).rejects.toThrow(
      /intent|lifecycle|execution/iu,
    );
    expect(harness.mutations).toHaveLength(1);

    const closed = closedJournal(
      committedJournal(
        authorityVerifiedJournal({
          operationId: 'cleanup-bypass-operation-001',
          recoveryOwnerToken: 'cleanup-bypass-owner-0000001',
          createdAt: 100,
        }),
      ),
    );
    const cleanupHarness = createHarness(encodeRuntimePromotionJournal(closed));
    const closedReceipt = await cleanupHarness.controller.claim(closed.operationId);
    const cleanupBypass = canonicalRuntimePromotionJournal({
      ...closed,
      revision: closed.revision + 2,
      progress: {
        ...closed.progress,
        phase: 'cleanup',
        lastPostcondition: {
          sequence: closed.counts.postconditionCount + 1,
          kind: 'owned-slot-cleanup',
          slot: 'authoredStage',
          cursor: null,
          outcome: 'applied',
          recordedAt: closed.timestamps.updatedAt + 2,
        },
      },
      cleanup: {
        ...closed.cleanup,
        authoredStage: 'removed',
      },
      counts: {
        ...closed.counts,
        intentCount: closed.counts.intentCount + 1,
        postconditionCount: closed.counts.postconditionCount + 1,
        cleanupCompleted: 1,
      },
      timestamps: {
        ...closed.timestamps,
        updatedAt: closed.timestamps.updatedAt + 2,
      },
    });

    await expect(cleanupHarness.controller.replace(closedReceipt, cleanupBypass)).rejects.toThrow(
      /revision|intent|lifecycle|execution/iu,
    );
    expect(cleanupHarness.mutations).toHaveLength(0);
  });

  it('records a write-ahead intent before accepting its exact postcondition', async () => {
    const harness = createHarness();
    const prepared = await createOpen(harness);
    const initial = await harness.controller.verifyOpen(prepared);
    const withIntent = canonicalRuntimePromotionJournal({
      ...initial,
      revision: initial.revision + 1,
      progress: {
        ...initial.progress,
        pendingIntent: {
          sequence: 1,
          kind: 'authored-prepare',
          slot: 'authoredStage',
          cursor: null,
          recordedAt: 101,
        },
      },
      counts: {
        ...initial.counts,
        intentCount: 1,
      },
      timestamps: {
        ...initial.timestamps,
        updatedAt: 101,
      },
    });

    const intentReceipt = await harness.controller.recordIntent(prepared, withIntent);
    const afterIntent = await harness.controller.verifyOpen(intentReceipt);
    expect(afterIntent.progress.pendingIntent).toMatchObject({
      kind: 'authored-prepare',
      sequence: 1,
    });
    const withPostcondition = canonicalRuntimePromotionJournal({
      ...afterIntent,
      revision: afterIntent.revision + 1,
      progress: {
        ...afterIntent.progress,
        phase: 'authored-prepared',
        pendingIntent: null,
        lastPostcondition: {
          ...withIntent.progress.pendingIntent!,
          outcome: 'applied',
          recordedAt: 102,
        },
      },
      cleanup: {
        ...afterIntent.cleanup,
        authoredStage: 'pending',
        authoredBackup: 'pending',
        replayManifest: 'pending',
      },
      counts: {
        ...afterIntent.counts,
        postconditionCount: 1,
      },
      timestamps: {
        ...afterIntent.timestamps,
        updatedAt: 102,
      },
    });

    const postconditionReceipt = await harness.controller.recordPostcondition(
      intentReceipt,
      withPostcondition,
    );

    await expect(harness.controller.verifyOpen(postconditionReceipt)).resolves.toMatchObject({
      progress: {
        phase: 'authored-prepared',
        pendingIntent: null,
        lastPostcondition: { outcome: 'applied' },
      },
      counts: { intentCount: 1, postconditionCount: 1 },
    });
  });

  it('begins rollback and seals exact rolled-back authority', async () => {
    const harness = createHarness();
    const prepared = await createOpen(harness);
    const initial = await harness.controller.verifyOpen(prepared);
    const rollbackStarted = canonicalRuntimePromotionJournal({
      ...initial,
      revision: initial.revision + 1,
      progress: {
        ...initial.progress,
        phase: 'rollback-started',
        direction: 'rollback',
      },
      timestamps: {
        ...initial.timestamps,
        updatedAt: 101,
      },
    });
    const rollbackReceipt = await harness.controller.beginRollback(prepared, rollbackStarted);
    const authoredRolledBack = canonicalRuntimePromotionJournal({
      ...rollbackStarted,
      revision: rollbackStarted.revision + 1,
      progress: {
        ...rollbackStarted.progress,
        phase: 'authored-rolled-back',
      },
      timestamps: {
        ...rollbackStarted.timestamps,
        updatedAt: 102,
      },
    });
    const authoredReceipt = await harness.controller.replace(rollbackReceipt, authoredRolledBack);
    if (authoredReceipt.state !== 'open') {
      throw new Error('expected open authored rollback receipt');
    }
    const sealed = canonicalRuntimePromotionJournal({
      ...authoredRolledBack,
      revision: authoredRolledBack.revision + 1,
      progress: {
        ...authoredRolledBack.progress,
        phase: 'rolled-back',
      },
      terminal: {
        outcome: 'rolled-back',
        authority: 'none',
        runtimeManifest: null,
        authoredVerified: true,
        sourcePreserved: false,
        verifiedAt: 103,
      },
      timestamps: {
        ...authoredRolledBack.timestamps,
        updatedAt: 103,
      },
    });

    const sealedReceipt = await harness.controller.sealRolledBack(authoredReceipt, sealed);

    await expect(harness.controller.verifyOpen(sealedReceipt)).resolves.toMatchObject({
      terminal: { outcome: 'rolled-back', authority: 'none' },
    });
  });

  it('reconciles replace failures from both the old and desired byte windows', async () => {
    for (const fault of ['throw-before', 'apply-then-throw'] as const) {
      const harness = createHarness();
      const receipt = await createOpen(harness);
      harness.faults.push(fault);

      await expect(
        harness.controller.handoffRecoveryOwner(receipt, (record, identity) => ({
          ...record,
          revision: record.revision + 1,
          recoveryOwnerToken: identity.recoveryOwnerToken,
          recoveryAttempt: record.recoveryAttempt + 1,
          timestamps: {
            ...record.timestamps,
            updatedAt: identity.claimedAt,
          },
        })),
      ).resolves.toMatchObject({ revision: 1 });
      expect(harness.mutations).toHaveLength(3);
      expect(harness.mutations.at(-1)?.operation).toBe('replace');
    }
  });

  it('authorizes a runtime stage only from an exact durable intent and consumes proof once', async () => {
    const stageIntent = runtimeStageIntentJournal({
      operationId: 'stage-operation-0000000000001',
      recoveryOwnerToken: 'stage-owner-000000000000001',
      createdAt: 100,
    });
    const harness = createHarness(encodeRuntimePromotionJournal(stageIntent));
    const receipt = await harness.controller.claim(stageIntent.operationId);
    if (receipt.state !== 'open') throw new Error('expected open test receipt');

    const authority = await harness.controller.authorizeRuntimeStage(
      receipt,
      stageIntent.owned.runtimeStage.basename,
    );
    expect(() =>
      harness.controller.assertRuntimeStageAuthority(
        { ...authority },
        stageIntent.owned.runtimeStage.basename,
      ),
    ).toThrow(/stale|foreign/iu);
    const identity = harness.controller.assertRuntimeStageAuthority(
      authority,
      stageIntent.owned.runtimeStage.basename,
    );
    expect(identity).toEqual({
      operationId: stageIntent.operationId,
      stageBasename: stageIntent.owned.runtimeStage.basename,
      ownershipId: stageIntent.owned.runtimeStage.ownershipId,
    });
    expect(() =>
      harness.controller.assertRuntimeStageAuthority(
        authority,
        stageIntent.owned.runtimeStage.basename,
      ),
    ).toThrow(/stale|foreign/iu);
    await expect(
      harness.controller.authorizeRuntimeStage(receipt, stageIntent.owned.authoredStage.basename),
    ).rejects.toMatchObject({ code: 'SYSTEM.INIT.PROMOTION_JOURNAL' });
  });

  it('keeps one current receipt and invalidates derived authority on a later claim', async () => {
    const stageIntent = runtimeStageIntentJournal({
      operationId: 'single-receipt-operation-0001',
      recoveryOwnerToken: 'single-receipt-owner-000001',
      createdAt: 100,
    });
    const harness = createHarness(encodeRuntimePromotionJournal(stageIntent));
    const first = await harness.controller.claim(stageIntent.operationId);
    if (first.state !== 'open') throw new Error('expected open test receipt');
    const authority = await harness.controller.authorizeRuntimeStage(
      first,
      stageIntent.owned.runtimeStage.basename,
    );

    const second = await harness.controller.claim(stageIntent.operationId);

    await expect(harness.controller.verifyOpen(first)).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_JOURNAL',
    });
    expect(() =>
      harness.controller.assertRuntimeStageAuthority(
        authority,
        stageIntent.owned.runtimeStage.basename,
      ),
    ).toThrow(/stale|foreign/iu);
    await expect(harness.controller.verifyReceipt(second)).resolves.toEqual(stageIntent);
  });

  it('rejects a statically impossible current intent before issuing a receipt', () => {
    const initial = initialJournal({
      operationId: 'impossible-intent-operation-01',
      recoveryOwnerToken: 'impossible-intent-owner-0001',
      createdAt: 100,
    });

    expect(() =>
      canonicalRuntimePromotionJournal({
        ...initial,
        revision: 1,
        progress: {
          ...initial.progress,
          pendingIntent: {
            sequence: 1,
            kind: 'runtime-stage-create',
            slot: 'runtimeStage',
            cursor: null,
            recordedAt: 101,
          },
        },
        counts: {
          ...initial.counts,
          intentCount: 1,
        },
        timestamps: {
          ...initial.timestamps,
          updatedAt: 101,
        },
      }),
    ).toThrow(/intent|route|phase/iu);
  });

  it('refuses stage authority before a durable open intent exists', async () => {
    const harness = createHarness();
    const receipt = await createOpen(harness);
    const current = await harness.controller.verifyOpen(receipt);
    await expect(
      harness.controller.authorizeRuntimeStage(receipt, current.owned.runtimeStage.basename),
    ).rejects.toMatchObject({ code: 'SYSTEM.INIT.PROMOTION_JOURNAL' });
  });

  it('closes monotonically and unlinks with one durable mutation on success', async () => {
    const base = initialJournal({
      operationId: 'close-operation-0000000000001',
      recoveryOwnerToken: 'close-owner-000000000000001',
      createdAt: 100,
    });
    const rolledBack = rolledBackJournal(base);
    const harness = createHarness(encodeRuntimePromotionJournal(rolledBack));
    const claimed = await harness.controller.claim(rolledBack.operationId);
    if (claimed.state !== 'open') throw new Error('expected open test receipt');

    const closed = await harness.controller.close(claimed, closedJournal(rolledBack));
    expect(closed.state).toBe('closed');
    await harness.controller.unlinkClosed(closed);

    expect(harness.getContent()).toBeUndefined();
    expect(harness.mutations.map((mutation) => mutation.operation)).toEqual(['replace', 'unlink']);
  });

  it('seals committed authority only after the verified authority phase', async () => {
    const authorityVerified = authorityVerifiedJournal(
      {
        operationId: 'seal-operation-00000000000001',
        recoveryOwnerToken: 'seal-owner-0000000000000001',
        createdAt: 100,
      },
      { route: 'project-authority' },
    );
    const harness = createHarness(encodeRuntimePromotionJournal(authorityVerified));
    const claimed = await harness.controller.claim(authorityVerified.operationId);
    if (claimed.state !== 'open') throw new Error('expected open test receipt');
    const committed = committedJournal(authorityVerified);

    const sealed = await harness.controller.sealCommitted(claimed, committed);

    await expect(harness.controller.verifyOpen(sealed)).resolves.toMatchObject({
      progress: { phase: 'committed' },
      terminal: { outcome: 'committed' },
    });
  });

  it('keeps a closed receipt while an owned leftover is pending', async () => {
    const authorityVerified = authorityVerifiedJournal({
      operationId: 'cleanup-blocked-pending-01',
      recoveryOwnerToken: 'cleanup-blocked-pending-owner-01',
      createdAt: 100,
    });
    const closed = closedJournal(committedJournal(authorityVerified));
    const harness = createHarness(encodeRuntimePromotionJournal(closed));
    const receipt = await harness.controller.claim(closed.operationId);
    if (receipt.state !== 'closed') {
      throw new Error('expected closed test receipt');
    }

    await expect(harness.controller.unlinkClosed(receipt)).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_JOURNAL',
    });
    expect(harness.mutations).toEqual([]);
    await expect(harness.controller.verifyReceipt(receipt)).resolves.toEqual(closed);
  });

  it('journals closed cleanup intent and postcondition before unlink', async () => {
    const closed = closedJournalWithOnePendingAuthored({
      operationId: 'cleanup-operation-00000000001',
      recoveryOwnerToken: 'cleanup-owner-0000000000001',
      createdAt: 100,
    });
    const harness = createHarness(encodeRuntimePromotionJournal(closed));
    const claimed = await harness.controller.claim(closed.operationId);
    if (claimed.state !== 'closed') throw new Error('expected closed test receipt');
    const cleanupIntent = canonicalRuntimePromotionJournal({
      ...closed,
      revision: closed.revision + 1,
      progress: {
        ...closed.progress,
        pendingIntent: {
          sequence: closed.counts.intentCount + 1,
          kind: 'owned-slot-cleanup',
          slot: 'authoredStage',
          cursor: null,
          recordedAt: closed.timestamps.updatedAt + 1,
        },
      },
      counts: {
        ...closed.counts,
        intentCount: closed.counts.intentCount + 1,
      },
      timestamps: {
        ...closed.timestamps,
        updatedAt: closed.timestamps.updatedAt + 1,
      },
    });
    const intentReceipt = await harness.controller.recordCleanupIntent(claimed, cleanupIntent);
    const cleanupPostcondition = canonicalRuntimePromotionJournal({
      ...cleanupIntent,
      revision: cleanupIntent.revision + 1,
      progress: {
        ...cleanupIntent.progress,
        phase: 'cleanup',
        pendingIntent: null,
        lastPostcondition: {
          ...cleanupIntent.progress.pendingIntent!,
          outcome: 'already-satisfied',
          recordedAt: cleanupIntent.timestamps.updatedAt + 1,
        },
      },
      cleanup: {
        ...cleanupIntent.cleanup,
        authoredStage: 'removed',
      },
      counts: {
        ...cleanupIntent.counts,
        postconditionCount: cleanupIntent.counts.postconditionCount + 1,
        cleanupCompleted: cleanupIntent.counts.cleanupCompleted + 1,
      },
      timestamps: {
        ...cleanupIntent.timestamps,
        updatedAt: cleanupIntent.timestamps.updatedAt + 1,
      },
    });

    const completed = await harness.controller.recordCleanupPostcondition(
      intentReceipt,
      cleanupPostcondition,
    );
    await harness.controller.unlinkClosed(completed);

    expect(harness.getContent()).toBeUndefined();
    expect(harness.mutations.map((mutation) => mutation.operation)).toEqual([
      'replace',
      'replace',
      'unlink',
    ]);
  });

  it('retries a visibly absent unlink to close the fsync ambiguity window', async () => {
    const rolledBack = rolledBackJournal(
      initialJournal({
        operationId: 'unlink-operation-000000000001',
        recoveryOwnerToken: 'unlink-owner-00000000000001',
        createdAt: 100,
      }),
    );
    const closed = closedJournal(rolledBack);
    const harness = createHarness(encodeRuntimePromotionJournal(closed));
    const receipt = await harness.controller.claim(closed.operationId);
    if (receipt.state !== 'closed') throw new Error('expected closed test receipt');
    harness.faults.push('apply-then-throw');

    await harness.controller.unlinkClosed(receipt);

    expect(harness.mutations.map((mutation) => mutation.operation)).toEqual(['unlink', 'unlink']);
    expect(harness.getContent()).toBeUndefined();
  });

  it('makes a second mutation failure recovery-required', async () => {
    const harness = createHarness();
    harness.faults.push('throw-before', 'throw-before');

    await expect(createOpen(harness)).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_RECOVERY_REQUIRED',
    });
    expect(harness.mutations).toHaveLength(2);
  });

  it('makes a second closed-unlink failure recovery-required', async () => {
    const closed = closedJournal(
      rolledBackJournal(
        initialJournal({
          operationId: 'unlink-failure-operation-0001',
          recoveryOwnerToken: 'unlink-failure-owner-000001',
          createdAt: 100,
        }),
      ),
    );
    const harness = createHarness(encodeRuntimePromotionJournal(closed));
    const receipt = await harness.controller.claim(closed.operationId);
    if (receipt.state !== 'closed') throw new Error('expected closed test receipt');
    harness.faults.push('throw-before', 'throw-before');

    await expect(harness.controller.unlinkClosed(receipt)).rejects.toMatchObject({
      code: 'SYSTEM.INIT.PROMOTION_RECOVERY_REQUIRED',
    });
    expect(harness.getContent()).toBe(encodeRuntimePromotionJournal(closed));
    expect(harness.mutations).toHaveLength(2);
  });

  it('keeps all core journal I/O behind the single controller facade', () => {
    const initDirectory = dirname(fileURLToPath(import.meta.url));
    const productionDirectory = join(initDirectory, '..');
    const bypasses = readdirSync(productionDirectory)
      .filter((name) => name.endsWith('.ts') && name !== 'runtime-promotion-journal.ts')
      .filter((name) => {
        const source = readFileSync(join(productionDirectory, name), 'utf8');
        return (
          source.includes('readRuntimePromotionJournal') ||
          source.includes('mutateRuntimePromotionJournal')
        );
      });

    expect(bypasses).toEqual([]);
    expect(RUNTIME_PROMOTION_JOURNAL_FILE).toBe('runtime-promotion.json');
  });
});

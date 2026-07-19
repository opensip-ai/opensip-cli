import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  projectCoordinationKey,
  type AnchoredRecordReadResult,
  type RuntimeExclusiveLease,
  type RuntimeRecoveryRecordMutation,
} from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  bindAuthoredStateReceipt,
  commitAuthoredState,
  prepareAuthoredState,
  rollbackAuthoredState,
  type AuthoredStateCheckpoint,
} from '../authored-state-transaction.js';
import { sha256Bytes, sha256Parts } from '../init-authored-plan-types.js';
import * as currentAuthoredPlan from '../init-authored-plan.js';
import {
  encodeAuthoredReplayManifest,
  type AuthoredReplayManifest,
  type InitAuthoredMutation,
  type InitAuthoredPathState,
  type InitAuthoredPlan,
} from '../init-authored-plan.js';
import {
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  parseRuntimePromotionJournal,
  type RuntimePromotionJournal,
} from '../runtime-promotion-journal-schema.js';
import {
  createRuntimePromotionJournalController,
  type DurableOpenPromotionJournal,
  type RuntimePromotionJournalController,
} from '../runtime-promotion-journal.js';
import {
  recoverRuntimePromotion,
  type RuntimePromotionRecoveryDependencies,
} from '../runtime-promotion-recovery.js';
import { captureRuntimePromotionProjectRootAuthority } from '../runtime-promotion-root-authority.js';
import { createRuntimePromotionTransitionWriter } from '../runtime-promotion-transitions.js';

const OPERATION_ID = 'runtime-promotion-authored-recovery-0001';
const DATASTORE_LOCK_CONTEXT = {
  policy: { waitMs: 100, staleMs: 1000, heartbeatMs: 100 },
  command: 'opensip init',
  cwdBasename: 'authored-recovery',
} as const;

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function projectRoot(): string {
  const created = mkdtempSync(join(tmpdir(), 'opensip-recovery-authored-'));
  chmodSync(created, 0o700);
  const canonical = realpathSync(created);
  temporaryRoots.push(canonical);
  return canonical;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function absent(): InitAuthoredPathState {
  return { exists: false, type: null, mode: null, digest: null };
}

function fileState(content: string): InitAuthoredPathState {
  return {
    exists: true,
    type: 'file',
    mode: 0o600,
    digest: sha256Bytes(content),
  };
}

interface MutationSpec {
  readonly path: string;
  readonly preimage: InitAuthoredPathState;
  readonly desired: InitAuthoredPathState;
  readonly preimageContent?: string;
  readonly desiredContent?: string;
}

function actionFor(
  preimage: InitAuthoredPathState,
  desired: InitAuthoredPathState,
): InitAuthoredMutation['action'] {
  if (!preimage.exists && desired.exists) return 'create';
  if (preimage.exists && !desired.exists) return 'delete';
  if (JSON.stringify(preimage) === JSON.stringify(desired)) return 'preserve';
  return 'replace';
}

function authoredPlan(specifications: readonly MutationSpec[]): InitAuthoredPlan {
  const desired: Record<string, string> = {};
  const preimage: Record<string, string> = {};
  let aggregateBlobBytes = 0;
  const mutations = [...specifications]
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')),
    )
    .map((specification, sequence): InitAuthoredMutation => {
      const desiredBlob =
        specification.desired.exists && specification.desired.type === 'file'
          ? `desired/${String(sequence).padStart(4, '0')}.blob`
          : null;
      const preimageBlob =
        specification.preimage.exists && specification.preimage.type === 'file'
          ? `preimage/${String(sequence).padStart(4, '0')}.blob`
          : null;
      if (desiredBlob !== null) {
        if (specification.desiredContent === undefined) throw new Error('missing desired bytes');
        desired[desiredBlob] = Buffer.from(specification.desiredContent).toString('base64');
        aggregateBlobBytes += Buffer.byteLength(specification.desiredContent);
      }
      if (preimageBlob !== null) {
        if (specification.preimageContent === undefined) throw new Error('missing preimage bytes');
        preimage[preimageBlob] = Buffer.from(specification.preimageContent).toString('base64');
        aggregateBlobBytes += Buffer.byteLength(specification.preimageContent);
      }
      const target = specification.desired.exists ? specification.desired : specification.preimage;
      if (!target.exists || target.type === null || target.mode === null) {
        throw new Error('missing target identity');
      }
      return {
        sequence,
        action: actionFor(specification.preimage, specification.desired),
        path: specification.path,
        targetType: target.type,
        targetMode: target.mode,
        preimage: specification.preimage,
        desired: specification.desired,
        desiredBlob,
        preimageBlob,
      };
    });
  const inputs = {
    languages: ['typescript'] as const,
    mode: 'fresh' as const,
    tools: [] as const,
  };
  const replayManifest: AuthoredReplayManifest = {
    kind: 'opensip-init-authored-replay',
    version: 1,
    inputs,
    mutations,
  };
  const replayManifestBytes = encodeAuthoredReplayManifest(replayManifest);
  return {
    inputs,
    mutations,
    replayManifest,
    replayManifestBytes,
    replayManifestDigest: sha256Bytes(replayManifestBytes),
    digest: sha256Parts([
      'opensip-init-authored-plan\0v1\0',
      JSON.stringify(inputs),
      '\0',
      replayManifestBytes,
    ]),
    aggregateBlobBytes,
    blobs: { desired, preimage },
  };
}

interface JournalStore {
  content: string | undefined;
}

interface AuthoredRecoveryHarness {
  readonly root: string;
  readonly coordinationKey: string;
  readonly store: JournalStore;
  readonly normalLease: RuntimeExclusiveLease;
  readonly controller: RuntimePromotionJournalController;
  readonly receipt: DurableOpenPromotionJournal;
  readonly released: { count: number };
  readonly inspectManifest: Mock<RuntimePromotionRecoveryDependencies['inspectManifest']>;
  readonly now: () => number;
}

function readStore(store: JournalStore): AnchoredRecordReadResult {
  return store.content === undefined
    ? { status: 'absent' }
    : {
        status: 'present',
        content: store.content,
        sha256: sha256(store.content),
      };
}

function mutateStore(store: JournalStore, mutation: RuntimeRecoveryRecordMutation): void {
  if (mutation.operation === 'create') {
    if (store.content !== undefined) throw new Error('journal already exists');
    store.content = mutation.content;
    return;
  }
  if (store.content === undefined || sha256(store.content) !== mutation.expectedContentSha256) {
    throw new Error('journal compare-and-swap collision');
  }
  store.content = mutation.operation === 'replace' ? mutation.content : undefined;
}

function controllerFor(
  lease: RuntimeExclusiveLease,
  store: JournalStore,
  now: () => number,
): RuntimePromotionJournalController {
  let ownerSequence = 0;
  return createRuntimePromotionJournalController(lease, {
    now,
    generateOperationId: () => OPERATION_ID,
    generateRecoveryOwnerToken: () =>
      `${lease.posture}-authored-recovery-${(++ownerSequence).toString().padStart(8, '0')}`,
    read: () => Promise.resolve(readStore(store)),
    mutate: (_lease, mutation) => {
      mutateStore(store, mutation);
      return Promise.resolve({ strategy: 'portable-anchored' });
    },
  });
}

function lease(
  coordinationKey: string,
  posture: 'normal' | 'init-recovery',
  release: () => void,
): RuntimeExclusiveLease {
  return Object.freeze({
    kind: 'runtime-exclusive',
    coordinationKey,
    posture,
    ownerToken: `${posture}-authored-recovery-owner-0001`,
    acquiredAt: 1,
    release,
  });
}

async function createHarness(plan: InitAuthoredPlan): Promise<AuthoredRecoveryHarness> {
  const root = projectRoot();
  const coordinationKey = projectCoordinationKey(root);
  const store: JournalStore = { content: undefined };
  let clock = 100;
  const now = (): number => ++clock;
  const normalLease = lease(coordinationKey, 'normal', () => undefined);
  const controller = controllerFor(normalLease, store, now);
  const allocation = controller.allocate((identity) =>
    createInitialRuntimePromotionJournal({
      coordinationKey,
      operationId: identity.operationId,
      recoveryOwnerToken: identity.recoveryOwnerToken,
      route: 'authored-only',
      destinationParentPreexisting: false,
      destinationRuntimePreexisting: false,
      destinationRootIdentity: null,
      source: {
        classification: 'none',
        cacheKey: null,
        generationDigest: null,
        markerSha256: null,
        rootIdentity: null,
      },
      inputs: {
        conflict: 'abort',
        authoredMode: 'fresh',
        languages: ['typescript'],
        languageExplicit: false,
      },
      plan: {
        authoredDigest: plan.digest,
        replayDigest: plan.replayManifestDigest,
        mutationCount: plan.mutations.length,
      },
      owned: createRuntimePromotionOwnedSlots(identity.operationId),
      createdAt: identity.createdAt,
    }),
  );
  const receipt = await controller.create(allocation);
  return {
    root,
    coordinationKey,
    store,
    normalLease,
    controller,
    receipt,
    released: { count: 0 },
    inspectManifest: vi.fn(() => {
      throw new Error('authored-only recovery must not inspect runtime defaults');
    }),
    now,
  };
}

function projectAuthority(harness: AuthoredRecoveryHarness) {
  return captureRuntimePromotionProjectRootAuthority({
    lease: harness.normalLease,
    projectRoot: harness.root,
    expectedPosture: 'normal',
  });
}

function currentJournal(harness: AuthoredRecoveryHarness): RuntimePromotionJournal {
  if (harness.store.content === undefined) throw new Error('journal is absent');
  return parseRuntimePromotionJournal(harness.store.content);
}

function recoveryDependencies(
  harness: AuthoredRecoveryHarness,
): Partial<RuntimePromotionRecoveryDependencies> {
  return {
    now: harness.now,
    canonicalizeProjectRoot: realpathSync,
    inspectHeader: () => {
      if (harness.store.content === undefined) return { status: 'absent' };
      const journal = parseRuntimePromotionJournal(harness.store.content);
      return {
        status: 'valid',
        operationId: journal.operationId,
        state: journal.state,
      };
    },
    acquireLease: () =>
      Promise.resolve(
        lease(harness.coordinationKey, 'init-recovery', () => {
          harness.released.count += 1;
        }),
      ),
    createController: (recoveryLease) => controllerFor(recoveryLease, harness.store, harness.now),
    checkpointDatastores: () => [],
    inspectManifest: harness.inspectManifest,
  };
}

async function recover(harness: AuthoredRecoveryHarness) {
  return recoverRuntimePromotion(
    {
      projectRoot: harness.root,
      datastoreLockContext: DATASTORE_LOCK_CONTEXT,
    },
    recoveryDependencies(harness),
  );
}

async function prepare(
  harness: AuthoredRecoveryHarness,
  plan: InitAuthoredPlan,
  checkpoint?: (checkpoint: AuthoredStateCheckpoint, cursor?: number) => void,
) {
  return prepareAuthoredState({
    projectRoot: harness.root,
    projectRootAuthority: projectAuthority(harness),
    lease: harness.normalLease,
    controller: harness.controller,
    receipt: harness.receipt,
    plan,
    dependencies: {
      now: harness.now,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    },
  });
}

function expectOwnedArtifactsAbsent(harness: AuthoredRecoveryHarness): void {
  const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
  for (const slot of ['authoredStage', 'authoredBackup', 'replayManifest'] as const) {
    expect(existsSync(join(harness.root, owned[slot].basename))).toBe(false);
  }
}

describe('runtime promotion recovery authored orchestration', () => {
  it('aborts an interrupted authored preparation and converges to an exact rollback', async () => {
    const plan = authoredPlan([
      {
        path: 'generated.txt',
        preimage: absent(),
        desired: fileState('durable-generated'),
        desiredContent: 'durable-generated',
      },
    ]);
    const harness = await createHarness(plan);

    await expect(
      prepare(harness, plan, (checkpoint) => {
        if (checkpoint === 'after-stage-materialization') {
          throw new Error('stop during authored preparation');
        }
      }),
    ).rejects.toThrow(/stop during authored preparation/iu);
    expect(currentJournal(harness).progress.pendingIntent?.kind).toBe('authored-prepare');

    const result = await recover(harness);

    expect(result).toMatchObject({
      status: 'rolled-back',
      sourcePreserved: false,
    });
    expect(existsSync(join(harness.root, 'generated.txt'))).toBe(false);
    expectOwnedArtifactsAbsent(harness);
    expect(harness.store.content).toBeUndefined();
    expect(harness.inspectManifest).not.toHaveBeenCalled();
    expect(harness.released.count).toBe(1);
  });

  it('resumes a partial authored target commit exclusively from durable replay bytes', async () => {
    const oldA = 'customer-a';
    const oldB = 'customer-b';
    const durableA = 'durable-a';
    const durableB = 'durable-b';
    const plan = authoredPlan([
      {
        path: 'a.txt',
        preimage: fileState(oldA),
        desired: fileState(durableA),
        preimageContent: oldA,
        desiredContent: durableA,
      },
      {
        path: 'b.txt',
        preimage: fileState(oldB),
        desired: fileState(durableB),
        preimageContent: oldB,
        desiredContent: durableB,
      },
    ]);
    const harness = await createHarness(plan);
    writeFileSync(join(harness.root, 'a.txt'), oldA, { mode: 0o600 });
    writeFileSync(join(harness.root, 'b.txt'), oldB, { mode: 0o600 });
    let armed = false;
    const prepared = await prepare(harness, plan, (checkpoint, cursor) => {
      if (armed && checkpoint === 'after-target-mutation' && cursor === 0) {
        throw new Error('stop after first authored target');
      }
    });
    const writer = createRuntimePromotionTransitionWriter(harness.controller, {
      now: harness.now,
    });
    const authoredPrepared = await writer.bindAuthoredPrepared(prepared.receipt);
    await bindAuthoredStateReceipt(prepared.transaction, authoredPrepared);
    armed = true;
    await expect(commitAuthoredState(prepared.transaction)).rejects.toThrow(
      /stop after first authored target/iu,
    );
    expect(readFileSync(join(harness.root, 'a.txt'), 'utf8')).toBe(durableA);
    expect(readFileSync(join(harness.root, 'b.txt'), 'utf8')).toBe(oldB);
    expect(currentJournal(harness).progress.pendingIntent?.kind).toBe('authored-target-commit');
    const freshPlanner = vi
      .spyOn(currentAuthoredPlan, 'createInitAuthoredPlan')
      .mockImplementation(() => {
        throw new Error('changed current defaults must not be rendered during recovery');
      });

    const result = await recover(harness);

    expect(result).toMatchObject({
      status: 'not-found',
      authored: { replaced: 2 },
    });
    expect(readFileSync(join(harness.root, 'a.txt'), 'utf8')).toBe(durableA);
    expect(readFileSync(join(harness.root, 'b.txt'), 'utf8')).toBe(durableB);
    expect(freshPlanner).not.toHaveBeenCalled();
    expect(harness.inspectManifest).not.toHaveBeenCalled();
    expectOwnedArtifactsAbsent(harness);
    expect(harness.store.content).toBeUndefined();
  });

  it('resumes a pending authored rollback and restores the exact recorded preimages', async () => {
    const oldA = 'preimage-a';
    const oldB = 'preimage-b';
    const plan = authoredPlan([
      {
        path: 'a.txt',
        preimage: fileState(oldA),
        desired: fileState('desired-a'),
        preimageContent: oldA,
        desiredContent: 'desired-a',
      },
      {
        path: 'b.txt',
        preimage: fileState(oldB),
        desired: fileState('desired-b'),
        preimageContent: oldB,
        desiredContent: 'desired-b',
      },
    ]);
    const harness = await createHarness(plan);
    writeFileSync(join(harness.root, 'a.txt'), oldA, { mode: 0o600 });
    writeFileSync(join(harness.root, 'b.txt'), oldB, { mode: 0o600 });
    let rollbackArmed = false;
    const prepared = await prepare(harness, plan, (checkpoint, cursor) => {
      if (rollbackArmed && checkpoint === 'after-target-mutation' && cursor === 1) {
        throw new Error('stop after first authored rollback target');
      }
    });
    const writer = createRuntimePromotionTransitionWriter(harness.controller, {
      now: harness.now,
    });
    let receipt = await writer.bindAuthoredPrepared(prepared.receipt);
    await bindAuthoredStateReceipt(prepared.transaction, receipt);
    const committed = await commitAuthoredState(prepared.transaction);
    receipt = await writer.beginRollback(committed.receipt);
    await bindAuthoredStateReceipt(prepared.transaction, receipt);
    rollbackArmed = true;
    await expect(rollbackAuthoredState(prepared.transaction)).rejects.toThrow(
      /stop after first authored rollback target/iu,
    );
    expect(currentJournal(harness).progress.pendingIntent?.kind).toBe('authored-target-rollback');

    const result = await recover(harness);

    expect(result).toMatchObject({
      status: 'rolled-back',
      sourcePreserved: false,
    });
    expect(readFileSync(join(harness.root, 'a.txt'), 'utf8')).toBe(oldA);
    expect(readFileSync(join(harness.root, 'b.txt'), 'utf8')).toBe(oldB);
    expectOwnedArtifactsAbsent(harness);
    expect(harness.store.content).toBeUndefined();
    expect(harness.inspectManifest).not.toHaveBeenCalled();
  });

  it.each([
    'missing replay manifest',
    'tampered replay manifest',
    'missing desired blob',
    'tampered desired blob',
  ] as const)(
    'returns recovery-required for a %s without consulting fresh plan or runtime defaults',
    async (corruption) => {
      const plan = authoredPlan([
        {
          path: 'generated.txt',
          preimage: absent(),
          desired: fileState('durable-generated'),
          desiredContent: 'durable-generated',
        },
      ]);
      const harness = await createHarness(plan);
      const prepared = await prepare(harness, plan);
      const writer = createRuntimePromotionTransitionWriter(harness.controller, {
        now: harness.now,
      });
      await writer.bindAuthoredPrepared(prepared.receipt);
      const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
      const replayManifest = join(harness.root, owned.replayManifest.basename);
      const desiredBlob = join(harness.root, owned.authoredStage.basename, 'desired', '0000.blob');
      switch (corruption) {
        case 'missing replay manifest': {
          unlinkSync(replayManifest);
          break;
        }
        case 'tampered replay manifest': {
          writeFileSync(replayManifest, '{}', { mode: 0o600 });
          break;
        }
        case 'missing desired blob': {
          unlinkSync(desiredBlob);
          break;
        }
        case 'tampered desired blob': {
          writeFileSync(desiredBlob, 'changed-current-default', {
            mode: 0o600,
          });
          break;
        }
      }
      const freshPlanner = vi
        .spyOn(currentAuthoredPlan, 'createInitAuthoredPlan')
        .mockImplementation(() => {
          throw new Error('fresh authored planning is forbidden during recovery');
        });

      const result = await recover(harness);

      expect(result).toMatchObject({ status: 'recovery-required' });
      expect(harness.store.content).toBeDefined();
      expect(currentJournal(harness).state).toBe('open');
      expect(existsSync(join(harness.root, 'generated.txt'))).toBe(false);
      expect(freshPlanner).not.toHaveBeenCalled();
      expect(harness.inspectManifest).not.toHaveBeenCalled();
      expect(harness.released.count).toBe(1);
    },
  );
});

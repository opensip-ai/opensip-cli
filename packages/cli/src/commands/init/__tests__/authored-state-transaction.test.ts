import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  anchoredRecordTemporaryBasename,
  RUNTIME_RECOVERY_RECORD_MAX_BYTES,
  type AnchoredRecordReadResult,
  type RuntimeExclusiveLease,
  type RuntimeRecoveryRecordMutation,
} from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  abortPendingAuthoredPreparation,
  bindAuthoredStateReceipt,
  cleanupAuthoredState,
  commitAuthoredState,
  loadAuthoredState,
  loadClosedAuthoredState,
  prepareAuthoredState,
  rollbackAuthoredState,
  verifyAuthoredState,
  type AuthoredStateCheckpoint,
} from '../authored-state-transaction.js';
import { directoryDigest, sha256Bytes } from '../init-authored-plan-types.js';
import {
  encodeAuthoredReplayManifest,
  type AuthoredReplayManifest,
  type InitAuthoredMutation,
  type InitAuthoredPathState,
  type InitAuthoredPlan,
} from '../init-authored-plan.js';
import {
  canonicalRuntimePromotionJournal,
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  type RuntimePromotionJournal,
} from '../runtime-promotion-journal-schema.js';
import {
  createRuntimePromotionJournalController,
  type AuthoredStateMaterializationAuthority,
  type DurableClosedPromotionJournal,
  type DurableOpenPromotionJournal,
  type PromotionJournalIdentity,
  type RuntimePromotionJournalController,
} from '../runtime-promotion-journal.js';

const PROJECT_KEY = 'a'.repeat(24);
const OPERATION_ID = 'authored-transaction-operation-0001';
const OWNER_TOKEN = 'authored-transaction-owner-000001';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opensip-authored-transaction-'));
  chmodSync(root, 0o700);
  temporaryRoots.push(root);
  return root;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fakeLease(key = PROJECT_KEY): RuntimeExclusiveLease {
  return {
    kind: 'runtime-exclusive',
    coordinationKey: key,
    posture: 'normal',
    ownerToken: OWNER_TOKEN,
    acquiredAt: 1,
    release: () => undefined,
  };
}

interface JournalStore {
  content: string | undefined;
}

function controllerFor(
  lease: RuntimeExclusiveLease,
  store: JournalStore,
): RuntimePromotionJournalController {
  let clock = 99;
  let recoveryOwnerSequence = 0;
  return createRuntimePromotionJournalController(lease, {
    now: () => ++clock,
    generateOperationId: () => OPERATION_ID,
    generateRecoveryOwnerToken: () =>
      `authored-transaction-owner-${(++recoveryOwnerSequence).toString().padStart(6, '0')}`,
    read: (): Promise<AnchoredRecordReadResult> =>
      Promise.resolve(
        store.content === undefined
          ? { status: 'absent' }
          : {
              status: 'present',
              content: store.content,
              sha256: sha256(store.content),
            },
      ),
    mutate: (
      _lease: RuntimeExclusiveLease,
      mutation: RuntimeRecoveryRecordMutation,
    ): Promise<void> => {
      if (mutation.operation === 'create') {
        if (store.content !== undefined) throw new Error('exists');
        store.content = mutation.content;
        return Promise.resolve();
      }
      if (mutation.operation === 'replace') {
        if (
          store.content === undefined ||
          sha256(store.content) !== mutation.expectedContentSha256
        ) {
          throw new Error('changed');
        }
        store.content = mutation.content;
        return Promise.resolve();
      }
      if (store.content === undefined || sha256(store.content) !== mutation.expectedContentSha256) {
        throw new Error('changed');
      }
      store.content = undefined;
      return Promise.resolve();
    },
  });
}

function absent(): InitAuthoredPathState {
  return { exists: false, type: null, mode: null, digest: null };
}

function fileState(content: string, mode = 0o600): InitAuthoredPathState {
  return {
    exists: true,
    type: 'file',
    mode,
    digest: sha256Bytes(content),
  };
}

function directoryState(mode = 0o700): InitAuthoredPathState {
  return {
    exists: true,
    type: 'directory',
    mode,
    digest: directoryDigest(mode),
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
  const mutations: InitAuthoredMutation[] = [...specifications]
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')),
    )
    .map((specification, sequence) => {
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
  const digest = sha256Bytes(
    Buffer.concat([
      Buffer.from('opensip-init-authored-plan\0v1\0', 'utf8'),
      Buffer.from(JSON.stringify(inputs), 'utf8'),
      Buffer.from('\0', 'utf8'),
      Buffer.from(replayManifestBytes, 'utf8'),
    ]),
  );
  return {
    inputs,
    mutations,
    replayManifest,
    replayManifestBytes,
    replayManifestDigest: sha256Bytes(replayManifestBytes),
    digest,
    aggregateBlobBytes,
    blobs: { desired, preimage },
  };
}

function initialJournal(
  identity: PromotionJournalIdentity,
  plan: InitAuthoredPlan,
): RuntimePromotionJournal {
  return createInitialRuntimePromotionJournal({
    coordinationKey: PROJECT_KEY,
    operationId: identity.operationId,
    recoveryOwnerToken: identity.recoveryOwnerToken,
    route: 'authored-only',
    destinationParentPreexisting: true,
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
      authoredDigest: plan.digest,
      replayDigest: plan.replayManifestDigest,
      mutationCount: plan.mutations.length,
    },
    owned: createRuntimePromotionOwnedSlots(identity.operationId),
    createdAt: identity.createdAt,
  });
}

async function createJournal(
  controller: RuntimePromotionJournalController,
  plan: InitAuthoredPlan,
): Promise<DurableOpenPromotionJournal> {
  const allocation = controller.allocate((identity) => initialJournal(identity, plan));
  return controller.create(allocation);
}

interface PreparedHarness {
  readonly root: string;
  readonly plan: InitAuthoredPlan;
  readonly lease: RuntimeExclusiveLease;
  readonly store: JournalStore;
  readonly controller: RuntimePromotionJournalController;
  readonly prepared: Awaited<ReturnType<typeof prepareAuthoredState>>;
}

async function prepareHarness(
  plan: InitAuthoredPlan,
  root = projectRoot(),
  checkpoint?: (checkpoint: AuthoredStateCheckpoint, cursor?: number) => void,
): Promise<PreparedHarness> {
  const lease = fakeLease();
  const store: JournalStore = { content: undefined };
  const controller = controllerFor(lease, store);
  const receipt = await createJournal(controller, plan);
  let now = 101;
  const prepared = await prepareAuthoredState({
    projectRoot: root,
    lease,
    controller,
    receipt,
    plan,
    dependencies: {
      now: () => now++,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    },
  });
  return { root, plan, lease, store, controller, prepared };
}

async function closeCommitted(
  controller: RuntimePromotionJournalController,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableClosedPromotionJournal> {
  let current = await controller.verifyOpen(receipt);
  const authorityVerified = canonicalRuntimePromotionJournal({
    ...current,
    revision: current.revision + 1,
    progress: { ...current.progress, phase: 'authority-verified' },
    timestamps: {
      ...current.timestamps,
      updatedAt: current.timestamps.updatedAt + 1,
    },
  });
  receipt = (await controller.replace(receipt, authorityVerified)) as DurableOpenPromotionJournal;
  current = await controller.verifyOpen(receipt);
  const committed = canonicalRuntimePromotionJournal({
    ...current,
    revision: current.revision + 1,
    progress: { ...current.progress, phase: 'committed' },
    terminal: {
      outcome: 'committed',
      authority: 'none',
      runtimeManifest: null,
      authoredVerified: true,
      sourcePreserved: false,
      verifiedAt: current.timestamps.updatedAt + 1,
    },
    timestamps: {
      ...current.timestamps,
      updatedAt: current.timestamps.updatedAt + 1,
    },
  });
  receipt = await controller.sealCommitted(receipt, committed);
  current = await controller.verifyOpen(receipt);
  const closedAt = current.timestamps.updatedAt + 1;
  const closed = canonicalRuntimePromotionJournal({
    ...current,
    state: 'closed',
    revision: current.revision + 1,
    progress: { ...current.progress, phase: 'closed', direction: 'cleanup' },
    timestamps: { ...current.timestamps, updatedAt: closedAt, closedAt },
  });
  return controller.close(receipt, closed);
}

describe('authored state transaction', () => {
  it('durably records preparation before creating any artifact', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    let sawDurableIntent = false;
    const harness = await prepareHarness(plan, root, (checkpoint) => {
      const hidden = createRuntimePromotionOwnedSlots(OPERATION_ID);
      const paths = [
        hidden.authoredStage.basename,
        hidden.authoredBackup.basename,
        hidden.replayManifest.basename,
      ].map((basename) => join(root, basename));
      if (checkpoint === 'before-prepare-intent') {
        expect(paths.some(existsSync)).toBe(false);
      }
      if (checkpoint === 'after-prepare-intent') {
        sawDurableIntent = true;
        expect(paths.some(existsSync)).toBe(false);
      }
      if (checkpoint === 'before-manifest-materialization') {
        expect(sawDurableIntent).toBe(true);
        expect(paths.some(existsSync)).toBe(false);
      }
    });

    expect(harness.prepared.summary).toMatchObject({
      total: 1,
      created: 1,
      completed: 0,
      verified: false,
    });
  });

  it('publishes replay manifests above the fixed recovery-record cap', async () => {
    const root = projectRoot();
    const specifications = Array.from({ length: 256 }, (_, index) => ({
      path: `generated-directory-${String(index).padStart(4, '0')}`,
      preimage: absent(),
      desired: directoryState(),
    }));
    const plan = authoredPlan(specifications);
    expect(Buffer.byteLength(plan.replayManifestBytes, 'utf8')).toBeGreaterThan(
      RUNTIME_RECOVERY_RECORD_MAX_BYTES,
    );

    const lease = fakeLease();
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan);
    const prepared = await prepareAuthoredState({
      projectRoot: root,
      lease,
      controller,
      receipt,
      plan,
      dependencies: { now: () => 101 },
    });

    expect(prepared.summary).toMatchObject({
      total: 256,
      completed: 0,
      verified: false,
    });
  });

  it('rejects wrong leases and forged, stale, or reused materialization authority', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const lease = fakeLease();
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan);

    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease: fakeLease(),
        controller,
        receipt,
        plan,
      }),
    ).rejects.toThrow(/controller-bound|another writer/iu);
    expect(readdirCustomerEntries(root)).toEqual([]);

    const openJournal = await controller.verifyOpen(receipt);
    const withIntent = canonicalRuntimePromotionJournal({
      ...openJournal,
      revision: 1,
      progress: {
        ...openJournal.progress,
        pendingIntent: {
          sequence: 1,
          kind: 'authored-prepare',
          slot: 'authoredStage',
          cursor: null,
          recordedAt: 101,
        },
      },
      counts: {
        ...openJournal.counts,
        intentCount: 1,
      },
      timestamps: {
        ...openJournal.timestamps,
        updatedAt: 101,
      },
    });
    const intentReceipt = await controller.recordIntent(receipt, withIntent);
    const staleAuthority = await controller.authorizeAuthoredState(intentReceipt, lease);
    const basenames = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const projection = {
      authoredStage: basenames.authoredStage.basename,
      authoredBackup: basenames.authoredBackup.basename,
      replayManifest: basenames.replayManifest.basename,
    };
    expect(() =>
      controller.assertAuthoredStateAuthority(
        {} as AuthoredStateMaterializationAuthority,
        projection,
      ),
    ).toThrow(/stale or foreign/iu);

    const handedOffReceipt = await controller.handoffRecoveryOwner(
      intentReceipt,
      (current, identity) =>
        canonicalRuntimePromotionJournal({
          ...current,
          revision: current.revision + 1,
          recoveryOwnerToken: identity.recoveryOwnerToken,
          recoveryAttempt: current.recoveryAttempt + 1,
          timestamps: {
            ...current.timestamps,
            updatedAt: identity.claimedAt,
          },
        }),
    );
    if (handedOffReceipt.state !== 'open') {
      throw new Error('expected an open handoff receipt');
    }
    expect(() => controller.assertAuthoredStateAuthority(staleAuthority, projection)).toThrow(
      /stale or foreign/iu,
    );

    const authority = await controller.authorizeAuthoredState(handedOffReceipt, lease);
    controller.assertAuthoredStateAuthority(authority, projection);
    expect(() => controller.assertAuthoredStateAuthority(authority, projection)).toThrow(
      /stale or foreign/iu,
    );
  });

  it('resumes a partial commit from stored evidence without rebuilding the plan', async () => {
    const root = projectRoot();
    writeFileSync(join(root, 'a.txt'), 'old-a', { mode: 0o600 });
    writeFileSync(join(root, 'b.txt'), 'old-b', { mode: 0o600 });
    const plan = authoredPlan([
      {
        path: 'a.txt',
        preimage: fileState('old-a'),
        desired: fileState('new-a'),
        preimageContent: 'old-a',
        desiredContent: 'new-a',
      },
      {
        path: 'b.txt',
        preimage: fileState('old-b'),
        desired: fileState('new-b'),
        preimageContent: 'old-b',
        desiredContent: 'new-b',
      },
    ]);
    let failed = false;
    const harness = await prepareHarness(plan, root, (checkpoint, cursor) => {
      if (!failed && checkpoint === 'after-target-mutation' && cursor === 0) {
        failed = true;
        throw new Error('simulated crash');
      }
    });
    await expect(commitAuthoredState(harness.prepared.transaction)).rejects.toThrow(
      /simulated crash/iu,
    );
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new-a');

    const recoveryLease = fakeLease();
    const recoveryController = controllerFor(recoveryLease, harness.store);
    const claimed = (await recoveryController.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
    const loaded = await loadAuthoredState({
      projectRoot: root,
      lease: recoveryLease,
      controller: recoveryController,
      receipt: claimed,
    });
    const result = await commitAuthoredState(loaded.transaction);

    expect(result.summary).toMatchObject({
      completed: 2,
      replaced: 2,
      verified: true,
    });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new-a');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('new-b');
  });

  it('removes an exact marker-owned partial preparation and rematerializes idempotently', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const lease = fakeLease();
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan);
    let crashed = false;
    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease,
        controller,
        receipt,
        plan,
        dependencies: {
          now: () => 101,
          checkpoint: (checkpoint) => {
            if (!crashed && checkpoint === 'after-stage-materialization') {
              crashed = true;
              throw new Error('stage crash');
            }
          },
        },
      }),
    ).rejects.toThrow(/stage crash/iu);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    expect(existsSync(join(root, owned.authoredStage.basename))).toBe(true);
    expect(existsSync(join(root, owned.authoredBackup.basename))).toBe(false);

    const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
    const resumed = await prepareAuthoredState({
      projectRoot: root,
      lease,
      controller,
      receipt: claimed,
      plan,
      dependencies: { now: () => 102 },
    });
    await expect(commitAuthoredState(resumed.transaction)).resolves.toMatchObject({
      summary: { completed: 1, verified: true },
    });
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('new');
  });

  it.each([
    'after-stage-root-mkdir',
    'after-stage-marker-open',
    'after-stage-marker-partial-write',
    'after-stage-marker-fsync',
    'after-stage-blob-directory-mkdir',
    'after-stage-blob-open',
    'after-stage-blob-partial-write',
    'after-stage-blob-fsync',
    'after-backup-root-mkdir',
    'after-backup-marker-open',
    'after-backup-marker-partial-write',
    'after-backup-marker-fsync',
    'after-backup-blob-directory-mkdir',
    'after-backup-blob-open',
    'after-backup-blob-partial-write',
    'after-backup-blob-fsync',
  ] as const)('recovers a pending authored preparation interrupted at %s', async (boundary) => {
    const root = projectRoot();
    writeFileSync(join(root, 'target.txt'), 'old', { mode: 0o600 });
    const plan = authoredPlan([
      {
        path: 'target.txt',
        preimage: fileState('old'),
        desired: fileState('new'),
        preimageContent: 'old',
        desiredContent: 'new',
      },
    ]);
    const lease = fakeLease();
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan);
    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease,
        controller,
        receipt,
        plan,
        dependencies: {
          now: () => 101,
          checkpoint: (checkpoint) => {
            if (checkpoint === boundary) {
              throw new Error('artifact materialization crash');
            }
          },
        },
      }),
    ).rejects.toThrow(/artifact materialization crash/iu);

    const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
    const resumed = await prepareAuthoredState({
      projectRoot: root,
      lease,
      controller,
      receipt: claimed,
      plan,
      dependencies: { now: () => 102 },
    });
    const committed = await commitAuthoredState(resumed.transaction);

    expect(committed.summary).toMatchObject({
      completed: 1,
      verified: true,
    });
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('new');
  });

  it('preserves and rejects unexpected entries in an ownerless interrupted root', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const lease = fakeLease();
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan);
    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease,
        controller,
        receipt,
        plan,
        dependencies: {
          now: () => 101,
          checkpoint: (checkpoint) => {
            if (checkpoint === 'after-stage-root-mkdir') {
              throw new Error('root crash');
            }
          },
        },
      }),
    ).rejects.toThrow(/root crash/iu);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const unexpected = join(root, owned.authoredStage.basename, 'unexpected.txt');
    writeFileSync(unexpected, 'customer', { mode: 0o600 });
    const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;

    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease,
        controller,
        receipt: claimed,
        plan,
        dependencies: { now: () => 102 },
      }),
    ).rejects.toThrow(/ownerless authored root has unexpected entries/iu);
    expect(readFileSync(unexpected, 'utf8')).toBe('customer');
  });

  it('bounds recovery enumeration of an attacker-inflated authored root', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const lease = fakeLease();
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan);
    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease,
        controller,
        receipt,
        plan,
        dependencies: {
          now: () => 101,
          checkpoint: (checkpoint) => {
            if (checkpoint === 'after-stage-root-mkdir') {
              throw new Error('root crash');
            }
          },
        },
      }),
    ).rejects.toThrow(/root crash/iu);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const stage = join(root, owned.authoredStage.basename);
    for (const name of ['one', 'two', 'three']) {
      writeFileSync(join(stage, name), name, { mode: 0o600 });
    }
    const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;

    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease,
        controller,
        receipt: claimed,
        plan,
        dependencies: { now: () => 102 },
      }),
    ).rejects.toThrow(/exceeds its entry bound/iu);
    expect(readdirSync(stage).sort()).toEqual(['one', 'three', 'two']);
  });

  it('preserves and rejects a non-prefix partial owner marker', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const lease = fakeLease();
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan);
    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease,
        controller,
        receipt,
        plan,
        dependencies: {
          now: () => 101,
          checkpoint: (checkpoint) => {
            if (checkpoint === 'after-stage-marker-partial-write') {
              throw new Error('marker crash');
            }
          },
        },
      }),
    ).rejects.toThrow(/marker crash/iu);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const marker = join(root, owned.authoredStage.basename, '.opensip-owner.json');
    writeFileSync(marker, 'foreign', { mode: 0o600 });
    const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;

    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease,
        controller,
        receipt: claimed,
        plan,
        dependencies: { now: () => 102 },
      }),
    ).rejects.toThrow(/not a canonical prefix/iu);
    expect(readFileSync(marker, 'utf8')).toBe('foreign');
  });

  it('preserves and rejects an unowned blob in an interrupted root', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const lease = fakeLease();
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan);
    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease,
        controller,
        receipt,
        plan,
        dependencies: {
          now: () => 101,
          checkpoint: (checkpoint) => {
            if (checkpoint === 'after-stage-blob-partial-write') {
              throw new Error('blob crash');
            }
          },
        },
      }),
    ).rejects.toThrow(/blob crash/iu);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const extra = join(root, owned.authoredStage.basename, 'desired', 'extra.blob');
    writeFileSync(extra, 'foreign', { mode: 0o600 });
    const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;

    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease,
        controller,
        receipt: claimed,
        plan,
        dependencies: { now: () => 102 },
      }),
    ).rejects.toThrow(/unowned blob|entry bound/iu);
    expect(readFileSync(extra, 'utf8')).toBe('foreign');
  });

  it.each([
    { window: 'pre-link temporary', linked: false, recovery: 'prepare' },
    { window: 'pre-link temporary', linked: false, recovery: 'abort' },
    { window: 'post-link temporary', linked: true, recovery: 'prepare' },
    { window: 'post-link temporary', linked: true, recovery: 'abort' },
  ] as const)(
    'settles a replay $window during $recovery recovery',
    async ({ linked, recovery }) => {
      const root = projectRoot();
      const plan = authoredPlan([
        {
          path: 'new.txt',
          preimage: absent(),
          desired: fileState('new'),
          desiredContent: 'new',
        },
      ]);
      const lease = fakeLease();
      const store: JournalStore = { content: undefined };
      const controller = controllerFor(lease, store);
      const receipt = await createJournal(controller, plan);
      await expect(
        prepareAuthoredState({
          projectRoot: root,
          lease,
          controller,
          receipt,
          plan,
          dependencies: {
            now: () => 101,
            checkpoint: (checkpoint) => {
              if (checkpoint === 'after-prepare-intent') {
                throw new Error('pre-publication crash');
              }
            },
          },
        }),
      ).rejects.toThrow(/pre-publication crash/iu);

      const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
      const replayBasename = owned.replayManifest.basename;
      const temporaryBasename = anchoredRecordTemporaryBasename(
        replayBasename,
        owned.replayManifest.ownershipId,
      );
      const temporary = join(root, temporaryBasename);
      const target = join(root, replayBasename);
      const bytes = linked
        ? plan.replayManifestBytes
        : plan.replayManifestBytes.slice(0, Math.floor(plan.replayManifestBytes.length / 2));
      writeFileSync(temporary, bytes, { mode: 0o600 });
      if (linked) {
        linkSync(temporary, target);
        expect(lstatSync(target).nlink).toBe(2);
      } else {
        expect(existsSync(target)).toBe(false);
      }

      const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
      if (recovery === 'prepare') {
        await prepareAuthoredState({
          projectRoot: root,
          lease,
          controller,
          receipt: claimed,
          plan,
          dependencies: { now: () => 102 },
        });
        expect(readFileSync(target, 'utf8')).toBe(plan.replayManifestBytes);
        expect(lstatSync(target).nlink).toBe(1);
      } else {
        await abortPendingAuthoredPreparation({
          projectRoot: root,
          lease,
          controller,
          receipt: claimed,
          dependencies: { now: () => 102 },
        });
        expect(existsSync(target)).toBe(false);
      }
      expect(existsSync(temporary)).toBe(false);
    },
  );

  it('preserves and rejects a foreign replay publication temporary', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const lease = fakeLease();
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan);
    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease,
        controller,
        receipt,
        plan,
        dependencies: {
          now: () => 101,
          checkpoint: (checkpoint) => {
            if (checkpoint === 'after-prepare-intent') {
              throw new Error('pre-publication crash');
            }
          },
        },
      }),
    ).rejects.toThrow(/pre-publication crash/iu);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const foreignBasename = anchoredRecordTemporaryBasename(
      owned.replayManifest.basename,
      'foreign-replay-create-identity-0001',
    );
    const foreign = join(root, foreignBasename);
    writeFileSync(foreign, 'customer', { mode: 0o600 });
    const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;

    await expect(
      prepareAuthoredState({
        projectRoot: root,
        lease,
        controller,
        receipt: claimed,
        plan,
        dependencies: { now: () => 102 },
      }),
    ).rejects.toThrow(/foreign replay publication temporary/iu);
    expect(readFileSync(foreign, 'utf8')).toBe('customer');
  });

  it.each([
    'after-prepare-intent',
    'after-replay-materialization',
    'after-stage-root-mkdir',
    'after-stage-marker-open',
    'after-stage-marker-partial-write',
    'after-stage-marker-fsync',
    'after-stage-blob-directory-mkdir',
    'after-stage-blob-open',
    'after-stage-blob-partial-write',
    'after-stage-blob-fsync',
    'after-stage-materialization',
    'after-backup-root-mkdir',
    'after-backup-marker-open',
    'after-backup-marker-partial-write',
    'after-backup-marker-fsync',
    'after-backup-blob-directory-mkdir',
    'after-backup-blob-open',
    'after-backup-blob-partial-write',
    'after-backup-blob-fsync',
    'after-backup-materialization',
  ] as const)(
    'aborts a restarted prepare at %s without an in-memory plan or renderer',
    async (boundary) => {
      const root = projectRoot();
      writeFileSync(join(root, 'target.txt'), 'old', { mode: 0o600 });
      const plan = authoredPlan([
        {
          path: 'target.txt',
          preimage: fileState('old'),
          desired: fileState('new'),
          preimageContent: 'old',
          desiredContent: 'new',
        },
      ]);
      const lease = fakeLease();
      const store: JournalStore = { content: undefined };
      const controller = controllerFor(lease, store);
      const receipt = await createJournal(controller, plan);
      await expect(
        prepareAuthoredState({
          projectRoot: root,
          lease,
          controller,
          receipt,
          plan,
          dependencies: {
            now: () => 101,
            checkpoint: (checkpoint) => {
              if (checkpoint === boundary) throw new Error('prepare crash');
            },
          },
        }),
      ).rejects.toThrow(/prepare crash/iu);

      const recoveryLease = fakeLease();
      const recoveryController = controllerFor(recoveryLease, store);
      const claimed = (await recoveryController.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
      const aborted = await abortPendingAuthoredPreparation({
        projectRoot: root,
        lease: recoveryLease,
        controller: recoveryController,
        receipt: claimed,
        dependencies: { now: () => 102 },
      });
      const journal = await recoveryController.verifyOpen(aborted.receipt);
      const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);

      expect(journal).toMatchObject({
        progress: {
          direction: 'rollback',
          phase: 'authored-rolled-back',
          authoredCursor: 0,
          rollbackCursor: 0,
          lastPostcondition: {
            kind: 'authored-prepare',
            outcome: 'aborted',
          },
        },
        cleanup: {
          authoredStage: 'unmaterialized',
          authoredBackup: 'unmaterialized',
          replayManifest: 'unmaterialized',
        },
      });
      expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('old');
      expect(existsSync(join(root, owned.authoredStage.basename))).toBe(false);
      expect(existsSync(join(root, owned.authoredBackup.basename))).toBe(false);
      expect(existsSync(join(root, owned.replayManifest.basename))).toBe(false);
      expect(aborted.summary).toMatchObject({
        completed: 0,
        rolledBack: 0,
        verified: true,
        actionsKnown: boundary !== 'after-prepare-intent',
      });
    },
  );

  it('resumes an abort after owned cleanup and aborted-postcondition crash windows', async () => {
    for (const abortBoundary of ['after-abort-cleanup', 'after-abort-postcondition'] as const) {
      const root = projectRoot();
      const plan = authoredPlan([
        {
          path: 'new.txt',
          preimage: absent(),
          desired: fileState('new'),
          desiredContent: 'new',
        },
      ]);
      const lease = fakeLease();
      const store: JournalStore = { content: undefined };
      const controller = controllerFor(lease, store);
      const receipt = await createJournal(controller, plan);
      await expect(
        prepareAuthoredState({
          projectRoot: root,
          lease,
          controller,
          receipt,
          plan,
          dependencies: {
            now: () => 101,
            checkpoint: (checkpoint) => {
              if (checkpoint === 'after-stage-materialization') {
                throw new Error('prepare crash');
              }
            },
          },
        }),
      ).rejects.toThrow(/prepare crash/iu);
      let claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
      await expect(
        abortPendingAuthoredPreparation({
          projectRoot: root,
          lease,
          controller,
          receipt: claimed,
          dependencies: {
            now: () => 102,
            checkpoint: (checkpoint) => {
              if (checkpoint === abortBoundary) throw new Error('abort crash');
            },
          },
        }),
      ).rejects.toThrow(/abort crash/iu);

      claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
      const resumed = await abortPendingAuthoredPreparation({
        projectRoot: root,
        lease,
        controller,
        receipt: claimed,
        dependencies: { now: () => 103 },
      });
      await expect(controller.verifyOpen(resumed.receipt)).resolves.toMatchObject({
        progress: { direction: 'rollback', phase: 'authored-rolled-back' },
      });
    }
  });

  it('commits directory-to-file changes children-first and rolls back exactly', async () => {
    const root = projectRoot();
    mkdirSync(join(root, 'tree'), { mode: 0o700 });
    writeFileSync(join(root, 'tree', 'child.txt'), 'child', { mode: 0o600 });
    const plan = authoredPlan([
      {
        path: 'tree',
        preimage: directoryState(),
        desired: fileState('replacement'),
        desiredContent: 'replacement',
      },
      {
        path: 'tree/child.txt',
        preimage: fileState('child'),
        desired: absent(),
        preimageContent: 'child',
      },
    ]);
    const harness = await prepareHarness(plan, root);
    const committed = await commitAuthoredState(harness.prepared.transaction);
    expect(readFileSync(join(root, 'tree'), 'utf8')).toBe('replacement');

    await rollbackAuthoredState(harness.prepared.transaction);
    expect(readFileSync(join(root, 'tree', 'child.txt'), 'utf8')).toBe('child');
    await expect(
      verifyAuthoredState(harness.prepared.transaction, 'preimage'),
    ).resolves.toMatchObject({ completed: 2, rolledBack: 2, verified: true });
    expect(committed.summary.completed).toBe(2);
  });

  it('advances zero-mutation commit and rollback phases explicitly', async () => {
    const harness = await prepareHarness(authoredPlan([]));
    const committed = await commitAuthoredState(harness.prepared.transaction);
    await expect(harness.controller.verifyOpen(committed.receipt)).resolves.toMatchObject({
      progress: { phase: 'authored-committed', authoredCursor: 0 },
    });
    const rolledBack = await rollbackAuthoredState(harness.prepared.transaction);
    await expect(harness.controller.verifyOpen(rolledBack.receipt)).resolves.toMatchObject({
      progress: {
        direction: 'rollback',
        phase: 'authored-rolled-back',
        rollbackCursor: 0,
      },
    });
  });

  it('fails before a target intent when its recorded preimage changed', async () => {
    const root = projectRoot();
    writeFileSync(join(root, 'target.txt'), 'old', { mode: 0o600 });
    const plan = authoredPlan([
      {
        path: 'target.txt',
        preimage: fileState('old'),
        desired: fileState('new'),
        preimageContent: 'old',
        desiredContent: 'new',
      },
    ]);
    const harness = await prepareHarness(plan, root);
    writeFileSync(join(root, 'target.txt'), 'customer-change', { mode: 0o600 });

    await expect(commitAuthoredState(harness.prepared.transaction)).rejects.toThrow(
      /changed before its write-ahead intent/iu,
    );
    const journal = await harness.controller.verifyOpen(harness.prepared.receipt);
    expect(journal.counts.intentCount).toBe(1);
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('customer-change');
  });

  it('fails closed on a tampered blob or replay manifest', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const harness = await prepareHarness(plan, root);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    writeFileSync(join(root, owned.authoredStage.basename, 'desired', '0000.blob'), 'tampered');
    await expect(commitAuthoredState(harness.prepared.transaction)).rejects.toThrow(
      /blob was changed/iu,
    );

    writeFileSync(join(root, owned.replayManifest.basename), '{}');
    const recoveryLease = fakeLease();
    const recoveryController = controllerFor(recoveryLease, harness.store);
    const claimed = (await recoveryController.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
    await expect(
      loadAuthoredState({
        projectRoot: root,
        lease: recoveryLease,
        controller: recoveryController,
        receipt: claimed,
      }),
    ).rejects.toThrow(/expected identity|replay manifest identity/iu);
  });

  it('cleans only exact journal-owned artifacts and preserves a changed owner marker', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const harness = await prepareHarness(plan, root);
    const committed = await commitAuthoredState(harness.prepared.transaction);
    const closed = await closeCommitted(harness.controller, committed.receipt);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const ownerMarker = join(root, owned.authoredStage.basename, '.opensip-owner.json');
    writeFileSync(ownerMarker, '{}');

    await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
      /owner marker/iu,
    );
    expect(existsSync(join(root, owned.authoredStage.basename))).toBe(true);
  });

  it('preserves a post-close blob whose digest or mode no longer matches', async () => {
    const root = projectRoot();
    writeFileSync(join(root, 'kept.txt'), 'same', { mode: 0o600 });
    const plan = authoredPlan([
      {
        path: 'kept.txt',
        preimage: fileState('same'),
        desired: fileState('same'),
        preimageContent: 'same',
        desiredContent: 'same',
      },
    ]);
    const harness = await prepareHarness(plan, root);
    const committed = await commitAuthoredState(harness.prepared.transaction);
    const closed = await closeCommitted(harness.controller, committed.receipt);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const blob = join(root, owned.authoredStage.basename, 'desired', '0000.blob');
    writeFileSync(blob, 'tampered', { mode: 0o600 });

    await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
      /incomplete authored blob is changed/iu,
    );
    expect(readFileSync(blob, 'utf8')).toBe('tampered');
  });

  it('bounds closed cleanup enumeration and preserves extra entries', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const harness = await prepareHarness(plan, root);
    const committed = await commitAuthoredState(harness.prepared.transaction);
    const closed = await closeCommitted(harness.controller, committed.receipt);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const stage = join(root, owned.authoredStage.basename);
    const extras = [join(stage, 'extra-one'), join(stage, 'extra-two')];
    for (const extra of extras) {
      writeFileSync(extra, 'customer', { mode: 0o600 });
    }

    await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
      /exceeds its entry bound/iu,
    );
    for (const extra of extras) {
      expect(readFileSync(extra, 'utf8')).toBe('customer');
    }
  });

  it('removes exact closed leftovers and supports receipt rebinding', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const harness = await prepareHarness(plan, root);
    await bindAuthoredStateReceipt(harness.prepared.transaction, harness.prepared.receipt);
    const committed = await commitAuthoredState(harness.prepared.transaction);
    const closed = await closeCommitted(harness.controller, committed.receipt);
    const result = await cleanupAuthoredState(harness.prepared.transaction, closed);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);

    expect(result.summary.verified).toBe(true);
    expect(existsSync(join(root, owned.authoredStage.basename))).toBe(false);
    expect(existsSync(join(root, owned.authoredBackup.basename))).toBe(false);
    expect(existsSync(join(root, owned.replayManifest.basename))).toBe(false);
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('new');
  });

  it('resumes cleanup after an authored stage was removed before its postcondition', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    let cleanupMutations = 0;
    const harness = await prepareHarness(plan, root, (checkpoint) => {
      if (checkpoint === 'after-cleanup-mutation' && cleanupMutations++ === 0) {
        throw new Error('cleanup crash');
      }
    });
    const committed = await commitAuthoredState(harness.prepared.transaction);
    const closed = await closeCommitted(harness.controller, committed.receipt);
    await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
      /cleanup crash/iu,
    );

    const recoveryLease = fakeLease();
    const recoveryController = controllerFor(recoveryLease, harness.store);
    const claimed = (await recoveryController.claim(OPERATION_ID)) as DurableClosedPromotionJournal;
    const transaction = await loadClosedAuthoredState({
      projectRoot: root,
      lease: recoveryLease,
      controller: recoveryController,
      receipt: claimed,
    });
    const result = await cleanupAuthoredState(transaction, claimed);
    expect(result.summary).toMatchObject({
      verified: true,
      actionsKnown: true,
    });
  });

  it('resumes cleanup after replay unlink without needing current renderers or bytes', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    let cleanupMutations = 0;
    const harness = await prepareHarness(plan, root, (checkpoint) => {
      if (checkpoint === 'after-cleanup-mutation') {
        cleanupMutations += 1;
        if (cleanupMutations === 3) throw new Error('replay cleanup crash');
      }
    });
    const committed = await commitAuthoredState(harness.prepared.transaction);
    const closed = await closeCommitted(harness.controller, committed.receipt);
    await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
      /replay cleanup crash/iu,
    );

    const recoveryLease = fakeLease();
    const recoveryController = controllerFor(recoveryLease, harness.store);
    const claimed = (await recoveryController.claim(OPERATION_ID)) as DurableClosedPromotionJournal;
    const transaction = await loadClosedAuthoredState({
      projectRoot: root,
      lease: recoveryLease,
      controller: recoveryController,
      receipt: claimed,
    });
    const result = await cleanupAuthoredState(transaction, claimed);
    expect(result.summary).toMatchObject({
      total: 1,
      verified: true,
      actionsKnown: false,
    });
  });
});

function readdirCustomerEntries(root: string): readonly string[] {
  return readdirSync(root);
}

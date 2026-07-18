import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  advanceAuthoredPhase,
  recordOpenIntent,
  recordOpenPostcondition,
} from '../authored-state-transaction-journal.js';
import {
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  encodeRuntimePromotionJournal,
  parseRuntimePromotionJournal,
  type RuntimeManifestIdentity,
  type RuntimePromotionJournal,
} from '../runtime-promotion-journal-schema.js';
import {
  createRuntimePromotionJournalController,
  type DurableClosedPromotionJournal,
  type DurableOpenPromotionJournal,
  type RuntimePromotionJournalController,
} from '../runtime-promotion-journal.js';
import {
  recoverRuntimePromotion,
  type RuntimePromotionRecoveryCheckpoint,
  type RuntimePromotionRecoveryDependencies,
} from '../runtime-promotion-recovery.js';
import {
  createRuntimePromotionTransitionWriter,
  type RuntimePromotionTransitionWriter,
} from '../runtime-promotion-transitions.js';

import type {
  AuthoredStateSummary,
  InitAuthoredTransaction,
} from '../authored-state-transaction.js';
import type { VerifiedRuntimeManifest } from '../runtime-manifest.js';
import type { RuntimePromotionFilesystemAuthority } from '../runtime-promotion-filesystem.js';
import type {
  AnchoredRecordReadResult,
  RuntimeExclusiveLease,
  RuntimeRecoveryRecordMutation,
} from '@opensip-cli/core';

const PROJECT_ROOT = '/canonical/open-recovery-project';
const PROJECT_KEY = 'a'.repeat(24);
const OPERATION_ID = 'runtime-promotion-open-matrix-operation';
const INITIAL_OWNER = 'runtime-promotion-open-matrix-owner';
const SOURCE_DIGEST = 'b'.repeat(64);
const DESTINATION_DIGEST = 'c'.repeat(64);
const AUTHORED_DIGEST = 'd'.repeat(64);
const REPLAY_DIGEST = 'e'.repeat(64);
const SOURCE_RUNTIME = `/ephemeral/projects/${PROJECT_KEY}`;
const DESTINATION_RUNTIME = `${PROJECT_ROOT}/opensip-cli/.runtime`;
const DATASTORE_LOCK_CONTEXT = {
  policy: { waitMs: 100, staleMs: 1000, heartbeatMs: 100 },
  command: 'opensip init',
  cwdBasename: 'open-recovery-project',
} as const;

const SUMMARY: AuthoredStateSummary = {
  total: 0,
  created: 0,
  replaced: 0,
  deleted: 0,
  preserved: 0,
  completed: 0,
  rolledBack: 0,
  verified: true,
  actionsKnown: true,
};

interface JournalStore {
  content: string | undefined;
  readonly mutations: RuntimeRecoveryRecordMutation[];
}

interface JournalBuilder {
  readonly store: JournalStore;
  readonly controller: RuntimePromotionJournalController;
  readonly writer: RuntimePromotionTransitionWriter;
  receipt: DurableOpenPromotionJournal;
}

interface FakeAuthoredState {
  readonly controller: RuntimePromotionJournalController;
  receipt: DurableOpenPromotionJournal | DurableClosedPromotionJournal;
}

interface RecoveryHarness {
  readonly store: JournalStore;
  readonly run: () => ReturnType<typeof recoverRuntimePromotion>;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function manifest(digest: string): RuntimeManifestIdentity {
  return {
    digest,
    fileCount: 0,
    directoryCount: 0,
    symlinkCount: 0,
    rootMode: 0o700,
    totalBytes: 0,
    sqlite: { status: 'absent' },
  };
}

const SOURCE_IDENTITY = manifest(SOURCE_DIGEST);
const DESTINATION_IDENTITY = manifest(DESTINATION_DIGEST);

function verified(identity: RuntimeManifestIdentity): VerifiedRuntimeManifest {
  return { identity, entries: [] };
}

function initialPromotion(destinationPreexisting: boolean): RuntimePromotionJournal {
  return createInitialRuntimePromotionJournal({
    coordinationKey: PROJECT_KEY,
    operationId: OPERATION_ID,
    recoveryOwnerToken: INITIAL_OWNER,
    route: 'promote-cache',
    destinationParentPreexisting: destinationPreexisting,
    destinationRuntimePreexisting: destinationPreexisting,
    destinationRootIdentity: destinationPreexisting ? { device: '1', inode: '2' } : null,
    source: {
      classification: 'legacy',
      cacheKey: PROJECT_KEY,
      generationDigest: null,
      markerSha256: SOURCE_DIGEST,
      rootIdentity: { device: '1', inode: '2' },
    },
    inputs: {
      conflict: 'use-cache',
      authoredMode: 'fresh',
      languages: ['typescript'],
      languageExplicit: false,
    },
    plan: {
      authoredDigest: AUTHORED_DIGEST,
      replayDigest: REPLAY_DIGEST,
      mutationCount: 0,
    },
    owned: createRuntimePromotionOwnedSlots(OPERATION_ID),
    createdAt: 100,
  });
}

function initialAuthoredOnly(): RuntimePromotionJournal {
  return createInitialRuntimePromotionJournal({
    coordinationKey: PROJECT_KEY,
    operationId: OPERATION_ID,
    recoveryOwnerToken: INITIAL_OWNER,
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
      authoredDigest: AUTHORED_DIGEST,
      replayDigest: REPLAY_DIGEST,
      mutationCount: 0,
    },
    owned: createRuntimePromotionOwnedSlots(OPERATION_ID),
    createdAt: 100,
  });
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
  store.mutations.push(mutation);
  if (mutation.operation === 'create') {
    if (store.content !== undefined) throw new Error('unexpected journal create collision');
    store.content = mutation.content;
    return;
  }
  if (store.content === undefined || sha256(store.content) !== mutation.expectedContentSha256) {
    throw new Error('unexpected journal compare-and-swap collision');
  }
  store.content = mutation.operation === 'replace' ? mutation.content : undefined;
}

function lease(ownerToken: string): RuntimeExclusiveLease {
  return Object.freeze({
    kind: 'runtime-exclusive',
    coordinationKey: PROJECT_KEY,
    posture: 'init-recovery',
    ownerToken,
    acquiredAt: 1,
    release: () => undefined,
  });
}

function controllerFor(
  store: JournalStore,
  ownerPrefix: string,
  initialNow = 200,
): RuntimePromotionJournalController {
  let now = initialNow;
  let owner = 0;
  return createRuntimePromotionJournalController(lease(`${ownerPrefix}-lease-owner-0001`), {
    now: () => ++now,
    generateRecoveryOwnerToken: () => `${ownerPrefix}-owner-${++owner}`.padEnd(24, '0'),
    read: () => Promise.resolve(readStore(store)),
    mutate: (_lease, mutation) => {
      mutateStore(store, mutation);
      return Promise.resolve({ strategy: 'portable-anchored' });
    },
  });
}

async function createBuilder(
  destinationPreexisting: boolean,
  initial: RuntimePromotionJournal = initialPromotion(destinationPreexisting),
): Promise<JournalBuilder> {
  const store = {
    content: encodeRuntimePromotionJournal(initial),
    mutations: [],
  } satisfies JournalStore;
  const controller = controllerFor(store, 'builder');
  return {
    store,
    controller,
    writer: createRuntimePromotionTransitionWriter(controller, {
      now: (() => {
        let value = 300;
        return () => ++value;
      })(),
    }),
    receipt: (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal,
  };
}

function storedJournal(store: JournalStore): RuntimePromotionJournal {
  if (store.content === undefined) throw new Error('expected a durable test journal');
  return parseRuntimePromotionJournal(store.content);
}

async function advanceToAuthoredPrepared(builder: JournalBuilder): Promise<void> {
  builder.receipt = await builder.writer.verifySource(builder.receipt, SOURCE_IDENTITY);
  builder.receipt = await builder.writer.verifyDestination(
    builder.receipt,
    storedJournal(builder.store).destinationRuntimePreexisting ? DESTINATION_IDENTITY : null,
  );
  builder.receipt = await recordOpenIntent(
    builder.controller,
    builder.receipt,
    'authored-prepare',
    'authoredStage',
    null,
    () => 310,
  );
  builder.receipt = await recordOpenPostcondition(
    builder.controller,
    builder.receipt,
    {
      phase: 'authored-prepared',
      outcome: 'applied',
      prepareArtifacts: true,
    },
    () => 311,
  );
}

async function advanceToDestinationReady(builder: JournalBuilder): Promise<void> {
  await advanceToAuthoredPrepared(builder);
  const journal = storedJournal(builder.store);
  if (journal.destinationParentPreexisting) {
    builder.receipt = await builder.writer.advancePreexistingDestinationReady(builder.receipt);
    return;
  }
  builder.receipt = await builder.writer.recordDestinationParentCreateIntent(builder.receipt);
  builder.receipt = await builder.writer.recordDestinationReady(builder.receipt, 'applied');
}

async function advanceToRuntimeStaged(builder: JournalBuilder): Promise<void> {
  await advanceToDestinationReady(builder);
  builder.receipt = await builder.writer.recordRuntimeStageCreateIntent(builder.receipt);
  builder.receipt = await builder.writer.recordRuntimeStaged(
    builder.receipt,
    'applied',
    SOURCE_IDENTITY,
  );
}

async function advanceToRuntimeInstalled(builder: JournalBuilder): Promise<void> {
  await advanceToRuntimeStaged(builder);
  if (storedJournal(builder.store).destinationRuntimePreexisting) {
    builder.receipt = await builder.writer.recordDestinationBackupCreateIntent(builder.receipt);
    builder.receipt = await builder.writer.recordDestinationBackedUp(builder.receipt, 'applied');
  }
  builder.receipt = await builder.writer.recordDestinationInstallIntent(builder.receipt);
  builder.receipt = await builder.writer.recordRuntimeInstalled(builder.receipt, 'applied');
}

async function destinationParentIntentJournal(): Promise<RuntimePromotionJournal> {
  const builder = await createBuilder(false);
  await advanceToAuthoredPrepared(builder);
  builder.receipt = await builder.writer.recordDestinationParentCreateIntent(builder.receipt);
  return storedJournal(builder.store);
}

async function runtimeStageIntentJournal(): Promise<RuntimePromotionJournal> {
  const builder = await createBuilder(true);
  await advanceToDestinationReady(builder);
  builder.receipt = await builder.writer.recordRuntimeStageCreateIntent(builder.receipt);
  return storedJournal(builder.store);
}

async function destinationBackupIntentJournal(): Promise<RuntimePromotionJournal> {
  const builder = await createBuilder(true);
  await advanceToRuntimeStaged(builder);
  builder.receipt = await builder.writer.recordDestinationBackupCreateIntent(builder.receipt);
  return storedJournal(builder.store);
}

async function destinationInstallIntentJournal(): Promise<RuntimePromotionJournal> {
  const builder = await createBuilder(false);
  await advanceToRuntimeStaged(builder);
  builder.receipt = await builder.writer.recordDestinationInstallIntent(builder.receipt);
  return storedJournal(builder.store);
}

async function sourceRetireIntentJournal(): Promise<RuntimePromotionJournal> {
  const builder = await createBuilder(false);
  await advanceToRuntimeInstalled(builder);
  builder.receipt = await advanceAuthoredPhase(
    builder.controller,
    builder.receipt,
    'authored-committed',
    () => 400,
  );
  builder.receipt = await builder.writer.recordSourceRetireIntent(builder.receipt);
  return storedJournal(builder.store);
}

async function runtimeRollbackIntentJournal(): Promise<RuntimePromotionJournal> {
  const builder = await createBuilder(false);
  await advanceToRuntimeStaged(builder);
  builder.receipt = await builder.writer.beginRollback(builder.receipt);
  builder.receipt = await builder.writer.recordRuntimeRollbackIntent(builder.receipt);
  return storedJournal(builder.store);
}

async function openRolledBackTerminalJournal(): Promise<RuntimePromotionJournal> {
  const builder = await createBuilder(false, initialAuthoredOnly());
  builder.receipt = await builder.writer.beginRollback(builder.receipt);
  builder.receipt = await builder.writer.recordUnmaterializedAuthoredRolledBack(builder.receipt);
  builder.receipt = await builder.writer.sealRolledBack(builder.receipt, null);
  return storedJournal(builder.store);
}

function createFakeTransaction(
  state: FakeAuthoredState,
  states: WeakMap<InitAuthoredTransaction, FakeAuthoredState>,
): InitAuthoredTransaction {
  const transaction = {
    operationId: OPERATION_ID,
    mutationCount: 0,
  } as InitAuthoredTransaction;
  states.set(transaction, state);
  return transaction;
}

function createHarness(
  journal: RuntimePromotionJournal,
  overrides: Partial<RuntimePromotionRecoveryDependencies> = {},
): RecoveryHarness {
  const store = {
    content: encodeRuntimePromotionJournal(journal),
    mutations: [],
  } satisfies JournalStore;
  const transactionStates = new WeakMap<InitAuthoredTransaction, FakeAuthoredState>();
  let clock = 1000;
  let leaseOwner = 0;
  let controllerOwner = 0;
  const now = (): number => ++clock;

  const dependencies: Partial<RuntimePromotionRecoveryDependencies> = {
    now,
    canonicalizeProjectRoot: () => PROJECT_ROOT,
    inspectHeader: () => {
      if (store.content === undefined) return { status: 'absent' };
      const current = storedJournal(store);
      return {
        status: 'valid',
        operationId: current.operationId,
        state: current.state,
      };
    },
    acquireLease: () =>
      Promise.resolve(
        Object.freeze({
          kind: 'runtime-exclusive',
          coordinationKey: PROJECT_KEY,
          posture: 'init-recovery',
          ownerToken: `matrix-lease-owner-${++leaseOwner}`.padEnd(24, '0'),
          acquiredAt: now(),
          release: () => undefined,
        }) satisfies RuntimeExclusiveLease,
      ),
    ephemeralProjectsDir: () => '/ephemeral/projects',
    assertSourceAuthority: () => undefined,
    assertSourceLocation: () => undefined,
    checkpointDatastores: () => [],
    createController: (recoveryLease) =>
      createRuntimePromotionJournalController(recoveryLease, {
        now,
        generateRecoveryOwnerToken: () =>
          `matrix-handoff-owner-${++controllerOwner}`.padEnd(32, '0'),
        read: () => Promise.resolve(readStore(store)),
        mutate: (_lease, mutation) => {
          mutateStore(store, mutation);
          return Promise.resolve({ strategy: 'portable-anchored' });
        },
      }),
    createWriter: (controller) =>
      createRuntimePromotionTransitionWriter(controller, {
        now,
      }),
    captureProjectRootAuthority: ({ lease: recoveryLease }) => ({
      version: 1,
      projectRoot: PROJECT_ROOT,
      coordinationKey: recoveryLease.coordinationKey,
      leasePosture: 'init-recovery',
      identity: { dev: '1', ino: '2', uid: '3', mode: String(0o4_0700) },
      destinationParent: null,
    }),
    assertProjectRootAuthority: () => undefined,
    assertDestinationRootAuthority: () => undefined,
    inspectManifest: () => verified(SOURCE_IDENTITY),
    classifyPath: () => ({ status: 'directory', mode: 0o700, owner: 'current' }),
    authorizeFilesystem: (input) =>
      Promise.resolve({
        operationId: OPERATION_ID,
        revision: input.receipt.revision,
        action: input.action,
      } as RuntimePromotionFilesystemAuthority),
    createDestinationParent: () => Promise.resolve({ status: 'created' }),
    reconcileStage: () => Promise.resolve({ status: 'absent' }),
    copyStage: () => Promise.resolve({ stage: verified(SOURCE_IDENTITY) }),
    backupDestination: () =>
      Promise.resolve({
        status: 'applied',
        manifest: verified(DESTINATION_IDENTITY),
      }),
    installStage: () =>
      Promise.resolve({
        status: 'applied',
        manifest: verified(SOURCE_IDENTITY),
      }),
    retireSource: () =>
      Promise.resolve({
        status: 'applied',
        manifest: verified(SOURCE_IDENTITY),
      }),
    rollbackRuntime: () =>
      Promise.resolve({
        status: 'rolled-back',
        runtimeInstallState: 'rolled-back',
        restored: null,
      }),
    cleanupOwnedSlot: () =>
      Promise.reject(new Error('the matrix fixture did not expect runtime owned cleanup')),
    loadAuthored: (input) => {
      const transaction = createFakeTransaction(
        { controller: input.controller, receipt: input.receipt },
        transactionStates,
      );
      return Promise.resolve({
        transaction,
        receipt: input.receipt,
        summary: SUMMARY,
      });
    },
    abortAuthoredPreparation: () =>
      Promise.reject(new Error('the matrix fixture did not expect authored prepare recovery')),
    bindAuthoredReceipt: (transaction, receipt) => {
      const state = transactionStates.get(transaction);
      if (state === undefined) throw new Error('unknown fake authored transaction');
      state.receipt = receipt;
      return Promise.resolve();
    },
    commitAuthored: async (transaction) => {
      const state = transactionStates.get(transaction);
      if (state?.receipt.state !== 'open') {
        throw new Error('unknown open fake authored transaction');
      }
      const receipt = await advanceAuthoredPhase(
        state.controller,
        state.receipt,
        'authored-committed',
        now,
      );
      state.receipt = receipt;
      return { receipt, summary: SUMMARY };
    },
    rollbackAuthored: async (transaction) => {
      const state = transactionStates.get(transaction);
      if (state?.receipt.state !== 'open') {
        throw new Error('unknown open fake authored transaction');
      }
      const receipt = await advanceAuthoredPhase(
        state.controller,
        state.receipt,
        'authored-rolled-back',
        now,
      );
      state.receipt = receipt;
      return { receipt, summary: SUMMARY };
    },
    verifyAuthored: () => Promise.resolve(SUMMARY),
    loadClosedAuthored: (input) =>
      Promise.resolve(
        createFakeTransaction(
          { controller: input.controller, receipt: input.receipt },
          transactionStates,
        ),
      ),
    cleanupAuthored: async (transaction, initialReceipt) => {
      const state = transactionStates.get(transaction);
      if (state === undefined) throw new Error('unknown closed fake authored transaction');
      const writer = createRuntimePromotionTransitionWriter(state.controller, { now });
      let receipt = initialReceipt;
      for (const slot of ['authoredStage', 'authoredBackup', 'replayManifest'] as const) {
        if (storedJournal(store).cleanup[slot] !== 'pending') continue;
        receipt = await writer.recordCleanupIntent(receipt, slot);
        receipt = await writer.recordCleanupPostcondition(receipt, slot, 'applied');
      }
      state.receipt = receipt;
      return { receipt, summary: SUMMARY };
    },
    ...overrides,
  };

  return {
    store,
    run: () =>
      recoverRuntimePromotion(
        {
          projectRoot: PROJECT_ROOT,
          datastoreLockContext: DATASTORE_LOCK_CONTEXT,
        },
        dependencies,
      ),
  };
}

function stopAfterIntentReconciliation(): {
  readonly checkpoint: (checkpoint: RuntimePromotionRecoveryCheckpoint) => void;
} {
  let stopped = false;
  return {
    checkpoint: (checkpoint) => {
      if (!stopped && checkpoint === 'after-open-intent-reconciled') {
        stopped = true;
        throw new Error('stop after reconciling the selected open intent');
      }
    },
  };
}

describe('runtime promotion open recovery intent matrix', () => {
  it('replays datastore checkpointing from the durable prepared state before advancing', async () => {
    const checkpointDatastores = vi.fn(() => []);
    const harness = createHarness(initialPromotion(true), {
      checkpointDatastores,
      checkpoint: (checkpoint) => {
        if (checkpoint === 'after-datastore-checkpoint') {
          throw new Error('stop after durable datastore replay');
        }
      },
    });

    await expect(harness.run()).resolves.toMatchObject({ status: 'recovery-required' });

    expect(checkpointDatastores).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          { kind: 'source', runtimeDir: SOURCE_RUNTIME },
          { kind: 'destination', runtimeDir: DESTINATION_RUNTIME },
        ],
        lockContext: DATASTORE_LOCK_CONTEXT,
      }),
    );
    expect(storedJournal(harness.store).progress).toMatchObject({
      phase: 'prepared',
      pendingIntent: null,
    });
  });

  it('reconciles destination-parent creation from its durable intent', async () => {
    const createDestinationParent = vi.fn(() => Promise.resolve({ status: 'created' as const }));
    const harness = createHarness(await destinationParentIntentJournal(), {
      ...stopAfterIntentReconciliation(),
      createDestinationParent,
    });

    await expect(harness.run()).resolves.toMatchObject({ status: 'recovery-required' });

    expect(createDestinationParent).toHaveBeenCalledOnce();
    expect(storedJournal(harness.store)).toMatchObject({
      progress: {
        phase: 'destination-ready',
        pendingIntent: null,
        lastPostcondition: {
          kind: 'destination-parent-create',
          outcome: 'applied',
        },
      },
      cleanup: { destinationParent: 'pending' },
    });
  });

  it.each([
    { side: 'absent stage', status: 'absent' as const, outcome: 'applied', copied: true },
    {
      side: 'already materialized stage',
      status: 'verified' as const,
      outcome: 'already-satisfied',
      copied: false,
    },
  ])(
    'reconciles runtime-stage creation from the $side side of the intent',
    async ({ status, outcome, copied }) => {
      const reconcileStage = vi.fn(() =>
        Promise.resolve(
          status === 'absent'
            ? ({ status } as const)
            : ({ status, manifest: verified(SOURCE_IDENTITY) } as const),
        ),
      );
      const copyStage = vi.fn(() =>
        Promise.resolve({
          stage: verified(SOURCE_IDENTITY),
        }),
      );
      const harness = createHarness(await runtimeStageIntentJournal(), {
        ...stopAfterIntentReconciliation(),
        reconcileStage,
        copyStage,
      });

      await expect(harness.run()).resolves.toMatchObject({ status: 'recovery-required' });

      expect(reconcileStage).toHaveBeenCalledOnce();
      expect(copyStage).toHaveBeenCalledTimes(copied ? 1 : 0);
      expect(storedJournal(harness.store)).toMatchObject({
        manifests: { runtimeStage: SOURCE_IDENTITY },
        progress: {
          phase: 'runtime-staged',
          pendingIntent: null,
          lastPostcondition: {
            kind: 'runtime-stage-create',
            outcome,
          },
        },
        cleanup: { runtimeStage: 'pending' },
      });
    },
  );

  it('reconciles destination backup creation against the recorded destination manifest', async () => {
    const backupDestination = vi.fn(() =>
      Promise.resolve({
        status: 'already-applied' as const,
        manifest: verified(DESTINATION_IDENTITY),
      }),
    );
    const harness = createHarness(await destinationBackupIntentJournal(), {
      ...stopAfterIntentReconciliation(),
      backupDestination,
    });

    await expect(harness.run()).resolves.toMatchObject({ status: 'recovery-required' });

    expect(backupDestination).toHaveBeenCalledWith(expect.anything(), DESTINATION_IDENTITY);
    expect(storedJournal(harness.store)).toMatchObject({
      progress: {
        phase: 'destination-backed-up',
        pendingIntent: null,
        lastPostcondition: {
          kind: 'destination-backup-create',
          outcome: 'already-satisfied',
        },
      },
      cleanup: { destinationBackup: 'pending' },
    });
  });

  it.each([
    { side: 'before rename', status: 'applied' as const, outcome: 'applied' },
    {
      side: 'after rename',
      status: 'already-applied' as const,
      outcome: 'already-satisfied',
    },
  ])(
    'reconciles destination install when recovery observes the $side side',
    async ({ status, outcome }) => {
      const installStage = vi.fn(() =>
        Promise.resolve({
          status,
          manifest: verified(SOURCE_IDENTITY),
        }),
      );
      const harness = createHarness(await destinationInstallIntentJournal(), {
        ...stopAfterIntentReconciliation(),
        installStage,
      });

      await expect(harness.run()).resolves.toMatchObject({ status: 'recovery-required' });

      expect(installStage).toHaveBeenCalledWith(expect.anything(), SOURCE_IDENTITY);
      expect(storedJournal(harness.store)).toMatchObject({
        progress: {
          phase: 'runtime-installed',
          runtimeInstallState: 'installed',
          pendingIntent: null,
          lastPostcondition: {
            kind: 'destination-install',
            outcome,
          },
        },
        cleanup: {
          destinationParent: 'pending',
          runtimeStage: 'removed',
        },
      });
    },
  );

  it.each([
    { side: 'source side', status: 'applied' as const, outcome: 'applied' },
    {
      side: 'tombstone side',
      status: 'already-applied' as const,
      outcome: 'already-satisfied',
    },
  ])('reconciles source retirement from the $side of its rename', async ({ status, outcome }) => {
    const retireSource = vi.fn(() =>
      Promise.resolve({
        status,
        manifest: verified(SOURCE_IDENTITY),
      }),
    );
    const harness = createHarness(await sourceRetireIntentJournal(), {
      ...stopAfterIntentReconciliation(),
      retireSource,
    });

    await expect(harness.run()).resolves.toMatchObject({ status: 'recovery-required' });

    expect(retireSource).toHaveBeenCalledWith(expect.anything(), SOURCE_IDENTITY);
    expect(storedJournal(harness.store)).toMatchObject({
      progress: {
        phase: 'source-retired',
        pendingIntent: null,
        lastPostcondition: {
          kind: 'source-retire',
          outcome,
        },
      },
      cleanup: { sourceTombstone: 'pending' },
    });
  });

  it('converges rollback after creating a previously absent destination parent', async () => {
    const rollbackRuntime = vi.fn(() =>
      Promise.resolve({
        status: 'rolled-back' as const,
        runtimeInstallState: 'rolled-back' as const,
        restored: null,
      }),
    );
    const harness = createHarness(await runtimeRollbackIntentJournal(), {
      rollbackRuntime,
    });

    await expect(harness.run()).resolves.toMatchObject({
      status: 'rolled-back',
      sourcePreserved: true,
    });

    expect(rollbackRuntime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        installedWasAuthoritative: false,
        backup: null,
      }),
    );
    expect(harness.store.content).toBeUndefined();
    expect(harness.store.mutations.filter(({ operation }) => operation === 'unlink')).toHaveLength(
      1,
    );
  });

  it('closes terminal truth once and converges idempotently across cleanup restarts', async () => {
    const stops: RuntimePromotionRecoveryCheckpoint[] = [
      'after-terminal-close',
      'before-journal-unlink',
    ];
    const harness = createHarness(await openRolledBackTerminalJournal(), {
      checkpoint: (checkpoint) => {
        if (checkpoint === stops[0]) {
          stops.shift();
          throw new Error(`restart at ${checkpoint}`);
        }
      },
    });

    await expect(harness.run()).resolves.toMatchObject({
      status: 'rolled-back',
      cleanupPending: true,
      reasonCode: 'operation-failed',
    });
    expect(storedJournal(harness.store)).toMatchObject({
      state: 'closed',
      terminal: { outcome: 'rolled-back', authority: 'none' },
    });

    await expect(harness.run()).resolves.toMatchObject({
      status: 'rolled-back',
      cleanupPending: true,
      reasonCode: 'operation-failed',
    });
    expect(storedJournal(harness.store)).toMatchObject({
      state: 'closed',
      terminal: { outcome: 'rolled-back', authority: 'none' },
    });

    await expect(harness.run()).resolves.toMatchObject({
      status: 'rolled-back',
      sourcePreserved: false,
    });
    expect(harness.store.content).toBeUndefined();
    expect(harness.store.mutations.filter(({ operation }) => operation === 'unlink')).toHaveLength(
      1,
    );
  });
});

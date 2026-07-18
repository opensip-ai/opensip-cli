import { createHash } from 'node:crypto';

import {
  type AnchoredRecordReadResult,
  type RuntimeExclusiveLease,
  type RuntimeRecoveryRecordMutation,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import {
  advanceAuthoredPhase,
  recordOpenIntent,
  recordOpenPostcondition,
} from '../authored-state-transaction-journal.js';
import {
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  type RuntimeManifestIdentity,
  type RuntimePromotionJournal,
  type RuntimePromotionOwnedSlotName,
  type RuntimePromotionRoute,
} from '../runtime-promotion-journal-schema.js';
import {
  createRuntimePromotionJournalController,
  type DurableClosedPromotionJournal,
  type DurableOpenPromotionJournal,
  type RuntimePromotionJournalControllerDependencies,
} from '../runtime-promotion-journal.js';
import {
  createRuntimePromotionTransitionWriter,
  type RuntimePromotionTransitionWriter,
} from '../runtime-promotion-transitions.js';

const PROJECT_KEY = 'a'.repeat(24);
const SOURCE_DIGEST = 'a'.repeat(64);
const DESTINATION_DIGEST = 'b'.repeat(64);
const REPLAY_DIGEST = 'c'.repeat(64);
const AUTHORED_DIGEST = 'd'.repeat(64);

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function manifest(digest: string): RuntimeManifestIdentity {
  return {
    digest,
    fileCount: 1,
    directoryCount: 1,
    symlinkCount: 0,
    rootMode: 0o700,
    totalBytes: 8,
    sqlite: {
      status: 'verified',
      sha256: 'e'.repeat(64),
      userVersion: 4,
    },
  };
}

interface RouteOptions {
  readonly destinationParentPreexisting?: boolean;
  readonly destinationRuntimePreexisting?: boolean;
  readonly mutationCount?: number;
}

function conflictForRoute(route: RuntimePromotionRoute): 'abort' | 'keep-project' | 'use-cache' {
  if (route === 'keep-project') return 'keep-project';
  return route === 'promote-cache' ? 'use-cache' : 'abort';
}

function initialForRoute(
  route: RuntimePromotionRoute,
  identity: {
    readonly operationId: string;
    readonly recoveryOwnerToken: string;
    readonly createdAt: number;
  },
  options: RouteOptions = {},
): RuntimePromotionJournal {
  const sourcePresent = ['promote-cache', 'keep-project', 'deduplicate-cache'].includes(route);
  const destinationRuntimePreexisting =
    options.destinationRuntimePreexisting ??
    ['project-authority', 'keep-project', 'deduplicate-cache'].includes(route);
  const destinationParentPreexisting =
    options.destinationParentPreexisting ?? destinationRuntimePreexisting;
  return createInitialRuntimePromotionJournal({
    coordinationKey: PROJECT_KEY,
    operationId: identity.operationId,
    recoveryOwnerToken: identity.recoveryOwnerToken,
    route,
    destinationParentPreexisting,
    destinationRuntimePreexisting,
    destinationRootIdentity: destinationRuntimePreexisting ? { device: '1', inode: '2' } : null,
    source: sourcePresent
      ? {
          classification: 'generation-bound',
          cacheKey: 'f'.repeat(24),
          generationDigest: '1'.repeat(64),
          markerSha256: '2'.repeat(64),
          rootIdentity: { device: '1', inode: '2' },
        }
      : {
          classification: 'none',
          cacheKey: null,
          generationDigest: null,
          markerSha256: null,
          rootIdentity: null,
        },
    inputs: {
      conflict: conflictForRoute(route),
      authoredMode: 'fresh',
      languages: ['typescript'],
      languageExplicit: false,
    },
    plan: {
      authoredDigest: AUTHORED_DIGEST,
      replayDigest: REPLAY_DIGEST,
      mutationCount: options.mutationCount ?? 0,
    },
    owned: createRuntimePromotionOwnedSlots(identity.operationId),
    createdAt: identity.createdAt,
  });
}

interface TransitionHarness {
  readonly controller: ReturnType<typeof createRuntimePromotionJournalController>;
  readonly writer: RuntimePromotionTransitionWriter;
  readonly now: () => number;
  readonly mutations: RuntimeRecoveryRecordMutation[];
  readonly create: (
    route: RuntimePromotionRoute,
    options?: RouteOptions,
  ) => Promise<DurableOpenPromotionJournal>;
}

function createHarness(): TransitionHarness {
  let content: string | undefined;
  let clock = 100;
  const now = (): number => ++clock;
  const mutations: RuntimeRecoveryRecordMutation[] = [];
  const lease = Object.freeze({
    kind: 'runtime-exclusive',
    coordinationKey: PROJECT_KEY,
    posture: 'normal',
    ownerToken: 'transition-lease-owner-0000001',
    acquiredAt: 1,
    release: () => undefined,
  }) satisfies RuntimeExclusiveLease;
  const read = (): AnchoredRecordReadResult =>
    content === undefined
      ? { status: 'absent' }
      : { status: 'present', content, sha256: sha256(content) };
  const dependencies: RuntimePromotionJournalControllerDependencies = {
    now,
    generateOperationId: () => 'transition-operation-0000001',
    generateRecoveryOwnerToken: () => 'transition-recovery-owner-000001',
    read: (actualLease) => {
      expect(actualLease).toBe(lease);
      return Promise.resolve(read());
    },
    mutate: (actualLease, mutation) => {
      expect(actualLease).toBe(lease);
      mutations.push(mutation);
      if (mutation.operation === 'create') {
        if (content !== undefined) throw new Error('exclusive create conflict');
        content = mutation.content;
      } else if (mutation.operation === 'replace') {
        if (content === undefined || sha256(content) !== mutation.expectedContentSha256) {
          throw new Error('replace compare-and-swap conflict');
        }
        content = mutation.content;
      } else {
        if (content === undefined || sha256(content) !== mutation.expectedContentSha256) {
          throw new Error('unlink compare-and-swap conflict');
        }
        content = undefined;
      }
      return Promise.resolve({ strategy: 'portable-anchored' });
    },
  };
  const controller = createRuntimePromotionJournalController(lease, dependencies);
  return {
    controller,
    writer: createRuntimePromotionTransitionWriter(controller, { now }),
    now,
    mutations,
    create: async (route, options) => {
      const allocation = controller.allocate((identity) =>
        initialForRoute(route, identity, options),
      );
      return controller.create(allocation);
    },
  };
}

async function prepareAuthored(
  harness: TransitionHarness,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  receipt = await recordOpenIntent(
    harness.controller,
    receipt,
    'authored-prepare',
    'authoredStage',
    null,
    harness.now,
  );
  receipt = await recordOpenPostcondition(
    harness.controller,
    receipt,
    {
      phase: 'authored-prepared',
      outcome: 'applied',
      prepareArtifacts: true,
    },
    harness.now,
  );
  return harness.writer.bindAuthoredPrepared(receipt);
}

async function commitAuthored(
  harness: TransitionHarness,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  receipt = await advanceAuthoredPhase(
    harness.controller,
    receipt,
    'authored-committed',
    harness.now,
  );
  return harness.writer.bindAuthoredCommitted(receipt);
}

async function verifyRouteInputs(
  harness: TransitionHarness,
  route: RuntimePromotionRoute,
  receipt: DurableOpenPromotionJournal,
  destination: RuntimeManifestIdentity | null,
): Promise<DurableOpenPromotionJournal> {
  if (['promote-cache', 'keep-project', 'deduplicate-cache'].includes(route)) {
    receipt = await harness.writer.verifySource(receipt, manifest(SOURCE_DIGEST));
  }
  if (route !== 'authored-only') {
    receipt = await harness.writer.verifyDestination(receipt, destination);
  }
  return receipt;
}

async function installPromotedRuntime(
  harness: TransitionHarness,
  receipt: DurableOpenPromotionJournal,
  destinationPreexisting: boolean,
): Promise<DurableOpenPromotionJournal> {
  const before = await harness.controller.verifyOpen(receipt);
  if (before.destinationParentPreexisting) {
    receipt = await harness.writer.advancePreexistingDestinationReady(receipt);
  } else {
    receipt = await harness.writer.recordDestinationParentCreateIntent(receipt);
    receipt = await harness.writer.recordDestinationReady(receipt, 'applied');
  }
  receipt = await harness.writer.recordRuntimeStageCreateIntent(receipt);
  receipt = await harness.writer.recordRuntimeStaged(receipt, 'applied', manifest(SOURCE_DIGEST));
  if (destinationPreexisting) {
    receipt = await harness.writer.recordDestinationBackupCreateIntent(receipt);
    receipt = await harness.writer.recordDestinationBackedUp(receipt, 'applied');
  }
  receipt = await harness.writer.recordDestinationInstallIntent(receipt);
  return harness.writer.recordRuntimeInstalled(receipt, 'applied');
}

async function retireSource(
  harness: TransitionHarness,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  receipt = await harness.writer.recordSourceRetireIntent(receipt);
  return harness.writer.recordSourceRetired(receipt, 'applied');
}

const CLEANUP_ORDER: readonly RuntimePromotionOwnedSlotName[] = [
  'runtimeStage',
  'destinationBackup',
  'sourceTombstone',
  'authoredStage',
  'authoredBackup',
  'replayManifest',
  'destinationParent',
];

async function cleanupAndUnlink(
  harness: TransitionHarness,
  receipt: DurableClosedPromotionJournal,
): Promise<RuntimePromotionJournal> {
  let current = await harness.controller.verifyReceipt(receipt, {
    state: 'closed',
  });
  for (const slot of CLEANUP_ORDER) {
    if (current.cleanup[slot] !== 'pending') continue;
    receipt = await harness.writer.recordCleanupIntent(receipt, slot);
    receipt = await harness.writer.recordCleanupPostcondition(receipt, slot, 'already-satisfied');
    current = await harness.controller.verifyReceipt(receipt, {
      state: 'closed',
    });
  }
  await harness.writer.unlinkClean(receipt);
  return current;
}

function committedAuthorityForRoute(
  route: RuntimePromotionRoute,
  destination: RuntimeManifestIdentity | null,
): RuntimeManifestIdentity | null {
  if (route === 'authored-only') return null;
  return route === 'promote-cache' ? manifest(SOURCE_DIGEST) : destination;
}

function rolledBackAuthorityForRoute(
  route: RuntimePromotionRoute,
  destination: RuntimeManifestIdentity | null,
): RuntimeManifestIdentity | null {
  if (route === 'authored-only') return null;
  return route === 'promote-cache' ? manifest(SOURCE_DIGEST) : destination;
}

describe('runtime promotion typed transitions', () => {
  it.each([
    ['authored-only', null],
    ['project-authority', DESTINATION_DIGEST],
    ['promote-cache', null],
    ['keep-project', DESTINATION_DIGEST],
    ['deduplicate-cache', SOURCE_DIGEST],
  ] as const)(
    'commits and cleans the %s route without raw journal assembly',
    async (route, digest) => {
      const harness = createHarness();
      const destination = digest === null ? null : manifest(digest);
      let receipt = await harness.create(route);
      receipt = await verifyRouteInputs(harness, route, receipt, destination);
      receipt = await prepareAuthored(harness, receipt);
      if (route === 'promote-cache') {
        receipt = await installPromotedRuntime(harness, receipt, false);
      }
      receipt = await commitAuthored(harness, receipt);
      if (['promote-cache', 'keep-project', 'deduplicate-cache'].includes(route)) {
        receipt = await retireSource(harness, receipt);
      }
      const authority = committedAuthorityForRoute(route, destination);
      receipt = await harness.writer.recordAuthorityVerified(receipt, authority);
      receipt = await harness.writer.sealCommitted(receipt);
      const terminal = await harness.controller.verifyOpen(receipt);
      expect(terminal.terminal).toEqual({
        outcome: 'committed',
        authority: route === 'authored-only' ? 'none' : 'project',
        runtimeManifest: authority,
        authoredVerified: true,
        sourcePreserved: false,
        verifiedAt: terminal.timestamps.updatedAt,
      });
      const closed = await harness.writer.close(receipt);
      const cleaned = await cleanupAndUnlink(harness, closed);
      expect(Object.values(cleaned.cleanup)).not.toContain('pending');
      expect(cleaned.counts.cleanupCompleted).toBe(
        Object.values(cleaned.cleanup).filter((state) => state === 'removed').length -
          (route === 'promote-cache' ? 1 : 0),
      );
      expect(harness.mutations.at(-1)?.operation).toBe('unlink');
    },
  );

  it('records destination-parent creation before a source-only install', async () => {
    const harness = createHarness();
    let receipt = await harness.create('promote-cache', {
      destinationParentPreexisting: false,
      destinationRuntimePreexisting: false,
    });
    receipt = await verifyRouteInputs(harness, 'promote-cache', receipt, null);
    receipt = await prepareAuthored(harness, receipt);
    receipt = await harness.writer.recordDestinationParentCreateIntent(receipt);
    let current = await harness.controller.verifyOpen(receipt);
    expect(current.progress.pendingIntent).toMatchObject({
      kind: 'destination-parent-create',
      slot: 'destinationParent',
    });
    expect(current.cleanup.destinationParent).toBe('unmaterialized');
    receipt = await harness.writer.recordDestinationReady(receipt, 'already-satisfied');
    current = await harness.controller.verifyOpen(receipt);
    expect(current).toMatchObject({
      progress: { phase: 'destination-ready', pendingIntent: null },
      cleanup: { destinationParent: 'pending' },
    });
  });

  it('restores a preinstall destination backup before authored rollback', async () => {
    const harness = createHarness();
    const destination = manifest(DESTINATION_DIGEST);
    let receipt = await harness.create('promote-cache', {
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: true,
    });
    receipt = await verifyRouteInputs(harness, 'promote-cache', receipt, destination);
    receipt = await prepareAuthored(harness, receipt);
    receipt = await harness.writer.advancePreexistingDestinationReady(receipt);
    receipt = await harness.writer.recordRuntimeStageCreateIntent(receipt);
    receipt = await harness.writer.recordRuntimeStaged(receipt, 'applied', manifest(SOURCE_DIGEST));
    receipt = await harness.writer.recordDestinationBackupCreateIntent(receipt);
    receipt = await harness.writer.recordDestinationBackedUp(receipt, 'applied');
    receipt = await harness.writer.beginRollback(receipt);

    await expect(harness.writer.bindAuthoredRolledBack(receipt)).rejects.toThrow(
      /authored transaction|rollback receipt/iu,
    );
    receipt = await harness.writer.recordRuntimeRollbackIntent(receipt);
    receipt = await harness.writer.recordRuntimeRolledBack(receipt, 'applied');
    let current = await harness.controller.verifyOpen(receipt);
    expect(current).toMatchObject({
      progress: {
        phase: 'runtime-rolled-back',
        runtimeInstallState: 'backup-restored',
      },
      cleanup: {
        destinationBackup: 'removed',
        runtimeStage: 'removed',
      },
    });
    receipt = await advanceAuthoredPhase(
      harness.controller,
      receipt,
      'authored-rolled-back',
      harness.now,
    );
    receipt = await harness.writer.bindAuthoredRolledBack(receipt);
    receipt = await harness.writer.sealRolledBack(receipt, destination);
    current = await harness.controller.verifyOpen(receipt);
    expect(current.terminal).toMatchObject({
      outcome: 'rolled-back',
      authority: 'project',
      sourcePreserved: true,
    });
    const closed = await harness.writer.close(receipt);
    await expect(
      harness.controller.verifyReceipt(closed, { state: 'closed' }),
    ).resolves.toMatchObject({
      progress: { runtimeInstallState: 'backup-restored' },
      cleanup: {
        destinationParent: 'unmaterialized',
        runtimeStage: 'removed',
        destinationBackup: 'removed',
      },
    });
  });

  it('removes a staged runtime and operation-created parent before authored rollback', async () => {
    const harness = createHarness();
    let receipt = await harness.create('promote-cache', {
      destinationParentPreexisting: false,
      destinationRuntimePreexisting: false,
    });
    receipt = await verifyRouteInputs(harness, 'promote-cache', receipt, null);
    receipt = await prepareAuthored(harness, receipt);
    receipt = await harness.writer.recordDestinationParentCreateIntent(receipt);
    receipt = await harness.writer.recordDestinationReady(receipt, 'applied');
    receipt = await harness.writer.recordRuntimeStageCreateIntent(receipt);
    receipt = await harness.writer.recordRuntimeStaged(receipt, 'applied', manifest(SOURCE_DIGEST));
    receipt = await harness.writer.beginRollback(receipt);

    await expect(
      advanceAuthoredPhase(harness.controller, receipt, 'authored-rolled-back', harness.now),
    ).rejects.toThrow(/destination|parent|evidence|rollback/iu);
    receipt = await harness.writer.recordRuntimeRollbackIntent(receipt);
    const intent = await harness.controller.verifyOpen(receipt);
    expect(intent.cleanup).toMatchObject({
      destinationParent: 'pending',
      runtimeStage: 'pending',
      destinationBackup: 'unmaterialized',
    });
    const recordedAt = harness.now();
    const unrelatedCleanup: RuntimePromotionJournal = {
      ...intent,
      revision: intent.revision + 1,
      progress: {
        ...intent.progress,
        phase: 'runtime-rolled-back',
        runtimeInstallState: 'rolled-back',
        pendingIntent: null,
        lastPostcondition: {
          ...intent.progress.pendingIntent!,
          outcome: 'applied',
          recordedAt,
        },
      },
      cleanup: {
        ...intent.cleanup,
        destinationParent: 'removed',
        runtimeStage: 'removed',
        authoredStage: 'removed',
      },
      counts: {
        ...intent.counts,
        postconditionCount: intent.counts.postconditionCount + 1,
      },
      timestamps: { ...intent.timestamps, updatedAt: recordedAt },
    };
    await expect(harness.controller.recordPostcondition(receipt, unrelatedCleanup)).rejects.toThrow(
      /cleanup|artifact|owned|rollback/iu,
    );

    receipt = await harness.writer.recordRuntimeRolledBack(receipt, 'applied');
    const restored = await harness.controller.verifyOpen(receipt);
    expect(restored).toMatchObject({
      progress: {
        phase: 'runtime-rolled-back',
        runtimeInstallState: 'rolled-back',
      },
      cleanup: {
        destinationParent: 'removed',
        runtimeStage: 'removed',
        destinationBackup: 'unmaterialized',
        authoredStage: 'pending',
      },
    });
    receipt = await advanceAuthoredPhase(
      harness.controller,
      receipt,
      'authored-rolled-back',
      harness.now,
    );
    await expect(harness.writer.bindAuthoredRolledBack(receipt)).resolves.toBe(receipt);
  });

  it('resolves a preinstall stage in a preexisting parent during rollback', async () => {
    const harness = createHarness();
    let receipt = await harness.create('promote-cache', {
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: false,
    });
    receipt = await verifyRouteInputs(harness, 'promote-cache', receipt, null);
    receipt = await prepareAuthored(harness, receipt);
    receipt = await harness.writer.advancePreexistingDestinationReady(receipt);
    receipt = await harness.writer.recordRuntimeStageCreateIntent(receipt);
    receipt = await harness.writer.recordRuntimeStaged(receipt, 'applied', manifest(SOURCE_DIGEST));
    receipt = await harness.writer.beginRollback(receipt);
    receipt = await harness.writer.recordRuntimeRollbackIntent(receipt);
    receipt = await harness.writer.recordRuntimeRolledBack(receipt, 'applied');
    receipt = await advanceAuthoredPhase(
      harness.controller,
      receipt,
      'authored-rolled-back',
      harness.now,
    );
    receipt = await harness.writer.bindAuthoredRolledBack(receipt);
    receipt = await harness.writer.sealRolledBack(receipt, manifest(SOURCE_DIGEST));
    const closed = await harness.writer.close(receipt);
    await expect(
      harness.controller.verifyReceipt(closed, { state: 'closed' }),
    ).resolves.toMatchObject({
      progress: { runtimeInstallState: 'rolled-back' },
      cleanup: {
        destinationParent: 'unmaterialized',
        runtimeStage: 'removed',
        destinationBackup: 'unmaterialized',
      },
    });
  });

  it.each([
    ['authored-only', null, 'none'],
    ['project-authority', DESTINATION_DIGEST, 'project'],
    ['promote-cache', null, 'cache'],
    ['keep-project', DESTINATION_DIGEST, 'project'],
    ['deduplicate-cache', SOURCE_DIGEST, 'project'],
  ] as const)(
    'seals exact rolled-back authority for the %s route',
    async (route, digest, authority) => {
      const harness = createHarness();
      const destination = digest === null ? null : manifest(digest);
      let receipt = await harness.create(route);
      receipt = await verifyRouteInputs(harness, route, receipt, destination);
      receipt = await prepareAuthored(harness, receipt);
      receipt = await harness.writer.beginRollback(receipt);
      receipt = await advanceAuthoredPhase(
        harness.controller,
        receipt,
        'authored-rolled-back',
        harness.now,
      );
      receipt = await harness.writer.bindAuthoredRolledBack(receipt);
      const observed = rolledBackAuthorityForRoute(route, destination);
      receipt = await harness.writer.sealRolledBack(receipt, observed);
      const current = await harness.controller.verifyOpen(receipt);
      expect(current.terminal).toEqual({
        outcome: 'rolled-back',
        authority,
        runtimeManifest: observed,
        authoredVerified: true,
        sourcePreserved: ['promote-cache', 'keep-project', 'deduplicate-cache'].includes(route),
        verifiedAt: current.timestamps.updatedAt,
      });
    },
  );

  it('seals rollback before authored materialization without inventing artifacts', async () => {
    const harness = createHarness();
    let receipt = await harness.create('authored-only');
    receipt = await harness.writer.beginRollback(receipt);
    receipt = await harness.writer.recordUnmaterializedAuthoredRolledBack(receipt);
    receipt = await harness.writer.sealRolledBack(receipt, null);
    const current = await harness.controller.verifyOpen(receipt);
    expect(current).toMatchObject({
      progress: {
        phase: 'rolled-back',
        authoredCursor: 0,
        rollbackCursor: 0,
      },
      cleanup: {
        authoredStage: 'unmaterialized',
        authoredBackup: 'unmaterialized',
        replayManifest: 'unmaterialized',
      },
      terminal: {
        outcome: 'rolled-back',
        authority: 'none',
        sourcePreserved: false,
      },
    });
  });

  it('rolls an installed source-only runtime back to cache authority', async () => {
    const harness = createHarness();
    let receipt = await harness.create('promote-cache', {
      destinationParentPreexisting: false,
      destinationRuntimePreexisting: false,
    });
    receipt = await verifyRouteInputs(harness, 'promote-cache', receipt, null);
    receipt = await prepareAuthored(harness, receipt);
    receipt = await installPromotedRuntime(harness, receipt, false);
    receipt = await harness.writer.beginRollback(receipt);
    receipt = await harness.writer.recordRuntimeRollbackIntent(receipt);
    receipt = await harness.writer.recordRuntimeRolledBack(receipt, 'already-satisfied');
    receipt = await advanceAuthoredPhase(
      harness.controller,
      receipt,
      'authored-rolled-back',
      harness.now,
    );
    receipt = await harness.writer.bindAuthoredRolledBack(receipt);
    receipt = await harness.writer.sealRolledBack(receipt, manifest(SOURCE_DIGEST));
    const current = await harness.controller.verifyOpen(receipt);
    expect(current).toMatchObject({
      progress: { runtimeInstallState: 'rolled-back' },
      terminal: {
        outcome: 'rolled-back',
        authority: 'cache',
        runtimeManifest: manifest(SOURCE_DIGEST),
        sourcePreserved: true,
      },
      cleanup: {
        destinationParent: 'removed',
        runtimeStage: 'removed',
        destinationBackup: 'unmaterialized',
      },
    });
  });

  it('retains the created-parent marker until authored rollback after authored progress', async () => {
    const harness = createHarness();
    let receipt = await harness.create('promote-cache', {
      destinationParentPreexisting: false,
      destinationRuntimePreexisting: false,
      mutationCount: 1,
    });
    receipt = await verifyRouteInputs(harness, 'promote-cache', receipt, null);
    receipt = await prepareAuthored(harness, receipt);
    receipt = await installPromotedRuntime(harness, receipt, false);
    receipt = await recordOpenIntent(
      harness.controller,
      receipt,
      'authored-target-commit',
      'replayManifest',
      0,
      harness.now,
    );
    receipt = await recordOpenPostcondition(
      harness.controller,
      receipt,
      {
        phase: 'authored-committed',
        outcome: 'applied',
        authoredDelta: 1,
      },
      harness.now,
    );
    receipt = await harness.writer.bindAuthoredCommitted(receipt);
    receipt = await harness.writer.beginRollback(receipt);
    receipt = await harness.writer.recordRuntimeRollbackIntent(receipt);
    receipt = await harness.writer.recordRuntimeRolledBack(receipt, 'applied');

    await expect(harness.controller.verifyOpen(receipt)).resolves.toMatchObject({
      progress: {
        phase: 'runtime-rolled-back',
        runtimeInstallState: 'rolled-back',
        authoredCursor: 1,
      },
      cleanup: {
        destinationParent: 'pending',
        runtimeStage: 'removed',
        destinationBackup: 'unmaterialized',
      },
    });
  });

  it('rejects skipped intents, stale receipts, route misuse, and mismatched evidence', async () => {
    const harness = createHarness();
    let receipt = await harness.create('promote-cache', {
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: false,
    });
    receipt = await verifyRouteInputs(harness, 'promote-cache', receipt, null);
    receipt = await prepareAuthored(harness, receipt);

    await expect(harness.writer.recordRuntimeInstalled(receipt, 'applied')).rejects.toThrow(
      /pending intent/iu,
    );
    await expect(
      harness.writer.recordAuthorityVerified(receipt, manifest(SOURCE_DIGEST)),
    ).rejects.toThrow(/authored-committed|forward/iu);

    const beforeIntent = receipt;
    receipt = await harness.writer.advancePreexistingDestinationReady(receipt);
    receipt = await harness.writer.recordRuntimeStageCreateIntent(receipt);
    await expect(
      harness.writer.recordRuntimeStaged(receipt, 'applied', manifest(DESTINATION_DIGEST)),
    ).rejects.toThrow(/exactly match/iu);
    await expect(harness.writer.recordRuntimeStageCreateIntent(beforeIntent)).rejects.toThrow(
      /stale|changed/iu,
    );

    const projectHarness = createHarness();
    let project = await projectHarness.create('project-authority');
    project = await projectHarness.writer.verifyDestination(project, manifest(DESTINATION_DIGEST));
    project = await prepareAuthored(projectHarness, project);
    await expect(projectHarness.writer.recordRuntimeStageCreateIntent(project)).rejects.toThrow(
      /intent|route|phase/iu,
    );
  });

  it('exposes no generic raw replacement or phase-assembly escape hatch', () => {
    const writer = createHarness().writer as unknown as Record<string, unknown>;
    expect(writer.replace).toBeUndefined();
    expect(writer.advancePhase).toBeUndefined();
    expect(writer.recordIntent).toBeUndefined();
    expect(writer.recordPostcondition).toBeUndefined();
    expect(Object.isFrozen(writer)).toBe(true);
  });
});

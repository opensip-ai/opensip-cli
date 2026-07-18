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
  parseRuntimePromotionJournal,
  type RuntimeManifestIdentity,
  type RuntimePromotionJournal,
  type RuntimePromotionOwnedSlotName,
  type RuntimePromotionRoute,
} from '../runtime-promotion-journal-schema.js';
import {
  createRuntimePromotionJournalController,
  type DurableClosedPromotionJournal,
  type DurableOpenPromotionJournal,
  type RuntimePromotionJournalController,
  type RuntimePromotionJournalControllerDependencies,
} from '../runtime-promotion-journal.js';
import {
  recoverRuntimePromotion,
  type RuntimePromotionRecoveryCheckpoint,
  type RuntimePromotionRecoveryDependencies,
} from '../runtime-promotion-recovery.js';
import { createRuntimePromotionTransitionWriter } from '../runtime-promotion-transitions.js';

import type {
  AuthoredStateSummary,
  InitAuthoredTransaction,
} from '../authored-state-transaction.js';
import type { RuntimePromotionFilesystemAuthority } from '../runtime-promotion-filesystem.js';
import type { RuntimePromotionProjectRootAuthority } from '../runtime-promotion-root-authority.js';
import type { RuntimeAdoptionResult, RuntimeAdoptionStatus } from '@opensip-cli/contracts';

const PROJECT_ROOT = '/canonical/recovery-forward-project';
const PROJECT_KEY = 'a'.repeat(24);
const SOURCE_CACHE_KEY = 'b'.repeat(24);
const SOURCE_DIGEST = 'c'.repeat(64);
const DESTINATION_DIGEST = 'd'.repeat(64);
const GENERATION_DIGEST = 'e'.repeat(64);
const MARKER_DIGEST = 'f'.repeat(64);
const AUTHORED_DIGEST = '1'.repeat(64);
const REPLAY_DIGEST = '2'.repeat(64);
const OPERATION_ID = 'recovery-forward-restart-operation-0001';
const RECOVERY_NOW = 10_000;
const DATASTORE_LOCK_CONTEXT = {
  policy: { waitMs: 100, staleMs: 1000, heartbeatMs: 100 },
  command: 'opensip init',
  cwdBasename: 'recovery-forward-project',
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

const AUTHORED_CLEANUP_SLOTS = [
  'authoredStage',
  'authoredBackup',
  'replayManifest',
] as const satisfies readonly RuntimePromotionOwnedSlotName[];

type FaultCheckpoint = Extract<
  RuntimePromotionRecoveryCheckpoint,
  'after-open-intent-reconciled' | 'after-open-transition'
>;

type EffectName =
  | 'authoredCommit'
  | 'destinationParentCreate'
  | 'runtimeStageReconcile'
  | 'runtimeStageCopy'
  | 'destinationBackup'
  | 'destinationInstall'
  | 'sourceRetire'
  | 'authoredCleanup'
  | 'cleanupDestinationParent'
  | 'cleanupRuntimeStage'
  | 'cleanupDestinationBackup'
  | 'cleanupSourceTombstone';

const EFFECT_NAMES = [
  'authoredCommit',
  'destinationParentCreate',
  'runtimeStageReconcile',
  'runtimeStageCopy',
  'destinationBackup',
  'destinationInstall',
  'sourceRetire',
  'authoredCleanup',
  'cleanupDestinationParent',
  'cleanupRuntimeStage',
  'cleanupDestinationBackup',
  'cleanupSourceTombstone',
] as const satisfies readonly EffectName[];

const RUNTIME_CLEANUP_EFFECTS: Partial<Record<RuntimePromotionOwnedSlotName, EffectName>> = {
  destinationParent: 'cleanupDestinationParent',
  runtimeStage: 'cleanupRuntimeStage',
  destinationBackup: 'cleanupDestinationBackup',
  sourceTombstone: 'cleanupSourceTombstone',
};

interface ForwardScenario {
  readonly name: string;
  readonly route: RuntimePromotionRoute;
  readonly destinationParentPreexisting: boolean;
  readonly destinationRuntimePreexisting: boolean;
  readonly expectedStatus: RuntimeAdoptionStatus;
  readonly expectedReason?: 'destination-absent' | 'equivalent' | 'source-absent';
  readonly transitionFaults: number;
  readonly intentFaults: number;
  readonly effects: Partial<Record<EffectName, number>>;
}

const SCENARIOS: readonly ForwardScenario[] = [
  {
    name: 'authored-only',
    route: 'authored-only',
    destinationParentPreexisting: false,
    destinationRuntimePreexisting: false,
    expectedStatus: 'not-found',
    expectedReason: 'source-absent',
    transitionFaults: 2,
    intentFaults: 0,
    effects: { authoredCommit: 1, authoredCleanup: 1 },
  },
  {
    name: 'project-authority',
    route: 'project-authority',
    destinationParentPreexisting: true,
    destinationRuntimePreexisting: true,
    expectedStatus: 'already-project',
    expectedReason: 'source-absent',
    transitionFaults: 2,
    intentFaults: 0,
    effects: { authoredCommit: 1, authoredCleanup: 1 },
  },
  {
    name: 'promote-cache into a new destination',
    route: 'promote-cache',
    destinationParentPreexisting: false,
    destinationRuntimePreexisting: false,
    expectedStatus: 'promoted',
    expectedReason: 'destination-absent',
    transitionFaults: 10,
    intentFaults: 4,
    effects: {
      authoredCommit: 1,
      destinationParentCreate: 1,
      runtimeStageReconcile: 1,
      runtimeStageCopy: 1,
      destinationInstall: 1,
      sourceRetire: 1,
      authoredCleanup: 1,
      cleanupDestinationParent: 1,
      cleanupSourceTombstone: 1,
    },
  },
  {
    name: 'promote-cache over a destination',
    route: 'promote-cache',
    destinationParentPreexisting: true,
    destinationRuntimePreexisting: true,
    expectedStatus: 'promoted',
    transitionFaults: 11,
    intentFaults: 4,
    effects: {
      authoredCommit: 1,
      runtimeStageReconcile: 1,
      runtimeStageCopy: 1,
      destinationBackup: 1,
      destinationInstall: 1,
      sourceRetire: 1,
      authoredCleanup: 1,
      cleanupDestinationBackup: 1,
      cleanupSourceTombstone: 1,
    },
  },
  {
    name: 'keep-project',
    route: 'keep-project',
    destinationParentPreexisting: true,
    destinationRuntimePreexisting: true,
    expectedStatus: 'kept-project',
    transitionFaults: 4,
    intentFaults: 1,
    effects: {
      authoredCommit: 1,
      sourceRetire: 1,
      authoredCleanup: 1,
      cleanupSourceTombstone: 1,
    },
  },
  {
    name: 'deduplicate-cache',
    route: 'deduplicate-cache',
    destinationParentPreexisting: true,
    destinationRuntimePreexisting: true,
    expectedStatus: 'deduplicated',
    expectedReason: 'equivalent',
    transitionFaults: 4,
    intentFaults: 1,
    effects: {
      authoredCommit: 1,
      sourceRetire: 1,
      authoredCleanup: 1,
      cleanupSourceTombstone: 1,
    },
  },
];

interface JournalStore {
  content: string | undefined;
  readonly mutations: RuntimeRecoveryRecordMutation[];
}

interface TransactionState {
  readonly controller: RuntimePromotionJournalController;
  receipt: DurableOpenPromotionJournal | DurableClosedPromotionJournal;
}

interface FakeFilesystemAuthority {
  readonly action: string;
  readonly cleanupSlot?: RuntimePromotionOwnedSlotName;
}

interface RecoveryHarness {
  readonly store: JournalStore;
  readonly effects: Record<EffectName, number>;
  readonly datastoreCheckpoints: () => number;
  readonly run: () => Promise<RuntimeAdoptionResult>;
  readonly armFault: (checkpoint: FaultCheckpoint) => void;
  readonly faultFired: () => boolean;
}

type RecoveryStartPhase = 'authored-prepared' | 'prepared';

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
    totalBytes: 16,
    sqlite: { status: 'absent' },
  };
}

const SOURCE_IDENTITY = manifest(SOURCE_DIGEST);
const DESTINATION_IDENTITY = manifest(DESTINATION_DIGEST);

function verified(identity: RuntimeManifestIdentity) {
  return { identity, entries: [] };
}

function sourceRoute(route: RuntimePromotionRoute): boolean {
  return ['promote-cache', 'keep-project', 'deduplicate-cache'].includes(route);
}

function conflictForRoute(route: RuntimePromotionRoute): 'abort' | 'keep-project' | 'use-cache' {
  if (route === 'keep-project') return 'keep-project';
  return route === 'promote-cache' ? 'use-cache' : 'abort';
}

function destinationIdentity(scenario: ForwardScenario): RuntimeManifestIdentity | null {
  if (!scenario.destinationRuntimePreexisting) return null;
  return scenario.route === 'deduplicate-cache' ? SOURCE_IDENTITY : DESTINATION_IDENTITY;
}

function projectAuthorityIdentity(scenario: ForwardScenario): RuntimeManifestIdentity {
  return scenario.route === 'promote-cache'
    ? SOURCE_IDENTITY
    : (destinationIdentity(scenario) ?? DESTINATION_IDENTITY);
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
    if (store.content !== undefined) throw new Error('test journal already exists');
    store.content = mutation.content;
    return;
  }
  if (store.content === undefined || sha256(store.content) !== mutation.expectedContentSha256) {
    throw new Error('test journal compare-and-swap collision');
  }
  store.content = mutation.operation === 'replace' ? mutation.content : undefined;
}

function currentJournal(store: JournalStore): RuntimePromotionJournal {
  if (store.content === undefined) throw new Error('expected a durable promotion journal');
  return parseRuntimePromotionJournal(store.content);
}

function builderLease(): RuntimeExclusiveLease {
  return Object.freeze({
    kind: 'runtime-exclusive',
    coordinationKey: PROJECT_KEY,
    posture: 'normal',
    ownerToken: 'recovery-forward-builder-lease-owner',
    acquiredAt: 1,
    release: () => undefined,
  });
}

function initialJournal(
  scenario: ForwardScenario,
  identity: {
    readonly operationId: string;
    readonly recoveryOwnerToken: string;
    readonly createdAt: number;
  },
): RuntimePromotionJournal {
  return createInitialRuntimePromotionJournal({
    coordinationKey: PROJECT_KEY,
    operationId: identity.operationId,
    recoveryOwnerToken: identity.recoveryOwnerToken,
    route: scenario.route,
    destinationParentPreexisting: scenario.destinationParentPreexisting,
    destinationRuntimePreexisting: scenario.destinationRuntimePreexisting,
    source: sourceRoute(scenario.route)
      ? {
          classification: 'generation-bound',
          cacheKey: SOURCE_CACHE_KEY,
          generationDigest: GENERATION_DIGEST,
          markerSha256: MARKER_DIGEST,
        }
      : {
          classification: 'none',
          cacheKey: null,
          generationDigest: null,
          markerSha256: null,
        },
    inputs: {
      conflict: conflictForRoute(scenario.route),
      authoredMode: 'fresh',
      languages: ['typescript'],
      languageExplicit: false,
    },
    plan: {
      authoredDigest: AUTHORED_DIGEST,
      replayDigest: REPLAY_DIGEST,
      mutationCount: 0,
    },
    owned: createRuntimePromotionOwnedSlots(identity.operationId),
    createdAt: identity.createdAt,
  });
}

async function createStartingStore(
  scenario: ForwardScenario,
  startPhase: RecoveryStartPhase,
): Promise<JournalStore> {
  const store: JournalStore = { content: undefined, mutations: [] };
  let clock = 100;
  const now = (): number => ++clock;
  const lease = builderLease();
  const dependencies: RuntimePromotionJournalControllerDependencies = {
    now,
    generateOperationId: () => OPERATION_ID,
    generateRecoveryOwnerToken: () => 'recovery-forward-builder-owner-token',
    read: () => Promise.resolve(readStore(store)),
    mutate: (_lease, mutation) => {
      mutateStore(store, mutation);
      return Promise.resolve({ strategy: 'portable-anchored' });
    },
  };
  const controller = createRuntimePromotionJournalController(lease, dependencies);
  const writer = createRuntimePromotionTransitionWriter(controller, { now });
  const allocation = controller.allocate((identity) => initialJournal(scenario, identity));
  let receipt = await controller.create(allocation);
  if (startPhase === 'prepared') {
    expect(currentJournal(store).progress).toMatchObject({
      phase: 'prepared',
      pendingIntent: null,
    });
    return store;
  }
  if (sourceRoute(scenario.route)) {
    receipt = await writer.verifySource(receipt, SOURCE_IDENTITY);
  }
  if (scenario.route !== 'authored-only') {
    receipt = await writer.verifyDestination(receipt, destinationIdentity(scenario));
  }
  receipt = await recordOpenIntent(
    controller,
    receipt,
    'authored-prepare',
    'authoredStage',
    null,
    now,
  );
  receipt = await recordOpenPostcondition(
    controller,
    receipt,
    {
      phase: 'authored-prepared',
      outcome: 'applied',
      prepareArtifacts: true,
    },
    now,
  );
  await writer.bindAuthoredPrepared(receipt);
  expect(currentJournal(store).progress).toMatchObject({
    phase: 'authored-prepared',
    pendingIntent: null,
  });
  return store;
}

function recoveryRootAuthority(
  scenario: ForwardScenario,
  lease: RuntimeExclusiveLease,
): RuntimePromotionProjectRootAuthority {
  const identity = { dev: '1', ino: '2', uid: '3', mode: String(0o4_0700) };
  return {
    version: 1,
    projectRoot: PROJECT_ROOT,
    coordinationKey: lease.coordinationKey,
    leasePosture: 'init-recovery',
    identity,
    destinationParent: scenario.destinationParentPreexisting
      ? { path: `${PROJECT_ROOT}/opensip-cli`, identity }
      : null,
  };
}

function expectedResult(scenario: ForwardScenario): RuntimeAdoptionResult {
  return {
    status: scenario.expectedStatus,
    ...(sourceRoute(scenario.route) ? { proofStrength: 'generation-bound' as const } : {}),
    sourcePreserved: false,
    ...(sourceRoute(scenario.route) ? { sourceRetired: true } : {}),
    authored: {
      created: 0,
      replaced: 0,
      deleted: 0,
      preserved: 0,
    },
    durationMs: 0,
    ...(scenario.expectedReason === undefined ? {} : { reasonCode: scenario.expectedReason }),
  };
}

function increment(effects: Record<EffectName, number>, effect: EffectName): void {
  effects[effect] += 1;
}

async function createRecoveryHarness(
  scenario: ForwardScenario,
  startPhase: RecoveryStartPhase = 'authored-prepared',
): Promise<RecoveryHarness> {
  const store = await createStartingStore(scenario, startPhase);
  const effects = Object.fromEntries(EFFECT_NAMES.map((name) => [name, 0])) as Record<
    EffectName,
    number
  >;
  const transactions = new WeakMap<InitAuthoredTransaction, TransactionState>();
  let leaseAttempt = 0;
  let recoveryOwner = 0;
  let datastoreCheckpoints = 0;
  let faultTarget: FaultCheckpoint | undefined;
  let faultArmed = false;

  const now = (): number => RECOVERY_NOW;
  const createTransaction = (
    controller: RuntimePromotionJournalController,
    receipt: DurableOpenPromotionJournal | DurableClosedPromotionJournal,
  ): InitAuthoredTransaction => {
    const transaction = {
      operationId: OPERATION_ID,
      mutationCount: 0,
    } as InitAuthoredTransaction;
    transactions.set(transaction, { controller, receipt });
    return transaction;
  };
  const controllerFor = (lease: RuntimeExclusiveLease): RuntimePromotionJournalController =>
    createRuntimePromotionJournalController(lease, {
      now,
      generateOperationId: () => OPERATION_ID,
      generateRecoveryOwnerToken: () => `recovery-forward-owner-${++recoveryOwner}`.padEnd(32, '0'),
      read: () => Promise.resolve(readStore(store)),
      mutate: (_lease, mutation) => {
        mutateStore(store, mutation);
        return Promise.resolve({ strategy: 'portable-anchored' });
      },
    });
  const dependencies: Partial<RuntimePromotionRecoveryDependencies> = {
    now,
    checkpoint: (checkpoint) => {
      if (faultArmed && checkpoint === faultTarget) {
        faultArmed = false;
        throw new Error(`restart at ${checkpoint}`);
      }
    },
    canonicalizeProjectRoot: () => PROJECT_ROOT,
    inspectHeader: () => {
      if (store.content === undefined) return { status: 'absent' };
      const journal = currentJournal(store);
      return {
        status: 'valid',
        operationId: journal.operationId,
        state: journal.state,
      };
    },
    acquireLease: () =>
      Promise.resolve(
        Object.freeze({
          kind: 'runtime-exclusive',
          coordinationKey: PROJECT_KEY,
          posture: 'init-recovery',
          ownerToken: `recovery-forward-lease-${++leaseAttempt}`.padEnd(32, '0'),
          acquiredAt: RECOVERY_NOW,
          release: () => undefined,
        }) satisfies RuntimeExclusiveLease,
      ),
    ephemeralProjectsDir: () => '/ephemeral/projects',
    assertSourceAuthority: () => undefined,
    assertSourceLocation: () => undefined,
    checkpointDatastores: () => {
      if (startPhase === 'authored-prepared') {
        throw new Error('authored-prepared recovery must not repeat datastore checkpointing');
      }
      datastoreCheckpoints += 1;
      return [];
    },
    createController: controllerFor,
    createWriter: (controller) => createRuntimePromotionTransitionWriter(controller, { now }),
    captureProjectRootAuthority: ({ lease }) => recoveryRootAuthority(scenario, lease),
    assertProjectRootAuthority: () => undefined,
    inspectManifest: (_runtimeDir, posture) => {
      if (posture === 'cache-source') return verified(SOURCE_IDENTITY);
      if (scenario.route === 'authored-only') {
        throw new Error('authored-only recovery must not inspect a project runtime');
      }
      if (
        scenario.route === 'promote-cache' &&
        currentJournal(store).progress.runtimeInstallState !== 'installed'
      ) {
        const destination = destinationIdentity(scenario);
        if (destination === null) {
          throw new Error('destination-absent promotion must not inspect a project runtime');
        }
        return verified(destination);
      }
      return verified(projectAuthorityIdentity(scenario));
    },
    classifyPath: () => ({
      status: 'directory',
      mode: 0o700,
      owner: 'current',
    }),
    authorizeFilesystem: (input) =>
      Promise.resolve({
        action: input.action,
        ...(input.cleanupSlot === undefined ? {} : { cleanupSlot: input.cleanupSlot }),
      } as unknown as RuntimePromotionFilesystemAuthority),
    createDestinationParent: () => {
      increment(effects, 'destinationParentCreate');
      return Promise.resolve({ status: 'created' });
    },
    reconcileStage: () => {
      increment(effects, 'runtimeStageReconcile');
      return Promise.resolve({ status: 'absent' });
    },
    copyStage: () => {
      increment(effects, 'runtimeStageCopy');
      return Promise.resolve({ stage: verified(SOURCE_IDENTITY) });
    },
    backupDestination: (_authority, expected) => {
      increment(effects, 'destinationBackup');
      return Promise.resolve({
        status: 'applied',
        manifest: verified(expected),
      });
    },
    installStage: (_authority, expected) => {
      increment(effects, 'destinationInstall');
      return Promise.resolve({
        status: 'applied',
        manifest: verified(expected),
      });
    },
    retireSource: (_authority, expected) => {
      increment(effects, 'sourceRetire');
      return Promise.resolve({
        status: 'applied',
        manifest: verified(expected),
      });
    },
    rollbackRuntime: () => {
      throw new Error('forward recovery must not roll back runtime state');
    },
    cleanupOwnedSlot: (authority) => {
      const slot = (authority as unknown as FakeFilesystemAuthority).cleanupSlot;
      if (slot === undefined) throw new Error('closed cleanup lacks its slot');
      const effect: EffectName | undefined = RUNTIME_CLEANUP_EFFECTS[slot];
      if (effect === undefined) throw new Error(`unexpected authored cleanup slot ${slot}`);
      increment(effects, effect);
      return Promise.resolve({ slot, status: 'already-absent' });
    },
    loadAuthored: (input) => {
      const transaction = createTransaction(input.controller, input.receipt);
      return Promise.resolve({
        transaction,
        receipt: input.receipt,
        summary: SUMMARY,
      });
    },
    abortAuthoredPreparation: () => {
      throw new Error('authored-prepared recovery must not abort authored preparation');
    },
    bindAuthoredReceipt: (transaction, receipt) => {
      const state = transactions.get(transaction);
      if (state === undefined) throw new Error('unknown authored transaction');
      state.receipt = receipt;
      return Promise.resolve();
    },
    commitAuthored: async (transaction) => {
      const state = transactions.get(transaction);
      if (state?.receipt.state !== 'open') {
        throw new Error('unknown open authored transaction');
      }
      increment(effects, 'authoredCommit');
      const receipt = await advanceAuthoredPhase(
        state.controller,
        state.receipt,
        'authored-committed',
        now,
      );
      state.receipt = receipt;
      return { receipt, summary: SUMMARY };
    },
    rollbackAuthored: () => {
      throw new Error('forward recovery must not roll back authored state');
    },
    verifyAuthored: (_transaction, expected) => {
      if (expected !== 'desired') throw new Error('forward recovery must verify desired state');
      return Promise.resolve(SUMMARY);
    },
    loadClosedAuthored: (input) =>
      Promise.resolve(createTransaction(input.controller, input.receipt)),
    cleanupAuthored: async (transaction, initialReceipt) => {
      const state = transactions.get(transaction);
      if (state === undefined) throw new Error('unknown closed authored transaction');
      increment(effects, 'authoredCleanup');
      const writer = createRuntimePromotionTransitionWriter(state.controller, {
        now,
      });
      let receipt = initialReceipt;
      let journal = currentJournal(store);
      for (const slot of AUTHORED_CLEANUP_SLOTS) {
        if (journal.cleanup[slot] !== 'pending') continue;
        if (journal.progress.pendingIntent === null) {
          receipt = await writer.recordCleanupIntent(receipt, slot);
        } else if (
          journal.progress.pendingIntent.kind !== 'owned-slot-cleanup' ||
          journal.progress.pendingIntent.slot !== slot
        ) {
          throw new Error('closed authored cleanup found another pending intent');
        }
        receipt = await writer.recordCleanupPostcondition(receipt, slot, 'already-satisfied');
        journal = currentJournal(store);
      }
      state.receipt = receipt;
      return { receipt, summary: SUMMARY };
    },
  };

  return {
    store,
    effects,
    datastoreCheckpoints: () => datastoreCheckpoints,
    run: () =>
      recoverRuntimePromotion(
        {
          projectRoot: PROJECT_ROOT,
          datastoreLockContext: DATASTORE_LOCK_CONTEXT,
        },
        dependencies,
      ),
    armFault: (checkpoint) => {
      faultTarget = checkpoint;
      faultArmed = true;
    },
    faultFired: () => !faultArmed,
  };
}

async function runThroughEveryFault(
  harness: RecoveryHarness,
  scenario: ForwardScenario,
  checkpoint: FaultCheckpoint,
): Promise<{
  readonly result: RuntimeAdoptionResult;
  readonly faults: number;
}> {
  let faults = 0;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    harness.armFault(checkpoint);
    const result = await harness.run();
    if (result.status === scenario.expectedStatus) {
      expect(harness.faultFired()).toBe(false);
      return { result, faults };
    }
    expect(result).toMatchObject({
      status: 'recovery-required',
      reasonCode: 'operation-failed',
    });
    expect(harness.faultFired()).toBe(true);
    faults += 1;
  }
  throw new Error(`recovery did not converge for ${scenario.name} at ${checkpoint}`);
}

interface PreparedRestartCase {
  readonly name: string;
  readonly scenario: ForwardScenario;
  readonly expectedFaults: number;
  readonly expectedDatastoreCheckpoints: number;
}

function namedScenario(name: string): ForwardScenario {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  if (scenario === undefined) throw new Error(`missing forward scenario ${name}`);
  return scenario;
}

const PREPARED_RESTART_CASES: readonly PreparedRestartCase[] = [
  {
    name: 'authored-only prepared state',
    scenario: namedScenario('authored-only'),
    expectedFaults: 3,
    expectedDatastoreCheckpoints: 1,
  },
  {
    name: 'source-absent project prepared state',
    scenario: namedScenario('project-authority'),
    expectedFaults: 4,
    expectedDatastoreCheckpoints: 1,
  },
  {
    name: 'source-backed destination-absent prepared state',
    scenario: namedScenario('promote-cache into a new destination'),
    expectedFaults: 5,
    expectedDatastoreCheckpoints: 2,
  },
  {
    name: 'source-backed destination-present prepared state',
    scenario: namedScenario('promote-cache over a destination'),
    expectedFaults: 5,
    expectedDatastoreCheckpoints: 2,
  },
];

function expectedPreparedRollbackResult(scenario: ForwardScenario): RuntimeAdoptionResult {
  const selectedSource = sourceRoute(scenario.route);
  return {
    status: 'rolled-back',
    ...(selectedSource ? { proofStrength: 'generation-bound' as const } : {}),
    sourcePreserved: selectedSource,
    sourceRetired: false,
    durationMs: 0,
    reasonCode: 'operation-failed',
    nextCommand: 'opensip init',
  };
}

async function runPreparedThroughEveryTransitionFault(harness: RecoveryHarness): Promise<{
  readonly result: RuntimeAdoptionResult;
  readonly faults: number;
}> {
  let faults = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    harness.armFault('after-open-transition');
    const result = await harness.run();
    if (result.status === 'rolled-back') {
      expect(harness.faultFired()).toBe(false);
      return { result, faults };
    }
    expect(result).toMatchObject({
      status: 'recovery-required',
      reasonCode: 'operation-failed',
    });
    expect(harness.faultFired()).toBe(true);
    faults += 1;
  }
  throw new Error('prepared recovery did not converge to rollback');
}

const RESTART_CASES = SCENARIOS.flatMap((scenario) =>
  (
    [
      ['after-open-transition', scenario.transitionFaults],
      ['after-open-intent-reconciled', scenario.intentFaults],
    ] as const
  ).map(([checkpoint, expectedFaults]) => ({
    name: `${scenario.name} / ${checkpoint}`,
    scenario,
    checkpoint,
    expectedFaults,
  })),
);

describe('runtime promotion forward recovery restart convergence', () => {
  it.each(PREPARED_RESTART_CASES)(
    'rolls back exactly through every transition from $name',
    async ({ scenario, expectedFaults, expectedDatastoreCheckpoints }) => {
      const harness = await createRecoveryHarness(scenario, 'prepared');

      const completed = await runPreparedThroughEveryTransitionFault(harness);

      expect(completed.faults).toBe(expectedFaults);
      expect(completed.result).toStrictEqual(expectedPreparedRollbackResult(scenario));
      expect(harness.datastoreCheckpoints()).toBe(expectedDatastoreCheckpoints);
      expect(harness.store.content).toBeUndefined();
      expect(
        harness.store.mutations.filter(({ operation }) => operation === 'unlink'),
      ).toHaveLength(1);
      for (const effect of EFFECT_NAMES) {
        expect(harness.effects[effect], effect).toBe(0);
      }
    },
  );

  it.each(RESTART_CASES)(
    'converges exactly through every $name boundary',
    async ({ scenario, checkpoint, expectedFaults }) => {
      const harness = await createRecoveryHarness(scenario);

      const completed = await runThroughEveryFault(harness, scenario, checkpoint);

      expect(completed.faults).toBe(expectedFaults);
      expect(completed.result).toStrictEqual(expectedResult(scenario));
      expect(harness.store.content).toBeUndefined();
      expect(
        harness.store.mutations.filter(({ operation }) => operation === 'unlink'),
      ).toHaveLength(1);
      for (const effect of EFFECT_NAMES) {
        expect(harness.effects[effect], effect).toBe(scenario.effects[effect] ?? 0);
      }
    },
  );
});

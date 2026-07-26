import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  advanceAuthoredPhase,
  recordOpenIntent,
  recordOpenPostcondition,
} from '../authored-state-transaction-journal.js';
import {
  AUTHORED_REPLAY_MANIFEST_KIND,
  AUTHORED_REPLAY_MANIFEST_VERSION,
  type InitAuthoredMode,
  type InitAuthoredPlan,
} from '../init-authored-plan.js';
import { RuntimeManifestError, type VerifiedRuntimeManifest } from '../runtime-manifest.js';
import {
  createRuntimePromotionJournalController,
  type DurableOpenPromotionJournal,
  type RuntimePromotionJournalController,
} from '../runtime-promotion-journal.js';
import { RuntimePromotionDatastoreError } from '../runtime-promotion-preflight.js';
import {
  createRuntimePromotionTransitionWriter,
  type RuntimePromotionTransitionWriter,
} from '../runtime-promotion-transitions.js';
import {
  runFreshRuntimePromotion,
  type FreshRuntimePromotionInput,
  type RuntimePromotionCheckpoint,
  type RuntimePromotionDependencies,
} from '../runtime-promotion.js';

import type {
  RuntimeManifestIdentity,
  RuntimePromotionJournal,
  RuntimePromotionRoute,
} from '../runtime-promotion-journal-schema.js';
import type { RuntimePromotionPreflightSelected } from '../runtime-promotion-preflight.js';
import type {
  AnchoredRecordReadResult,
  RuntimeExclusiveLease,
  RuntimeRecoveryRecordMutation,
} from '@opensip-cli/core';

const PROJECT_KEY = 'a'.repeat(24);
const SOURCE_DIGEST = 'b'.repeat(64);
const DESTINATION_DIGEST = 'c'.repeat(64);
const CHANGED_DIGEST = 'd'.repeat(64);
const REPLAY_DIGEST = 'e'.repeat(64);
const AUTHORED_DIGEST = 'f'.repeat(64);
const MARKER_DIGEST = '1'.repeat(64);
const GENERATION_DIGEST = '2'.repeat(64);
const CANONICAL_ROOT = '/canonical/project';
const ALIAS_ROOT = '/alias/project';
const SOURCE_RUNTIME = `/cache/${'9'.repeat(24)}`;
const DESTINATION_PARENT = `${CANONICAL_ROOT}/opensip-cli`;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function manifestIdentity(digest: string): RuntimeManifestIdentity {
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

function manifest(digest: string): VerifiedRuntimeManifest {
  return { identity: manifestIdentity(digest), entries: [] };
}

function plan(mode: InitAuthoredMode = 'fresh'): InitAuthoredPlan {
  const inputs = {
    languages: ['typescript'] as const,
    mode,
    tools: [],
  };
  return {
    inputs,
    mutations: [
      {
        sequence: 0,
        action: 'create',
        path: 'opensip-cli.config.yml',
        targetType: 'file',
        targetMode: 0o600,
        preimage: { exists: false, type: null, mode: null, digest: null },
        desired: {
          exists: true,
          type: 'file',
          mode: 0o600,
          digest: '3'.repeat(64),
        },
        desiredBlob: 'desired/0000.blob',
        preimageBlob: null,
      },
    ],
    replayManifest: {
      kind: AUTHORED_REPLAY_MANIFEST_KIND,
      version: AUTHORED_REPLAY_MANIFEST_VERSION,
      inputs,
      mutations: [
        {
          sequence: 0,
          action: 'create',
          path: 'opensip-cli.config.yml',
          targetType: 'file',
          targetMode: 0o600,
          preimage: { exists: false, type: null, mode: null, digest: null },
          desired: {
            exists: true,
            type: 'file',
            mode: 0o600,
            digest: '3'.repeat(64),
          },
          desiredBlob: 'desired/0000.blob',
          preimageBlob: null,
        },
      ],
    },
    replayManifestBytes: '{}',
    replayManifestDigest: REPLAY_DIGEST,
    digest: AUTHORED_DIGEST,
    aggregateBlobBytes: 1,
    blobs: { desired: { 'desired/0000.blob': 'eA==' }, preimage: {} },
  };
}

const SUMMARY = {
  total: 1,
  created: 1,
  replaced: 0,
  deleted: 0,
  preserved: 0,
  completed: 1,
  rolledBack: 0,
  verified: true,
  actionsKnown: true,
} as const;

const PREPARED_SUMMARY = { ...SUMMARY, completed: 0, verified: false } as const;

interface HarnessOptions {
  readonly route: RuntimePromotionRoute;
  readonly authoredMode?: FreshRuntimePromotionInput['authoredMode'];
  readonly destinationRuntimePreexisting?: boolean;
  readonly destinationParentPreexisting?: boolean;
  readonly inputRoot?: string;
  readonly canonicalRoot?: string;
  readonly faultAt?: RuntimePromotionCheckpoint;
  readonly checkpointHook?: (checkpoint: RuntimePromotionCheckpoint, state: HarnessState) => void;
  readonly journalMutationHook?: (next: RuntimePromotionJournal, state: HarnessState) => void;
  readonly authoredVerificationHook?: (
    expected: 'desired' | 'preimage',
    state: HarnessState,
  ) => void;
  readonly closedAuthoredLoadHook?: (state: HarnessState) => void;
  readonly planFailure?: boolean;
  readonly revalidationFailure?: boolean;
  readonly rootSwapAt?: RuntimePromotionCheckpoint;
  readonly filesystemFailure?: {
    readonly action: 'destination-parent-create' | 'destination-install';
    readonly afterEffect?: boolean;
  };
}

interface HarnessState {
  readonly events: string[];
  readonly mutations: RuntimeRecoveryRecordMutation[];
  content: string | undefined;
  sourcePresent: boolean;
  sourceDigest: string;
  destinationPresent: boolean;
  destinationDigest: string;
  authoredAuthority: 'desired' | 'preimage' | 'changed';
  released: number;
  projectRootChanged: boolean;
}

interface Harness {
  readonly input: FreshRuntimePromotionInput;
  readonly dependencies: Partial<RuntimePromotionDependencies>;
  readonly state: HarnessState;
  readonly run: () => ReturnType<typeof runFreshRuntimePromotion>;
  readonly journal: () => RuntimePromotionJournal | undefined;
}

function sourceRoute(route: RuntimePromotionRoute): boolean {
  return ['promote-cache', 'keep-project', 'deduplicate-cache'].includes(route);
}

function routeConflict(route: RuntimePromotionRoute): 'abort' | 'keep-project' | 'use-cache' {
  if (route === 'keep-project') return 'keep-project';
  return route === 'promote-cache' ? 'use-cache' : 'abort';
}

function selectedPreflight(
  options: HarnessOptions,
  canonicalRoot: string,
): RuntimePromotionPreflightSelected {
  const destinationRuntimePreexisting =
    options.destinationRuntimePreexisting ??
    ['project-authority', 'keep-project', 'deduplicate-cache'].includes(options.route);
  const destinationParentPreexisting =
    options.destinationParentPreexisting ?? destinationRuntimePreexisting;
  return {
    status: 'selected',
    route: options.route,
    effectiveConflict: routeConflict(options.route),
    source: sourceRoute(options.route)
      ? {
          classification: 'generation-bound',
          cacheKey: '9'.repeat(24),
          generationDigest: GENERATION_DIGEST,
          markerSha256: MARKER_DIGEST,
          rootIdentity: { device: '1', inode: '2' },
        }
      : {
          classification: 'none',
          cacheKey: null,
          generationDigest: null,
          markerSha256: null,
          rootIdentity: null,
        },
    destinationParentPreexisting,
    destinationRuntimePreexisting,
    destinationRootIdentity: destinationRuntimePreexisting ? { device: '3', inode: '4' } : null,
    ...(sourceRoute(options.route) ? { sourceRuntimeDir: SOURCE_RUNTIME } : {}),
    destinationParentDir: `${canonicalRoot}/opensip-cli`,
    destinationRuntimeDir: `${canonicalRoot}/opensip-cli/.runtime`,
    preliminaryEquality: options.route === 'deduplicate-cache' ? 'verified-equal' : 'not-required',
    revalidation: {
      projectRoot: canonicalRoot,
      coordinationKey: PROJECT_KEY,
    } as RuntimePromotionPreflightSelected['revalidation'],
  };
}

function journalEvent(content: string): string {
  const journal = JSON.parse(content) as RuntimePromotionJournal;
  const pending = journal.progress.pendingIntent;
  if (pending !== null) return `intent:${pending.kind}`;
  if (journal.terminal !== null) return `terminal:${journal.terminal.outcome}`;
  return `phase:${journal.progress.phase}`;
}

function createHarness(options: HarnessOptions): Harness {
  const canonicalRoot = options.canonicalRoot ?? CANONICAL_ROOT;
  const preflight = selectedPreflight(options, canonicalRoot);
  const state: HarnessState = {
    events: [],
    mutations: [],
    content: undefined,
    sourcePresent: sourceRoute(options.route),
    sourceDigest: SOURCE_DIGEST,
    destinationPresent: preflight.destinationRuntimePreexisting,
    destinationDigest: options.route === 'deduplicate-cache' ? SOURCE_DIGEST : DESTINATION_DIGEST,
    authoredAuthority: 'preimage',
    released: 0,
    projectRootChanged: false,
  };
  let clock = 100;
  const now = (): number => ++clock;
  const lease = Object.freeze({
    kind: 'runtime-exclusive',
    coordinationKey: PROJECT_KEY,
    posture: 'normal',
    ownerToken: 'fresh-promotion-lease-owner-0001',
    acquiredAt: 1,
    release: () => {
      state.released += 1;
      state.events.push('lease:release');
    },
  }) satisfies RuntimeExclusiveLease;
  let controller: RuntimePromotionJournalController;
  let writer: RuntimePromotionTransitionWriter;
  let boundReceipt: DurableOpenPromotionJournal;

  const checkpoint = (value: RuntimePromotionCheckpoint): void => {
    state.events.push(`checkpoint:${value}`);
    options.checkpointHook?.(value, state);
    if (options.rootSwapAt === value) state.projectRootChanged = true;
    if (options.faultAt === value) throw new Error(`fault:${value}`);
  };

  const dependencies: Partial<RuntimePromotionDependencies> = {
    now,
    checkpoint,
    acquireLease: (input) => {
      state.events.push(`lease:acquire:${input.projectDir}`);
      return Promise.resolve(lease);
    },
    preflight: (input) => {
      state.events.push(`preflight:${input.projectRoot}`);
      return preflight;
    },
    assertPreflightUnchanged: () => {
      state.events.push('preflight:revalidate');
      if (options.revalidationFailure || state.projectRootChanged) {
        throw new Error('preflight changed');
      }
    },
    bindProjectRootAuthority: ({ token }) => ({
      version: 1,
      projectRoot: token.projectRoot,
      coordinationKey: token.coordinationKey,
      leasePosture: 'normal',
      identity: {
        dev: '1',
        ino: '2',
        uid: '3',
        mode: String(0o4_0700),
      },
      destinationParent: null,
    }),
    assertProjectRootAuthority: () => {
      state.events.push('project-root:assert');
      if (state.projectRootChanged) throw new Error('project root changed');
    },
    assertDestinationRootAuthority: () => {
      state.events.push('destination-root:assert');
    },
    checkpointDatastores: ({ candidates }) => {
      state.events.push(`datastores:${candidates.map(({ kind }) => kind).join(',')}`);
      return [];
    },
    createPlan: (input) => {
      state.events.push(`plan:${input.projectRoot}`);
      if (options.planFailure) throw new Error('plan failed');
      return plan(input.mode);
    },
    createController: (actualLease) => {
      controller = createRuntimePromotionJournalController(actualLease, {
        now,
        generateOperationId: () => 'fresh-promotion-operation-0001',
        generateRecoveryOwnerToken: () => 'fresh-promotion-recovery-owner-0001',
        read: () => {
          const result: AnchoredRecordReadResult =
            state.content === undefined
              ? { status: 'absent' }
              : {
                  status: 'present',
                  content: state.content,
                  sha256: sha256(state.content),
                };
          return Promise.resolve(result);
        },
        mutate: (_actualLease, mutation) => {
          state.mutations.push(mutation);
          if (mutation.operation === 'create') {
            if (state.content !== undefined) throw new Error('create collision');
            state.content = mutation.content;
            state.events.push('journal:create');
          } else if (mutation.operation === 'replace') {
            if (
              state.content === undefined ||
              sha256(state.content) !== mutation.expectedContentSha256
            ) {
              throw new Error('replace collision');
            }
            options.journalMutationHook?.(
              JSON.parse(mutation.content) as RuntimePromotionJournal,
              state,
            );
            state.content = mutation.content;
            state.events.push(journalEvent(mutation.content));
          } else {
            if (
              state.content === undefined ||
              sha256(state.content) !== mutation.expectedContentSha256
            ) {
              throw new Error('unlink collision');
            }
            state.content = undefined;
            state.events.push('journal:unlink');
          }
          return Promise.resolve({ strategy: 'portable-anchored' });
        },
      });
      return controller;
    },
    createWriter: (actualController) => {
      writer = createRuntimePromotionTransitionWriter(actualController, {
        now,
      });
      return writer;
    },
    inspectManifest: (runtimeDir, posture) => {
      state.events.push(`inspect:${posture}:${runtimeDir}`);
      if (posture === 'cache-source') {
        if (!state.sourcePresent) throw new Error('cache source absent');
        return manifest(state.sourceDigest);
      }
      if (!state.destinationPresent) throw new Error('project runtime absent');
      return manifest(state.destinationDigest);
    },
    copyStage: () => {
      state.events.push('fs:copy-stage');
      const source = manifest(SOURCE_DIGEST);
      return Promise.resolve({
        stageDir: `${DESTINATION_PARENT}/stage`,
        source,
        stage: source,
      });
    },
    prepareAuthored: async (input) => {
      state.events.push('authored:prepare');
      boundReceipt = await recordOpenIntent(
        input.controller,
        input.receipt,
        'authored-prepare',
        'authoredStage',
        null,
        now,
      );
      boundReceipt = await recordOpenPostcondition(
        input.controller,
        boundReceipt,
        {
          phase: 'authored-prepared',
          outcome: 'applied',
          prepareArtifacts: true,
        },
        now,
      );
      const transaction = {
        operationId: boundReceipt.operationId,
        mutationCount: 0,
      } as Parameters<RuntimePromotionDependencies['bindAuthoredReceipt']>[0];
      return { transaction, receipt: boundReceipt, summary: PREPARED_SUMMARY };
    },
    bindAuthoredReceipt: (_transaction, receipt) => {
      state.events.push('authored:bind');
      boundReceipt = receipt;
      return Promise.resolve();
    },
    loadClosedAuthored: (input) => {
      state.events.push('authored:load-closed');
      options.closedAuthoredLoadHook?.(state);
      return Promise.resolve({
        operationId: input.receipt.operationId,
        mutationCount: 1,
      } as Awaited<ReturnType<RuntimePromotionDependencies['loadClosedAuthored']>>);
    },
    commitAuthored: async () => {
      state.events.push('authored:commit');
      boundReceipt = await recordOpenIntent(
        controller,
        boundReceipt,
        'authored-target-commit',
        'replayManifest',
        0,
        now,
      );
      boundReceipt = await recordOpenPostcondition(
        controller,
        boundReceipt,
        {
          phase: 'authored-committed',
          outcome: 'applied',
          authoredDelta: 1,
        },
        now,
      );
      state.authoredAuthority = 'desired';
      return { receipt: boundReceipt, summary: SUMMARY };
    },
    rollbackAuthored: async () => {
      state.events.push('authored:rollback');
      const current = await controller.verifyOpen(boundReceipt);
      if (current.progress.authoredCursor === 0) {
        boundReceipt = await advanceAuthoredPhase(
          controller,
          boundReceipt,
          'authored-rolled-back',
          now,
        );
      } else {
        boundReceipt = await recordOpenIntent(
          controller,
          boundReceipt,
          'authored-target-rollback',
          'replayManifest',
          0,
          now,
        );
        boundReceipt = await recordOpenPostcondition(
          controller,
          boundReceipt,
          {
            phase: 'authored-rolled-back',
            outcome: 'applied',
            rollbackDelta: 1,
          },
          now,
        );
      }
      state.authoredAuthority = 'preimage';
      return { receipt: boundReceipt, summary: SUMMARY };
    },
    verifyAuthored: (_transaction, expected) => {
      state.events.push(`authored:verify:${expected}`);
      options.authoredVerificationHook?.(expected, state);
      if (state.authoredAuthority !== expected) {
        return Promise.reject(new Error(`authored ${expected} authority changed`));
      }
      return Promise.resolve(SUMMARY);
    },
    cleanupAuthored: async (_transaction, initialReceipt) => {
      state.events.push('authored:cleanup');
      let receipt = initialReceipt;
      for (const slot of ['authoredStage', 'authoredBackup', 'replayManifest'] as const) {
        const current = await controller.verifyReceipt(receipt, {
          state: 'closed',
        });
        if (current.cleanup[slot] !== 'pending') continue;
        receipt = await writer.recordCleanupIntent(receipt, slot);
        receipt = await writer.recordCleanupPostcondition(receipt, slot, 'already-satisfied');
      }
      return { receipt, summary: SUMMARY };
    },
    authorizeFilesystem: (input) => {
      state.events.push(`authorize:${input.action}:${input.projectRoot}`);
      return Promise.resolve({
        operationId: input.receipt.operationId,
        revision: input.receipt.revision,
        action: input.action,
      } as Parameters<RuntimePromotionDependencies['createDestinationParent']>[0]);
    },
    createDestinationParent: () => {
      state.events.push('fs:destination-parent-create');
      if (options.filesystemFailure?.action === 'destination-parent-create') {
        if (options.filesystemFailure.afterEffect) {
          state.events.push('fs:destination-parent-created-before-fault');
        }
        throw new Error('destination parent fault');
      }
      return Promise.resolve({ status: 'created' });
    },
    reconcileStage: () => {
      state.events.push('fs:stage-reconcile');
      return Promise.resolve({ status: 'absent' });
    },
    backupDestination: () => {
      state.events.push('fs:destination-backup');
      return Promise.resolve({ status: 'applied' });
    },
    installStage: () => {
      state.events.push('fs:destination-install');
      if (
        options.filesystemFailure?.action === 'destination-install' &&
        !options.filesystemFailure.afterEffect
      ) {
        throw new Error('install fault');
      }
      state.destinationPresent = true;
      state.destinationDigest = SOURCE_DIGEST;
      if (options.filesystemFailure?.action === 'destination-install') {
        throw new Error('install post-effect fault');
      }
      return Promise.resolve({ status: 'applied' });
    },
    refreshSourceRetirementProof: () => {
      state.events.push('source:refresh-proof');
      return { version: 1 } as ReturnType<
        RuntimePromotionDependencies['refreshSourceRetirementProof']
      >;
    },
    assertSourceRetirementUnchanged: () => {
      state.events.push('source:revalidate');
    },
    retireSource: () => {
      state.events.push('fs:source-retire');
      state.sourcePresent = false;
      return Promise.resolve({
        status: 'applied',
        manifest: manifest(state.sourceDigest),
      });
    },
    rollbackRuntime: (_authority, input) => {
      state.events.push('fs:runtime-rollback');
      state.destinationPresent = input.backup !== null;
      state.destinationDigest = DESTINATION_DIGEST;
      return Promise.resolve({
        status: 'rolled-back',
        runtimeInstallState: input.installedWasAuthoritative ? 'rolled-back' : 'backup-restored',
        restored: input.backup === null ? null : manifest(DESTINATION_DIGEST),
      });
    },
    cleanupOwnedSlot: (authority) => {
      state.events.push(`fs:cleanup:${authority.action}`);
      const current = JSON.parse(state.content ?? '{}') as RuntimePromotionJournal;
      return Promise.resolve({
        slot: current.progress.pendingIntent?.slot,
        status: 'removed',
      } as Awaited<ReturnType<RuntimePromotionDependencies['cleanupOwnedSlot']>>);
    },
  };
  const input: FreshRuntimePromotionInput = {
    projectRoot: options.inputRoot ?? canonicalRoot,
    languages: ['typescript'],
    languageExplicit: false,
    authoredMode: options.authoredMode ?? 'fresh',
    toolScaffolds: [],
    datastoreLockContext: {
      policy: { waitMs: 100, staleMs: 1000, heartbeatMs: 100 },
      command: 'opensip init',
      cwdBasename: 'project',
    },
    conflict: routeConflict(options.route),
  };
  return {
    input,
    dependencies,
    state,
    run: () => runFreshRuntimePromotion(input, dependencies),
    journal: () =>
      state.content === undefined
        ? undefined
        : (JSON.parse(state.content) as RuntimePromotionJournal),
  };
}

describe('fresh runtime promotion coordinator', () => {
  it.each(['keep', 'remove'] as const)(
    'records explicit %s mode durably for a pristine authored-only operation',
    async (authoredMode) => {
      let recordedMode: RuntimePromotionJournal['inputs']['authoredMode'] | undefined;
      const harness = createHarness({
        route: 'authored-only',
        authoredMode,
        checkpointHook: (checkpoint, state) => {
          if (checkpoint !== 'after-journal-created' || state.content === undefined) return;
          recordedMode = (JSON.parse(state.content) as RuntimePromotionJournal).inputs.authoredMode;
        },
      });

      await expect(harness.run()).resolves.toMatchObject({ status: 'not-found' });
      expect(recordedMode).toBe(authoredMode);
    },
  );

  it.each([
    ['authored-only', 'not-found', 'source-absent'],
    ['project-authority', 'already-project', 'source-absent'],
    ['promote-cache', 'promoted', 'destination-absent'],
    ['keep-project', 'kept-project', undefined],
    ['deduplicate-cache', 'deduplicated', 'equivalent'],
  ] as const)(
    'commits, cleans, and unlinks the %s route',
    async (route, expectedStatus, expectedReason) => {
      const harness = createHarness({ route });
      const result = await harness.run();
      expect(result).toMatchObject({
        status: expectedStatus,
        sourcePreserved: false,
        authored: { created: 1, replaced: 0, deleted: 0, preserved: 0 },
      });
      if (expectedReason === undefined) {
        expect(result).not.toHaveProperty('reasonCode');
      } else {
        expect(result.reasonCode).toBe(expectedReason);
      }
      expect(harness.state.content).toBeUndefined();
      expect(harness.state.released).toBe(1);
    },
  );

  it('does not invent divergence when use-cache explicitly replaces an existing destination', async () => {
    const harness = createHarness({
      route: 'promote-cache',
      destinationParentPreexisting: true,
      destinationRuntimePreexisting: true,
    });
    const result = await harness.run();
    expect(result).toMatchObject({ status: 'promoted' });
    expect(result).not.toHaveProperty('reasonCode');
  });

  it('orders preflight, planning, journal creation, checkpointing, and every filesystem intent', async () => {
    const harness = createHarness({ route: 'promote-cache' });
    await expect(harness.run()).resolves.toMatchObject({ status: 'promoted' });
    const { events } = harness.state;
    expect(events.indexOf(`preflight:${CANONICAL_ROOT}`)).toBeLessThan(
      events.indexOf(`plan:${CANONICAL_ROOT}`),
    );
    expect(events.indexOf('preflight:revalidate')).toBeLessThan(events.indexOf('journal:create'));
    expect(events.indexOf('journal:create')).toBeLessThan(events.indexOf('datastores:source'));
    for (const [intent, effect] of [
      ['intent:destination-parent-create', 'fs:destination-parent-create'],
      ['intent:runtime-stage-create', 'fs:stage-reconcile'],
      ['intent:destination-install', 'fs:destination-install'],
      ['intent:source-retire', 'fs:source-retire'],
    ] as const) {
      expect(events.indexOf(intent)).toBeLessThan(events.indexOf(effect));
    }
  });

  it.each([
    {
      name: 'retains',
      reason: 'checkpoint-incomplete' as const,
      closeResult: {
        checkpointed: true,
        closed: false,
        reason: 'native-close-failed',
      } as const,
      expectedReleases: 0,
    },
    {
      name: 'releases',
      reason: 'checkpoint-incomplete' as const,
      closeResult: {
        checkpointed: false,
        closed: true,
        reason: 'checkpoint-failed',
      } as const,
      expectedReleases: 1,
    },
    {
      name: 'retains a conservatively mapped throwing-inspector result',
      reason: 'database-unreadable' as const,
      closeResult: {
        checkpointed: false,
        closed: false,
        reason: 'checkpoint-and-close-failed',
      } as const,
      expectedReleases: 0,
    },
  ])(
    '$name the process-owned lease according to the native close proof',
    async ({ reason, closeResult, expectedReleases }) => {
      const harness = createHarness({ route: 'authored-only' });
      const result = await runFreshRuntimePromotion(harness.input, {
        ...harness.dependencies,
        checkpointDatastores: () => {
          throw new RuntimePromotionDatastoreError(reason, closeResult);
        },
      });

      expect(result.status).toBe('rolled-back');
      expect(harness.state.released).toBe(expectedReleases);
    },
  );

  it('retains the process-owned lease for an asynchronous unclosed-handle proof', async () => {
    const harness = createHarness({ route: 'authored-only' });
    const result = await runFreshRuntimePromotion(harness.input, {
      ...harness.dependencies,
      checkpointDatastores: () =>
        Promise.reject(
          new RuntimePromotionDatastoreError('checkpoint-incomplete', {
            checkpointed: false,
            closed: false,
            reason: 'checkpoint-and-close-failed',
          }),
        ),
    });

    expect(result.status).toBe('rolled-back');
    expect(harness.state.released).toBe(0);
  });

  it('retains the process-owned lease when forward manifest inspection cannot prove SQLite closure', async () => {
    const harness = createHarness({ route: 'keep-project' });
    const result = await runFreshRuntimePromotion(harness.input, {
      ...harness.dependencies,
      inspectManifest: () => {
        throw new RuntimeManifestError('sqlite-native-close-failed', {
          releaseSafe: false,
        });
      },
    });

    expect(result).toMatchObject({
      status: 'recovery-required',
      sourcePreserved: false,
    });
    expect(harness.state.released).toBe(0);
    expect(harness.journal()).toMatchObject({ state: 'open' });
  });

  it.each([
    ['vanishes', () => new Error('cache source absent')],
    ['changes', () => new RuntimeManifestError('changed')],
  ] as const)(
    'reports the selected source as unpreserved when it %s during initial inspection',
    async (_sourceFailure, failure) => {
      const harness = createHarness({ route: 'keep-project' });
      const inspectManifest = harness.dependencies.inspectManifest;
      if (inspectManifest === undefined) throw new Error('Harness manifest inspector is missing');

      const result = await runFreshRuntimePromotion(harness.input, {
        ...harness.dependencies,
        inspectManifest: (runtimeDir, posture) => {
          if (posture === 'cache-source') throw failure();
          return inspectManifest(runtimeDir, posture);
        },
      });

      expect(result).toMatchObject({
        status: 'recovery-required',
        sourcePreserved: false,
      });
      expect(harness.journal()).toMatchObject({
        state: 'open',
        manifests: { source: null },
      });
      expect(harness.state.events.some((event) => /^(?:authored|fs):/u.test(event))).toBe(false);
    },
  );

  it('retains the lease and reports an unpreserved source when rollback reinspection cannot prove SQLite closure', async () => {
    const harness = createHarness({
      route: 'keep-project',
      faultAt: 'after-authored-verified',
    });
    const inspectManifest = harness.dependencies.inspectManifest;
    if (inspectManifest === undefined) throw new Error('Harness manifest inspector is missing');

    const result = await runFreshRuntimePromotion(harness.input, {
      ...harness.dependencies,
      inspectManifest: (runtimeDir, posture) => {
        const journal = harness.journal();
        if (
          posture === 'cache-source' &&
          journal?.state === 'open' &&
          journal.progress.direction === 'rollback' &&
          journal.progress.phase === 'authored-rolled-back'
        ) {
          throw new RuntimeManifestError('sqlite-native-close-failed', {
            releaseSafe: false,
          });
        }
        return inspectManifest(runtimeDir, posture);
      },
    });

    expect(result).toMatchObject({
      status: 'recovery-required',
      sourcePreserved: false,
    });
    expect(harness.state.released).toBe(0);
    expect(harness.journal()).toMatchObject({
      state: 'open',
      progress: { phase: 'authored-rolled-back', direction: 'rollback' },
      terminal: null,
    });
  });

  it('retains the process-owned lease when swallowed cleanup cannot prove SQLite closure', async () => {
    const harness = createHarness({ route: 'keep-project' });
    const result = await runFreshRuntimePromotion(harness.input, {
      ...harness.dependencies,
      cleanupOwnedSlot: () =>
        Promise.reject(
          new RuntimeManifestError('sqlite-close-unproven', {
            releaseSafe: false,
          }),
        ),
    });

    expect(result).toMatchObject({
      status: 'cleanup-pending',
      cleanupPending: true,
    });
    expect(harness.state.released).toBe(0);
    expect(harness.journal()).toMatchObject({ state: 'closed' });
  });

  it('retains the lease and reports an unpreserved source when fresh rollback cleanup reinspection is release-unsafe', async () => {
    const harness = createHarness({
      route: 'keep-project',
      faultAt: 'after-authored-verified',
    });
    const inspectManifest = harness.dependencies.inspectManifest;
    if (inspectManifest === undefined) throw new Error('Harness manifest inspector is missing');
    let closedSourceInspections = 0;

    const result = await runFreshRuntimePromotion(harness.input, {
      ...harness.dependencies,
      inspectManifest: (runtimeDir, posture) => {
        const journal = harness.journal();
        if (
          posture === 'cache-source' &&
          journal?.state === 'closed' &&
          ++closedSourceInspections === 3
        ) {
          throw new RuntimeManifestError('sqlite-close-unproven', {
            releaseSafe: false,
          });
        }
        return inspectManifest(runtimeDir, posture);
      },
    });

    expect(result).toMatchObject({
      status: 'rolled-back',
      cleanupPending: true,
      sourcePreserved: false,
      reasonCode: 'operation-failed',
      nextCommand: 'opensip init',
    });
    expect(harness.state.released).toBe(0);
    expect(harness.journal()).toMatchObject({
      state: 'closed',
      terminal: { outcome: 'rolled-back' },
    });
    expect(harness.state.events).not.toContain('journal:unlink');
  });

  it('does not record cleanup for a different slot than the filesystem result', async () => {
    const harness = createHarness({ route: 'keep-project' });
    const result = await runFreshRuntimePromotion(harness.input, {
      ...harness.dependencies,
      cleanupOwnedSlot: () =>
        Promise.resolve({
          slot: 'runtimeStage',
          status: 'removed',
        }),
    });

    expect(result).toMatchObject({
      status: 'cleanup-pending',
      cleanupPending: true,
    });
    expect(harness.journal()).toMatchObject({
      state: 'closed',
      progress: {
        pendingIntent: {
          kind: 'owned-slot-cleanup',
          slot: 'sourceTombstone',
        },
      },
      cleanup: { sourceTombstone: 'pending' },
    });
  });

  it('leaves recovery evidence without touching a replacement root after journal creation', async () => {
    const harness = createHarness({
      route: 'promote-cache',
      rootSwapAt: 'after-journal-created',
    });
    const result = await harness.run();
    expect(result).toMatchObject({
      status: 'recovery-required',
      sourcePreserved: false,
    });
    expect(harness.journal()).toMatchObject({
      state: 'open',
      progress: {
        phase: 'prepared',
        direction: 'forward',
        pendingIntent: null,
      },
    });
    expect(harness.state.events.some((event) => /^(?:datastores|authored|fs):/u.test(event))).toBe(
      false,
    );
    expect(harness.state.released).toBe(1);
  });

  it.each([
    ['after-runtime-installed', 'promote-cache', 'recovery-required'],
    ['after-source-retired', 'keep-project', 'recovery-required'],
    ['after-journal-closed', 'authored-only', 'recovery-required'],
  ] as const)(
    'does not mutate a replacement root after %s',
    async (checkpoint, route, expectedStatus) => {
      const harness = createHarness({ route, rootSwapAt: checkpoint });
      const result = await harness.run();
      expect(result.status).toBe(expectedStatus);
      const boundary = harness.state.events.indexOf(`checkpoint:${checkpoint}`);
      expect(boundary).toBeGreaterThanOrEqual(0);
      const replacementEffects = harness.state.events
        .slice(boundary + 1)
        .filter((event) => /^(?:datastores|authored|fs|inspect:project-runtime):/u.test(event));
      expect(replacementEffects).toEqual([]);
      expect(harness.state.released).toBe(1);
    },
  );

  it.each([
    ['after-journal-created', 'authored-only', false, 'rolled-back'],
    ['after-datastore-checkpoint', 'authored-only', false, 'rolled-back'],
    ['after-source-verified', 'promote-cache', false, 'recovery-required'],
    ['after-destination-verified', 'promote-cache', false, 'rolled-back'],
    ['after-authored-prepared', 'promote-cache', false, 'rolled-back'],
    ['after-destination-ready', 'promote-cache', false, 'rolled-back'],
    ['after-runtime-staged', 'promote-cache', false, 'rolled-back'],
    ['after-destination-backed-up', 'promote-cache', true, 'rolled-back'],
    ['after-runtime-installed', 'promote-cache', false, 'rolled-back'],
    ['after-authored-committed', 'keep-project', true, 'rolled-back'],
    ['after-authored-verified', 'keep-project', true, 'rolled-back'],
    ['after-source-retired', 'keep-project', true, 'recovery-required'],
    ['after-terminal-sealed', 'authored-only', false, 'not-found'],
    ['after-journal-closed', 'authored-only', false, 'not-found'],
    ['after-cleanup', 'authored-only', false, 'cleanup-pending'],
  ] as const)(
    'settles the %s fault on %s without guessing',
    async (faultAt, route, destinationRuntimePreexisting, expectedStatus) => {
      const harness = createHarness({
        route,
        destinationRuntimePreexisting,
        destinationParentPreexisting: destinationRuntimePreexisting,
        faultAt,
      });
      const result = await harness.run();
      expect(result.status).toBe(expectedStatus);
      expect(harness.state.released).toBe(1);
      if (expectedStatus === 'recovery-required' || expectedStatus === 'cleanup-pending') {
        expect(harness.state.content).toBeDefined();
      } else {
        expect(harness.state.content).toBeUndefined();
      }
    },
  );

  it.each([false, true])(
    'leaves an exact open intent when destination install fails (afterEffect=%s)',
    async (afterEffect) => {
      const harness = createHarness({
        route: 'promote-cache',
        filesystemFailure: { action: 'destination-install', afterEffect },
      });
      await expect(harness.run()).resolves.toMatchObject({
        status: 'recovery-required',
        nextCommand: 'opensip init',
      });
      expect(harness.journal()?.progress.pendingIntent?.kind).toBe('destination-install');
      expect(harness.state.events).not.toContain('fs:runtime-rollback');
    },
  );

  it('does not retire the source when destination authority changes after authored verification', async () => {
    const harness = createHarness({
      route: 'keep-project',
      checkpointHook: (checkpoint, state) => {
        if (checkpoint === 'after-authored-verified') {
          state.destinationDigest = CHANGED_DIGEST;
        }
      },
    });
    await expect(harness.run()).resolves.toMatchObject({
      status: 'recovery-required',
    });
    expect(harness.state.sourcePresent).toBe(true);
    expect(harness.state.events).not.toContain('fs:source-retire');
    expect(harness.journal()?.cleanup.sourceTombstone).toBe('unmaterialized');
  });

  it('reports source preservation as unproven when opaque retirement fails after moving the source', async () => {
    const harness = createHarness({ route: 'keep-project' });
    const result = await runFreshRuntimePromotion(harness.input, {
      ...harness.dependencies,
      retireSource: () => {
        harness.state.events.push('fs:source-retire');
        harness.state.sourcePresent = false;
        return Promise.reject(new Error('post-rename retirement proof failed'));
      },
    });

    expect(result).toMatchObject({
      status: 'recovery-required',
      sourcePreserved: false,
    });
    expect(harness.journal()).toMatchObject({
      state: 'open',
      progress: {
        pendingIntent: {
          kind: 'source-retire',
          slot: 'sourceTombstone',
        },
      },
    });
  });

  it('rejects a retired tombstone manifest that does not prove the selected source', async () => {
    const harness = createHarness({ route: 'keep-project' });
    const result = await runFreshRuntimePromotion(harness.input, {
      ...harness.dependencies,
      retireSource: () => {
        harness.state.sourcePresent = false;
        return Promise.resolve({
          status: 'applied',
          manifest: manifest(CHANGED_DIGEST),
        });
      },
    });

    expect(result).toMatchObject({
      status: 'recovery-required',
      sourcePreserved: false,
    });
    expect(harness.journal()).toMatchObject({
      state: 'open',
      progress: {
        pendingIntent: {
          kind: 'source-retire',
          slot: 'sourceTombstone',
        },
      },
    });
  });

  it('preserves exact owned-tombstone proof after retirement returns and a later checkpoint fails', async () => {
    const harness = createHarness({
      route: 'keep-project',
      faultAt: 'after-source-retired',
    });

    await expect(harness.run()).resolves.toMatchObject({
      status: 'recovery-required',
      sourcePreserved: true,
    });
    expect(harness.state.sourcePresent).toBe(false);
    expect(harness.journal()).toMatchObject({
      state: 'open',
      progress: {
        phase: 'source-retired',
        pendingIntent: null,
      },
      cleanup: { sourceTombstone: 'pending' },
    });
  });

  it.each(['runtime', 'authored'] as const)(
    'returns recovery-required when committed %s authority changes after close',
    async (mutatedAuthority) => {
      const harness = createHarness({
        route: 'keep-project',
        checkpointHook: (checkpoint, state) => {
          if (checkpoint !== 'after-journal-closed') return;
          if (mutatedAuthority === 'runtime') state.destinationDigest = CHANGED_DIGEST;
          if (mutatedAuthority === 'authored') state.authoredAuthority = 'changed';
        },
      });

      await expect(harness.run()).resolves.toMatchObject({
        status: 'recovery-required',
        reasonCode: 'operation-failed',
      });
      expect(harness.journal()).toMatchObject({
        state: 'closed',
        cleanup: { sourceTombstone: 'pending' },
      });
      expect(harness.state.events.some((event) => event.startsWith('fs:cleanup:'))).toBe(false);
    },
  );

  it.each(['after-authority-verified', 'after-terminal-sealed'] as const)(
    'does not close committed authority when the project runtime changes at %s',
    async (checkpoint) => {
      const harness = createHarness({
        route: 'keep-project',
        checkpointHook: (observed, state) => {
          if (observed === checkpoint) state.destinationDigest = CHANGED_DIGEST;
        },
      });

      await expect(harness.run()).resolves.toMatchObject({
        status: 'recovery-required',
        sourcePreserved: true,
      });
      expect(harness.journal()).toMatchObject({ state: 'open' });
      expect(harness.state.events).not.toContain('journal:unlink');
    },
  );

  it.each(['after-authority-verified', 'after-terminal-sealed'] as const)(
    'does not close committed authority when authored desired state changes at %s',
    async (checkpoint) => {
      const harness = createHarness({
        route: 'keep-project',
        checkpointHook: (observed, state) => {
          if (observed === checkpoint) state.authoredAuthority = 'changed';
        },
      });

      await expect(harness.run()).resolves.toMatchObject({ status: 'recovery-required' });
      expect(harness.journal()).toMatchObject({ state: 'open' });
      expect(harness.state.events).not.toContain('journal:unlink');
    },
  );

  it('rechecks runtime authority after the authority-verification journal write', async () => {
    const harness = createHarness({
      route: 'keep-project',
      journalMutationHook: (next, state) => {
        if (next.progress.phase === 'authority-verified') {
          state.destinationDigest = CHANGED_DIGEST;
        }
      },
    });

    await expect(harness.run()).resolves.toMatchObject({ status: 'recovery-required' });
    expect(harness.journal()).toMatchObject({
      state: 'open',
      progress: { phase: 'authority-verified' },
    });
  });

  it('rechecks authored desired state after the committed-terminal journal write', async () => {
    const harness = createHarness({
      route: 'keep-project',
      journalMutationHook: (next, state) => {
        if (next.state === 'open' && next.terminal?.outcome === 'committed') {
          state.authoredAuthority = 'changed';
        }
      },
    });

    await expect(harness.run()).resolves.toMatchObject({ status: 'recovery-required' });
    expect(harness.journal()).toMatchObject({
      state: 'open',
      terminal: { outcome: 'committed' },
    });
    expect(harness.state.events).not.toContain('journal:unlink');
  });

  it('rechecks committed runtime after awaited open authored verification before close', async () => {
    let mutated = false;
    const harness = createHarness({
      route: 'keep-project',
      authoredVerificationHook: (expected, state) => {
        if (mutated || expected !== 'desired' || state.content === undefined) return;
        const journal = JSON.parse(state.content) as RuntimePromotionJournal;
        if (journal.state !== 'open' || journal.terminal?.outcome !== 'committed') return;
        mutated = true;
        state.destinationDigest = CHANGED_DIGEST;
      },
    });

    await expect(harness.run()).resolves.toMatchObject({
      status: 'recovery-required',
      sourcePreserved: true,
    });
    expect(harness.journal()).toMatchObject({
      state: 'open',
      terminal: { outcome: 'committed' },
    });
    expect(harness.state.events).not.toContain('checkpoint:after-terminal-sealed');
    expect(harness.state.events).not.toContain('journal:unlink');
  });

  it.each(['runtime', 'authored'] as const)(
    'rechecks committed %s authority after the journal close write',
    async (mutatedAuthority) => {
      const harness = createHarness({
        route: 'keep-project',
        journalMutationHook: (next, state) => {
          if (next.state !== 'closed' || next.terminal?.outcome !== 'committed') return;
          if (mutatedAuthority === 'runtime') state.destinationDigest = CHANGED_DIGEST;
          if (mutatedAuthority === 'authored') state.authoredAuthority = 'changed';
        },
      });

      await expect(harness.run()).resolves.toMatchObject({ status: 'recovery-required' });
      expect(harness.journal()).toMatchObject({
        state: 'closed',
        terminal: { outcome: 'committed' },
      });
      expect(harness.state.events.some((event) => event.startsWith('fs:cleanup:'))).toBe(false);
    },
  );

  it('rechecks committed runtime after awaited fresh-closed authored verification', async () => {
    let mutated = false;
    const harness = createHarness({
      route: 'keep-project',
      closedAuthoredLoadHook: (state) => {
        if (mutated) return;
        mutated = true;
        state.destinationDigest = CHANGED_DIGEST;
      },
    });

    await expect(harness.run()).resolves.toMatchObject({
      status: 'recovery-required',
      sourcePreserved: true,
    });
    expect(harness.journal()).toMatchObject({
      state: 'closed',
      terminal: { outcome: 'committed' },
    });
    expect(harness.state.events).not.toContain('checkpoint:after-journal-closed');
    expect(harness.state.events).not.toContain('journal:unlink');
  });

  it.each([
    ['keep-project', undefined, 'removed'],
    ['keep-project', undefined, 'replaced'],
    ['deduplicate-cache', undefined, 'removed'],
    ['deduplicate-cache', undefined, 'replaced'],
    ['promote-cache', false, 'removed'],
    ['promote-cache', false, 'replaced'],
    ['promote-cache', true, 'removed'],
    ['promote-cache', true, 'replaced'],
  ] as const)(
    'leaves %s rollback open with destinationPreexisting=%s when its source is %s',
    async (route, destinationRuntimePreexisting, sourceMutation) => {
      const harness = createHarness({
        route,
        ...(destinationRuntimePreexisting === undefined
          ? {}
          : {
              destinationRuntimePreexisting,
              destinationParentPreexisting: destinationRuntimePreexisting,
            }),
        faultAt: 'after-authored-verified',
        authoredVerificationHook: (expected, state) => {
          if (expected !== 'preimage') return;
          if (sourceMutation === 'removed') {
            state.sourcePresent = false;
          } else {
            state.sourceDigest = CHANGED_DIGEST;
          }
        },
      });

      await expect(harness.run()).resolves.toMatchObject({
        status: 'recovery-required',
        sourcePreserved: false,
      });
      expect(harness.journal()).toMatchObject({
        state: 'open',
        progress: { phase: 'authored-rolled-back' },
        terminal: null,
      });
      expect(harness.state.events).not.toContain('journal:unlink');
    },
  );

  it.each(['runtime', 'source'] as const)(
    'rechecks rolled-back %s authority after awaited open authored verification before close',
    async (mutatedAuthority) => {
      let preimageVerifications = 0;
      const harness = createHarness({
        route: 'keep-project',
        faultAt: 'after-authored-verified',
        authoredVerificationHook: (expected, state) => {
          if (expected !== 'preimage' || ++preimageVerifications !== 2) return;
          if (mutatedAuthority === 'runtime') state.destinationDigest = CHANGED_DIGEST;
          if (mutatedAuthority === 'source') state.sourceDigest = CHANGED_DIGEST;
        },
      });

      await expect(harness.run()).resolves.toMatchObject({
        status: 'recovery-required',
        sourcePreserved: mutatedAuthority !== 'source',
      });
      expect(harness.journal()).toMatchObject({
        state: 'open',
        progress: { phase: 'authored-rolled-back' },
        terminal: null,
      });
      expect(harness.state.events).not.toContain('journal:unlink');
    },
  );

  it.each(['runtime', 'source', 'authored'] as const)(
    'rechecks rolled-back %s authority after the terminal journal write',
    async (mutatedAuthority) => {
      const harness = createHarness({
        route: 'keep-project',
        faultAt: 'after-authored-verified',
        journalMutationHook: (next, state) => {
          if (next.state !== 'open' || next.terminal?.outcome !== 'rolled-back') return;
          if (mutatedAuthority === 'runtime') state.destinationDigest = CHANGED_DIGEST;
          if (mutatedAuthority === 'source') state.sourceDigest = CHANGED_DIGEST;
          if (mutatedAuthority === 'authored') state.authoredAuthority = 'changed';
        },
      });

      await expect(harness.run()).resolves.toMatchObject({
        status: 'recovery-required',
        sourcePreserved: mutatedAuthority !== 'source',
      });
      expect(harness.journal()).toMatchObject({
        state: 'open',
        terminal: { outcome: 'rolled-back' },
      });
      expect(harness.state.events).not.toContain('journal:unlink');
    },
  );

  it.each(['runtime', 'source', 'authored'] as const)(
    'rechecks rolled-back %s authority after the journal close write',
    async (mutatedAuthority) => {
      const harness = createHarness({
        route: 'keep-project',
        faultAt: 'after-authored-verified',
        journalMutationHook: (next, state) => {
          if (next.state !== 'closed' || next.terminal?.outcome !== 'rolled-back') return;
          if (mutatedAuthority === 'runtime') state.destinationDigest = CHANGED_DIGEST;
          if (mutatedAuthority === 'source') state.sourceDigest = CHANGED_DIGEST;
          if (mutatedAuthority === 'authored') state.authoredAuthority = 'changed';
        },
      });

      await expect(harness.run()).resolves.toMatchObject({
        status: 'recovery-required',
        sourcePreserved: mutatedAuthority !== 'source',
      });
      expect(harness.journal()).toMatchObject({
        state: 'closed',
        terminal: { outcome: 'rolled-back' },
      });
      expect(harness.state.events.some((event) => event.startsWith('fs:cleanup:'))).toBe(false);
    },
  );

  it.each(['runtime', 'source'] as const)(
    'rechecks rolled-back %s authority after awaited fresh-closed authored verification',
    async (mutatedAuthority) => {
      let mutated = false;
      const harness = createHarness({
        route: 'keep-project',
        faultAt: 'after-authored-verified',
        closedAuthoredLoadHook: (state) => {
          if (mutated) return;
          mutated = true;
          if (mutatedAuthority === 'runtime') state.destinationDigest = CHANGED_DIGEST;
          if (mutatedAuthority === 'source') state.sourceDigest = CHANGED_DIGEST;
        },
      });

      await expect(harness.run()).resolves.toMatchObject({
        status: 'recovery-required',
        sourcePreserved: mutatedAuthority !== 'source',
      });
      expect(harness.journal()).toMatchObject({
        state: 'closed',
        terminal: { outcome: 'rolled-back' },
      });
      expect(harness.state.events.some((event) => event.startsWith('fs:cleanup:'))).toBe(false);
      expect(harness.state.events).not.toContain('journal:unlink');
    },
  );

  it('uses the preflight canonical root after a caller alias is swapped', async () => {
    const harness = createHarness({
      route: 'promote-cache',
      inputRoot: ALIAS_ROOT,
      canonicalRoot: CANONICAL_ROOT,
    });
    await expect(harness.run()).resolves.toMatchObject({ status: 'promoted' });
    expect(harness.state.events).toContain(`preflight:${ALIAS_ROOT}`);
    expect(harness.state.events).toContain(`plan:${CANONICAL_ROOT}`);
    expect(
      harness.state.events
        .filter((event) => event.startsWith('authorize:'))
        .every((event) => event.endsWith(`:${CANONICAL_ROOT}`)),
    ).toBe(true);
  });

  it.each(['plan', 'revalidation'] as const)(
    'propagates a pre-journal %s failure without inventing recovery work',
    async (failure) => {
      const harness = createHarness({
        route: 'authored-only',
        planFailure: failure === 'plan',
        revalidationFailure: failure === 'revalidation',
      });
      await expect(harness.run()).rejects.toThrow();
      expect(harness.state.events).not.toContain('journal:create');
      expect(harness.state.content).toBeUndefined();
      expect(harness.state.released).toBe(1);
    },
  );

  it('returns only bounded path-free state when cleanup remains pending', async () => {
    const harness = createHarness({
      route: 'authored-only',
      faultAt: 'after-cleanup',
    });
    const result = await harness.run();
    const encoded = JSON.stringify(result);
    expect(result).toMatchObject({
      status: 'cleanup-pending',
      cleanupPending: true,
      reasonCode: 'cleanup-pending',
      nextCommand: 'opensip init',
    });
    expect(encoded).not.toContain(CANONICAL_ROOT);
    expect(encoded).not.toContain(SOURCE_DIGEST);
    expect(encoded).not.toContain('fresh-promotion-operation');
    expect(encoded.length).toBeLessThan(1024);
  });

  it('returns busy without planning or acquiring a releasable lease', async () => {
    const harness = createHarness({ route: 'authored-only' });
    const result = await runFreshRuntimePromotion(harness.input, {
      ...harness.dependencies,
      acquireLease: () =>
        Promise.reject(
          Object.assign(new Error('busy'), {
            code: 'CORE.RUNTIME_LEASE.EXCLUSIVE',
          }),
        ),
    });
    expect(result).toMatchObject({
      status: 'busy',
      reasonCode: 'lease-busy',
      nextCommand: 'opensip init',
    });
    expect(result).not.toHaveProperty('sourcePreserved');
    expect(harness.state.events).not.toContain('journal:create');
    expect(harness.state.released).toBe(0);
  });
});

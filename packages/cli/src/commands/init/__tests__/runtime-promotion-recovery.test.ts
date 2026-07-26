import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  advanceAuthoredPhase,
  recordOpenIntent,
  recordOpenPostcondition,
} from '../authored-state-transaction-journal.js';
import { RuntimeManifestError } from '../runtime-manifest.js';
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
import { RuntimePromotionDatastoreError } from '../runtime-promotion-preflight.js';
import { recoveryInputsCompatible } from '../runtime-promotion-recovery-common.js';
import {
  recoverRuntimePromotion,
  type RuntimePromotionRecoveryCheckpoint,
  type RuntimePromotionRecoveryDependencies,
} from '../runtime-promotion-recovery.js';
import {
  createRuntimePromotionTransitionWriter,
  type RuntimePromotionTransitionWriter,
} from '../runtime-promotion-transitions.js';

import type { InitAuthoredTransaction } from '../authored-state-transaction.js';
import type {
  AnchoredRecordReadResult,
  RecoveryHeaderInspection,
  RuntimeExclusiveLease,
  RuntimeRecoveryRecordMutation,
} from '@opensip-cli/core';

const PROJECT_ROOT = '/canonical/recovery-project';
const PROJECT_KEY = 'a'.repeat(24);
const OPERATION_ID = 'runtime-promotion-recovery-operation-0001';
const INITIAL_OWNER = 'runtime-promotion-recovery-owner-0001';
const DIGEST = 'b'.repeat(64);
const REPLAY_DIGEST = 'c'.repeat(64);
const DESTINATION_DIGEST = 'd'.repeat(64);
const DATASTORE_LOCK_CONTEXT = {
  policy: { waitMs: 100, staleMs: 1000, heartbeatMs: 100 },
  command: 'opensip init',
  cwdBasename: 'recovery-project',
} as const;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function manifest(digest = DESTINATION_DIGEST): RuntimeManifestIdentity {
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

function initialJournal(
  input: {
    readonly route?: 'authored-only' | 'project-authority' | 'promote-cache';
    readonly mutationCount?: number;
    readonly destinationPreexisting?: boolean;
  } = {},
): RuntimePromotionJournal {
  const route = input.route ?? 'authored-only';
  const sourceSelected = route === 'promote-cache';
  const destination =
    route === 'project-authority' ||
    (route === 'promote-cache' && input.destinationPreexisting === true);
  return createInitialRuntimePromotionJournal({
    coordinationKey: PROJECT_KEY,
    operationId: OPERATION_ID,
    recoveryOwnerToken: INITIAL_OWNER,
    route,
    destinationParentPreexisting: destination,
    destinationRuntimePreexisting: destination,
    destinationRootIdentity: destination ? { device: '1', inode: '2' } : null,
    source: {
      classification: sourceSelected ? 'legacy' : 'none',
      cacheKey: sourceSelected ? PROJECT_KEY : null,
      generationDigest: null,
      markerSha256: sourceSelected ? DIGEST : null,
      rootIdentity: sourceSelected ? { device: '1', inode: '2' } : null,
    },
    inputs: {
      conflict: sourceSelected ? 'use-cache' : 'abort',
      authoredMode: 'fresh',
      languages: ['typescript'],
      languageExplicit: false,
    },
    plan: {
      authoredDigest: DIGEST,
      replayDigest: REPLAY_DIGEST,
      mutationCount: input.mutationCount ?? 1,
    },
    owned: createRuntimePromotionOwnedSlots(OPERATION_ID),
    createdAt: 100,
  });
}

interface JournalStore {
  content: string | undefined;
  readonly mutations: RuntimeRecoveryRecordMutation[];
}

interface RecoveryHarness {
  readonly store: JournalStore;
  readonly released: { count: number };
  readonly dependencies: Partial<RuntimePromotionRecoveryDependencies>;
  readonly run: (
    explicit?: Parameters<typeof recoverRuntimePromotion>[0]['explicit'],
  ) => ReturnType<typeof recoverRuntimePromotion>;
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
    if (store.content !== undefined) throw new Error('create collision');
    store.content = mutation.content;
    return;
  }
  if (store.content === undefined || sha256(store.content) !== mutation.expectedContentSha256) {
    throw new Error('journal compare-and-swap collision');
  }
  store.content = mutation.operation === 'replace' ? mutation.content : undefined;
}

function createHarness(
  journal: RuntimePromotionJournal | string,
  options: {
    readonly checkpoint?: (checkpoint: RuntimePromotionRecoveryCheckpoint) => void;
    readonly dependencyOverrides?: Partial<RuntimePromotionRecoveryDependencies>;
  } = {},
): RecoveryHarness {
  const store: JournalStore = {
    content: typeof journal === 'string' ? journal : encodeRuntimePromotionJournal(journal),
    mutations: [],
  };
  const released = { count: 0 };
  let clock = 1000;
  let owner = 0;
  const now = (): number => ++clock;
  const dependencies: Partial<RuntimePromotionRecoveryDependencies> = {
    now,
    checkpoint: options.checkpoint,
    canonicalizeProjectRoot: () => PROJECT_ROOT,
    inspectHeader: () => {
      if (store.content === undefined) return { status: 'absent' };
      const parsed = JSON.parse(store.content) as {
        readonly operationId?: string;
        readonly state?: 'open' | 'closed';
      };
      return {
        status: 'valid',
        operationId: parsed.operationId ?? OPERATION_ID,
        state: parsed.state ?? 'open',
      };
    },
    acquireLease: () =>
      Promise.resolve(
        Object.freeze({
          kind: 'runtime-exclusive',
          coordinationKey: PROJECT_KEY,
          posture: 'init-recovery',
          ownerToken: `recovery-lease-owner-${++owner}`.padEnd(24, '0'),
          acquiredAt: now(),
          release: () => {
            released.count += 1;
          },
        }) satisfies RuntimeExclusiveLease,
      ),
    ephemeralProjectsDir: () => '/ephemeral/projects',
    assertSourceAuthority: () => undefined,
    assertSourceLocation: () => undefined,
    checkpointDatastores: () => [],
    createController: (lease) =>
      createRuntimePromotionJournalController(lease, {
        now,
        generateRecoveryOwnerToken: () => `recovery-handoff-owner-${++owner}`.padEnd(32, '0'),
        read: () => Promise.resolve(readStore(store)),
        mutate: (_lease, mutation) => {
          mutateStore(store, mutation);
          return Promise.resolve({ strategy: 'portable-anchored' });
        },
      }),
    captureProjectRootAuthority: ({ lease }) => ({
      version: 1,
      projectRoot: PROJECT_ROOT,
      coordinationKey: lease.coordinationKey,
      leasePosture: 'init-recovery',
      identity: { dev: '1', ino: '2', uid: '3', mode: String(0o4_0700) },
      destinationParent: null,
    }),
    assertProjectRootAuthority: () => undefined,
    assertDestinationRootAuthority: () => undefined,
    ...options.dependencyOverrides,
  };
  return {
    store,
    released,
    dependencies,
    run: (explicit) =>
      recoverRuntimePromotion(
        {
          projectRoot: PROJECT_ROOT,
          datastoreLockContext: DATASTORE_LOCK_CONTEXT,
          ...(explicit === undefined ? {} : { explicit }),
        },
        dependencies,
      ),
  };
}

function storedJournal(store: JournalStore): RuntimePromotionJournal {
  if (store.content === undefined) throw new Error('test journal is absent');
  return parseRuntimePromotionJournal(store.content);
}

async function closeUnmaterializedRollback(store: JournalStore): Promise<RuntimePromotionJournal> {
  const lease = Object.freeze({
    kind: 'runtime-exclusive',
    coordinationKey: PROJECT_KEY,
    posture: 'init-recovery',
    ownerToken: 'closed-fixture-lease-owner-0001',
    acquiredAt: 1,
    release: () => undefined,
  }) satisfies RuntimeExclusiveLease;
  const controller = createRuntimePromotionJournalController(lease, {
    now: (() => {
      let value = 200;
      return () => ++value;
    })(),
    read: () => Promise.resolve(readStore(store)),
    mutate: (_lease, mutation) => {
      mutateStore(store, mutation);
      return Promise.resolve({ strategy: 'portable-anchored' });
    },
  });
  const writer = createRuntimePromotionTransitionWriter(controller, {
    now: (() => {
      let value = 300;
      return () => ++value;
    })(),
  });
  let receipt = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
  receipt = await writer.beginRollback(receipt);
  receipt = await writer.recordUnmaterializedAuthoredRolledBack(receipt);
  receipt = await writer.sealRolledBack(receipt, null);
  await writer.close(receipt);
  return storedJournal(store);
}

async function closeCommittedProject(store: JournalStore): Promise<RuntimePromotionJournal> {
  const lease = Object.freeze({
    kind: 'runtime-exclusive',
    coordinationKey: PROJECT_KEY,
    posture: 'init-recovery',
    ownerToken: 'committed-fixture-lease-owner-01',
    acquiredAt: 1,
    release: () => undefined,
  }) satisfies RuntimeExclusiveLease;
  const controller = createRuntimePromotionJournalController(lease, {
    now: (() => {
      let value = 400;
      return () => ++value;
    })(),
    read: () => Promise.resolve(readStore(store)),
    mutate: (_lease, mutation) => {
      mutateStore(store, mutation);
      return Promise.resolve({ strategy: 'portable-anchored' });
    },
  });
  const writer = createRuntimePromotionTransitionWriter(controller, {
    now: (() => {
      let value = 500;
      return () => ++value;
    })(),
  });
  let receipt = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
  receipt = await writer.verifyDestination(receipt, manifest());
  receipt = await recordOpenIntent(
    controller,
    receipt,
    'authored-prepare',
    'authoredStage',
    null,
    () => 510,
  );
  receipt = await recordOpenPostcondition(
    controller,
    receipt,
    { phase: 'authored-prepared', outcome: 'applied', prepareArtifacts: true },
    () => 511,
  );
  receipt = await advanceAuthoredPhase(controller, receipt, 'authored-committed', () => 512);
  receipt = await writer.recordAuthorityVerified(receipt, manifest());
  receipt = await writer.sealCommitted(receipt);
  await writer.close(receipt);
  return storedJournal(store);
}

const SUMMARY = {
  total: 0,
  created: 0,
  replaced: 0,
  deleted: 0,
  preserved: 0,
  completed: 0,
  rolledBack: 0,
  verified: true,
  actionsKnown: true,
} as const;

interface RecoveryEntryCase {
  readonly name: string;
  readonly header: RecoveryHeaderInspection;
  readonly leaseErrorCode?: string;
  readonly expectedStatus: 'busy' | 'recovery-required';
  readonly expectedReasonCode:
    | 'journal-key-mismatch'
    | 'journal-malformed'
    | 'journal-oversize'
    | 'lease-busy'
    | 'state-ambiguous';
}

const RECOVERY_ENTRY_CASES = [
  {
    name: 'absent journal',
    header: { status: 'absent' },
    expectedStatus: 'recovery-required',
    expectedReasonCode: 'state-ambiguous',
  },
  {
    name: 'oversize journal',
    header: { status: 'malformed', reason: 'oversize' },
    expectedStatus: 'recovery-required',
    expectedReasonCode: 'journal-oversize',
  },
  {
    name: 'unsafe journal file',
    header: { status: 'malformed', reason: 'unsafe-file' },
    expectedStatus: 'recovery-required',
    expectedReasonCode: 'state-ambiguous',
  },
  {
    name: 'invalid journal JSON',
    header: { status: 'malformed', reason: 'invalid-json' },
    expectedStatus: 'recovery-required',
    expectedReasonCode: 'journal-malformed',
  },
  {
    name: 'invalid journal header',
    header: { status: 'malformed', reason: 'invalid-header' },
    expectedStatus: 'recovery-required',
    expectedReasonCode: 'journal-malformed',
  },
  {
    name: 'coordination-key mismatch',
    header: { status: 'malformed', reason: 'coordination-key-mismatch' },
    expectedStatus: 'recovery-required',
    expectedReasonCode: 'journal-key-mismatch',
  },
  {
    name: 'exclusive-lease timeout',
    header: { status: 'valid', operationId: OPERATION_ID, state: 'open' },
    leaseErrorCode: 'TIMEOUT.RUNTIME_LEASE.EXCLUSIVE',
    expectedStatus: 'busy',
    expectedReasonCode: 'lease-busy',
  },
  {
    name: 'coordination busy',
    header: { status: 'valid', operationId: OPERATION_ID, state: 'open' },
    leaseErrorCode: 'CORE.RUNTIME_COORDINATION.BUSY',
    expectedStatus: 'busy',
    expectedReasonCode: 'lease-busy',
  },
  {
    name: 'unrelated lease failure',
    header: { status: 'valid', operationId: OPERATION_ID, state: 'open' },
    leaseErrorCode: 'SYSTEM.UNRELATED',
    expectedStatus: 'recovery-required',
    expectedReasonCode: 'state-ambiguous',
  },
] satisfies readonly RecoveryEntryCase[];

describe('runtime promotion recovery', () => {
  it.each(RECOVERY_ENTRY_CASES)(
    'maps $name to a bounded result before journal mutation',
    async ({ header, leaseErrorCode, expectedStatus, expectedReasonCode }) => {
      const privateFailure = `private recovery entry failure: ${leaseErrorCode ?? header.status}`;
      const acquireLease = vi.fn(
        (
          _input: Parameters<RuntimePromotionRecoveryDependencies['acquireLease']>[0],
        ): Promise<RuntimeExclusiveLease> =>
          Promise.reject(
            Object.assign(new Error(privateFailure), {
              code: leaseErrorCode ?? 'SYSTEM.TEST.UNEXPECTED_LEASE_ACQUIRE',
            }),
          ),
      );
      const createController = vi.fn((_lease: RuntimeExclusiveLease): never => {
        throw new Error('recovery entry failure must not construct a journal controller');
      });
      const harness = createHarness(initialJournal(), {
        dependencyOverrides: {
          inspectHeader: () => header,
          acquireLease,
          createController,
        },
      });
      const initialContent = harness.store.content;

      const result = await harness.run();
      const encoded = JSON.stringify(result);

      expect(result).toMatchObject({
        status: expectedStatus,
        reasonCode: expectedReasonCode,
        nextCommand: 'opensip init',
      });
      expect(result).not.toHaveProperty('sourcePreserved');
      expect(encoded.length).toBeLessThan(1024);
      expect(encoded).not.toContain(PROJECT_ROOT);
      expect(encoded).not.toContain(OPERATION_ID);
      expect(encoded).not.toContain(privateFailure);
      expect(harness.store.content).toBe(initialContent);
      expect(harness.store.mutations).toEqual([]);
      expect(createController).not.toHaveBeenCalled();
      expect(harness.released.count).toBe(0);
      expect(acquireLease).toHaveBeenCalledTimes(leaseErrorCode === undefined ? 0 : 1);
    },
  );

  it('compares only explicit retry inputs and lets a plain retry use durable inputs', () => {
    const journal = initialJournal();
    expect(recoveryInputsCompatible(journal, undefined)).toBe(true);
    expect(recoveryInputsCompatible(journal, {})).toBe(true);
    expect(
      recoveryInputsCompatible(journal, {
        languages: ['typescript'],
        conflict: 'abort',
      }),
    ).toBe(true);
    expect(recoveryInputsCompatible(journal, { languages: ['python'] })).toBe(false);
    expect(recoveryInputsCompatible(journal, { authoredMode: 'remove' })).toBe(false);
    expect(recoveryInputsCompatible(journal, { conflict: 'use-cache' })).toBe(true);
    expect(recoveryInputsCompatible(journal, { conflict: 'keep-project' })).toBe(true);

    const sourceBacked = initialJournal({ route: 'promote-cache' });
    expect(recoveryInputsCompatible(sourceBacked, { conflict: 'use-cache' })).toBe(true);
    expect(recoveryInputsCompatible(sourceBacked, { conflict: 'abort' })).toBe(false);
  });

  it('compares recovery languages in their durable canonical order', () => {
    const journal: RuntimePromotionJournal = {
      ...initialJournal(),
      inputs: {
        ...initialJournal().inputs,
        languages: ['typescript', 'rust'],
        languageExplicit: true,
      },
    };

    expect(recoveryInputsCompatible(journal, { languages: ['typescript', 'rust'] })).toBe(true);
    expect(recoveryInputsCompatible(journal, { languages: ['rust', 'typescript'] })).toBe(false);
  });

  it('rolls back a journal that has no durable authored replay instead of rebuilding defaults', async () => {
    const checkpointDatastores = vi.fn(() => []);
    const harness = createHarness(initialJournal(), {
      dependencyOverrides: { checkpointDatastores },
    });
    const result = await harness.run();

    expect(result).toMatchObject({
      status: 'rolled-back',
      sourcePreserved: false,
      reasonCode: 'operation-failed',
    });
    expect(harness.store.content).toBeUndefined();
    expect(harness.released.count).toBe(1);
    expect(harness.store.mutations.some(({ operation }) => operation === 'unlink')).toBe(true);
    expect(checkpointDatastores).toHaveBeenCalledWith(expect.objectContaining({ candidates: [] }));
  });

  it('replays datastore checkpointing from a prepared source-backed journal', async () => {
    const events: string[] = [];
    const checkpointDatastores = vi.fn(
      (input: Parameters<RuntimePromotionRecoveryDependencies['checkpointDatastores']>[0]) => {
        events.push(`checkpoint:${input.candidates.map(({ kind }) => kind).join(',')}`);
        return [];
      },
    );
    let stopAfterCheckpoint = true;
    const harness = createHarness(
      initialJournal({ route: 'promote-cache', destinationPreexisting: true }),
      {
        checkpoint: (checkpoint) => {
          if (stopAfterCheckpoint && checkpoint === 'after-datastore-checkpoint') {
            stopAfterCheckpoint = false;
            throw new Error('restart after datastore checkpoint');
          }
        },
        dependencyOverrides: {
          assertSourceAuthority: () => {
            events.push('source-authority');
          },
          checkpointDatastores,
        },
      },
    );

    await expect(harness.run()).resolves.toMatchObject({
      status: 'recovery-required',
    });
    expect(events).toEqual(['source-authority', 'checkpoint:source,destination']);
    expect(checkpointDatastores).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          { kind: 'source', runtimeDir: `/ephemeral/projects/${PROJECT_KEY}` },
          {
            kind: 'destination',
            runtimeDir: `${PROJECT_ROOT}/opensip-cli/.runtime`,
          },
        ],
        lockContext: DATASTORE_LOCK_CONTEXT,
      }),
    );
    expect(storedJournal(harness.store).progress.phase).toBe('prepared');
  });

  it('retains the journal and lifecycle lease after a release-unsafe datastore failure', async () => {
    const checkpointDatastores = vi.fn(() =>
      Promise.reject(
        new RuntimePromotionDatastoreError('checkpoint-incomplete', {
          checkpointed: true,
          closed: false,
          reason: 'native-close-failed',
        }),
      ),
    );
    const harness = createHarness(initialJournal(), {
      dependencyOverrides: { checkpointDatastores },
    });

    const result = await harness.run();

    expect(result).toMatchObject({
      status: 'recovery-required',
      reasonCode: 'artifact-mismatch',
    });
    expect(checkpointDatastores).toHaveBeenCalledOnce();
    expect(harness.store.content).toBeDefined();
    expect(storedJournal(harness.store)).toMatchObject({
      state: 'open',
      operationId: OPERATION_ID,
    });
    expect(harness.store.mutations.some(({ operation }) => operation === 'unlink')).toBe(false);
    expect(harness.released.count).toBe(0);
  });

  it('rejects conflicting explicit retry input before the recovery-owner handoff', async () => {
    const initial = initialJournal();
    const harness = createHarness(initial);
    const before = harness.store.content;

    const result = await harness.run({ languages: ['python'] });

    expect(result).toMatchObject({
      status: 'conflict',
      reasonCode: 'state-ambiguous',
    });
    expect(harness.store.content).toBe(before);
    expect(storedJournal(harness.store).recoveryAttempt).toBe(1);
    expect(harness.store.mutations).toEqual([]);
    expect(harness.released.count).toBe(1);
  });

  it('rejects a noncanonical project-root alias before reading the journal', async () => {
    const inspectHeader = vi.fn();
    const harness = createHarness(initialJournal(), {
      dependencyOverrides: {
        canonicalizeProjectRoot: () => `${PROJECT_ROOT}-canonical`,
        inspectHeader,
      },
    });
    const before = harness.store.content;

    const result = await harness.run();

    expect(result).toMatchObject({
      status: 'recovery-required',
      reasonCode: 'state-ambiguous',
    });
    expect(inspectHeader).not.toHaveBeenCalled();
    expect(harness.store.content).toBe(before);
  });

  it('resumes after a crash immediately following durable owner handoff', async () => {
    let crash = true;
    const harness = createHarness(initialJournal(), {
      checkpoint: (checkpoint) => {
        if (crash && checkpoint === 'after-owner-handoff') {
          crash = false;
          throw new Error('restart after owner handoff');
        }
      },
    });

    await expect(harness.run()).resolves.toMatchObject({
      status: 'recovery-required',
    });
    expect(storedJournal(harness.store).recoveryAttempt).toBe(2);
    await expect(harness.run()).resolves.toMatchObject({
      status: 'rolled-back',
    });
    expect(harness.store.content).toBeUndefined();
    expect(harness.released.count).toBe(2);
  });

  it('fails closed on a valid-looking header with a malformed body before owned inspection', async () => {
    const inspectManifest = vi.fn();
    const malformed = JSON.stringify({
      kind: 'init-promotion',
      version: 1,
      coordinationKey: PROJECT_KEY,
      operationId: OPERATION_ID,
      state: 'open',
    });
    const harness = createHarness(malformed, {
      dependencyOverrides: { inspectManifest },
    });

    const result = await harness.run();

    expect(result).toMatchObject({
      status: 'recovery-required',
      reasonCode: 'journal-malformed',
    });
    expect(harness.store.content).toBe(malformed);
    expect(inspectManifest).not.toHaveBeenCalled();
    expect(harness.store.mutations).toEqual([]);
  });

  it('unlinks an already-closed receipt without reopening or re-verifying old authority bytes', async () => {
    const store: JournalStore = {
      content: encodeRuntimePromotionJournal(initialJournal()),
      mutations: [],
    };
    await closeUnmaterializedRollback(store);
    const inspectManifest = vi.fn();
    const harness = createHarness(storedJournal(store), {
      dependencyOverrides: { inspectManifest },
    });

    const result = await harness.run();

    expect(result.status).toBe('rolled-back');
    expect(harness.store.content).toBeUndefined();
    expect(inspectManifest).not.toHaveBeenCalled();
  });

  it.each(['after-journal-claimed', 'after-owner-handoff'] as const)(
    'preserves closed terminal truth when recovery stops %s',
    async (faultAt) => {
      const store: JournalStore = {
        content: encodeRuntimePromotionJournal(initialJournal()),
        mutations: [],
      };
      await closeUnmaterializedRollback(store);
      const harness = createHarness(storedJournal(store), {
        checkpoint: (checkpoint) => {
          if (checkpoint === faultAt) throw new Error(`stop ${faultAt}`);
        },
      });

      const result = await harness.run();

      expect(result).toMatchObject({
        status: 'rolled-back',
        cleanupPending: true,
        sourcePreserved: false,
        reasonCode: 'operation-failed',
        nextCommand: 'opensip init',
      });
      expect(storedJournal(harness.store).state).toBe('closed');
      expect(harness.released.count).toBe(1);
    },
  );

  it('preserves closed terminal truth when root-authority capture fails', async () => {
    const store: JournalStore = {
      content: encodeRuntimePromotionJournal(initialJournal()),
      mutations: [],
    };
    await closeUnmaterializedRollback(store);
    const harness = createHarness(storedJournal(store), {
      dependencyOverrides: {
        captureProjectRootAuthority: () => {
          throw new Error('project root replaced');
        },
      },
    });

    const result = await harness.run();

    expect(result).toMatchObject({
      status: 'rolled-back',
      cleanupPending: true,
      reasonCode: 'operation-failed',
      nextCommand: 'opensip init',
    });
    expect(storedJournal(harness.store).state).toBe('closed');
    expect(harness.released.count).toBe(1);
  });

  it('retains the lifecycle lease after a release-unsafe closed cleanup inspection', async () => {
    const store: JournalStore = {
      content: encodeRuntimePromotionJournal(
        initialJournal({ route: 'project-authority', mutationCount: 0 }),
      ),
      mutations: [],
    };
    await closeCommittedProject(store);
    const harness = createHarness(storedJournal(store), {
      dependencyOverrides: {
        classifyPath: () => {
          throw new RuntimeManifestError('sqlite-close-unproven', {
            releaseSafe: false,
          });
        },
      },
    });

    const result = await harness.run();

    expect(result).toMatchObject({
      status: 'cleanup-pending',
      cleanupPending: true,
    });
    expect(harness.released.count).toBe(0);
    expect(storedJournal(harness.store).state).toBe('closed');
  });

  it('returns the durable terminal result when a restart fault lands after receipt unlink', async () => {
    const store: JournalStore = {
      content: encodeRuntimePromotionJournal(initialJournal()),
      mutations: [],
    };
    await closeUnmaterializedRollback(store);
    const harness = createHarness(storedJournal(store), {
      checkpoint: (checkpoint) => {
        if (checkpoint === 'after-journal-unlink') {
          throw new Error('process stopped after durable unlink');
        }
      },
    });

    const result = await harness.run();

    expect(result).toMatchObject({ status: 'rolled-back' });
    expect(result).not.toHaveProperty('cleanupPending');
    expect(harness.store.content).toBeUndefined();
    expect(harness.released.count).toBe(1);
  });

  it('keeps a closed receipt visible and cleanup-only when an owned leftover mismatches', async () => {
    const store: JournalStore = {
      content: encodeRuntimePromotionJournal(
        initialJournal({ route: 'project-authority', mutationCount: 0 }),
      ),
      mutations: [],
    };
    await closeCommittedProject(store);
    let controller: RuntimePromotionJournalController | undefined;
    let writer: RuntimePromotionTransitionWriter | undefined;
    const cleanupAuthored = vi.fn(
      async (_transaction: InitAuthoredTransaction, receipt: DurableClosedPromotionJournal) => {
        if (controller === undefined || writer === undefined) {
          throw new Error('missing cleanup test controller');
        }
        const current = await controller.verifyReceipt(receipt, {
          state: 'closed',
        });
        expect(current.terminal?.outcome).toBe('committed');
        throw new Error('authored leftover identity mismatch');
      },
    );
    const harness = createHarness(storedJournal(store), {
      dependencyOverrides: {
        createController: (lease) => {
          controller = createRuntimePromotionJournalController(lease, {
            now: Date.now,
            read: () => Promise.resolve(readStore(harness.store)),
            mutate: (_lease, mutation) => {
              mutateStore(harness.store, mutation);
              return Promise.resolve({ strategy: 'portable-anchored' });
            },
          });
          writer = createRuntimePromotionTransitionWriter(controller);
          return controller;
        },
        createWriter: (current) => {
          writer = createRuntimePromotionTransitionWriter(current);
          return writer;
        },
        classifyPath: () => ({
          status: 'directory',
          mode: 0o700,
          owner: 'current',
        }),
        loadClosedAuthored: () =>
          Promise.resolve({
            operationId: OPERATION_ID,
            mutationCount: 0,
          } as InitAuthoredTransaction),
        cleanupAuthored,
      },
    });

    const result = await harness.run();

    expect(result).toMatchObject({
      status: 'cleanup-pending',
      cleanupPending: true,
      reasonCode: 'cleanup-pending',
    });
    expect(cleanupAuthored).toHaveBeenCalledOnce();
    expect(storedJournal(harness.store)).toMatchObject({
      state: 'closed',
      terminal: { outcome: 'committed', authority: 'project' },
    });
    expect(harness.released.count).toBe(1);
  });

  it('finishes a closed authored cleanup without consulting current renderer defaults', async () => {
    const store: JournalStore = {
      content: encodeRuntimePromotionJournal(
        initialJournal({ route: 'project-authority', mutationCount: 0 }),
      ),
      mutations: [],
    };
    await closeCommittedProject(store);
    let activeController: RuntimePromotionJournalController | undefined;
    const harness = createHarness(storedJournal(store), {
      dependencyOverrides: {
        createController: (lease) => {
          activeController = createRuntimePromotionJournalController(lease, {
            now: Date.now,
            read: () => Promise.resolve(readStore(harness.store)),
            mutate: (_lease, mutation) => {
              mutateStore(harness.store, mutation);
              return Promise.resolve({ strategy: 'portable-anchored' });
            },
          });
          return activeController;
        },
        classifyPath: () => ({
          status: 'directory',
          mode: 0o700,
          owner: 'current',
        }),
        loadClosedAuthored: () =>
          Promise.resolve({
            operationId: OPERATION_ID,
            mutationCount: 0,
          } as InitAuthoredTransaction),
        cleanupAuthored: async (_transaction, initialReceipt) => {
          if (activeController === undefined) throw new Error('missing cleanup controller');
          const cleanupWriter = createRuntimePromotionTransitionWriter(activeController);
          let receipt = initialReceipt;
          for (const slot of ['authoredStage', 'authoredBackup', 'replayManifest'] as const) {
            receipt = await cleanupWriter.recordCleanupIntent(receipt, slot);
            receipt = await cleanupWriter.recordCleanupPostcondition(
              receipt,
              slot,
              'already-satisfied',
            );
          }
          return { receipt, summary: SUMMARY };
        },
      },
    });

    const result = await harness.run();

    expect(result).toMatchObject({
      status: 'already-project',
      sourcePreserved: false,
    });
    expect(harness.store.content).toBeUndefined();
  });
});

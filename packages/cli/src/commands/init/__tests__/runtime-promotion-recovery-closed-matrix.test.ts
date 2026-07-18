import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  EPHEMERAL_MARKER_FILE,
  projectCoordinationKey,
  resolveUserPaths,
  type AnchoredRecordReadResult,
  type RuntimeExclusiveLease,
  type RuntimeRecoveryRecordMutation,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import type { InitAuthoredTransaction } from '../authored-state-transaction.js';
import type { RuntimePromotionFilesystemAuthority } from '../runtime-promotion-filesystem.js';

const SOURCE_DIGEST = '1'.repeat(64);
const DESTINATION_DIGEST = '2'.repeat(64);
const AUTHORED_DIGEST = '3'.repeat(64);
const REPLAY_DIGEST = '4'.repeat(64);
const SOURCE_CACHE_KEY = '5'.repeat(24);
const SOURCE_GENERATION = '6'.repeat(64);
const HISTORICAL_MARKER_SHA = '7'.repeat(64);
const OPERATION_ID = 'closed-recovery-matrix-operation-0001';
const DATASTORE_LOCK_CONTEXT = {
  policy: { waitMs: 100, staleMs: 1000, heartbeatMs: 100 },
  command: 'opensip init',
  cwdBasename: 'project',
} as const;
const CLEANUP_ORDER = [
  'runtimeStage',
  'destinationBackup',
  'sourceTombstone',
  'authoredStage',
  'authoredBackup',
  'replayManifest',
  'destinationParent',
] as const satisfies readonly RuntimePromotionOwnedSlotName[];
const CLOSED_PENDING_SLOTS = CLEANUP_ORDER.filter((slot) => slot !== 'runtimeStage');
const AUTHORED_SLOTS = [
  'authoredStage',
  'authoredBackup',
  'replayManifest',
] as const satisfies readonly RuntimePromotionOwnedSlotName[];
const FAULT_POSITIONS = [
  'before-intent',
  'after-intent',
  'before-postcondition',
  'after-postcondition',
] as const;

type AuthorityLocation = 'project' | 'cache' | 'none';
type FaultPosition = (typeof FAULT_POSITIONS)[number];

interface JournalStore {
  content: string | undefined;
  readonly mutations: RuntimeRecoveryRecordMutation[];
}

interface ClosedFixture {
  readonly journal: RuntimePromotionJournal;
  readonly store: JournalStore;
}

interface CleanupAuthorityToken {
  readonly cleanupSlot: RuntimePromotionOwnedSlotName;
}

interface FaultSpec {
  readonly slot: RuntimePromotionOwnedSlotName;
  readonly position: FaultPosition;
  fired: boolean;
}

interface RecoveryHarness {
  readonly releases: { count: number };
  readonly inspectManifest: ReturnType<typeof vi.fn>;
  readonly run: () => ReturnType<typeof recoverRuntimePromotion>;
}

let sandbox: string;
let home: string;
let projectRoot: string;
let cacheRoot: string;
let previousHome: string | undefined;
let recoveryClockSeed = 1000;

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
    totalBytes: 17,
    sqlite: { status: 'absent' },
  };
}

function ensureDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function writePrivateFile(path: string, content: string): void {
  ensureDirectory(dirname(path));
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
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

function storedJournal(store: JournalStore): RuntimePromotionJournal {
  if (store.content === undefined) throw new Error('test journal is absent');
  return parseRuntimePromotionJournal(store.content);
}

function normalLease(): RuntimeExclusiveLease {
  return Object.freeze({
    kind: 'runtime-exclusive',
    coordinationKey: projectCoordinationKey(projectRoot),
    posture: 'normal',
    ownerToken: 'closed-matrix-normal-lease-owner',
    acquiredAt: 1,
    release: () => undefined,
  });
}

function controllerFor(
  lease: RuntimeExclusiveLease,
  store: JournalStore,
  now: () => number,
): RuntimePromotionJournalController {
  return createRuntimePromotionJournalController(lease, {
    now,
    generateOperationId: () => OPERATION_ID,
    generateRecoveryOwnerToken: () => `closed-recovery-owner-${now()}`,
    read: () => Promise.resolve(readStore(store)),
    mutate: (_lease, mutation) => {
      mutateStore(store, mutation);
      return Promise.resolve({ strategy: 'portable-anchored' });
    },
  });
}

function source() {
  return {
    classification: 'generation-bound' as const,
    cacheKey: SOURCE_CACHE_KEY,
    generationDigest: SOURCE_GENERATION,
    markerSha256: HISTORICAL_MARKER_SHA,
  };
}

function allocateJournal(
  controller: RuntimePromotionJournalController,
  route: 'authored-only' | 'project-authority' | 'promote-cache',
  destinationPreexisting: boolean,
): Promise<DurableOpenPromotionJournal> {
  const allocation = controller.allocate((identity) =>
    createInitialRuntimePromotionJournal({
      coordinationKey: projectCoordinationKey(projectRoot),
      operationId: identity.operationId,
      recoveryOwnerToken: identity.recoveryOwnerToken,
      route,
      destinationParentPreexisting: destinationPreexisting,
      destinationRuntimePreexisting: destinationPreexisting,
      source:
        route === 'promote-cache'
          ? source()
          : {
              classification: 'none',
              cacheKey: null,
              generationDigest: null,
              markerSha256: null,
            },
      inputs: {
        conflict: route === 'promote-cache' ? 'use-cache' : 'abort',
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
    }),
  );
  return controller.create(allocation);
}

async function prepareAuthored(
  controller: RuntimePromotionJournalController,
  writer: RuntimePromotionTransitionWriter,
  receipt: DurableOpenPromotionJournal,
  now: () => number,
): Promise<DurableOpenPromotionJournal> {
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
    { phase: 'authored-prepared', outcome: 'applied', prepareArtifacts: true },
    now,
  );
  return writer.bindAuthoredPrepared(receipt);
}

async function commitAuthored(
  controller: RuntimePromotionJournalController,
  writer: RuntimePromotionTransitionWriter,
  receipt: DurableOpenPromotionJournal,
  now: () => number,
): Promise<DurableOpenPromotionJournal> {
  receipt = await advanceAuthoredPhase(controller, receipt, 'authored-committed', now);
  return writer.bindAuthoredCommitted(receipt);
}

function routeForAuthority(
  authority: AuthorityLocation,
): 'authored-only' | 'project-authority' | 'promote-cache' {
  if (authority === 'none') return 'authored-only';
  return authority === 'project' ? 'project-authority' : 'promote-cache';
}

function historicalManifestForAuthority(
  authority: AuthorityLocation,
): RuntimeManifestIdentity | null {
  if (authority === 'project') return manifest(DESTINATION_DIGEST);
  return authority === 'cache' ? manifest(SOURCE_DIGEST) : null;
}

async function createAuthorityFixture(authority: AuthorityLocation): Promise<ClosedFixture> {
  const store: JournalStore = { content: undefined, mutations: [] };
  let clock = 100;
  const now = (): number => ++clock;
  const controller = controllerFor(normalLease(), store, now);
  const writer = createRuntimePromotionTransitionWriter(controller, { now });
  const route = routeForAuthority(authority);
  let receipt = await allocateJournal(controller, route, authority === 'project');
  if (authority === 'project') {
    receipt = await writer.verifyDestination(receipt, manifest(DESTINATION_DIGEST));
  } else if (authority === 'cache') {
    receipt = await writer.verifySource(receipt, manifest(SOURCE_DIGEST));
    receipt = await writer.verifyDestination(receipt, null);
  }
  receipt = await writer.beginRollback(receipt);
  receipt = await writer.recordUnmaterializedAuthoredRolledBack(receipt);
  receipt = await writer.sealRolledBack(receipt, historicalManifestForAuthority(authority));
  await writer.close(receipt);
  return { journal: storedJournal(store), store };
}

async function createCleanupFixture(
  targetSlot?: RuntimePromotionOwnedSlotName,
): Promise<ClosedFixture> {
  const store: JournalStore = { content: undefined, mutations: [] };
  let clock = 300;
  const now = (): number => ++clock;
  const controller = controllerFor(normalLease(), store, now);
  const writer = createRuntimePromotionTransitionWriter(controller, { now });
  const destinationPreexisting = targetSlot === undefined || targetSlot === 'destinationBackup';
  let receipt = await allocateJournal(controller, 'promote-cache', destinationPreexisting);
  receipt = await writer.verifySource(receipt, manifest(SOURCE_DIGEST));
  receipt = await writer.verifyDestination(
    receipt,
    destinationPreexisting ? manifest(DESTINATION_DIGEST) : null,
  );
  receipt = await prepareAuthored(controller, writer, receipt, now);
  if (destinationPreexisting) {
    receipt = await writer.advancePreexistingDestinationReady(receipt);
  } else {
    receipt = await writer.recordDestinationParentCreateIntent(receipt);
    receipt = await writer.recordDestinationReady(receipt, 'applied');
  }
  receipt = await writer.recordRuntimeStageCreateIntent(receipt);
  receipt = await writer.recordRuntimeStaged(receipt, 'applied', manifest(SOURCE_DIGEST));
  if (destinationPreexisting) {
    receipt = await writer.recordDestinationBackupCreateIntent(receipt);
    receipt = await writer.recordDestinationBackedUp(receipt, 'applied');
  }
  receipt = await writer.recordDestinationInstallIntent(receipt);
  receipt = await writer.recordRuntimeInstalled(receipt, 'applied');
  receipt = await commitAuthored(controller, writer, receipt, now);
  receipt = await writer.recordSourceRetireIntent(receipt);
  receipt = await writer.recordSourceRetired(receipt, 'applied');
  receipt = await writer.recordAuthorityVerified(receipt, manifest(SOURCE_DIGEST));
  receipt = await writer.sealCommitted(receipt);
  let closed = await writer.close(receipt);
  let journal = await controller.verifyReceipt(closed, { state: 'closed' });
  if (targetSlot !== undefined) {
    for (const slot of CLEANUP_ORDER) {
      if (journal.cleanup[slot] !== 'pending' || slot === targetSlot) continue;
      closed = await writer.recordCleanupIntent(closed, slot);
      closed = await writer.recordCleanupPostcondition(closed, slot, 'already-satisfied');
      journal = await controller.verifyReceipt(closed, { state: 'closed' });
    }
  }
  if (targetSlot !== undefined && journal.cleanup[targetSlot] !== 'pending') {
    throw new Error(`fixture did not materialize ${targetSlot}`);
  }
  return { journal, store };
}

function currentProjectRuntime(): string {
  return join(projectRoot, 'opensip-cli', '.runtime');
}

function currentCacheRuntime(): string {
  return join(cacheRoot, SOURCE_CACHE_KEY);
}

function materializeCurrentAuthority(authority: AuthorityLocation): void {
  if (authority === 'project') {
    writePrivateFile(
      join(currentProjectRuntime(), 'current-evidence.txt'),
      'changed-project-bytes',
    );
  } else if (authority === 'cache') {
    writePrivateFile(join(currentCacheRuntime(), 'current-evidence.txt'), 'changed-cache-bytes');
    writePrivateFile(
      join(currentCacheRuntime(), EPHEMERAL_MARKER_FILE),
      '{"changed":"marker-bytes-after-close"}',
    );
  }
}

function artifactPath(
  journal: RuntimePromotionJournal,
  slot: RuntimePromotionOwnedSlotName,
): string {
  const basename = journal.owned[slot].basename;
  if (slot === 'runtimeStage' || slot === 'destinationBackup') {
    return join(projectRoot, 'opensip-cli', basename);
  }
  if (slot === 'sourceTombstone') return join(cacheRoot, basename);
  return join(projectRoot, basename);
}

function materializeExactArtifact(
  journal: RuntimePromotionJournal,
  slot: RuntimePromotionOwnedSlotName,
): void {
  writePrivateFile(
    join(artifactPath(journal, slot), 'ownership.txt'),
    journal.owned[slot].ownershipId,
  );
}

function artifactMatches(
  journal: RuntimePromotionJournal,
  slot: RuntimePromotionOwnedSlotName,
): boolean {
  const identityPath = join(artifactPath(journal, slot), 'ownership.txt');
  return (
    existsSync(identityPath) &&
    readFileSync(identityPath, 'utf8') === journal.owned[slot].ownershipId
  );
}

function removeExactArtifact(
  journal: RuntimePromotionJournal,
  slot: RuntimePromotionOwnedSlotName,
): 'removed' | 'already-absent' {
  const path = artifactPath(journal, slot);
  if (!existsSync(path)) return 'already-absent';
  if (!artifactMatches(journal, slot)) {
    throw new Error(`${slot} owned artifact identity mismatch`);
  }
  rmSync(path, { recursive: true });
  return 'removed';
}

function faultableWriter(
  writer: RuntimePromotionTransitionWriter,
  fault: FaultSpec | undefined,
): RuntimePromotionTransitionWriter {
  const shouldFault = (slot: RuntimePromotionOwnedSlotName, position: FaultPosition): boolean => {
    if (fault === undefined || fault.fired || fault.slot !== slot || fault.position !== position) {
      return false;
    }
    fault.fired = true;
    return true;
  };
  const recordCleanupIntent: RuntimePromotionTransitionWriter['recordCleanupIntent'] = async (
    receipt,
    slot,
  ) => {
    if (shouldFault(slot, 'before-intent')) throw new Error('fault before cleanup intent');
    const next = await writer.recordCleanupIntent(receipt, slot);
    if (shouldFault(slot, 'after-intent')) throw new Error('fault after cleanup intent');
    return next;
  };
  const recordCleanupPostcondition: RuntimePromotionTransitionWriter['recordCleanupPostcondition'] =
    async (receipt, slot, outcome) => {
      if (shouldFault(slot, 'before-postcondition')) {
        throw new Error('fault before cleanup postcondition');
      }
      const next = await writer.recordCleanupPostcondition(receipt, slot, outcome);
      if (shouldFault(slot, 'after-postcondition')) {
        throw new Error('fault after cleanup postcondition');
      }
      return next;
    };
  return Object.freeze({
    ...writer,
    recordCleanupIntent,
    recordCleanupPostcondition,
  });
}

function createRecoveryHarness(
  fixture: ClosedFixture,
  options: {
    readonly checkpoint?: (checkpoint: RuntimePromotionRecoveryCheckpoint) => void;
    readonly fault?: FaultSpec;
    readonly rejectArtifact?: RuntimePromotionOwnedSlotName;
  } = {},
): RecoveryHarness {
  const releases = { count: 0 };
  const inspectManifest = vi.fn();
  let clock = (recoveryClockSeed += 1000);
  let owner = 0;
  let activeWriter: RuntimePromotionTransitionWriter | undefined;
  const now = (): number => ++clock;
  const dependencies: Partial<RuntimePromotionRecoveryDependencies> = {
    now,
    checkpoint: options.checkpoint,
    canonicalizeProjectRoot: realpathSync,
    inspectHeader: () => {
      if (fixture.store.content === undefined) return { status: 'absent' };
      const journal = storedJournal(fixture.store);
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
          coordinationKey: projectCoordinationKey(projectRoot),
          posture: 'init-recovery',
          ownerToken: `closed-matrix-recovery-lease-${++owner}`.padEnd(32, '0'),
          acquiredAt: now(),
          release: () => {
            releases.count += 1;
          },
        }) satisfies RuntimeExclusiveLease,
      ),
    ephemeralProjectsDir: () => cacheRoot,
    checkpointDatastores: () => [],
    createController: (lease) => controllerFor(lease, fixture.store, now),
    createWriter: (controller) => {
      activeWriter = faultableWriter(
        createRuntimePromotionTransitionWriter(controller, { now }),
        options.fault,
      );
      return activeWriter;
    },
    inspectManifest,
    authorizeFilesystem: (input) =>
      Promise.resolve({
        cleanupSlot: input.cleanupSlot,
      } as unknown as RuntimePromotionFilesystemAuthority),
    cleanupOwnedSlot: (authority) => {
      const { cleanupSlot } = authority as unknown as CleanupAuthorityToken;
      if (
        !['destinationParent', 'runtimeStage', 'destinationBackup', 'sourceTombstone'].includes(
          cleanupSlot,
        )
      ) {
        throw new Error(`unexpected runtime cleanup slot ${cleanupSlot}`);
      }
      if (options.rejectArtifact === cleanupSlot) {
        throw new Error(`${cleanupSlot} owned artifact identity mismatch`);
      }
      const status = removeExactArtifact(fixture.journal, cleanupSlot);
      return Promise.resolve({ slot: cleanupSlot, status });
    },
    loadClosedAuthored: () =>
      Promise.resolve({
        operationId: fixture.journal.operationId,
        mutationCount: fixture.journal.plan.mutationCount,
      } as InitAuthoredTransaction),
    cleanupAuthored: async (
      _transaction: InitAuthoredTransaction,
      initialReceipt: DurableClosedPromotionJournal,
    ) => {
      if (activeWriter === undefined) throw new Error('missing recovery writer');
      let receipt = initialReceipt;
      let current = controllerForReceipt(fixture, receipt);
      for (const slot of AUTHORED_SLOTS) {
        if (current.cleanup[slot] !== 'pending') continue;
        if (options.rejectArtifact === slot) {
          throw new Error(`${slot} owned artifact identity mismatch`);
        }
        if (current.progress.pendingIntent === null) {
          receipt = await activeWriter.recordCleanupIntent(receipt, slot);
        } else if (
          current.progress.pendingIntent.kind !== 'owned-slot-cleanup' ||
          current.progress.pendingIntent.slot !== slot
        ) {
          throw new Error('another authored cleanup intent is pending');
        }
        const status = removeExactArtifact(fixture.journal, slot);
        receipt = await activeWriter.recordCleanupPostcondition(
          receipt,
          slot,
          status === 'already-absent' ? 'already-satisfied' : 'applied',
        );
        current = controllerForReceipt(fixture, receipt);
      }
      return {
        receipt,
        summary: {
          total: 0,
          created: 0,
          replaced: 0,
          deleted: 0,
          preserved: 0,
          completed: 0,
          rolledBack: 0,
          verified: true,
          actionsKnown: true,
        },
      };
    },
  };
  return {
    releases,
    inspectManifest,
    run: () =>
      recoverRuntimePromotion(
        {
          projectRoot,
          datastoreLockContext: DATASTORE_LOCK_CONTEXT,
        },
        dependencies,
      ),
  };
}

function controllerForReceipt(
  fixture: ClosedFixture,
  receipt: DurableClosedPromotionJournal,
): RuntimePromotionJournal {
  if (fixture.store.content === undefined) throw new Error('journal disappeared during cleanup');
  const current = storedJournal(fixture.store);
  if (
    current.operationId !== receipt.operationId ||
    current.revision !== receipt.revision ||
    current.recoveryOwnerToken !== receipt.recoveryOwnerToken
  ) {
    throw new Error('cleanup receipt does not match the durable journal');
  }
  return current;
}

beforeEach(() => {
  previousHome = process.env.HOME;
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-closed-recovery-')));
  home = ensureDirectory(join(sandbox, 'home'));
  projectRoot = realpathSync(ensureDirectory(join(sandbox, 'project')));
  process.env.HOME = home;
  cacheRoot = ensureDirectory(resolveUserPaths().ephemeralProjectsDir);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('closed runtime promotion recovery matrix', () => {
  it.each(['project', 'cache', 'none'] as const)(
    'accepts the current %s authority by canonical location and directory type',
    async (authority) => {
      const fixture = await createAuthorityFixture(authority);
      materializeCurrentAuthority(authority);
      const harness = createRecoveryHarness(fixture);

      await expect(harness.run()).resolves.toMatchObject({
        status: 'rolled-back',
      });
      expect(fixture.store.content).toBeUndefined();
      expect(harness.inspectManifest).not.toHaveBeenCalled();
      expect(harness.releases.count).toBe(1);
    },
  );

  it('accepts changed cache bytes and marker bytes after the closed receipt became history', async () => {
    const fixture = await createAuthorityFixture('cache');
    materializeCurrentAuthority('cache');
    const markerPath = join(currentCacheRuntime(), EPHEMERAL_MARKER_FILE);
    expect(readFileSync(markerPath, 'utf8')).not.toContain(HISTORICAL_MARKER_SHA);
    const harness = createRecoveryHarness(fixture);

    await expect(harness.run()).resolves.toMatchObject({
      status: 'rolled-back',
      sourcePreserved: true,
    });
    expect(fixture.store.content).toBeUndefined();
    expect(readFileSync(markerPath, 'utf8')).toBe('{"changed":"marker-bytes-after-close"}');
    expect(harness.inspectManifest).not.toHaveBeenCalled();
  });

  it.each(['project', 'cache'] as const)(
    'preserves a closed receipt when the current %s authority is not a directory',
    async (authority) => {
      const fixture = await createAuthorityFixture(authority);
      const runtime = authority === 'project' ? currentProjectRuntime() : currentCacheRuntime();
      writePrivateFile(runtime, 'not-a-directory');
      const harness = createRecoveryHarness(fixture);

      await expect(harness.run()).resolves.toMatchObject({
        status: 'cleanup-pending',
        cleanupPending: true,
      });
      expect(storedJournal(fixture.store).state).toBe('closed');
      expect(readFileSync(runtime, 'utf8')).toBe('not-a-directory');

      rmSync(runtime);
      ensureDirectory(runtime);
      await expect(harness.run()).resolves.toMatchObject({
        status: 'rolled-back',
      });
      expect(fixture.store.content).toBeUndefined();
    },
  );

  it('removes every exact runtime and authored leftover before unlinking', async () => {
    const fixture = await createCleanupFixture();
    materializeCurrentAuthority('project');
    const pendingSlots = CLEANUP_ORDER.filter(
      (slot) => fixture.journal.cleanup[slot] === 'pending',
    );
    for (const slot of pendingSlots) materializeExactArtifact(fixture.journal, slot);
    const harness = createRecoveryHarness(fixture);

    await expect(harness.run()).resolves.toMatchObject({
      status: 'promoted',
    });
    expect(pendingSlots).toEqual([
      'destinationBackup',
      'sourceTombstone',
      'authoredStage',
      'authoredBackup',
      'replayManifest',
    ]);
    for (const slot of pendingSlots) {
      expect(existsSync(artifactPath(fixture.journal, slot))).toBe(false);
    }
    expect(existsSync(currentProjectRuntime())).toBe(true);
    expect(fixture.store.content).toBeUndefined();
  });

  it.each(['destinationBackup', 'authoredStage'] as const)(
    'preserves a mismatched %s leftover and converges after exact identity is restored',
    async (slot) => {
      const fixture = await createCleanupFixture(slot);
      materializeCurrentAuthority('project');
      materializeExactArtifact(fixture.journal, slot);
      writePrivateFile(
        join(artifactPath(fixture.journal, slot), 'ownership.txt'),
        'foreign-owned-artifact',
      );
      const mismatch = createRecoveryHarness(fixture, { rejectArtifact: slot });

      await expect(mismatch.run()).resolves.toMatchObject({
        status: 'cleanup-pending',
        cleanupPending: true,
      });
      expect(existsSync(artifactPath(fixture.journal, slot))).toBe(true);
      expect(storedJournal(fixture.store)).toMatchObject({
        state: 'closed',
        terminal: { outcome: 'committed', authority: 'project' },
        cleanup: { [slot]: 'pending' },
      });

      writePrivateFile(
        join(artifactPath(fixture.journal, slot), 'ownership.txt'),
        fixture.journal.owned[slot].ownershipId,
      );
      const repaired = createRecoveryHarness(fixture);
      await expect(repaired.run()).resolves.toMatchObject({
        status: 'promoted',
      });
      expect(existsSync(artifactPath(fixture.journal, slot))).toBe(false);
      expect(fixture.store.content).toBeUndefined();
    },
  );

  it.each(
    CLOSED_PENDING_SLOTS.flatMap((slot) =>
      FAULT_POSITIONS.map((position) => [slot, position] as const),
    ),
  )('converges after a %s fault at %s', async (slot, position) => {
    const fixture = await createCleanupFixture(slot);
    materializeCurrentAuthority('project');
    materializeExactArtifact(fixture.journal, slot);
    const fault: FaultSpec = { slot, position, fired: false };
    const interrupted = createRecoveryHarness(fixture, { fault });

    await expect(interrupted.run()).resolves.toMatchObject({
      status: 'cleanup-pending',
      cleanupPending: true,
    });
    expect(fault.fired).toBe(true);
    expect(storedJournal(fixture.store)).toMatchObject({
      state: 'closed',
      terminal: { outcome: 'committed', authority: 'project' },
    });

    const resumed = createRecoveryHarness(fixture);
    await expect(resumed.run()).resolves.toMatchObject({
      status: 'promoted',
    });
    expect(existsSync(artifactPath(fixture.journal, slot))).toBe(false);
    expect(fixture.store.content).toBeUndefined();
  });

  it.each(['before-journal-unlink', 'after-journal-unlink'] as const)(
    'converges when recovery stops at %s',
    async (faultAt) => {
      const fixture = await createAuthorityFixture('none');
      let fault = true;
      const interrupted = createRecoveryHarness(fixture, {
        checkpoint: (checkpoint) => {
          if (fault && checkpoint === faultAt) {
            fault = false;
            throw new Error(`fault at ${faultAt}`);
          }
        },
      });

      const first = await interrupted.run();
      if (faultAt === 'before-journal-unlink') {
        expect(first).toMatchObject({
          status: 'cleanup-pending',
          cleanupPending: true,
        });
        expect(storedJournal(fixture.store).state).toBe('closed');
        const resumed = createRecoveryHarness(fixture);
        await expect(resumed.run()).resolves.toMatchObject({
          status: 'rolled-back',
        });
      } else {
        expect(first).toMatchObject({
          status: 'rolled-back',
        });
      }
      expect(fixture.store.content).toBeUndefined();
    },
  );

  it.each([
    'after-header-inspection',
    'after-lease-acquired',
    'after-journal-claimed',
    'after-owner-handoff',
    'after-root-authority-captured',
  ] as const)(
    'preserves restart convergence when a closed recovery faults at %s before cleanup construction',
    async (faultAt) => {
      const fixture = await createAuthorityFixture('none');
      let fault = true;
      const interrupted = createRecoveryHarness(fixture, {
        checkpoint: (checkpoint) => {
          if (fault && checkpoint === faultAt) {
            fault = false;
            throw new Error(`fault at ${faultAt}`);
          }
        },
      });

      if (faultAt === 'after-header-inspection') {
        await expect(interrupted.run()).rejects.toThrow(`fault at ${faultAt}`);
      } else {
        await expect(interrupted.run()).resolves.toMatchObject({
          status: faultAt === 'after-lease-acquired' ? 'recovery-required' : 'cleanup-pending',
        });
      }
      expect(storedJournal(fixture.store)).toMatchObject({
        state: 'closed',
        terminal: { outcome: 'rolled-back', authority: 'none' },
      });

      const resumed = createRecoveryHarness(fixture);
      await expect(resumed.run()).resolves.toMatchObject({
        status: 'rolled-back',
      });
      expect(fixture.store.content).toBeUndefined();
    },
  );
});

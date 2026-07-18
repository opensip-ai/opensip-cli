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
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  anchoredRecordTemporaryBasename,
  projectCoordinationKey,
  RUNTIME_RECOVERY_RECORD_MAX_BYTES,
  type AnchoredRecordReadResult,
  type RuntimeExclusiveLease,
  type RuntimeRecoveryRecordMutation,
} from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createDurableDirectory } from '../authored-state-transaction-fs.js';
import { AUTHORED_ARTIFACT_OWNER_FILE } from '../authored-state-transaction-types.js';
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
import { captureRuntimePromotionProjectRootAuthority } from '../runtime-promotion-root-authority.js';
import { createRuntimePromotionTransitionWriter } from '../runtime-promotion-transitions.js';

const PROJECT_KEY = 'a'.repeat(24);
const OPERATION_ID = 'authored-transaction-operation-0001';
const OWNER_TOKEN = 'authored-transaction-owner-000001';
const CLEANUP_ROOT_CHECKPOINTS = [
  'before-cleanup-intent',
  'after-cleanup-intent',
  'before-cleanup-mutation',
  'after-cleanup-artifact-observation',
  'after-cleanup-evidence-published',
  'after-cleanup-artifact-read',
  'before-cleanup-entry-unlink',
  'after-cleanup-entry-unlink',
  'before-cleanup-directory-removal',
  'after-cleanup-directory-removal',
  'before-cleanup-evidence-unlink',
  'after-cleanup-evidence-unlink',
  'after-cleanup-mutation',
  'before-cleanup-postcondition',
  'after-cleanup-postcondition',
] as const satisfies readonly AuthoredStateCheckpoint[];
const CLEANUP_ARTIFACT_CHECKPOINTS = [
  'after-cleanup-artifact-observation',
  'after-cleanup-evidence-published',
  'after-cleanup-artifact-read',
  'before-cleanup-entry-unlink',
  'after-cleanup-entry-unlink',
  'before-cleanup-directory-removal',
  'after-cleanup-directory-removal',
  'before-cleanup-evidence-unlink',
  'after-cleanup-evidence-unlink',
  'after-cleanup-mutation',
  'before-cleanup-postcondition',
  'after-cleanup-postcondition',
] as const satisfies readonly AuthoredStateCheckpoint[];

const temporaryRoots: string[] = [];
let latestProjectRoot: string | undefined;
const controllerCoordinationKeys = new WeakMap<RuntimePromotionJournalController, string>();

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function projectRoot(): string {
  const created = mkdtempSync(join(tmpdir(), 'opensip-authored-transaction-'));
  chmodSync(created, 0o700);
  const root = realpathSync(created);
  temporaryRoots.push(root);
  latestProjectRoot = root;
  return root;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fakeLease(
  root = latestProjectRoot,
  key = root === undefined ? PROJECT_KEY : projectCoordinationKey(root),
): RuntimeExclusiveLease {
  return {
    kind: 'runtime-exclusive',
    coordinationKey: key,
    posture: 'normal',
    ownerToken: OWNER_TOKEN,
    acquiredAt: 1,
    release: () => undefined,
  };
}

function projectRootAuthority(
  root: string,
  lease: RuntimeExclusiveLease,
): ReturnType<typeof captureRuntimePromotionProjectRootAuthority> {
  return captureRuntimePromotionProjectRootAuthority({
    lease,
    projectRoot: root,
    expectedPosture: 'normal',
  });
}

interface JournalStore {
  content: string | undefined;
}

function controllerFor(
  lease: RuntimeExclusiveLease,
  store: JournalStore,
  afterMutation?: (mutation: RuntimeRecoveryRecordMutation) => void,
): RuntimePromotionJournalController {
  let clock = 99;
  let recoveryOwnerSequence = 0;
  const controller = createRuntimePromotionJournalController(lease, {
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
        afterMutation?.(mutation);
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
        afterMutation?.(mutation);
        return Promise.resolve();
      }
      if (store.content === undefined || sha256(store.content) !== mutation.expectedContentSha256) {
        throw new Error('changed');
      }
      store.content = undefined;
      afterMutation?.(mutation);
      return Promise.resolve();
    },
  });
  controllerCoordinationKeys.set(controller, lease.coordinationKey);
  return controller;
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
  coordinationKey: string,
): RuntimePromotionJournal {
  return createInitialRuntimePromotionJournal({
    coordinationKey,
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
  coordinationKey = controllerCoordinationKeys.get(controller) ?? PROJECT_KEY,
): Promise<DurableOpenPromotionJournal> {
  const allocation = controller.allocate((identity) =>
    initialJournal(identity, plan, coordinationKey),
  );
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
  afterJournalMutation?: (mutation: RuntimeRecoveryRecordMutation) => void,
): Promise<PreparedHarness> {
  const lease = fakeLease(root);
  const store: JournalStore = { content: undefined };
  const controller = controllerFor(lease, store, afterJournalMutation);
  const receipt = await createJournal(controller, plan, lease.coordinationKey);
  let now = 101;
  const prepared = await prepareAuthoredState({
    projectRoot: root,
    projectRootAuthority: projectRootAuthority(root, lease),
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
  it('rejects a project root outside the controller-bound coordination key before writing', async () => {
    const authorizedRoot = projectRoot();
    const foreignRoot = projectRoot();
    const plan = authoredPlan([]);
    const lease = fakeLease(authorizedRoot);
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan);

    await expect(
      prepareAuthoredState({
        projectRoot: foreignRoot,
        projectRootAuthority: projectRootAuthority(authorizedRoot, lease),
        lease,
        controller,
        receipt,
        plan,
      }),
    ).rejects.toThrow(/coordination key/iu);
    expect(readdirCustomerEntries(foreignRoot)).toEqual([]);
    await expect(controller.verifyOpen(receipt)).resolves.toMatchObject({
      revision: 0,
      progress: { pendingIntent: null },
    });
  });

  it('binds a transaction handle to its original project-root inode', async () => {
    const root = projectRoot();
    const plan = authoredPlan([]);
    const harness = await prepareHarness(plan, root);
    const displaced = `${root}-displaced`;
    renameSync(root, displaced);
    temporaryRoots.push(displaced);
    mkdirSync(root, { mode: 0o700 });

    await expect(commitAuthoredState(harness.prepared.transaction)).rejects.toThrow(
      /project root changed/iu,
    );
    await expect(verifyAuthoredState(harness.prepared.transaction)).rejects.toThrow(
      /project root changed/iu,
    );
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects an authored target changed at the after-verify checkpoint', async () => {
    const root = projectRoot();
    const target = join(root, 'new.txt');
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    let armed = false;
    const harness = await prepareHarness(plan, root, (checkpoint) => {
      if (armed && checkpoint === 'after-verify') {
        writeFileSync(target, 'changed', { mode: 0o600 });
      }
    });
    await commitAuthoredState(harness.prepared.transaction);
    armed = true;

    await expect(verifyAuthoredState(harness.prepared.transaction)).rejects.toThrow(
      /authored target verification failed/iu,
    );
    expect(readFileSync(target, 'utf8')).toBe('changed');
  });

  it('rejects an authored artifact changed at the after-verify checkpoint', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const replayManifest = join(
      root,
      createRuntimePromotionOwnedSlots(OPERATION_ID).replayManifest.basename,
    );
    let armed = false;
    const harness = await prepareHarness(plan, root, (checkpoint) => {
      if (armed && checkpoint === 'after-verify') {
        writeFileSync(replayManifest, '{}', { mode: 0o600 });
      }
    });
    await commitAuthoredState(harness.prepared.transaction);
    armed = true;

    await expect(verifyAuthoredState(harness.prepared.transaction)).rejects.toThrow(
      /stored replay manifest does not match/iu,
    );
  });

  it('rejects a project-root replacement at the after-verify checkpoint', async () => {
    const root = projectRoot();
    const displaced = `${root}-after-verify-displaced`;
    temporaryRoots.push(displaced);
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    let armed = false;
    let swapped = false;
    const harness = await prepareHarness(plan, root, (checkpoint) => {
      if (!armed || swapped || checkpoint !== 'after-verify') return;
      swapped = true;
      renameSync(root, displaced);
      mkdirSync(root, { mode: 0o700 });
    });
    await commitAuthoredState(harness.prepared.transaction);
    armed = true;

    await expect(verifyAuthoredState(harness.prepared.transaction)).rejects.toThrow(
      /project root changed/iu,
    );
    expect(swapped).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it('rechecks a closed-loaded authored target after the after-verify checkpoint', async () => {
    const root = projectRoot();
    const target = join(root, 'new.txt');
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
    const recoveryLease = fakeLease(root);
    const recoveryController = controllerFor(recoveryLease, harness.store);
    const claimed = (await recoveryController.claim(OPERATION_ID)) as DurableClosedPromotionJournal;
    const transaction = await loadClosedAuthoredState({
      projectRoot: root,
      projectRootAuthority: projectRootAuthority(root, recoveryLease),
      lease: recoveryLease,
      controller: recoveryController,
      receipt: claimed,
      dependencies: {
        checkpoint: (checkpoint) => {
          if (checkpoint === 'after-verify') {
            writeFileSync(target, 'changed', { mode: 0o600 });
          }
        },
      },
    });

    await expect(verifyAuthoredState(transaction)).rejects.toThrow(
      /authored target verification failed/iu,
    );
    expect(closed.state).toBe('closed');
  });

  it('uses an identity-only Windows fallback when directory descriptors are unavailable', () => {
    const root = projectRoot();
    const path = join(root, 'windows-fallback');
    const unsupported = Object.assign(new Error('directory open unsupported'), {
      code: 'EINVAL',
    });
    let descriptorChmodCalled = false;

    const created = createDurableDirectory(path, undefined, {
      platform: 'win32',
      openDirectory: () => {
        throw unsupported;
      },
      fchmodDirectory: () => {
        descriptorChmodCalled = true;
      },
    });

    expect(created.path).toBe(path);
    expect(created.type).toBe('directory');
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(descriptorChmodCalled).toBe(false);
  });

  it('does not path-chmod a replacement symlink in the Windows directory fallback', () => {
    const root = projectRoot();
    const path = join(root, 'windows-fallback');
    const displaced = join(root, 'windows-fallback-displaced');
    const externalCreated = mkdtempSync(join(tmpdir(), 'opensip-authored-windows-fallback-'));
    chmodSync(externalCreated, 0o755);
    const external = realpathSync(externalCreated);
    temporaryRoots.push(external);
    const sentinel = join(external, 'sentinel.txt');
    writeFileSync(sentinel, 'customer', { mode: 0o600 });
    const unsupported = Object.assign(new Error('directory open unsupported'), {
      code: 'EINVAL',
    });

    expect(() =>
      createDurableDirectory(
        path,
        () => {
          renameSync(path, displaced);
          symlinkSync(external, path);
        },
        {
          platform: 'win32',
          openDirectory: () => {
            throw unsupported;
          },
        },
      ),
    ).toThrow(/could not be finalized safely/iu);

    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('customer');
    if (process.platform !== 'win32') {
      expect(lstatSync(external).mode & 0o777).toBe(0o755);
    }
  });

  it('does not materialize authored artifacts into a root replaced at a checkpoint', async () => {
    const root = projectRoot();
    const displaced = `${root}-displaced`;
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const lease = fakeLease(root);
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan, lease.coordinationKey);
    let swapped = false;

    await expect(
      prepareAuthoredState({
        projectRoot: root,
        projectRootAuthority: projectRootAuthority(root, lease),
        lease,
        controller,
        receipt,
        plan,
        dependencies: {
          checkpoint: (checkpoint) => {
            if (swapped || checkpoint !== 'after-stage-root-mkdir') return;
            swapped = true;
            renameSync(root, displaced);
            temporaryRoots.push(displaced);
            mkdirSync(root, { mode: 0o700 });
          },
        },
      }),
    ).rejects.toThrow(/project root changed/iu);

    expect(swapped).toBe(true);
    expect(readdirCustomerEntries(root)).toEqual([]);
    const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
    await expect(controller.verifyOpen(claimed)).resolves.toMatchObject({
      progress: {
        phase: 'prepared',
        pendingIntent: { kind: 'authored-prepare' },
      },
    });
  });

  it.each([
    {
      boundary: 'after-stage-root-mkdir',
      ownedDirectory: (root: string, stageBasename: string) => join(root, stageBasename),
    },
    {
      boundary: 'after-stage-blob-directory-mkdir',
      ownedDirectory: (root: string, stageBasename: string) => join(root, stageBasename, 'desired'),
    },
    {
      boundary: 'after-manifest-materialization',
      ownedDirectory: (root: string, stageBasename: string) => join(root, stageBasename),
    },
    {
      boundary: 'before-prepare-postcondition',
      ownedDirectory: (root: string, stageBasename: string) => join(root, stageBasename, 'desired'),
    },
    {
      boundary: 'after-prepare-postcondition',
      ownedDirectory: (root: string, stageBasename: string) => join(root, stageBasename),
    },
  ] as const)(
    'does not write through an authored artifact parent replaced at $boundary',
    async ({ boundary, ownedDirectory }) => {
      const root = projectRoot();
      const externalCreated = mkdtempSync(join(tmpdir(), 'opensip-authored-external-'));
      chmodSync(externalCreated, 0o755);
      const external = realpathSync(externalCreated);
      temporaryRoots.push(external);
      const externalSentinel = join(external, 'sentinel.txt');
      writeFileSync(externalSentinel, 'customer', { mode: 0o600 });
      const plan = authoredPlan([
        {
          path: 'new.txt',
          preimage: absent(),
          desired: fileState('new'),
          desiredContent: 'new',
        },
      ]);
      const lease = fakeLease(root);
      const store: JournalStore = { content: undefined };
      const controller = controllerFor(lease, store);
      const receipt = await createJournal(controller, plan, lease.coordinationKey);
      const stageBasename = createRuntimePromotionOwnedSlots(OPERATION_ID).authoredStage.basename;
      const ownedPath = ownedDirectory(root, stageBasename);
      const displaced = `${ownedPath}.opensip-displaced`;
      let swapped = false;

      await expect(
        prepareAuthoredState({
          projectRoot: root,
          projectRootAuthority: projectRootAuthority(root, lease),
          lease,
          controller,
          receipt,
          plan,
          dependencies: {
            checkpoint: (checkpoint) => {
              if (swapped || checkpoint !== boundary) return;
              swapped = true;
              renameSync(ownedPath, displaced);
              symlinkSync(external, ownedPath);
            },
          },
        }),
      ).rejects.toThrow(
        /could not be finalized safely|artifact root changed|blob directory changed/iu,
      );

      expect(swapped).toBe(true);
      expect(readdirSync(external)).toEqual(['sentinel.txt']);
      expect(readFileSync(externalSentinel, 'utf8')).toBe('customer');
      if (process.platform !== 'win32') {
        expect(lstatSync(external).mode & 0o777).toBe(0o755);
      }
      expect(lstatSync(ownedPath).isSymbolicLink()).toBe(true);
    },
  );

  it('accepts only journal-proven runtime installation and rollback of the authored root', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'opensip-cli',
        preimage: absent(),
        desired: directoryState(0o755),
      },
    ]);
    const lease = fakeLease();
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const allocation = controller.allocate((identity) =>
      createInitialRuntimePromotionJournal({
        coordinationKey: lease.coordinationKey,
        operationId: identity.operationId,
        recoveryOwnerToken: identity.recoveryOwnerToken,
        route: 'promote-cache',
        destinationParentPreexisting: false,
        destinationRuntimePreexisting: false,
        source: {
          classification: 'generation-bound',
          cacheKey: 'b'.repeat(24),
          generationDigest: 'c'.repeat(64),
          markerSha256: 'd'.repeat(64),
        },
        inputs: {
          conflict: 'use-cache',
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
    let receipt = await controller.create(allocation);
    const writer = createRuntimePromotionTransitionWriter(controller, {
      now: () => 101,
    });
    const runtimeManifest = {
      digest: 'e'.repeat(64),
      fileCount: 0,
      directoryCount: 1,
      symlinkCount: 0,
      rootMode: 0o700,
      totalBytes: 0,
      sqlite: { status: 'absent' as const },
    };
    receipt = await writer.verifySource(receipt, runtimeManifest);
    receipt = await writer.verifyDestination(receipt, null);
    const prepared = await prepareAuthoredState({
      projectRoot: root,
      projectRootAuthority: projectRootAuthority(root, lease),
      lease,
      controller,
      receipt,
      plan,
      dependencies: { now: () => 101 },
    });
    receipt = await writer.bindAuthoredPrepared(prepared.receipt);
    receipt = await writer.recordDestinationParentCreateIntent(receipt);
    mkdirSync(join(root, 'opensip-cli'), { mode: 0o755 });
    receipt = await writer.recordDestinationReady(receipt, 'applied');
    receipt = await writer.recordRuntimeStageCreateIntent(receipt);
    receipt = await writer.recordRuntimeStaged(receipt, 'applied', runtimeManifest);
    receipt = await writer.recordDestinationInstallIntent(receipt);
    mkdirSync(join(root, 'opensip-cli', '.runtime'), { mode: 0o700 });
    receipt = await writer.recordRuntimeInstalled(receipt, 'applied');

    await bindAuthoredStateReceipt(prepared.transaction, receipt);
    const committed = await commitAuthoredState(prepared.transaction);
    expect(committed.summary).toMatchObject({
      completed: 1,
      created: 1,
      verified: true,
    });
    expect(existsSync(join(root, 'opensip-cli', '.runtime'))).toBe(true);

    receipt = await writer.beginRollback(committed.receipt);
    receipt = await writer.recordRuntimeRollbackIntent(receipt);
    rmSync(join(root, 'opensip-cli', '.runtime'), { recursive: true });
    receipt = await writer.recordRuntimeRolledBack(receipt, 'applied');
    await bindAuthoredStateReceipt(prepared.transaction, receipt);
    const rolledBack = await rollbackAuthoredState(prepared.transaction);

    expect(rolledBack.summary).toMatchObject({ rolledBack: 1, verified: true });
    expect(existsSync(join(root, 'opensip-cli'))).toBe(false);
    await expect(verifyAuthoredState(prepared.transaction, 'preimage')).resolves.toMatchObject({
      completed: 1,
      rolledBack: 1,
      verified: true,
    });
  });

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
      projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
      projectRootAuthority: projectRootAuthority(root, recoveryLease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
      projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
      projectRootAuthority: projectRootAuthority(root, lease),
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

  it.each([
    {
      artifact: 'replay manifest',
      boundary: 'after-manifest-materialization',
      path: (root: string, owned: ReturnType<typeof createRuntimePromotionOwnedSlots>) =>
        join(root, owned.replayManifest.basename),
    },
    {
      artifact: 'stage marker',
      boundary: 'before-prepare-postcondition',
      path: (root: string, owned: ReturnType<typeof createRuntimePromotionOwnedSlots>) =>
        join(root, owned.authoredStage.basename, AUTHORED_ARTIFACT_OWNER_FILE),
    },
    {
      artifact: 'stage blob',
      boundary: 'after-prepare-postcondition',
      path: (root: string, owned: ReturnType<typeof createRuntimePromotionOwnedSlots>) =>
        join(root, owned.authoredStage.basename, 'desired', '0000.blob'),
    },
  ] as const)(
    'rejects a changed $artifact at $boundary',
    async ({ boundary, path: artifactPath }) => {
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
      const lease = fakeLease(root);
      const store: JournalStore = { content: undefined };
      const controller = controllerFor(lease, store);
      const receipt = await createJournal(controller, plan, lease.coordinationKey);
      const path = artifactPath(root, createRuntimePromotionOwnedSlots(OPERATION_ID));
      let changed = false;

      await expect(
        prepareAuthoredState({
          projectRoot: root,
          projectRootAuthority: projectRootAuthority(root, lease),
          lease,
          controller,
          receipt,
          plan,
          dependencies: {
            checkpoint: (checkpoint) => {
              if (changed || checkpoint !== boundary) return;
              changed = true;
              writeFileSync(path, 'customer-artifact', { mode: 0o600 });
            },
          },
        }),
      ).rejects.toThrow(/artifact|blob|manifest|owner|identity|changed/iu);

      expect(changed).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('customer-artifact');
    },
  );

  it('rejects a changed backup blob immediately after its prepare journal postcondition', async () => {
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
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const backupBlob = join(root, owned.authoredBackup.basename, 'preimage', '0000.blob');
    const lease = fakeLease(root);
    const store: JournalStore = { content: undefined };
    let changed = false;
    const controller = controllerFor(lease, store, (mutation) => {
      if (changed || mutation.operation !== 'replace' || mutation.content === undefined) {
        return;
      }
      const next = JSON.parse(mutation.content) as RuntimePromotionJournal;
      if (
        next.progress.pendingIntent !== null ||
        next.progress.lastPostcondition?.kind !== 'authored-prepare' ||
        next.progress.phase !== 'authored-prepared'
      ) {
        return;
      }
      changed = true;
      writeFileSync(backupBlob, 'customer-backup', { mode: 0o600 });
    });
    const receipt = await createJournal(controller, plan, lease.coordinationKey);

    await expect(
      prepareAuthoredState({
        projectRoot: root,
        projectRootAuthority: projectRootAuthority(root, lease),
        lease,
        controller,
        receipt,
        plan,
      }),
    ).rejects.toThrow(/backup blob|blob was changed|artifact/iu);

    expect(changed).toBe(true);
    expect(readFileSync(backupBlob, 'utf8')).toBe('customer-backup');
    expect((JSON.parse(store.content ?? '{}') as RuntimePromotionJournal).progress.phase).toBe(
      'authored-prepared',
    );
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
          projectRootAuthority: projectRootAuthority(root, lease),
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
          projectRootAuthority: projectRootAuthority(root, lease),
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
          projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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
          projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, recoveryLease),
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
          projectRootAuthority: projectRootAuthority(root, lease),
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
          projectRootAuthority: projectRootAuthority(root, lease),
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
        projectRootAuthority: projectRootAuthority(root, lease),
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

  it.each(['abort-postcondition', 'begin-rollback', 'advance-authored-rollback'] as const)(
    'converges an exact replay temporary introduced during %s',
    async (transition) => {
      const root = projectRoot();
      const plan = authoredPlan([
        {
          path: 'new.txt',
          preimage: absent(),
          desired: fileState('new'),
          desiredContent: 'new',
        },
      ]);
      const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
      const temporary = join(
        root,
        anchoredRecordTemporaryBasename(
          owned.replayManifest.basename,
          owned.replayManifest.ownershipId,
        ),
      );
      const lease = fakeLease(root);
      const store: JournalStore = { content: undefined };
      let armed = false;
      let inserted = false;
      const controller = controllerFor(lease, store, (mutation) => {
        if (
          !armed ||
          inserted ||
          mutation.operation !== 'replace' ||
          mutation.content === undefined
        ) {
          return;
        }
        const next = JSON.parse(mutation.content) as RuntimePromotionJournal;
        let matches: boolean;
        if (transition === 'abort-postcondition') {
          matches =
            next.progress.direction === 'forward' &&
            next.progress.pendingIntent === null &&
            next.progress.lastPostcondition?.kind === 'authored-prepare' &&
            next.progress.lastPostcondition.outcome === 'aborted';
        } else if (transition === 'begin-rollback') {
          matches =
            next.progress.direction === 'rollback' && next.progress.phase === 'rollback-started';
        } else {
          matches =
            next.progress.direction === 'rollback' &&
            next.progress.phase === 'authored-rolled-back';
        }
        if (!matches) return;
        inserted = true;
        writeFileSync(temporary, 'partial-replay', { mode: 0o600 });
      });
      const receipt = await createJournal(controller, plan, lease.coordinationKey);
      await expect(
        prepareAuthoredState({
          projectRoot: root,
          projectRootAuthority: projectRootAuthority(root, lease),
          lease,
          controller,
          receipt,
          plan,
          dependencies: {
            checkpoint: (checkpoint) => {
              if (checkpoint === 'after-stage-materialization') {
                throw new Error('prepare crash');
              }
            },
          },
        }),
      ).rejects.toThrow(/prepare crash/iu);
      const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
      armed = true;

      const aborted = await abortPendingAuthoredPreparation({
        projectRoot: root,
        projectRootAuthority: projectRootAuthority(root, lease),
        lease,
        controller,
        receipt: claimed,
      });

      expect(inserted).toBe(true);
      expect(existsSync(temporary)).toBe(false);
      await expect(controller.verifyOpen(aborted.receipt)).resolves.toMatchObject({
        progress: {
          direction: 'rollback',
          phase: 'authored-rolled-back',
        },
      });
    },
  );

  it.each(['begin-rollback', 'advance-authored-rollback'] as const)(
    'preserves and rejects a replacement artifact introduced during %s',
    async (transition) => {
      const root = projectRoot();
      const plan = authoredPlan([
        {
          path: 'new.txt',
          preimage: absent(),
          desired: fileState('new'),
          desiredContent: 'new',
        },
      ]);
      const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
      const stage = join(root, owned.authoredStage.basename);
      const sentinel = join(stage, 'customer.txt');
      const lease = fakeLease(root);
      const store: JournalStore = { content: undefined };
      let armed = false;
      let inserted = false;
      const controller = controllerFor(lease, store, (mutation) => {
        if (
          !armed ||
          inserted ||
          mutation.operation !== 'replace' ||
          mutation.content === undefined
        ) {
          return;
        }
        const next = JSON.parse(mutation.content) as RuntimePromotionJournal;
        const matches =
          transition === 'begin-rollback'
            ? next.progress.direction === 'rollback' && next.progress.phase === 'rollback-started'
            : next.progress.direction === 'rollback' &&
              next.progress.phase === 'authored-rolled-back';
        if (!matches) return;
        inserted = true;
        mkdirSync(stage, { mode: 0o700 });
        writeFileSync(sentinel, 'customer', { mode: 0o600 });
      });
      const receipt = await createJournal(controller, plan, lease.coordinationKey);
      await expect(
        prepareAuthoredState({
          projectRoot: root,
          projectRootAuthority: projectRootAuthority(root, lease),
          lease,
          controller,
          receipt,
          plan,
          dependencies: {
            checkpoint: (checkpoint) => {
              if (checkpoint === 'after-stage-materialization') {
                throw new Error('prepare crash');
              }
            },
          },
        }),
      ).rejects.toThrow(/prepare crash/iu);
      const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
      armed = true;

      await expect(
        abortPendingAuthoredPreparation({
          projectRoot: root,
          projectRootAuthority: projectRootAuthority(root, lease),
          lease,
          controller,
          receipt: claimed,
        }),
      ).rejects.toThrow(/left an owned artifact path/iu);

      expect(inserted).toBe(true);
      expect(readFileSync(sentinel, 'utf8')).toBe('customer');
    },
  );

  it('rejects a customer target edit introduced while advancing an aborted rollback', async () => {
    const root = projectRoot();
    const target = join(root, 'target.txt');
    writeFileSync(target, 'old', { mode: 0o600 });
    const plan = authoredPlan([
      {
        path: 'target.txt',
        preimage: fileState('old'),
        desired: fileState('new'),
        preimageContent: 'old',
        desiredContent: 'new',
      },
    ]);
    const lease = fakeLease(root);
    const store: JournalStore = { content: undefined };
    let armed = false;
    let changed = false;
    const controller = controllerFor(lease, store, (mutation) => {
      if (!armed || changed || mutation.operation !== 'replace' || mutation.content === undefined) {
        return;
      }
      const next = JSON.parse(mutation.content) as RuntimePromotionJournal;
      if (
        next.progress.direction !== 'rollback' ||
        next.progress.phase !== 'authored-rolled-back'
      ) {
        return;
      }
      changed = true;
      writeFileSync(target, 'customer', { mode: 0o600 });
    });
    const receipt = await createJournal(controller, plan, lease.coordinationKey);
    await expect(
      prepareAuthoredState({
        projectRoot: root,
        projectRootAuthority: projectRootAuthority(root, lease),
        lease,
        controller,
        receipt,
        plan,
        dependencies: {
          checkpoint: (checkpoint) => {
            if (checkpoint === 'after-stage-materialization') {
              throw new Error('prepare crash');
            }
          },
        },
      }),
    ).rejects.toThrow(/prepare crash/iu);
    const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
    armed = true;

    await expect(
      abortPendingAuthoredPreparation({
        projectRoot: root,
        projectRootAuthority: projectRootAuthority(root, lease),
        lease,
        controller,
        receipt: claimed,
      }),
    ).rejects.toThrow(
      /authored target changed|authored target verification failed|does not match/iu,
    );

    expect(changed).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('customer');
  });

  it('preserves a blob replaced after abort cleanup authority was captured', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const lease = fakeLease(root);
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan, lease.coordinationKey);
    await expect(
      prepareAuthoredState({
        projectRoot: root,
        projectRootAuthority: projectRootAuthority(root, lease),
        lease,
        controller,
        receipt,
        plan,
        dependencies: {
          checkpoint: (checkpoint) => {
            if (checkpoint === 'after-stage-materialization') {
              throw new Error('prepare crash');
            }
          },
        },
      }),
    ).rejects.toThrow(/prepare crash/iu);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const blob = join(root, owned.authoredStage.basename, 'desired', '0000.blob');
    const displaced = `${blob}.opensip-original`;
    const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
    let replaced = false;

    await expect(
      abortPendingAuthoredPreparation({
        projectRoot: root,
        projectRootAuthority: projectRootAuthority(root, lease),
        lease,
        controller,
        receipt: claimed,
        dependencies: {
          checkpoint: (checkpoint) => {
            if (replaced || checkpoint !== 'before-abort-cleanup') return;
            replaced = true;
            renameSync(blob, displaced);
            writeFileSync(blob, 'customer', { mode: 0o600 });
          },
        },
      }),
    ).rejects.toThrow(/blob changed while it was being removed|blob changed/iu);

    expect(replaced).toBe(true);
    expect(readFileSync(blob, 'utf8')).toBe('customer');
    expect(readFileSync(displaced, 'utf8')).toBe('new');
    await expect(controller.verifyOpen(claimed)).resolves.toMatchObject({
      progress: {
        direction: 'forward',
        pendingIntent: { kind: 'authored-prepare' },
      },
    });
  });

  it.each([
    'after-abort-cleanup',
    'before-abort-postcondition',
    'after-abort-postcondition',
  ] as const)(
    'does not record a false unmaterialized postcondition when an artifact appears at %s',
    async (boundary) => {
      const root = projectRoot();
      const plan = authoredPlan([
        {
          path: 'new.txt',
          preimage: absent(),
          desired: fileState('new'),
          desiredContent: 'new',
        },
      ]);
      const lease = fakeLease(root);
      const store: JournalStore = { content: undefined };
      const controller = controllerFor(lease, store);
      const receipt = await createJournal(controller, plan, lease.coordinationKey);
      await expect(
        prepareAuthoredState({
          projectRoot: root,
          projectRootAuthority: projectRootAuthority(root, lease),
          lease,
          controller,
          receipt,
          plan,
          dependencies: {
            checkpoint: (checkpoint) => {
              if (checkpoint === 'after-stage-materialization') {
                throw new Error('prepare crash');
              }
            },
          },
        }),
      ).rejects.toThrow(/prepare crash/iu);
      const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
      const stage = join(root, owned.authoredStage.basename);
      const sentinel = join(stage, 'customer.txt');
      const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
      let inserted = false;

      await expect(
        abortPendingAuthoredPreparation({
          projectRoot: root,
          projectRootAuthority: projectRootAuthority(root, lease),
          lease,
          controller,
          receipt: claimed,
          dependencies: {
            checkpoint: (checkpoint) => {
              if (inserted || checkpoint !== boundary) return;
              inserted = true;
              mkdirSync(stage, { mode: 0o700 });
              writeFileSync(sentinel, 'customer', { mode: 0o600 });
            },
          },
        }),
      ).rejects.toThrow(/left an owned artifact path/iu);

      expect(inserted).toBe(true);
      expect(readFileSync(sentinel, 'utf8')).toBe('customer');
      const journal = JSON.parse(store.content ?? '{}') as RuntimePromotionJournal;
      expect(journal.progress.pendingIntent === null).toBe(
        boundary === 'after-abort-postcondition',
      );

      const retry = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
      await expect(
        abortPendingAuthoredPreparation({
          projectRoot: root,
          projectRootAuthority: projectRootAuthority(root, lease),
          lease,
          controller,
          receipt: retry,
        }),
      ).rejects.toThrow(
        /left an owned artifact path|ownership marker|without their durable replay manifest/iu,
      );
      expect(readFileSync(sentinel, 'utf8')).toBe('customer');
    },
  );

  it('stops an abort when its project root is replaced after owned cleanup', async () => {
    const root = projectRoot();
    const displaced = `${root}-displaced`;
    const replacementFile = join(root, 'customer.txt');
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const lease = fakeLease(root);
    const store: JournalStore = { content: undefined };
    const controller = controllerFor(lease, store);
    const receipt = await createJournal(controller, plan, lease.coordinationKey);
    await expect(
      prepareAuthoredState({
        projectRoot: root,
        projectRootAuthority: projectRootAuthority(root, lease),
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
    const claimed = (await controller.claim(OPERATION_ID)) as DurableOpenPromotionJournal;
    const authority = projectRootAuthority(root, lease);
    let swapped = false;

    await expect(
      abortPendingAuthoredPreparation({
        projectRoot: root,
        projectRootAuthority: authority,
        lease,
        controller,
        receipt: claimed,
        dependencies: {
          now: () => 102,
          checkpoint: (checkpoint) => {
            if (swapped || checkpoint !== 'after-abort-cleanup') return;
            swapped = true;
            renameSync(root, displaced);
            temporaryRoots.push(displaced);
            mkdirSync(root, { mode: 0o700 });
            writeFileSync(replacementFile, 'customer', { mode: 0o600 });
          },
        },
      }),
    ).rejects.toThrow(/project root changed/iu);

    expect(swapped).toBe(true);
    expect(readdirCustomerEntries(root)).toEqual(['customer.txt']);
    expect(readFileSync(replacementFile, 'utf8')).toBe('customer');
    await expect(controller.verifyOpen(claimed)).resolves.toMatchObject({
      progress: {
        direction: 'forward',
        phase: 'prepared',
        pendingIntent: { kind: 'authored-prepare' },
      },
    });
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

  it.each([
    { direction: 'commit', boundary: 'after-target-mutation' },
    { direction: 'commit', boundary: 'before-target-postcondition' },
    { direction: 'rollback', boundary: 'after-target-mutation' },
    { direction: 'rollback', boundary: 'before-target-postcondition' },
  ] as const)(
    'rejects a $direction target replacement at $boundary before recording success',
    async ({ direction, boundary }) => {
      const root = projectRoot();
      const target = join(root, 'target.txt');
      writeFileSync(target, 'old', { mode: 0o600 });
      const plan = authoredPlan([
        {
          path: 'target.txt',
          preimage: fileState('old'),
          desired: fileState('new'),
          preimageContent: 'old',
          desiredContent: 'new',
        },
      ]);
      let armed = false;
      let replaced = false;
      const harness = await prepareHarness(plan, root, (checkpoint, cursor) => {
        if (!armed || replaced || cursor !== 0 || checkpoint !== boundary) {
          return;
        }
        replaced = true;
        writeFileSync(target, 'customer', { mode: 0o600 });
      });
      if (direction === 'rollback') {
        await commitAuthoredState(harness.prepared.transaction);
      }
      armed = true;

      const operation =
        direction === 'commit'
          ? commitAuthoredState(harness.prepared.transaction)
          : rollbackAuthoredState(harness.prepared.transaction);
      await expect(operation).rejects.toThrow(/target changed before its durable postcondition/iu);

      expect(replaced).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('customer');
    },
  );

  it.each(['commit', 'rollback'] as const)(
    'detects a $direction target replacement immediately after its journal postcondition',
    async (direction) => {
      const root = projectRoot();
      const target = join(root, 'target.txt');
      writeFileSync(target, 'old', { mode: 0o600 });
      const plan = authoredPlan([
        {
          path: 'target.txt',
          preimage: fileState('old'),
          desired: fileState('new'),
          preimageContent: 'old',
          desiredContent: 'new',
        },
      ]);
      let armed = false;
      let replaced = false;
      const harness = await prepareHarness(plan, root, undefined, (mutation) => {
        if (
          !armed ||
          replaced ||
          mutation.operation !== 'replace' ||
          mutation.content === undefined
        ) {
          return;
        }
        const next = JSON.parse(mutation.content) as RuntimePromotionJournal;
        if (
          next.progress.pendingIntent !== null ||
          next.progress.lastPostcondition?.kind !== `authored-target-${direction}`
        ) {
          return;
        }
        replaced = true;
        writeFileSync(target, 'customer', { mode: 0o600 });
      });
      if (direction === 'rollback') {
        await commitAuthoredState(harness.prepared.transaction);
      }
      armed = true;

      const operation =
        direction === 'commit'
          ? commitAuthoredState(harness.prepared.transaction)
          : rollbackAuthoredState(harness.prepared.transaction);
      await expect(operation).rejects.toThrow(/target changed before its durable postcondition/iu);

      expect(replaced).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('customer');
      const journal = JSON.parse(harness.store.content ?? '{}') as RuntimePromotionJournal;
      expect(
        direction === 'commit' ? journal.progress.authoredCursor : journal.progress.rollbackCursor,
      ).toBe(1);
    },
  );

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
        projectRootAuthority: projectRootAuthority(root, recoveryLease),
        lease: recoveryLease,
        controller: recoveryController,
        receipt: claimed,
      }),
    ).rejects.toThrow(/expected identity|replay manifest identity/iu);
  });

  it.each(CLEANUP_ROOT_CHECKPOINTS)(
    'refuses a project-root replacement at cleanup checkpoint %s',
    async (boundary) => {
      const root = projectRoot();
      const displaced = `${root}-displaced-${boundary}`;
      const replacementFile = join(root, 'customer.txt');
      const plan = authoredPlan([
        {
          path: 'new.txt',
          preimage: absent(),
          desired: fileState('new'),
          desiredContent: 'new',
        },
      ]);
      let swapped = false;
      const harness = await prepareHarness(plan, root, (checkpoint) => {
        if (swapped || checkpoint !== boundary) return;
        swapped = true;
        renameSync(root, displaced);
        temporaryRoots.push(displaced);
        mkdirSync(root, { mode: 0o700 });
        writeFileSync(replacementFile, 'customer', { mode: 0o600 });
      });
      const committed = await commitAuthoredState(harness.prepared.transaction);
      const closed = await closeCommitted(harness.controller, committed.receipt);

      await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
        /project root changed/iu,
      );

      expect(swapped).toBe(true);
      expect(readFileSync(replacementFile, 'utf8')).toBe('customer');
      expect(readdirCustomerEntries(root)).toEqual(['customer.txt']);
    },
  );

  it.each(CLEANUP_ARTIFACT_CHECKPOINTS)(
    'preserves a replacement artifact tree introduced at cleanup checkpoint %s',
    async (boundary) => {
      const root = projectRoot();
      const plan = authoredPlan([
        {
          path: 'new.txt',
          preimage: absent(),
          desired: fileState('new'),
          desiredContent: 'new',
        },
      ]);
      const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
      const stage = join(root, owned.authoredStage.basename);
      const displaced = `${stage}-displaced-${boundary}`;
      const sentinel = join(stage, 'customer-tree', 'sentinel.txt');
      let swapped = false;
      const harness = await prepareHarness(plan, root, (checkpoint) => {
        if (swapped || checkpoint !== boundary) return;
        swapped = true;
        if (existsSync(stage)) renameSync(stage, displaced);
        mkdirSync(join(stage, 'customer-tree'), {
          recursive: true,
          mode: 0o700,
        });
        writeFileSync(sentinel, 'customer', { mode: 0o600 });
      });
      const committed = await commitAuthoredState(harness.prepared.transaction);
      const closed = await closeCommitted(harness.controller, committed.receipt);

      await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
        /changed|replaced|no longer absent|ownership marker|unexpected entries/iu,
      );

      expect(swapped).toBe(true);
      expect(readFileSync(sentinel, 'utf8')).toBe('customer');
      if (boundary === 'after-cleanup-evidence-unlink') {
        const recoveryLease = fakeLease(root);
        const recoveryController = controllerFor(recoveryLease, harness.store);
        const claimed = (await recoveryController.claim(
          OPERATION_ID,
        )) as DurableClosedPromotionJournal;
        const transaction = await loadClosedAuthoredState({
          projectRoot: root,
          projectRootAuthority: projectRootAuthority(root, recoveryLease),
          lease: recoveryLease,
          controller: recoveryController,
          receipt: claimed,
        });
        await expect(cleanupAuthoredState(transaction, claimed)).rejects.toThrow(
          /no longer absent/iu,
        );
        expect(readFileSync(sentinel, 'utf8')).toBe('customer');
      }
    },
  );

  it('does not authorize a replacement root after its owner marker was removed', async () => {
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
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const stage = join(root, owned.authoredStage.basename);
    const displaced = `${stage}.opensip-ownerless-original`;
    const sentinel = join(stage, 'customer.txt');
    let unlinks = 0;
    let swapped = false;
    const harness = await prepareHarness(plan, root, (checkpoint) => {
      if (checkpoint !== 'after-cleanup-entry-unlink') return;
      unlinks += 1;
      if (unlinks !== 2) return;
      swapped = true;
      renameSync(stage, displaced);
      mkdirSync(stage, { mode: 0o700 });
      writeFileSync(sentinel, 'customer', { mode: 0o600 });
    });
    const committed = await commitAuthoredState(harness.prepared.transaction);
    const closed = await closeCommitted(harness.controller, committed.receipt);

    await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
      /root changed|root was replaced|marker parent changed/iu,
    );

    expect(swapped).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('customer');
    expect(readdirSync(displaced)).toEqual([]);
  });

  it('reasserts the project root after cleanup journal writes', async () => {
    for (const transition of ['intent', 'postcondition'] as const) {
      const root = projectRoot();
      const displaced = `${root}-displaced-${transition}`;
      const replacementFile = join(root, 'customer.txt');
      const plan = authoredPlan([
        {
          path: 'new.txt',
          preimage: absent(),
          desired: fileState('new'),
          desiredContent: 'new',
        },
      ]);
      let swapped = false;
      const harness = await prepareHarness(plan, root, undefined, (mutation) => {
        if (swapped || mutation.operation !== 'replace') return;
        const next = JSON.parse(mutation.content) as RuntimePromotionJournal;
        const isTargetTransition =
          transition === 'intent'
            ? next.progress.pendingIntent?.kind === 'owned-slot-cleanup'
            : next.cleanup.authoredStage === 'removed';
        if (!isTargetTransition) return;
        swapped = true;
        renameSync(root, displaced);
        temporaryRoots.push(displaced);
        mkdirSync(root, { mode: 0o700 });
        writeFileSync(replacementFile, 'customer', { mode: 0o600 });
      });
      const committed = await commitAuthoredState(harness.prepared.transaction);
      const closed = await closeCommitted(harness.controller, committed.receipt);

      await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
        /project root changed/iu,
      );

      expect(swapped).toBe(true);
      expect(readFileSync(replacementFile, 'utf8')).toBe('customer');
    }
  });

  it('reasserts the project root on an absent cleanup branch', async () => {
    const root = projectRoot();
    const displaced = `${root}-displaced-absent-cleanup`;
    const replacementFile = join(root, 'customer.txt');
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    let swapped = false;
    const harness = await prepareHarness(plan, root, (checkpoint) => {
      if (swapped || checkpoint !== 'after-cleanup-artifact-observation') return;
      swapped = true;
      renameSync(root, displaced);
      temporaryRoots.push(displaced);
      mkdirSync(root, { mode: 0o700 });
      writeFileSync(replacementFile, 'customer', { mode: 0o600 });
    });
    const committed = await commitAuthoredState(harness.prepared.transaction);
    const closed = await closeCommitted(harness.controller, committed.receipt);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    rmSync(join(root, owned.authoredStage.basename), { recursive: true });

    await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
      /project root changed/iu,
    );

    expect(swapped).toBe(true);
    expect(readFileSync(replacementFile, 'utf8')).toBe('customer');
  });

  it('refuses a symlink swapped in between artifact inspection and unlink', async () => {
    const root = projectRoot();
    writeFileSync(join(root, 'new.txt'), 'new', { mode: 0o600 });
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: fileState('new'),
        desired: fileState('new'),
        preimageContent: 'new',
        desiredContent: 'new',
      },
    ]);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const blob = join(root, owned.authoredStage.basename, 'desired', '0000.blob');
    const displacedBlob = `${blob}.displaced`;
    const sentinel = join(root, 'customer-sentinel.txt');
    writeFileSync(sentinel, 'customer', { mode: 0o600 });
    let swapped = false;
    const harness = await prepareHarness(plan, root, (checkpoint) => {
      if (swapped || checkpoint !== 'before-cleanup-entry-unlink') return;
      swapped = true;
      renameSync(blob, displacedBlob);
      symlinkSync(sentinel, blob);
    });
    const committed = await commitAuthoredState(harness.prepared.transaction);
    const closed = await closeCommitted(harness.controller, committed.receipt);

    await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
      /changed while it was being removed/iu,
    );

    expect(swapped).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('customer');
    expect(lstatSync(blob).isSymbolicLink()).toBe(true);
  });

  it('does not record an already-satisfied cleanup after an absent artifact path is replaced', async () => {
    const root = projectRoot();
    const plan = authoredPlan([
      {
        path: 'new.txt',
        preimage: absent(),
        desired: fileState('new'),
        desiredContent: 'new',
      },
    ]);
    const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);
    const stage = join(root, owned.authoredStage.basename);
    const sentinel = join(stage, 'customer-tree', 'sentinel.txt');
    let inserted = false;
    const harness = await prepareHarness(plan, root, undefined, (mutation) => {
      if (inserted || mutation.operation !== 'replace') return;
      const next = JSON.parse(mutation.content) as RuntimePromotionJournal;
      if (next.cleanup.authoredStage !== 'removed') return;
      inserted = true;
      mkdirSync(join(stage, 'customer-tree'), { recursive: true, mode: 0o700 });
      writeFileSync(sentinel, 'customer', { mode: 0o600 });
    });
    const committed = await commitAuthoredState(harness.prepared.transaction);
    const closed = await closeCommitted(harness.controller, committed.receipt);
    rmSync(stage, { recursive: true });

    await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
      /no longer absent/iu,
    );

    expect(inserted).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('customer');
    const claimed = (await harness.controller.claim(OPERATION_ID)) as DurableClosedPromotionJournal;
    await expect(cleanupAuthoredState(harness.prepared.transaction, claimed)).rejects.toThrow(
      /no longer absent/iu,
    );
    expect(readFileSync(sentinel, 'utf8')).toBe('customer');
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

  it.each([
    {
      boundary: 'after-cleanup-evidence-published',
      occurrence: 1,
      window: 'durable evidence publication',
    },
    {
      boundary: 'after-cleanup-entry-unlink',
      occurrence: 1,
      window: 'blob unlink',
    },
    {
      boundary: 'after-cleanup-directory-removal',
      occurrence: 1,
      window: 'blob-directory removal',
    },
    {
      boundary: 'after-cleanup-entry-unlink',
      occurrence: 2,
      window: 'owner-marker unlink',
    },
    {
      boundary: 'after-cleanup-directory-removal',
      occurrence: 2,
      window: 'artifact-root removal',
    },
    {
      boundary: 'before-cleanup-evidence-unlink',
      occurrence: 1,
      window: 'pre-evidence unlink',
    },
    {
      boundary: 'after-cleanup-evidence-unlink',
      occurrence: 1,
      window: 'post-evidence unlink',
    },
  ] as const)(
    'resumes exact closed cleanup after a crash at $window',
    async ({ boundary, occurrence }) => {
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
      let observations = 0;
      const harness = await prepareHarness(plan, root, (checkpoint) => {
        if (checkpoint !== boundary) return;
        observations += 1;
        if (observations === occurrence) throw new Error('inner cleanup crash');
      });
      const committed = await commitAuthoredState(harness.prepared.transaction);
      const closed = await closeCommitted(harness.controller, committed.receipt);

      await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
        /inner cleanup crash/iu,
      );

      const recoveryLease = fakeLease(root);
      const recoveryController = controllerFor(recoveryLease, harness.store);
      const claimed = (await recoveryController.claim(
        OPERATION_ID,
      )) as DurableClosedPromotionJournal;
      const transaction = await loadClosedAuthoredState({
        projectRoot: root,
        projectRootAuthority: projectRootAuthority(root, recoveryLease),
        lease: recoveryLease,
        controller: recoveryController,
        receipt: claimed,
      });
      const result = await cleanupAuthoredState(transaction, claimed);
      const owned = createRuntimePromotionOwnedSlots(OPERATION_ID);

      expect(result.summary).toMatchObject({
        verified: true,
        actionsKnown: true,
      });
      expect(existsSync(join(root, owned.authoredStage.basename))).toBe(false);
      expect(existsSync(join(root, owned.authoredBackup.basename))).toBe(false);
      expect(existsSync(join(root, owned.replayManifest.basename))).toBe(false);
      expect(
        readdirSync(root).filter((name) => name.startsWith('.opensip-init-authored-cleanup-')),
      ).toEqual([]);
      expect(readFileSync(join(root, 'kept.txt'), 'utf8')).toBe('same');
    },
  );

  it('preserves an exact-byte replacement swapped in for cleanup evidence', async () => {
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
    let replacement: string | undefined;
    let displaced: string | undefined;
    let canonicalBytes: string | undefined;
    const harness = await prepareHarness(plan, root, (checkpoint) => {
      if (replacement !== undefined || checkpoint !== 'before-cleanup-evidence-unlink') {
        return;
      }
      const basename = readdirSync(root).find((name) =>
        name.startsWith('.opensip-init-authored-cleanup-'),
      );
      if (basename === undefined) throw new Error('missing cleanup evidence');
      replacement = join(root, basename);
      displaced = `${replacement}.opensip-original`;
      canonicalBytes = readFileSync(replacement, 'utf8');
      renameSync(replacement, displaced);
      writeFileSync(replacement, canonicalBytes, { mode: 0o600 });
    });
    const committed = await commitAuthoredState(harness.prepared.transaction);
    const closed = await closeCommitted(harness.controller, committed.receipt);

    await expect(cleanupAuthoredState(harness.prepared.transaction, closed)).rejects.toThrow(
      /cleanup evidence changed/iu,
    );

    expect(replacement).toBeDefined();
    expect(displaced).toBeDefined();
    if (replacement === undefined || displaced === undefined) {
      throw new Error('cleanup evidence replacement was not installed');
    }
    expect(canonicalBytes).toBeDefined();
    expect(readFileSync(replacement, 'utf8')).toBe(canonicalBytes);
    expect(readFileSync(displaced, 'utf8')).toContain('opensip-init-authored-cleanup-evidence');
    expect(lstatSync(replacement).ino).not.toBe(lstatSync(displaced).ino);
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
      projectRootAuthority: projectRootAuthority(root, recoveryLease),
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
      projectRootAuthority: projectRootAuthority(root, recoveryLease),
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

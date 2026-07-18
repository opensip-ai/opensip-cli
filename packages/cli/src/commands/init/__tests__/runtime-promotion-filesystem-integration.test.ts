import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  acquireRuntimeExclusiveLease,
  readRuntimePromotionJournal,
  resolveEphemeralProjectPaths,
  resolveProjectPaths,
  touchEphemeralRuntime,
  type RuntimeExclusiveLease,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStoreLockContext } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bindAuthoredStateReceipt,
  cleanupAuthoredState,
  prepareAuthoredState,
  rollbackAuthoredState,
  verifyAuthoredState,
  type InitAuthoredTransaction,
} from '../authored-state-transaction.js';
import { createInitAuthoredPlan } from '../init-authored-plan.js';
import {
  copyRuntimeToStage,
  inspectVerifiedRuntimeManifest,
  type VerifiedRuntimeManifest,
} from '../runtime-manifest.js';
import {
  authorizeRuntimePromotionFilesystem,
  createRuntimePromotionDestinationParent,
  installRuntimePromotionStage,
  reconcileRuntimePromotionStage,
  rollbackRuntimePromotion,
  type RuntimePromotionFilesystemCheckpoint,
} from '../runtime-promotion-filesystem.js';
import {
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
} from '../runtime-promotion-journal-schema.js';
import {
  createRuntimePromotionJournalController,
  type DurableOpenPromotionJournal,
  type RuntimePromotionJournalController,
} from '../runtime-promotion-journal.js';
import { preflightRuntimePromotionAuthority } from '../runtime-promotion-preflight.js';
import { recoverRuntimePromotion } from '../runtime-promotion-recovery.js';
import {
  bindRuntimePromotionFreshProjectRootAuthority,
  type RuntimePromotionProjectRootAuthority,
} from '../runtime-promotion-root-authority.js';
import {
  createRuntimePromotionTransitionWriter,
  type RuntimeMutationOutcome,
  type RuntimePromotionTransitionWriter,
} from '../runtime-promotion-transitions.js';
import { runFreshRuntimePromotion } from '../runtime-promotion.js';

const LOCK_CONTEXT: DataStoreLockContext = {
  policy: { waitMs: 1000, staleMs: 30_000, heartbeatMs: 1000 },
  command: 'opensip init',
  cwdBasename: 'project',
};

interface PreparedPromotion {
  readonly projectRoot: string;
  readonly sourceRuntime: string;
  readonly sourceManifest: VerifiedRuntimeManifest;
  readonly lease: RuntimeExclusiveLease;
  readonly controller: RuntimePromotionJournalController;
  readonly writer: RuntimePromotionTransitionWriter;
  readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
  readonly transaction: InitAuthoredTransaction;
  receipt: DurableOpenPromotionJournal;
}

let sandbox: string;
let home: string;
let project: string;
let priorHome: string | undefined;

function makeDirectory(path: string, mode = 0o700): string {
  mkdirSync(path, { recursive: true, mode });
  if (process.platform !== 'win32') chmodSync(path, mode);
  return path;
}

function writePrivate(path: string, content: string): void {
  makeDirectory(dirname(path));
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function createValidDatastore(runtimeDir: string): void {
  const datastore = DataStoreFactory.open({
    backend: 'sqlite',
    path: join(runtimeDir, 'datastore.sqlite'),
  });
  const closed = datastore.closeForLifecycle?.();
  if (closed === undefined) {
    datastore.close();
  } else if (!closed.closed) {
    throw new Error('The integration-test datastore did not close.');
  }
}

function seedCacheRuntime(): ReturnType<typeof resolveEphemeralProjectPaths> {
  const paths = resolveEphemeralProjectPaths(project);
  touchEphemeralRuntime(paths);
  if (process.platform !== 'win32') chmodSync(paths.runtimeDir, 0o700);
  writePrivate(join(paths.runtimeDir, 'evidence.txt'), 'cache authority');
  createValidDatastore(paths.runtimeDir);
  return paths;
}

function mutationOutcome(status: string): RuntimeMutationOutcome {
  return status.startsWith('already-') ? 'already-satisfied' : 'applied';
}

async function createPreparedPromotion(input: {
  readonly destinationParentPreexisting: boolean;
}): Promise<PreparedPromotion> {
  if (input.destinationParentPreexisting) {
    makeDirectory(join(project, 'opensip-cli'), 0o755);
  }
  const cache = seedCacheRuntime();
  const lease = await acquireRuntimeExclusiveLease({
    projectDir: project,
    posture: 'normal',
    command: 'opensip init integration test',
    cwdBasename: 'project',
  });
  try {
    const preflight = preflightRuntimePromotionAuthority({
      projectRoot: project,
      lease,
      conflict: 'use-cache',
    });
    if (preflight.status !== 'selected' || preflight.route !== 'promote-cache') {
      throw new Error('The integration fixture did not select cache promotion.');
    }
    if (preflight.sourceRuntimeDir === undefined) {
      throw new Error('The selected cache promotion has no source runtime.');
    }
    const projectRootAuthority = bindRuntimePromotionFreshProjectRootAuthority({
      lease,
      token: preflight.revalidation,
    });
    const plan = createInitAuthoredPlan({
      projectRoot: preflight.revalidation.projectRoot,
      languages: ['typescript'],
      mode: 'fresh',
      toolScaffolds: [],
    });
    const controller = createRuntimePromotionJournalController(lease);
    const writer = createRuntimePromotionTransitionWriter(controller);
    const allocation = controller.allocate((identity) =>
      createInitialRuntimePromotionJournal({
        coordinationKey: lease.coordinationKey,
        operationId: identity.operationId,
        recoveryOwnerToken: identity.recoveryOwnerToken,
        route: preflight.route,
        destinationParentPreexisting: preflight.destinationParentPreexisting,
        destinationRuntimePreexisting: preflight.destinationRuntimePreexisting,
        destinationRootIdentity: preflight.destinationRootIdentity,
        source: preflight.source,
        inputs: {
          conflict: preflight.effectiveConflict,
          authoredMode: plan.inputs.mode,
          languages: plan.inputs.languages,
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
    const sourceManifest = inspectVerifiedRuntimeManifest(cache.runtimeDir, 'cache-source');
    receipt = await writer.verifySource(receipt, sourceManifest.identity);
    receipt = await writer.verifyDestination(receipt, null);
    const prepared = await prepareAuthoredState({
      projectRoot: preflight.revalidation.projectRoot,
      projectRootAuthority,
      lease,
      controller,
      receipt,
      plan,
    });
    receipt = await writer.bindAuthoredPrepared(prepared.receipt);
    return {
      projectRoot: preflight.revalidation.projectRoot,
      sourceRuntime: preflight.sourceRuntimeDir,
      sourceManifest,
      lease,
      controller,
      writer,
      projectRootAuthority,
      transaction: prepared.transaction,
      receipt,
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}

async function installPreparedRuntime(promotion: PreparedPromotion): Promise<void> {
  const initial = await promotion.controller.verifyOpen(promotion.receipt);
  if (initial.destinationParentPreexisting) {
    promotion.receipt = await promotion.writer.advancePreexistingDestinationReady(
      promotion.receipt,
    );
  } else {
    promotion.receipt = await promotion.writer.recordDestinationParentCreateIntent(
      promotion.receipt,
    );
    const parentAuthority = await authorizeRuntimePromotionFilesystem({
      action: 'destination-parent-create',
      projectRoot: promotion.projectRoot,
      controller: promotion.controller,
      lease: promotion.lease,
      receipt: promotion.receipt,
      projectRootAuthority: promotion.projectRootAuthority,
    });
    const parent = await createRuntimePromotionDestinationParent(parentAuthority);
    promotion.receipt = await promotion.writer.recordDestinationReady(
      promotion.receipt,
      mutationOutcome(parent.status),
    );
  }

  promotion.receipt = await promotion.writer.recordRuntimeStageCreateIntent(promotion.receipt);
  const stageAuthority = await authorizeRuntimePromotionFilesystem({
    action: 'runtime-stage-reconcile',
    projectRoot: promotion.projectRoot,
    sourceRuntime: promotion.sourceRuntime,
    controller: promotion.controller,
    lease: promotion.lease,
    receipt: promotion.receipt,
    projectRootAuthority: promotion.projectRootAuthority,
  });
  await expect(
    reconcileRuntimePromotionStage(stageAuthority, {
      expected: promotion.sourceManifest,
    }),
  ).resolves.toEqual({ status: 'absent' });
  const journal = await promotion.controller.verifyOpen(promotion.receipt);
  const staged = await copyRuntimeToStage({
    controller: promotion.controller,
    receipt: promotion.receipt,
    sourceDir: promotion.sourceRuntime,
    sourcePosture: 'cache-source',
    destinationParent: join(promotion.projectRoot, 'opensip-cli'),
    stageBasename: journal.owned.runtimeStage.basename,
    projectRootAuthority: promotion.projectRootAuthority,
    lease: promotion.lease,
  });
  promotion.receipt = await promotion.writer.recordRuntimeStaged(
    promotion.receipt,
    'applied',
    staged.stage.identity,
  );

  promotion.receipt = await promotion.writer.recordDestinationInstallIntent(promotion.receipt);
  const installAuthority = await authorizeRuntimePromotionFilesystem({
    action: 'destination-install',
    projectRoot: promotion.projectRoot,
    sourceRuntime: promotion.sourceRuntime,
    controller: promotion.controller,
    lease: promotion.lease,
    receipt: promotion.receipt,
    projectRootAuthority: promotion.projectRootAuthority,
  });
  const installed = await installRuntimePromotionStage(installAuthority, staged.stage.identity);
  promotion.receipt = await promotion.writer.recordRuntimeInstalled(
    promotion.receipt,
    mutationOutcome(installed.status),
  );
}

beforeEach(() => {
  priorHome = process.env.HOME;
  sandbox = realpathSync(
    makeDirectory(mkdtempSync(join(tmpdir(), 'opensip-runtime-fs-integration-'))),
  );
  home = makeDirectory(join(sandbox, 'home'));
  project = makeDirectory(join(sandbox, 'project'));
  process.env.HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('production-wired runtime promotion filesystem', () => {
  it('promotes a real cache runtime and SQLite datastore into a fresh project', async () => {
    const cache = seedCacheRuntime();

    const result = await runFreshRuntimePromotion({
      projectRoot: project,
      languages: ['typescript'],
      languageExplicit: false,
      authoredMode: 'fresh',
      toolScaffolds: [],
      datastoreLockContext: LOCK_CONTEXT,
      conflict: 'use-cache',
    });
    expect(result).toMatchObject({
      status: 'promoted',
      sourcePreserved: false,
    });
    expect(result).not.toHaveProperty('cleanupPending');
    expect(existsSync(cache.runtimeDir)).toBe(false);
    const projectRuntime = resolveProjectPaths(project).runtimeDir;
    const installed = inspectVerifiedRuntimeManifest(projectRuntime, 'project-runtime');
    expect(installed.identity.sqlite.status).toBe('verified');
    expect(readdirSync(projectRuntime)).toContain('evidence.txt');

    const lease = await acquireRuntimeExclusiveLease({
      projectDir: project,
      posture: 'normal',
      command: 'verify promotion cleanup',
      cwdBasename: 'project',
    });
    try {
      await expect(readRuntimePromotionJournal(lease)).resolves.toEqual({
        status: 'absent',
      });
    } finally {
      lease.release();
    }
  }, 15_000);

  it('rejects a byte-identical project runtime replacement after datastore checkpointing', async () => {
    const projectRuntime = makeDirectory(resolveProjectPaths(project).runtimeDir);
    writePrivate(join(projectRuntime, 'evidence.txt'), 'project authority');
    createValidDatastore(projectRuntime);
    const replacement = join(sandbox, 'project-runtime-replacement');
    const displaced = join(sandbox, 'project-runtime-selected');
    const rejected = join(sandbox, 'project-runtime-rejected');
    cpSync(projectRuntime, replacement, { recursive: true, preserveTimestamps: true });
    if (process.platform !== 'win32') chmodSync(replacement, 0o700);
    expect(inspectVerifiedRuntimeManifest(replacement, 'project-runtime').identity).toEqual(
      inspectVerifiedRuntimeManifest(projectRuntime, 'project-runtime').identity,
    );
    const selectedIdentity = lstatSync(projectRuntime, { bigint: true });
    const replacementIdentity = lstatSync(replacement, { bigint: true });
    expect({
      dev: replacementIdentity.dev,
      ino: replacementIdentity.ino,
    }).not.toEqual({
      dev: selectedIdentity.dev,
      ino: selectedIdentity.ino,
    });

    let swapped = false;
    const result = await runFreshRuntimePromotion(
      {
        projectRoot: project,
        languages: ['typescript'],
        languageExplicit: false,
        authoredMode: 'fresh',
        toolScaffolds: [],
        datastoreLockContext: LOCK_CONTEXT,
      },
      {
        checkpoint: (checkpoint) => {
          if (swapped || checkpoint !== 'after-datastore-checkpoint') return;
          swapped = true;
          renameSync(projectRuntime, displaced);
          renameSync(replacement, projectRuntime);
        },
      },
    );

    expect(swapped).toBe(true);
    expect(result).toMatchObject({
      status: 'recovery-required',
      reasonCode: 'operation-failed',
    });
    expect(lstatSync(projectRuntime, { bigint: true }).ino).toBe(replacementIdentity.ino);

    await expect(
      recoverRuntimePromotion({
        projectRoot: project,
        datastoreLockContext: LOCK_CONTEXT,
      }),
    ).resolves.toMatchObject({
      status: 'recovery-required',
      reasonCode: 'artifact-mismatch',
    });
    expect(lstatSync(projectRuntime, { bigint: true }).ino).toBe(replacementIdentity.ino);

    renameSync(projectRuntime, rejected);
    renameSync(displaced, projectRuntime);
    await expect(
      recoverRuntimePromotion({
        projectRoot: project,
        datastoreLockContext: LOCK_CONTEXT,
      }),
    ).resolves.toMatchObject({
      status: 'rolled-back',
    });
    expect(lstatSync(projectRuntime, { bigint: true }).ino).toBe(selectedIdentity.ino);
    expect(lstatSync(rejected, { bigint: true }).ino).toBe(replacementIdentity.ino);
  }, 20_000);

  it('removes a staged runtime when rollback starts before install in a preexisting parent', async () => {
    const cache = seedCacheRuntime();
    const destinationParent = makeDirectory(join(project, 'opensip-cli'), 0o755);

    const result = await runFreshRuntimePromotion(
      {
        projectRoot: project,
        languages: ['typescript'],
        languageExplicit: false,
        authoredMode: 'fresh',
        toolScaffolds: [],
        datastoreLockContext: LOCK_CONTEXT,
        conflict: 'use-cache',
      },
      {
        checkpoint: (checkpoint) => {
          if (checkpoint === 'after-runtime-staged') {
            throw new Error('injected preinstall crash');
          }
        },
      },
    );
    expect(result).toMatchObject({
      status: 'rolled-back',
      sourcePreserved: true,
    });
    expect(existsSync(cache.runtimeDir)).toBe(true);
    expect(existsSync(resolveProjectPaths(project).runtimeDir)).toBe(false);
    expect(readdirSync(destinationParent)).toEqual([]);

    const lease = await acquireRuntimeExclusiveLease({
      projectDir: project,
      posture: 'normal',
      command: 'verify staged rollback cleanup',
      cwdBasename: 'project',
    });
    try {
      await expect(readRuntimePromotionJournal(lease)).resolves.toEqual({
        status: 'absent',
      });
    } finally {
      lease.release();
    }
  }, 15_000);

  it('retries a destination-parent create after crashing immediately after mkdir', async () => {
    const promotion = await createPreparedPromotion({
      destinationParentPreexisting: false,
    });
    try {
      promotion.receipt = await promotion.writer.recordDestinationParentCreateIntent(
        promotion.receipt,
      );
      let injected = false;
      const authority = await authorizeRuntimePromotionFilesystem({
        action: 'destination-parent-create',
        projectRoot: promotion.projectRoot,
        controller: promotion.controller,
        lease: promotion.lease,
        receipt: promotion.receipt,
        projectRootAuthority: promotion.projectRootAuthority,
        dependencies: {
          checkpoint: (checkpoint: RuntimePromotionFilesystemCheckpoint) => {
            if (
              !injected &&
              checkpoint.boundary === 'after' &&
              checkpoint.effect === 'mutation' &&
              checkpoint.operation === 'destination-parent-mkdir'
            ) {
              injected = true;
              throw new Error('injected post-mkdir crash');
            }
          },
        },
      });
      await expect(createRuntimePromotionDestinationParent(authority)).rejects.toThrow(
        /post-mkdir/u,
      );
      expect(injected).toBe(true);
      const pendingParent = await promotion.controller.verifyOpen(promotion.receipt);
      expect(existsSync(join(project, 'opensip-cli'))).toBe(false);
      expect(existsSync(join(project, pendingParent.owned.destinationParent.basename))).toBe(true);
      expect(pendingParent.progress.pendingIntent).toMatchObject({
        kind: 'destination-parent-create',
        slot: 'destinationParent',
      });

      const retryAuthority = await authorizeRuntimePromotionFilesystem({
        action: 'destination-parent-create',
        projectRoot: promotion.projectRoot,
        controller: promotion.controller,
        lease: promotion.lease,
        receipt: promotion.receipt,
        projectRootAuthority: promotion.projectRootAuthority,
      });
      const retried = await createRuntimePromotionDestinationParent(retryAuthority);
      expect(retried.status).toBe('created');
      promotion.receipt = await promotion.writer.recordDestinationReady(
        promotion.receipt,
        mutationOutcome(retried.status),
      );
      await expect(promotion.controller.verifyOpen(promotion.receipt)).resolves.toMatchObject({
        progress: { phase: 'destination-ready', pendingIntent: null },
        cleanup: { destinationParent: 'pending' },
      });
    } finally {
      promotion.lease.release();
    }
  }, 15_000);

  it('replays an interrupted installed rollback and completes real closed cleanup', async () => {
    const promotion = await createPreparedPromotion({
      destinationParentPreexisting: true,
    });
    try {
      await installPreparedRuntime(promotion);
      const projectRuntime = resolveProjectPaths(project).runtimeDir;
      expect(
        inspectVerifiedRuntimeManifest(projectRuntime, 'project-runtime').identity.sqlite.status,
      ).toBe('verified');

      promotion.receipt = await promotion.writer.beginRollback(promotion.receipt);
      promotion.receipt = await promotion.writer.recordRuntimeRollbackIntent(promotion.receipt);
      let injected = false;
      const authority = await authorizeRuntimePromotionFilesystem({
        action: 'runtime-rollback',
        projectRoot: promotion.projectRoot,
        sourceRuntime: promotion.sourceRuntime,
        controller: promotion.controller,
        lease: promotion.lease,
        receipt: promotion.receipt,
        projectRootAuthority: promotion.projectRootAuthority,
        dependencies: {
          checkpoint: (checkpoint: RuntimePromotionFilesystemCheckpoint) => {
            if (
              !injected &&
              checkpoint.boundary === 'after' &&
              checkpoint.effect === 'mutation' &&
              checkpoint.operation === 'owned-entry-unlink'
            ) {
              injected = true;
              throw new Error('injected rollback crash');
            }
          },
        },
      });
      await expect(
        rollbackRuntimePromotion(authority, {
          installed: promotion.sourceManifest.identity,
          backup: null,
          installedWasAuthoritative: true,
        }),
      ).rejects.toThrow(/rollback crash/u);
      expect(injected).toBe(true);
      const pendingRollback = await promotion.controller.verifyOpen(promotion.receipt);
      expect(pendingRollback.progress.pendingIntent).toMatchObject({
        kind: 'runtime-rollback',
        slot: 'destinationBackup',
      });

      const retryAuthority = await authorizeRuntimePromotionFilesystem({
        action: 'runtime-rollback',
        projectRoot: promotion.projectRoot,
        sourceRuntime: promotion.sourceRuntime,
        controller: promotion.controller,
        lease: promotion.lease,
        receipt: promotion.receipt,
        projectRootAuthority: promotion.projectRootAuthority,
      });
      const rollback = await rollbackRuntimePromotion(retryAuthority, {
        installed: promotion.sourceManifest.identity,
        backup: null,
        installedWasAuthoritative: true,
      });
      promotion.receipt = await promotion.writer.recordRuntimeRolledBack(
        promotion.receipt,
        mutationOutcome(rollback.status),
      );
      expect(existsSync(projectRuntime)).toBe(false);
      expect(existsSync(promotion.sourceRuntime)).toBe(true);

      await bindAuthoredStateReceipt(promotion.transaction, promotion.receipt);
      const authoredRollback = await rollbackAuthoredState(promotion.transaction);
      promotion.receipt = await promotion.writer.bindAuthoredRolledBack(authoredRollback.receipt);
      await expect(verifyAuthoredState(promotion.transaction, 'preimage')).resolves.toMatchObject({
        completed: 0,
        rolledBack: 0,
        verified: true,
      });
      const sealed = await promotion.writer.sealRolledBack(
        promotion.receipt,
        promotion.sourceManifest.identity,
      );
      const closed = await promotion.writer.close(sealed);
      const cleaned = await cleanupAuthoredState(promotion.transaction, closed);
      await promotion.writer.unlinkClean(cleaned.receipt);

      await expect(readRuntimePromotionJournal(promotion.lease)).resolves.toEqual({
        status: 'absent',
      });
      expect(existsSync(projectRuntime)).toBe(false);
      expect(existsSync(promotion.sourceRuntime)).toBe(true);
    } finally {
      promotion.lease.release();
    }
  }, 15_000);
});

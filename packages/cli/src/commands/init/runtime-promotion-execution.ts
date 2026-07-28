import { authoredTransactionFailure } from './authored-state-transaction-failure.js';
import { compareRuntimeManifests } from './runtime-manifest.js';
import { authorityUnverified } from './runtime-promotion-authority-error.js';
import { checkpointRuntimeDatastores } from './runtime-promotion-execution-datastore.js';
import {
  retireSelectedSource,
  runtimePromotionUsesSelectedSource,
} from './runtime-promotion-execution-retirement.js';
import { sealCommittedRuntimePromotion } from './runtime-promotion-execution-seal.js';
import { assertFreshRuntimePromotionProjectRoot } from './runtime-promotion-root-authority.js';
import { runtimePromotionMutationOutcome } from './runtime-promotion-transitions-common.js';

import type { VerifiedRuntimeManifest } from './runtime-manifest.js';
import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
} from './runtime-promotion-journal.js';
import type { RuntimePromotionOperation } from './runtime-promotion-types.js';

/** @throws {Error} When selected source or destination runtime authority has changed. */
async function verifySelectedRuntimes(
  operation: RuntimePromotionOperation,
): Promise<RuntimePromotionOperation> {
  assertFreshRuntimePromotionProjectRoot(operation);
  if (runtimePromotionUsesSelectedSource(operation.preflight.route)) {
    const sourceRuntimeDir = operation.preflight.sourceRuntimeDir;
    if (sourceRuntimeDir === undefined) {
      operation.sourcePreserved = false;
      authorityUnverified(
        'Selected cache authority has no source runtime',
        'selected-cache-source-runtime-absent',
      );
    }
    try {
      operation.sourceManifest = operation.dependencies.inspectManifest(
        sourceRuntimeDir,
        'cache-source',
      );
      operation.sourcePreserved = true;
    } catch (error) {
      operation.sourcePreserved = false;
      throw error;
    }
    operation.receipt = await operation.writer.verifySource(
      operation.receipt,
      operation.sourceManifest.identity,
    );
    operation.dependencies.checkpoint?.('after-source-verified');
  }
  if (operation.preflight.route === 'authored-only') return operation;
  assertFreshRuntimePromotionProjectRoot(operation);
  const journal = await operation.controller.verifyOpen(operation.receipt);
  operation.destinationManifest = operation.preflight.destinationRuntimePreexisting
    ? (() => {
        operation.dependencies.assertDestinationRootAuthority({
          runtimeDir: operation.preflight.destinationRuntimeDir,
          journal,
        });
        const manifest = operation.dependencies.inspectManifest(
          operation.preflight.destinationRuntimeDir,
          'project-runtime',
        );
        operation.dependencies.assertDestinationRootAuthority({
          runtimeDir: operation.preflight.destinationRuntimeDir,
          journal,
        });
        return manifest;
      })()
    : null;
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.receipt = await operation.writer.verifyDestination(
    operation.receipt,
    operation.destinationManifest?.identity ?? null,
  );
  if (operation.preflight.destinationRuntimePreexisting) {
    operation.dependencies.assertDestinationRootAuthority({
      runtimeDir: operation.preflight.destinationRuntimeDir,
      journal,
    });
  }
  operation.dependencies.checkpoint?.('after-destination-verified');
  if (
    operation.preflight.route === 'deduplicate-cache' &&
    (operation.sourceManifest === null ||
      operation.destinationManifest === null ||
      !compareRuntimeManifests(operation.sourceManifest, operation.destinationManifest).equal)
  ) {
    authorityUnverified(
      'Cache and project runtimes changed after equivalence selection',
      'equivalence-selection-runtimes-changed',
    );
  }
  return operation;
}

async function prepareAuthored(
  operation: RuntimePromotionOperation,
): Promise<RuntimePromotionOperation> {
  assertFreshRuntimePromotionProjectRoot(operation);
  const prepared = await operation.dependencies.prepareAuthored({
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    lease: operation.lease,
    controller: operation.controller,
    receipt: operation.receipt,
    plan: operation.plan,
  });
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.transaction = prepared.transaction;
  operation.receipt = await operation.writer.bindAuthoredPrepared(prepared.receipt);
  operation.authoredSummary = prepared.summary;
  operation.dependencies.checkpoint?.('after-authored-prepared');
  return operation;
}

async function ensureDestinationReady(
  operation: RuntimePromotionOperation,
): Promise<DurableOpenPromotionJournal> {
  assertFreshRuntimePromotionProjectRoot(operation);
  if (operation.preflight.destinationParentPreexisting) {
    operation.receipt = await operation.writer.advancePreexistingDestinationReady(
      operation.receipt,
    );
  } else {
    operation.receipt = await operation.writer.recordDestinationParentCreateIntent(
      operation.receipt,
    );
    const authority = await operation.dependencies.authorizeFilesystem({
      action: 'destination-parent-create',
      projectRoot: operation.input.projectRoot,
      projectRootAuthority: operation.projectRootAuthority,
      controller: operation.controller,
      lease: operation.lease,
      receipt: operation.receipt,
    });
    const result = await operation.dependencies.createDestinationParent(authority);
    assertFreshRuntimePromotionProjectRoot(operation);
    operation.receipt = await operation.writer.recordDestinationReady(
      operation.receipt,
      runtimePromotionMutationOutcome(result.status),
    );
  }
  operation.dependencies.checkpoint?.('after-destination-ready');
  return operation.receipt;
}

/** @throws {Error} When the runtime stage cannot be materialized with durable authority. */
async function materializeRuntimeStage(
  operation: RuntimePromotionOperation,
  initialReceipt: DurableOpenPromotionJournal,
): Promise<VerifiedRuntimeManifest> {
  if (operation.sourceManifest === null || operation.preflight.sourceRuntimeDir === undefined) {
    authorityUnverified(
      'Runtime staging requires a verified cache source',
      'staging-cache-source-unverified',
    );
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  const stageIntentReceipt = await operation.writer.recordRuntimeStageCreateIntent(initialReceipt);
  operation.receipt = stageIntentReceipt;
  const authority = await operation.dependencies.authorizeFilesystem({
    action: 'runtime-stage-reconcile',
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    sourceRuntime: operation.preflight.sourceRuntimeDir,
    controller: operation.controller,
    lease: operation.lease,
    receipt: stageIntentReceipt,
  });
  const reconciled = await operation.dependencies.reconcileStage(authority, {
    expected: operation.sourceManifest,
  });
  assertFreshRuntimePromotionProjectRoot(operation);
  let staged: VerifiedRuntimeManifest;
  let outcome: 'applied' | 'already-satisfied';
  if (reconciled.status === 'verified') {
    staged = reconciled.manifest;
    outcome = 'already-satisfied';
  } else {
    assertFreshRuntimePromotionProjectRoot(operation);
    const current = await operation.controller.verifyOpen(operation.receipt);
    const copied = await operation.dependencies.copyStage({
      controller: operation.controller,
      receipt: operation.receipt,
      sourceDir: operation.preflight.sourceRuntimeDir,
      sourcePosture: 'cache-source',
      destinationParent: operation.preflight.destinationParentDir,
      stageBasename: current.owned.runtimeStage.basename,
      projectRootAuthority: operation.projectRootAuthority,
      lease: operation.lease,
    });
    assertFreshRuntimePromotionProjectRoot(operation);
    staged = copied.stage;
    outcome = 'applied';
  }
  operation.receipt = await operation.writer.recordRuntimeStaged(
    operation.receipt,
    outcome,
    staged.identity,
  );
  operation.dependencies.checkpoint?.('after-runtime-staged');
  return staged;
}

/** @throws {Error} When a preexisting destination cannot be backed up safely. */
async function backupDestinationIfNeeded(
  operation: RuntimePromotionOperation,
): Promise<DurableOpenPromotionJournal> {
  if (!operation.preflight.destinationRuntimePreexisting) return operation.receipt;
  if (operation.destinationManifest === null) {
    authorityUnverified(
      'Destination backup requires a verified project runtime',
      'backup-project-runtime-unverified',
    );
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  let journal = await operation.controller.verifyOpen(operation.receipt);
  operation.dependencies.assertDestinationRootAuthority({
    runtimeDir: operation.preflight.destinationRuntimeDir,
    journal,
  });
  const backupIntentReceipt = await operation.writer.recordDestinationBackupCreateIntent(
    operation.receipt,
  );
  operation.receipt = backupIntentReceipt;
  journal = await operation.controller.verifyOpen(backupIntentReceipt);
  operation.dependencies.assertDestinationRootAuthority({
    runtimeDir: operation.preflight.destinationRuntimeDir,
    journal,
  });
  const authority = await operation.dependencies.authorizeFilesystem({
    action: 'destination-backup-create',
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    sourceRuntime: operation.preflight.sourceRuntimeDir,
    controller: operation.controller,
    lease: operation.lease,
    receipt: operation.receipt,
  });
  const result = await operation.dependencies.backupDestination(
    authority,
    operation.destinationManifest.identity,
  );
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.receipt = await operation.writer.recordDestinationBackedUp(
    operation.receipt,
    runtimePromotionMutationOutcome(result.status),
  );
  operation.dependencies.checkpoint?.('after-destination-backed-up');
  return operation.receipt;
}

async function installRuntime(
  operation: RuntimePromotionOperation,
  staged: VerifiedRuntimeManifest,
  initialReceipt: DurableOpenPromotionJournal,
): Promise<void> {
  assertFreshRuntimePromotionProjectRoot(operation);
  const installIntentReceipt =
    await operation.writer.recordDestinationInstallIntent(initialReceipt);
  operation.receipt = installIntentReceipt;
  const authority = await operation.dependencies.authorizeFilesystem({
    action: 'destination-install',
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    sourceRuntime: operation.preflight.sourceRuntimeDir,
    controller: operation.controller,
    lease: operation.lease,
    receipt: installIntentReceipt,
  });
  const result = await operation.dependencies.installStage(authority, staged.identity);
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.receipt = await operation.writer.recordRuntimeInstalled(
    operation.receipt,
    runtimePromotionMutationOutcome(result.status),
  );
  operation.dependencies.checkpoint?.('after-runtime-installed');
}

async function promoteCacheRuntime(
  operation: RuntimePromotionOperation,
): Promise<RuntimePromotionOperation> {
  const destinationReadyReceipt = await ensureDestinationReady(operation);
  const staged = await materializeRuntimeStage(operation, destinationReadyReceipt);
  await backupAndInstallRuntime(operation, staged);
  return operation;
}

async function backupAndInstallRuntime(
  operation: RuntimePromotionOperation,
  staged: VerifiedRuntimeManifest,
): Promise<void> {
  const backupReceipt = await backupDestinationIfNeeded(operation);
  await installRuntime(operation, staged, backupReceipt);
}

type AuthoredTransaction = NonNullable<RuntimePromotionOperation['transaction']>;

async function bindAuthoredForCommit(
  operation: RuntimePromotionOperation,
  transaction: AuthoredTransaction,
): Promise<AuthoredTransaction> {
  await operation.dependencies.bindAuthoredReceipt(transaction, operation.receipt);
  return transaction;
}

/** @throws {Error} When the authored-state transaction cannot be committed and verified. */
async function commitAuthored(
  operation: RuntimePromotionOperation,
): Promise<RuntimePromotionOperation> {
  if (operation.transaction === null) {
    authoredTransactionFailure(
      'the authored transaction was not prepared',
      undefined,
      'authored-transaction-not-prepared',
    );
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  const transaction = await bindAuthoredForCommit(operation, operation.transaction);
  const committed = await operation.dependencies.commitAuthored(transaction);
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.receipt = await operation.writer.bindAuthoredCommitted(committed.receipt);
  operation.authoredSummary = committed.summary;
  operation.dependencies.checkpoint?.('after-authored-committed');
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.authoredSummary = await operation.dependencies.verifyAuthored(transaction, 'desired');
  operation.dependencies.checkpoint?.('after-authored-verified');
  return operation;
}

export async function executeRuntimePromotionForward(
  operation: RuntimePromotionOperation,
): Promise<DurableClosedPromotionJournal> {
  const checkpointed = await checkpointRuntimeDatastores(operation);
  const selected = await verifySelectedRuntimes(checkpointed);
  const prepared = await prepareAuthored(selected);
  let promoted = prepared;
  if (prepared.preflight.route === 'promote-cache') {
    promoted = await promoteCacheRuntime(prepared);
  }
  const committed = await commitAuthored(promoted);
  const retired = await retireSelectedSource(committed);
  return sealCommittedRuntimePromotion(retired);
}

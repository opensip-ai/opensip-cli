import { compareRuntimeManifests, runtimeManifestIdentityEqual } from './runtime-manifest.js';
import {
  verifyClosedTerminalOperationAuthority,
  verifyCommittedOperationAuthority,
  verifyOpenTerminalOperationAuthority,
} from './runtime-promotion-authority-verification.js';
import { RuntimePromotionDatastoreError } from './runtime-promotion-preflight.js';
import { assertFreshRuntimePromotionProjectRoot } from './runtime-promotion-root-authority.js';

import type { VerifiedRuntimeManifest } from './runtime-manifest.js';
import type { DurableClosedPromotionJournal } from './runtime-promotion-journal.js';
import type {
  RuntimePromotionDatastoreCandidate,
  RuntimePromotionSourceRetirementProof,
} from './runtime-promotion-preflight.js';
import type { RuntimePromotionOperation } from './runtime-promotion-types.js';

const SOURCE_ROUTES = new Set(['promote-cache', 'keep-project', 'deduplicate-cache']);

function mutationOutcome(status: string): 'applied' | 'already-satisfied' {
  return status.startsWith('already-') ? 'already-satisfied' : 'applied';
}

async function checkpointRuntimeDatastores(operation: RuntimePromotionOperation): Promise<void> {
  assertFreshRuntimePromotionProjectRoot(operation);
  const candidates: RuntimePromotionDatastoreCandidate[] = [];
  if (operation.preflight.source.classification !== 'none') {
    if (operation.preflight.sourceRuntimeDir === undefined) {
      throw new Error('Selected cache evidence has no source runtime path');
    }
    candidates.push({
      kind: 'source',
      runtimeDir: operation.preflight.sourceRuntimeDir,
    });
  }
  if (operation.preflight.destinationRuntimePreexisting) {
    candidates.push({
      kind: 'destination',
      runtimeDir: operation.preflight.destinationRuntimeDir,
    });
  }
  try {
    await operation.dependencies.checkpointDatastores({
      candidates,
      lockContext: operation.input.datastoreLockContext,
      projectRootAuthority: operation.projectRootAuthority,
      lease: operation.lease,
      controller: operation.controller,
      receipt: operation.receipt,
    });
  } catch (error) {
    if (error instanceof RuntimePromotionDatastoreError && !error.releaseSafe) {
      operation.leaseDisposition.releaseSafe = false;
    }
    throw error;
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.dependencies.checkpoint?.('after-datastore-checkpoint');
}

async function verifySelectedRuntimes(operation: RuntimePromotionOperation): Promise<void> {
  assertFreshRuntimePromotionProjectRoot(operation);
  if (SOURCE_ROUTES.has(operation.preflight.route)) {
    const sourceRuntimeDir = operation.preflight.sourceRuntimeDir;
    if (sourceRuntimeDir === undefined) {
      operation.sourcePreserved = false;
      throw new Error('Selected cache authority has no source runtime');
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
  if (operation.preflight.route === 'authored-only') return;
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
    throw new Error('Cache and project runtimes changed after equivalence selection');
  }
}

async function prepareAuthored(operation: RuntimePromotionOperation): Promise<void> {
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
}

async function ensureDestinationReady(operation: RuntimePromotionOperation): Promise<void> {
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
      mutationOutcome(result.status),
    );
  }
  operation.dependencies.checkpoint?.('after-destination-ready');
}

async function materializeRuntimeStage(
  operation: RuntimePromotionOperation,
): Promise<VerifiedRuntimeManifest> {
  if (operation.sourceManifest === null || operation.preflight.sourceRuntimeDir === undefined) {
    throw new Error('Runtime staging requires a verified cache source');
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.receipt = await operation.writer.recordRuntimeStageCreateIntent(operation.receipt);
  const authority = await operation.dependencies.authorizeFilesystem({
    action: 'runtime-stage-reconcile',
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    sourceRuntime: operation.preflight.sourceRuntimeDir,
    controller: operation.controller,
    lease: operation.lease,
    receipt: operation.receipt,
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

async function backupDestinationIfNeeded(operation: RuntimePromotionOperation): Promise<void> {
  if (!operation.preflight.destinationRuntimePreexisting) return;
  if (operation.destinationManifest === null) {
    throw new Error('Destination backup requires a verified project runtime');
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  let journal = await operation.controller.verifyOpen(operation.receipt);
  operation.dependencies.assertDestinationRootAuthority({
    runtimeDir: operation.preflight.destinationRuntimeDir,
    journal,
  });
  operation.receipt = await operation.writer.recordDestinationBackupCreateIntent(operation.receipt);
  journal = await operation.controller.verifyOpen(operation.receipt);
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
    mutationOutcome(result.status),
  );
  operation.dependencies.checkpoint?.('after-destination-backed-up');
}

async function installRuntime(
  operation: RuntimePromotionOperation,
  staged: VerifiedRuntimeManifest,
): Promise<void> {
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.receipt = await operation.writer.recordDestinationInstallIntent(operation.receipt);
  const authority = await operation.dependencies.authorizeFilesystem({
    action: 'destination-install',
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    sourceRuntime: operation.preflight.sourceRuntimeDir,
    controller: operation.controller,
    lease: operation.lease,
    receipt: operation.receipt,
  });
  const result = await operation.dependencies.installStage(authority, staged.identity);
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.receipt = await operation.writer.recordRuntimeInstalled(
    operation.receipt,
    mutationOutcome(result.status),
  );
  operation.dependencies.checkpoint?.('after-runtime-installed');
}

async function promoteCacheRuntime(operation: RuntimePromotionOperation): Promise<void> {
  await ensureDestinationReady(operation);
  const staged = await materializeRuntimeStage(operation);
  await backupDestinationIfNeeded(operation);
  await installRuntime(operation, staged);
}

async function commitAuthored(operation: RuntimePromotionOperation): Promise<void> {
  if (operation.transaction === null) {
    throw new Error('Authored transaction was not prepared');
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  await operation.dependencies.bindAuthoredReceipt(operation.transaction, operation.receipt);
  const committed = await operation.dependencies.commitAuthored(operation.transaction);
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.receipt = await operation.writer.bindAuthoredCommitted(committed.receipt);
  operation.authoredSummary = committed.summary;
  operation.dependencies.checkpoint?.('after-authored-committed');
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.authoredSummary = await operation.dependencies.verifyAuthored(
    operation.transaction,
    'desired',
  );
  operation.dependencies.checkpoint?.('after-authored-verified');
}

async function retireSelectedSource(operation: RuntimePromotionOperation): Promise<void> {
  if (!SOURCE_ROUTES.has(operation.preflight.route)) return;
  if (operation.sourceManifest === null || operation.preflight.sourceRuntimeDir === undefined) {
    operation.sourcePreserved = false;
    throw new Error('Source retirement requires verified cache authority');
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  const destinationAuthority = operation.dependencies.inspectManifest(
    operation.preflight.destinationRuntimeDir,
    'project-runtime',
  );
  assertFreshRuntimePromotionProjectRoot(operation);
  const expectedDestination =
    operation.preflight.route === 'promote-cache'
      ? operation.sourceManifest.identity
      : operation.destinationManifest?.identity;
  if (
    expectedDestination === undefined ||
    !runtimeManifestIdentityEqual(destinationAuthority.identity, expectedDestination)
  ) {
    throw new Error('Project runtime authority changed before cache retirement');
  }
  let proof: RuntimePromotionSourceRetirementProof;
  try {
    proof = operation.dependencies.refreshSourceRetirementProof({
      lease: operation.lease,
      preflight: operation.preflight,
      verifiedSource: operation.sourceManifest.identity,
    });
  } catch (error) {
    operation.sourcePreserved = false;
    throw error;
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.receipt = await operation.writer.recordSourceRetireIntent(operation.receipt);
  try {
    operation.dependencies.assertSourceRetirementUnchanged({
      lease: operation.lease,
      proof,
    });
  } catch (error) {
    operation.sourcePreserved = false;
    throw error;
  }
  const authority = await operation.dependencies.authorizeFilesystem({
    action: 'source-retire',
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    sourceRuntime: operation.preflight.sourceRuntimeDir,
    controller: operation.controller,
    lease: operation.lease,
    receipt: operation.receipt,
  });
  operation.sourcePreserved = false;
  const result = await operation.dependencies.retireSource(
    authority,
    operation.sourceManifest.identity,
  );
  if (!runtimeManifestIdentityEqual(result.manifest.identity, operation.sourceManifest.identity)) {
    throw new Error('Retired source tombstone authority does not match the selected source');
  }
  operation.sourcePreserved = true;
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.receipt = await operation.writer.recordSourceRetired(
    operation.receipt,
    mutationOutcome(result.status),
  );
  operation.dependencies.checkpoint?.('after-source-retired');
}

async function sealCommitted(
  operation: RuntimePromotionOperation,
): Promise<DurableClosedPromotionJournal> {
  const authority = await verifyCommittedOperationAuthority(operation, operation.receipt);
  operation.receipt = await operation.writer.recordAuthorityVerified(operation.receipt, authority);
  await verifyCommittedOperationAuthority(operation, operation.receipt);
  operation.dependencies.checkpoint?.('after-authority-verified');
  await verifyCommittedOperationAuthority(operation, operation.receipt);
  operation.receipt = await operation.writer.sealCommitted(operation.receipt);
  await verifyOpenTerminalOperationAuthority(operation, operation.receipt);
  operation.dependencies.checkpoint?.('after-terminal-sealed');
  await verifyOpenTerminalOperationAuthority(operation, operation.receipt);
  const closed = await operation.writer.close(operation.receipt);
  await verifyClosedTerminalOperationAuthority(operation, closed);
  operation.dependencies.checkpoint?.('after-journal-closed');
  await verifyClosedTerminalOperationAuthority(operation, closed);
  return closed;
}

export async function executeRuntimePromotionForward(
  operation: RuntimePromotionOperation,
): Promise<DurableClosedPromotionJournal> {
  await checkpointRuntimeDatastores(operation);
  await verifySelectedRuntimes(operation);
  await prepareAuthored(operation);
  if (operation.preflight.route === 'promote-cache') {
    await promoteCacheRuntime(operation);
  }
  await commitAuthored(operation);
  await retireSelectedSource(operation);
  return sealCommitted(operation);
}

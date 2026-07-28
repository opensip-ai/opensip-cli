import { join } from 'node:path';

import { runtimeManifestIdentityEqual } from './runtime-manifest.js';
import {
  asRecoveryOpen,
  assertRecoveryProjectRoot,
  assertRecoverySourceAuthority,
  bindRecoveryAuthoredReceipt,
  inspectExactRecoveryManifest,
  inspectOpenRecoveryRuntimeAuthority,
  loadRecoveryAuthored,
  refreshRecoveryJournal,
  requireManifest,
} from './runtime-promotion-recovery-common.js';
import { recoveryEvidenceMismatch } from './runtime-promotion-root-authority.js';
import { runtimePromotionMutationOutcome } from './runtime-promotion-transitions-common.js';

import type { VerifiedRuntimeManifest } from './runtime-manifest.js';
import type {
  RuntimeManifestIdentity,
  RuntimePromotionJournal,
  RuntimePromotionPendingIntent,
} from './runtime-promotion-journal-schema.js';
import type { RuntimePromotionRecoveryOperation } from './runtime-promotion-recovery-types.js';

export async function transition(
  operation: RuntimePromotionRecoveryOperation,
  action: () => Promise<typeof operation.receipt>,
): Promise<void> {
  const receipt = await action();
  operation.receipt = receipt;
  operation.dependencies.checkpoint?.('after-open-transition');
  await refreshRecoveryJournal(operation, receipt);
}

async function authorizeFilesystem(
  operation: RuntimePromotionRecoveryOperation,
  action:
    | 'destination-parent-create'
    | 'runtime-stage-reconcile'
    | 'destination-backup-create'
    | 'destination-install'
    | 'source-retire'
    | 'runtime-rollback',
) {
  assertRecoveryProjectRoot(operation);
  return operation.dependencies.authorizeFilesystem({
    action,
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    ...(operation.sourceRuntime === undefined ? {} : { sourceRuntime: operation.sourceRuntime }),
    controller: operation.controller,
    lease: operation.lease,
    receipt: asRecoveryOpen(operation),
  });
}

function sourceManifest(operation: RuntimePromotionRecoveryOperation): RuntimeManifestIdentity {
  return requireManifest(operation.journal.manifests.source, 'Selected source');
}

function destinationManifest(
  operation: RuntimePromotionRecoveryOperation,
): RuntimeManifestIdentity {
  return requireManifest(operation.journal.manifests.destination, 'Selected destination');
}

function stageManifest(operation: RuntimePromotionRecoveryOperation): RuntimeManifestIdentity {
  return requireManifest(operation.journal.manifests.runtimeStage, 'Runtime stage');
}

export function currentSource(
  operation: RuntimePromotionRecoveryOperation,
): VerifiedRuntimeManifest {
  const sourceRuntime = assertRecoverySourceAuthority(operation);
  return inspectExactRecoveryManifest(
    operation,
    sourceRuntime,
    'cache-source',
    sourceManifest(operation),
  );
}

async function reconcileDestinationParent(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  const authority = await authorizeFilesystem(operation, 'destination-parent-create');
  const result = await operation.dependencies.createDestinationParent(authority);
  await transition(operation, () =>
    operation.writer.recordDestinationReady(
      asRecoveryOpen(operation),
      runtimePromotionMutationOutcome(result.status),
    ),
  );
}

/** @throws {Error} When the runtime stage cannot be copied or reverified. */
async function copyOrReuseStage(operation: RuntimePromotionRecoveryOperation): Promise<{
  readonly manifest: VerifiedRuntimeManifest;
  readonly outcome: 'applied' | 'already-satisfied';
}> {
  const source = currentSource(operation);
  const authority = await authorizeFilesystem(operation, 'runtime-stage-reconcile');
  const reconciled = await operation.dependencies.reconcileStage(authority, {
    expected: source,
  });
  if (reconciled.status === 'verified') {
    return { manifest: reconciled.manifest, outcome: 'already-satisfied' };
  }
  if (operation.sourceRuntime === undefined) {
    recoveryEvidenceMismatch(
      'Runtime-stage recovery lost its canonical source',
      'runtime-stage-recovery-canonical-source',
    );
  }
  const current = await operation.controller.verifyOpen(asRecoveryOpen(operation));
  const copied = await operation.dependencies.copyStage({
    controller: operation.controller,
    receipt: asRecoveryOpen(operation),
    sourceDir: operation.sourceRuntime,
    sourcePosture: 'cache-source',
    destinationParent: join(operation.input.projectRoot, 'opensip-cli'),
    stageBasename: current.owned.runtimeStage.basename,
    projectRootAuthority: operation.projectRootAuthority,
    lease: operation.lease,
  });
  if (!runtimeManifestIdentityEqual(copied.stage.identity, source.identity)) {
    recoveryEvidenceMismatch(
      'Recovered runtime stage differs from the selected source',
      'recovered-runtime-stage-selected-source',
    );
  }
  return { manifest: copied.stage, outcome: 'applied' };
}

async function reconcileRuntimeStage(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  const staged = await copyOrReuseStage(operation);
  await transition(operation, () =>
    operation.writer.recordRuntimeStaged(
      asRecoveryOpen(operation),
      staged.outcome,
      staged.manifest.identity,
    ),
  );
}

/** @throws {Error} When destination backup state cannot be reconciled safely. */
async function reconcileDestinationBackup(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  const expected = destinationManifest(operation);
  const authority = await authorizeFilesystem(operation, 'destination-backup-create');
  const result = await operation.dependencies.backupDestination(authority, expected);
  if (!runtimeManifestIdentityEqual(result.manifest.identity, expected)) {
    recoveryEvidenceMismatch(
      'Recovered destination backup differs from durable evidence',
      'recovered-destination-backup-durable-evidence',
    );
  }
  await transition(operation, () =>
    operation.writer.recordDestinationBackedUp(
      asRecoveryOpen(operation),
      runtimePromotionMutationOutcome(result.status),
    ),
  );
}

/** @throws {Error} When destination installation state cannot be reconciled safely. */
async function reconcileDestinationInstall(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  const expected = stageManifest(operation);
  const authority = await authorizeFilesystem(operation, 'destination-install');
  const result = await operation.dependencies.installStage(authority, expected);
  if (!runtimeManifestIdentityEqual(result.manifest.identity, expected)) {
    recoveryEvidenceMismatch(
      'Recovered destination install differs from durable evidence',
      'recovered-destination-install-durable-evidence',
    );
  }
  await transition(operation, () =>
    operation.writer.recordRuntimeInstalled(
      asRecoveryOpen(operation),
      runtimePromotionMutationOutcome(result.status),
    ),
  );
}

async function reconcileAuthoredPreparation(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  assertRecoveryProjectRoot(operation);
  const aborted = await operation.dependencies.abortAuthoredPreparation({
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    lease: operation.lease,
    controller: operation.controller,
    receipt: asRecoveryOpen(operation),
  });
  assertRecoveryProjectRoot(operation);
  operation.transaction = aborted.transaction;
  operation.receipt = aborted.receipt;
  operation.authoredSummary = aborted.summary;
  operation.dependencies.checkpoint?.('after-open-intent-reconciled');
  await refreshRecoveryJournal(operation);
}

/** @throws {Error} When authored commit state cannot be reconciled or verified. */
async function reconcileAuthoredCommit(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  await loadRecoveryAuthored(operation);
  if (operation.transaction === null) {
    recoveryEvidenceMismatch(
      'Recovered authored commit lacks its durable transaction',
      'recovered-authored-commit-durable-transaction',
    );
  }
  const committed = await operation.dependencies.commitAuthored(operation.transaction);
  operation.receipt = committed.receipt;
  operation.authoredSummary = committed.summary;
  operation.dependencies.checkpoint?.('after-open-intent-reconciled');
  await refreshRecoveryJournal(operation);
}

/** @throws {Error} When the desired authored state cannot be verified. */
export async function verifyDesiredAuthored(
  operation: RuntimePromotionRecoveryOperation,
  expectedJournal: RuntimePromotionJournal = operation.journal,
): Promise<void> {
  operation.journal = expectedJournal;
  await loadRecoveryAuthored(operation);
  if (operation.transaction === null) {
    recoveryEvidenceMismatch(
      'Recovered authored authority lacks its durable transaction',
      'recovered-authored-authority-durable-transaction',
    );
  }
  const transaction = await bindRecoveryAuthoredReceipt(operation);
  if (transaction === null) {
    recoveryEvidenceMismatch(
      'Recovered authored authority lost its durable transaction',
      'recovered-authored-authority-durable-transaction',
    );
  }
  operation.authoredSummary = await operation.dependencies.verifyAuthored(transaction, 'desired');
  if (!operation.authoredSummary.verified) {
    recoveryEvidenceMismatch(
      'Recovered authored desired authority was not verified',
      'recovered-authored-desired-authority-verified',
    );
  }
  assertRecoveryProjectRoot(operation);
}

/** @throws {Error} When source retirement state cannot be reconciled safely. */
async function reconcileSourceRetirement(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  await verifyDesiredAuthored(operation);
  inspectOpenRecoveryRuntimeAuthority(operation, 'committed');
  const expected = sourceManifest(operation);
  const authority = await authorizeFilesystem(operation, 'source-retire');
  const result = await operation.dependencies.retireSource(authority, expected);
  if (!runtimeManifestIdentityEqual(result.manifest.identity, expected)) {
    recoveryEvidenceMismatch(
      'Recovered source tombstone differs from durable evidence',
      'recovered-source-tombstone-durable-evidence',
    );
  }
  await transition(operation, () =>
    operation.writer.recordSourceRetired(
      asRecoveryOpen(operation),
      runtimePromotionMutationOutcome(result.status),
    ),
  );
}

export function runtimeRollbackRequired(journal: RuntimePromotionJournal): boolean {
  return (
    journal.progress.runtimeInstallState === 'installed' ||
    journal.cleanup.runtimeStage === 'pending' ||
    journal.cleanup.destinationBackup === 'pending' ||
    (!journal.destinationParentPreexisting && journal.cleanup.destinationParent === 'pending')
  );
}

async function reconcileRuntimeRollback(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  const before = operation.journal;
  const authority = await authorizeFilesystem(operation, 'runtime-rollback');
  const result = await operation.dependencies.rollbackRuntime(authority, {
    installed: before.manifests.runtimeStage,
    backup: before.destinationRuntimePreexisting ? before.manifests.destination : null,
    installedWasAuthoritative: before.progress.runtimeInstallState === 'installed',
  });
  await transition(operation, () =>
    operation.writer.recordRuntimeRolledBack(
      asRecoveryOpen(operation),
      runtimePromotionMutationOutcome(result.status),
    ),
  );
}

/** @throws {Error} When authored rollback state cannot be reconciled or verified. */
async function reconcileAuthoredRollback(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  await loadRecoveryAuthored(operation);
  if (operation.transaction === null) {
    recoveryEvidenceMismatch(
      'Recovered authored rollback lacks its durable transaction',
      'recovered-authored-rollback-durable-transaction',
    );
  }
  const rolledBack = await operation.dependencies.rollbackAuthored(operation.transaction);
  operation.receipt = rolledBack.receipt;
  operation.authoredSummary = rolledBack.summary;
  operation.dependencies.checkpoint?.('after-open-intent-reconciled');
  await refreshRecoveryJournal(operation);
}

/** @throws {Error} When a durable pending intent has an unsupported recovery shape. */
export async function reconcilePendingIntent(
  operation: RuntimePromotionRecoveryOperation,
  pending: RuntimePromotionPendingIntent,
): Promise<void> {
  switch (pending.kind) {
    case 'destination-parent-create': {
      await reconcileDestinationParent(operation);
      break;
    }
    case 'runtime-stage-create': {
      await reconcileRuntimeStage(operation);
      break;
    }
    case 'destination-backup-create': {
      await reconcileDestinationBackup(operation);
      break;
    }
    case 'destination-install': {
      await reconcileDestinationInstall(operation);
      break;
    }
    case 'authored-prepare': {
      await reconcileAuthoredPreparation(operation);
      break;
    }
    case 'authored-target-commit': {
      await reconcileAuthoredCommit(operation);
      break;
    }
    case 'source-retire': {
      await reconcileSourceRetirement(operation);
      break;
    }
    case 'runtime-rollback': {
      await reconcileRuntimeRollback(operation);
      break;
    }
    case 'authored-target-rollback': {
      await reconcileAuthoredRollback(operation);
      break;
    }
    case 'owned-slot-cleanup': {
      recoveryEvidenceMismatch(
        'An open promotion cannot contain a cleanup intent',
        'open-promotion-cleanup-intent',
      );
    }
  }
  operation.dependencies.checkpoint?.('after-open-intent-reconciled');
}

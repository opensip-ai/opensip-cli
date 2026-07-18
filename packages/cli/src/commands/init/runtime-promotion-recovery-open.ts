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
  recoveryAuthoredWasMaterialized,
  refreshRecoveryJournal,
  requireManifest,
  runtimeRecoveryMutationOutcome,
} from './runtime-promotion-recovery-common.js';

import type { VerifiedRuntimeManifest } from './runtime-manifest.js';
import type {
  RuntimeManifestIdentity,
  RuntimePromotionJournal,
  RuntimePromotionPendingIntent,
} from './runtime-promotion-journal-schema.js';
import type { DurableClosedPromotionJournal } from './runtime-promotion-journal.js';
import type { RuntimePromotionRecoveryOperation } from './runtime-promotion-recovery-types.js';

const SOURCE_ROUTES = new Set(['promote-cache', 'keep-project', 'deduplicate-cache']);
const MAX_RECOVERY_STEPS = 64;

async function transition(
  operation: RuntimePromotionRecoveryOperation,
  action: () => Promise<typeof operation.receipt>,
): Promise<void> {
  operation.receipt = await action();
  operation.dependencies.checkpoint?.('after-open-transition');
  await refreshRecoveryJournal(operation);
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

function currentSource(operation: RuntimePromotionRecoveryOperation): VerifiedRuntimeManifest {
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
      runtimeRecoveryMutationOutcome(result.status),
    ),
  );
}

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
    throw new Error('Runtime-stage recovery lost its canonical source');
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
    throw new Error('Recovered runtime stage differs from the selected source');
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

async function reconcileDestinationBackup(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  const expected = destinationManifest(operation);
  const authority = await authorizeFilesystem(operation, 'destination-backup-create');
  const result = await operation.dependencies.backupDestination(authority, expected);
  if (!runtimeManifestIdentityEqual(result.manifest.identity, expected)) {
    throw new Error('Recovered destination backup differs from durable evidence');
  }
  await transition(operation, () =>
    operation.writer.recordDestinationBackedUp(
      asRecoveryOpen(operation),
      runtimeRecoveryMutationOutcome(result.status),
    ),
  );
}

async function reconcileDestinationInstall(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  const expected = stageManifest(operation);
  const authority = await authorizeFilesystem(operation, 'destination-install');
  const result = await operation.dependencies.installStage(authority, expected);
  if (!runtimeManifestIdentityEqual(result.manifest.identity, expected)) {
    throw new Error('Recovered destination install differs from durable evidence');
  }
  await transition(operation, () =>
    operation.writer.recordRuntimeInstalled(
      asRecoveryOpen(operation),
      runtimeRecoveryMutationOutcome(result.status),
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

async function reconcileAuthoredCommit(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  await loadRecoveryAuthored(operation);
  if (operation.transaction === null) {
    throw new Error('Recovered authored commit lacks its durable transaction');
  }
  const committed = await operation.dependencies.commitAuthored(operation.transaction);
  operation.receipt = committed.receipt;
  operation.authoredSummary = committed.summary;
  operation.dependencies.checkpoint?.('after-open-intent-reconciled');
  await refreshRecoveryJournal(operation);
}

async function verifyDesiredAuthored(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  await loadRecoveryAuthored(operation);
  if (operation.transaction === null) {
    throw new Error('Recovered authored authority lacks its durable transaction');
  }
  await bindRecoveryAuthoredReceipt(operation);
  operation.authoredSummary = await operation.dependencies.verifyAuthored(
    operation.transaction,
    'desired',
  );
  if (!operation.authoredSummary.verified) {
    throw new Error('Recovered authored desired authority was not verified');
  }
  assertRecoveryProjectRoot(operation);
}

async function reconcileSourceRetirement(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  await verifyDesiredAuthored(operation);
  inspectOpenRecoveryRuntimeAuthority(operation, 'committed');
  const expected = sourceManifest(operation);
  const authority = await authorizeFilesystem(operation, 'source-retire');
  const result = await operation.dependencies.retireSource(authority, expected);
  if (!runtimeManifestIdentityEqual(result.manifest.identity, expected)) {
    throw new Error('Recovered source tombstone differs from durable evidence');
  }
  await transition(operation, () =>
    operation.writer.recordSourceRetired(
      asRecoveryOpen(operation),
      runtimeRecoveryMutationOutcome(result.status),
    ),
  );
}

function runtimeRollbackRequired(journal: RuntimePromotionJournal): boolean {
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
      runtimeRecoveryMutationOutcome(result.status),
    ),
  );
}

async function reconcileAuthoredRollback(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  await loadRecoveryAuthored(operation);
  if (operation.transaction === null) {
    throw new Error('Recovered authored rollback lacks its durable transaction');
  }
  const rolledBack = await operation.dependencies.rollbackAuthored(operation.transaction);
  operation.receipt = rolledBack.receipt;
  operation.authoredSummary = rolledBack.summary;
  operation.dependencies.checkpoint?.('after-open-intent-reconciled');
  await refreshRecoveryJournal(operation);
}

async function reconcilePendingIntent(
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
      throw new Error('An open promotion cannot contain a cleanup intent');
    }
  }
  operation.dependencies.checkpoint?.('after-open-intent-reconciled');
}

async function verifyInitialSource(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  const sourceRuntime = assertRecoverySourceAuthority(operation);
  assertRecoveryProjectRoot(operation);
  const observed = operation.dependencies.inspectManifest(sourceRuntime, 'cache-source');
  assertRecoveryProjectRoot(operation);
  assertRecoverySourceAuthority(operation);
  await transition(operation, () =>
    operation.writer.verifySource(asRecoveryOpen(operation), observed.identity),
  );
}

async function checkpointInitialDatastores(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  const candidates: (
    | { readonly kind: 'source'; readonly runtimeDir: string }
    | { readonly kind: 'destination'; readonly runtimeDir: string }
  )[] = [];
  if (operation.journal.source.classification !== 'none') {
    candidates.push({
      kind: 'source',
      runtimeDir: assertRecoverySourceAuthority(operation),
    });
  }
  if (operation.journal.destinationRuntimePreexisting) {
    candidates.push({
      kind: 'destination',
      runtimeDir: join(operation.input.projectRoot, 'opensip-cli', '.runtime'),
    });
  }
  assertRecoveryProjectRoot(operation);
  await operation.dependencies.checkpointDatastores({
    candidates,
    lockContext: operation.input.datastoreLockContext,
    projectRootAuthority: operation.projectRootAuthority,
    lease: operation.lease,
    controller: operation.controller,
    receipt: asRecoveryOpen(operation),
  });
  assertRecoveryProjectRoot(operation);
  operation.dependencies.checkpoint?.('after-datastore-checkpoint');
}

async function verifyInitialDestination(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  assertRecoveryProjectRoot(operation);
  const observed = operation.journal.destinationRuntimePreexisting
    ? operation.dependencies.inspectManifest(
        join(operation.input.projectRoot, 'opensip-cli', '.runtime'),
        'project-runtime',
      ).identity
    : null;
  assertRecoveryProjectRoot(operation);
  await transition(operation, () =>
    operation.writer.verifyDestination(asRecoveryOpen(operation), observed),
  );
}

async function beginRollback(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  await transition(operation, () => operation.writer.beginRollback(asRecoveryOpen(operation)));
}

async function continueAuthoredCommit(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  await loadRecoveryAuthored(operation);
  if (operation.transaction === null) {
    throw new Error('Authored commit lacks its durable replay transaction');
  }
  const committed = await operation.dependencies.commitAuthored(operation.transaction);
  operation.receipt = await operation.writer.bindAuthoredCommitted(committed.receipt);
  operation.authoredSummary = committed.summary;
  await refreshRecoveryJournal(operation);
  await verifyDesiredAuthored(operation);
}

async function startDestinationParent(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  if (operation.journal.destinationParentPreexisting) {
    await transition(operation, () =>
      operation.writer.advancePreexistingDestinationReady(asRecoveryOpen(operation)),
    );
    return;
  }
  await transition(operation, () =>
    operation.writer.recordDestinationParentCreateIntent(asRecoveryOpen(operation)),
  );
}

async function startRuntimeStage(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  currentSource(operation);
  await transition(operation, () =>
    operation.writer.recordRuntimeStageCreateIntent(asRecoveryOpen(operation)),
  );
}

async function startDestinationBackupOrInstall(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  const action = operation.journal.destinationRuntimePreexisting
    ? operation.writer.recordDestinationBackupCreateIntent
    : operation.writer.recordDestinationInstallIntent;
  await transition(operation, () => action(asRecoveryOpen(operation)));
}

async function startDestinationInstall(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  await transition(operation, () =>
    operation.writer.recordDestinationInstallIntent(asRecoveryOpen(operation)),
  );
}

async function startSourceRetirementOrVerifyAuthority(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  await verifyDesiredAuthored(operation);
  if (SOURCE_ROUTES.has(operation.journal.route)) {
    inspectOpenRecoveryRuntimeAuthority(operation, 'committed');
    assertRecoverySourceAuthority(operation);
    await transition(operation, () =>
      operation.writer.recordSourceRetireIntent(asRecoveryOpen(operation)),
    );
    return;
  }
  const authority = inspectOpenRecoveryRuntimeAuthority(operation, 'committed');
  await transition(operation, () =>
    operation.writer.recordAuthorityVerified(asRecoveryOpen(operation), authority),
  );
}

async function verifyAndRecordCommittedAuthority(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  await verifyDesiredAuthored(operation);
  const authority = inspectOpenRecoveryRuntimeAuthority(operation, 'committed');
  await transition(operation, () =>
    operation.writer.recordAuthorityVerified(asRecoveryOpen(operation), authority),
  );
}

async function sealCommitted(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  await verifyDesiredAuthored(operation);
  inspectOpenRecoveryRuntimeAuthority(operation, 'committed');
  await transition(operation, () => operation.writer.sealCommitted(asRecoveryOpen(operation)));
}

async function continueRollback(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  if (runtimeRollbackRequired(operation.journal)) {
    await transition(operation, () =>
      operation.writer.recordRuntimeRollbackIntent(asRecoveryOpen(operation)),
    );
    return;
  }
  if (!recoveryAuthoredWasMaterialized(operation.journal)) {
    await transition(operation, () =>
      operation.writer.recordUnmaterializedAuthoredRolledBack(asRecoveryOpen(operation)),
    );
    return;
  }
  await loadRecoveryAuthored(operation);
  if (operation.transaction === null) {
    throw new Error('Authored rollback lacks its durable transaction');
  }
  const rolledBack = await operation.dependencies.rollbackAuthored(operation.transaction);
  operation.receipt = await operation.writer.bindAuthoredRolledBack(rolledBack.receipt);
  operation.authoredSummary = rolledBack.summary;
  await refreshRecoveryJournal(operation);
}

async function verifyRolledBackAuthored(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  if (!recoveryAuthoredWasMaterialized(operation.journal)) return;
  await loadRecoveryAuthored(operation);
  if (operation.transaction === null) {
    throw new Error('Rolled-back authored verification lacks its transaction');
  }
  await bindRecoveryAuthoredReceipt(operation);
  operation.authoredSummary = await operation.dependencies.verifyAuthored(
    operation.transaction,
    'preimage',
  );
  if (!operation.authoredSummary.verified) {
    throw new Error('Recovered authored preimage authority was not verified');
  }
}

async function sealRolledBack(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  await verifyRolledBackAuthored(operation);
  const authority = inspectOpenRecoveryRuntimeAuthority(operation, 'rolled-back');
  await transition(operation, () =>
    operation.writer.sealRolledBack(asRecoveryOpen(operation), authority),
  );
}

async function closeTerminal(
  operation: RuntimePromotionRecoveryOperation,
  outcome: 'committed' | 'rolled-back',
): Promise<void> {
  if (outcome === 'committed') await verifyDesiredAuthored(operation);
  else await verifyRolledBackAuthored(operation);
  inspectOpenRecoveryRuntimeAuthority(operation, outcome);
  operation.receipt = await operation.writer.close(asRecoveryOpen(operation));
  operation.dependencies.checkpoint?.('after-terminal-close');
  await refreshRecoveryJournal(operation);
}

async function continueIdleOpen(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  const { phase, direction } = operation.journal.progress;
  if (direction === 'forward') {
    switch (phase) {
      case 'prepared': {
        await checkpointInitialDatastores(operation);
        if (operation.journal.route === 'authored-only') await beginRollback(operation);
        else if (operation.journal.source.classification === 'none') {
          await verifyInitialDestination(operation);
        } else {
          await verifyInitialSource(operation);
        }
        return;
      }
      case 'source-verified': {
        await checkpointInitialDatastores(operation);
        await verifyInitialDestination(operation);
        return;
      }
      case 'destination-verified': {
        await beginRollback(operation);
        return;
      }
      case 'authored-prepared': {
        if (operation.journal.route === 'promote-cache') {
          await startDestinationParent(operation);
        } else {
          await continueAuthoredCommit(operation);
        }
        return;
      }
      case 'destination-ready': {
        await startRuntimeStage(operation);
        return;
      }
      case 'runtime-staged': {
        await startDestinationBackupOrInstall(operation);
        return;
      }
      case 'destination-backed-up': {
        await startDestinationInstall(operation);
        return;
      }
      case 'runtime-installed': {
        await continueAuthoredCommit(operation);
        return;
      }
      case 'authored-committed': {
        await startSourceRetirementOrVerifyAuthority(operation);
        return;
      }
      case 'source-retired': {
        await verifyAndRecordCommittedAuthority(operation);
        return;
      }
      case 'authority-verified': {
        await sealCommitted(operation);
        return;
      }
      case 'committed': {
        await closeTerminal(operation, 'committed');
        return;
      }
      default: {
        throw new Error(`Unsupported forward recovery phase: ${phase}`);
      }
    }
  }
  if (direction !== 'rollback') {
    throw new Error('Open recovery has an invalid direction');
  }
  switch (phase) {
    case 'rollback-started':
    case 'runtime-rolled-back': {
      await continueRollback(operation);
      return;
    }
    case 'authored-rolled-back': {
      await sealRolledBack(operation);
      return;
    }
    case 'rolled-back': {
      await closeTerminal(operation, 'rolled-back');
      return;
    }
    default: {
      throw new Error(`Unsupported rollback recovery phase: ${phase}`);
    }
  }
}

/**
 * Reconcile one validated open journal to a closed terminal receipt.
 *
 * Every effect is selected exclusively from the durable phase/intent. Any
 * ambiguous observation throws without guessing a postcondition.
 */
export async function recoverOpenRuntimePromotion(
  operation: RuntimePromotionRecoveryOperation,
): Promise<DurableClosedPromotionJournal> {
  for (let step = 0; step < MAX_RECOVERY_STEPS; step += 1) {
    await refreshRecoveryJournal(operation);
    if (operation.receipt.state === 'closed') return operation.receipt;
    const pending = operation.journal.progress.pendingIntent;
    if (pending === null) {
      await continueIdleOpen(operation);
    } else {
      await reconcilePendingIntent(operation, pending);
    }
  }
  throw new Error('Runtime promotion recovery exceeded its bounded transition count');
}

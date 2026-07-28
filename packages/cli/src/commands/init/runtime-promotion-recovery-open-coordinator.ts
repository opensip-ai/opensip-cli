import { join } from 'node:path';

import {
  asRecoveryOpen,
  assertRecoveryProjectRoot,
  assertRecoverySourceAuthority,
  bindRecoveryAuthoredReceipt,
  inspectOpenRecoveryRuntimeAuthority,
  loadRecoveryAuthored,
  recoveryAuthoredWasMaterialized,
  refreshRecoveryJournal,
} from './runtime-promotion-recovery-common.js';
import {
  currentSource,
  reconcilePendingIntent,
  runtimeRollbackRequired,
  transition,
  verifyDesiredAuthored,
} from './runtime-promotion-recovery-open.js';
import { recoveryEvidenceMismatch } from './runtime-promotion-root-authority.js';

import type { RuntimeManifestIdentity } from './runtime-promotion-journal-schema.js';
import type { DurableClosedPromotionJournal } from './runtime-promotion-journal.js';
import type { RuntimePromotionRecoveryOperation } from './runtime-promotion-recovery-types.js';

const SOURCE_ROUTES = new Set(['promote-cache', 'keep-project', 'deduplicate-cache']);
const MAX_RECOVERY_STEPS = 64;

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
): Promise<RuntimePromotionRecoveryOperation> {
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
  return operation;
}

async function verifyInitialDestination(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  assertRecoveryProjectRoot(operation);
  const destinationRuntime = join(operation.input.projectRoot, 'opensip-cli', '.runtime');
  let observed: RuntimeManifestIdentity | null = null;
  if (operation.journal.destinationRuntimePreexisting) {
    operation.dependencies.assertDestinationRootAuthority({
      runtimeDir: destinationRuntime,
      journal: operation.journal,
    });
    observed = operation.dependencies.inspectManifest(
      destinationRuntime,
      'project-runtime',
    ).identity;
    operation.dependencies.assertDestinationRootAuthority({
      runtimeDir: destinationRuntime,
      journal: operation.journal,
    });
  }
  assertRecoveryProjectRoot(operation);
  await transition(operation, () =>
    operation.writer.verifyDestination(asRecoveryOpen(operation), observed),
  );
  if (operation.journal.destinationRuntimePreexisting) {
    operation.dependencies.assertDestinationRootAuthority({
      runtimeDir: destinationRuntime,
      journal: operation.journal,
    });
  }
}

async function beginRollback(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  await transition(operation, () => operation.writer.beginRollback(asRecoveryOpen(operation)));
}

/** @throws {Error} When authored commit recovery cannot verify the desired state. */
async function continueAuthoredCommit(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  await loadRecoveryAuthored(operation);
  if (operation.transaction === null) {
    recoveryEvidenceMismatch(
      'Authored commit lacks its durable replay transaction',
      'authored-commit-durable-replay-transaction',
    );
  }
  const committed = await operation.dependencies.commitAuthored(operation.transaction);
  const committedReceipt = await operation.writer.bindAuthoredCommitted(committed.receipt);
  operation.receipt = committedReceipt;
  operation.authoredSummary = committed.summary;
  const refreshed = await refreshRecoveryJournal(operation, committedReceipt);
  await verifyDesiredAuthored(operation, refreshed);
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

/** @throws {Error} When rollback recovery cannot establish an exact rollback route. */
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
    recoveryEvidenceMismatch(
      'Authored rollback lacks its durable transaction',
      'authored-rollback-durable-transaction',
    );
  }
  const rolledBack = await operation.dependencies.rollbackAuthored(operation.transaction);
  const rolledBackReceipt = await operation.writer.bindAuthoredRolledBack(rolledBack.receipt);
  operation.receipt = rolledBackReceipt;
  operation.authoredSummary = rolledBack.summary;
  await refreshRecoveryJournal(operation, rolledBackReceipt);
}

/** @throws {Error} When the authored preimage cannot be verified after rollback. */
async function verifyRolledBackAuthored(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  if (!recoveryAuthoredWasMaterialized(operation.journal)) return;
  await loadRecoveryAuthored(operation);
  if (operation.transaction === null) {
    recoveryEvidenceMismatch(
      'Rolled-back authored verification lacks its transaction',
      'rolled-back-authored-verification-transaction',
    );
  }
  const transaction = await bindRecoveryAuthoredReceipt(operation);
  if (transaction === null) {
    recoveryEvidenceMismatch(
      'Rolled-back authored verification lost its durable transaction',
      'rolled-back-authored-verification-durable',
    );
  }
  operation.authoredSummary = await operation.dependencies.verifyAuthored(transaction, 'preimage');
  if (!operation.authoredSummary.verified) {
    recoveryEvidenceMismatch(
      'Recovered authored preimage authority was not verified',
      'recovered-authored-preimage-authority-verified',
    );
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

/** @throws {Error} When an idle open journal has an unsupported recovery phase. */
async function continueIdleOpen(operation: RuntimePromotionRecoveryOperation): Promise<void> {
  const { phase, direction } = operation.journal.progress;
  if (direction === 'forward') {
    switch (phase) {
      case 'prepared': {
        const checkpointed = await checkpointInitialDatastores(operation);
        if (operation.journal.route === 'authored-only') await beginRollback(checkpointed);
        else if (operation.journal.source.classification === 'none') {
          await verifyInitialDestination(checkpointed);
        } else {
          await verifyInitialSource(checkpointed);
        }
        return;
      }
      case 'source-verified': {
        const checkpointed = await checkpointInitialDatastores(operation);
        await verifyInitialDestination(checkpointed);
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
        recoveryEvidenceMismatch(
          `Unsupported forward recovery phase: ${phase}`,
          'unsupported-forward-recovery-phase',
        );
      }
    }
  }
  if (direction !== 'rollback') {
    recoveryEvidenceMismatch(
      'Open recovery has an invalid direction',
      'open-recovery-invalid-direction',
    );
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
      recoveryEvidenceMismatch(
        `Unsupported rollback recovery phase: ${phase}`,
        'unsupported-rollback-recovery-phase',
      );
    }
  }
}

/**
 * Reconcile one validated open journal to a closed terminal receipt.
 *
 * Every effect is selected exclusively from the durable phase/intent. Any
 * ambiguous observation throws without guessing a postcondition.
 */
/** @throws {Error} When bounded open recovery cannot reach a closed receipt. */
async function recoverOpenStep(
  operation: RuntimePromotionRecoveryOperation,
  step: number,
): Promise<DurableClosedPromotionJournal> {
  if (step >= MAX_RECOVERY_STEPS) {
    recoveryEvidenceMismatch(
      'Runtime promotion recovery exceeded its bounded transition count',
      'runtime-promotion-recovery-bounded-transition',
    );
  }
  const journal = await refreshRecoveryJournal(operation);
  if (operation.receipt.state === 'closed') return operation.receipt;
  const pending = journal.progress.pendingIntent;
  if (pending === null) {
    await continueIdleOpen(operation);
  } else {
    await reconcilePendingIntent(operation, pending);
  }
  return recoverOpenStep(operation, step + 1);
}

/** @throws {Error} When open recovery cannot reconcile or close the durable journal. */
export async function recoverOpenRuntimePromotion(
  operation: RuntimePromotionRecoveryOperation,
): Promise<DurableClosedPromotionJournal> {
  return recoverOpenStep(operation, 0);
}

import {
  isRuntimePromotionAuthorityReleaseUnsafe,
  verifyClosedTerminalOperationAuthority,
  verifyOpenTerminalOperationAuthority,
  verifyRolledBackOperationAuthority,
} from './runtime-promotion-authority-verification.js';
import { cleanupFreshClosedRuntimePromotion } from './runtime-promotion-cleanup.js';
import {
  committedResult,
  recoveryRequiredResult,
  rolledBackResult,
} from './runtime-promotion-result.js';
import { assertFreshRuntimePromotionProjectRoot } from './runtime-promotion-root-authority.js';

import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
  DurablePromotionJournal,
} from './runtime-promotion-journal.js';
import type {
  RuntimePromotionOperation,
  RuntimePromotionRollbackCompletion,
} from './runtime-promotion-types.js';

function mutationOutcome(status: string): 'applied' | 'already-satisfied' {
  return status.startsWith('already-') ? 'already-satisfied' : 'applied';
}

function recoveryResult(operation: RuntimePromotionOperation): RuntimePromotionRollbackCompletion {
  return {
    result: recoveryRequiredResult({
      preflight: operation.preflight,
      authored: operation.authoredSummary,
      sourcePreserved: operation.sourcePreserved,
      startedAt: operation.startedAt,
      now: operation.dependencies.now,
    }),
  };
}

function rollbackEvidenceComplete(
  operation: RuntimePromotionOperation,
  journal: Awaited<ReturnType<RuntimePromotionOperation['controller']['verifyOpen']>>,
): boolean {
  const sourceRequired = operation.preflight.source.classification !== 'none';
  return (
    (!sourceRequired || journal.manifests.source !== null) &&
    (!journal.destinationRuntimePreexisting || journal.manifests.destination !== null) &&
    journal.cleanup.sourceTombstone === 'unmaterialized'
  );
}

function runtimeRollbackRequired(
  journal: Awaited<ReturnType<RuntimePromotionOperation['controller']['verifyOpen']>>,
): boolean {
  return (
    journal.progress.runtimeInstallState === 'installed' ||
    journal.cleanup.runtimeStage === 'pending' ||
    journal.cleanup.destinationBackup === 'pending' ||
    (!journal.destinationParentPreexisting && journal.cleanup.destinationParent === 'pending')
  );
}

async function rollbackRuntimeIfNeeded(
  operation: RuntimePromotionOperation,
  initialReceipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  let receipt = initialReceipt;
  const journal = await operation.controller.verifyOpen(receipt);
  if (!runtimeRollbackRequired(journal)) return receipt;
  assertFreshRuntimePromotionProjectRoot(operation);
  receipt = await operation.writer.recordRuntimeRollbackIntent(receipt);
  const authority = await operation.dependencies.authorizeFilesystem({
    action: 'runtime-rollback',
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    ...(operation.preflight.sourceRuntimeDir === undefined
      ? {}
      : { sourceRuntime: operation.preflight.sourceRuntimeDir }),
    controller: operation.controller,
    lease: operation.lease,
    receipt,
  });
  const result = await operation.dependencies.rollbackRuntime(authority, {
    installed: journal.manifests.runtimeStage,
    backup: journal.destinationRuntimePreexisting ? journal.manifests.destination : null,
    installedWasAuthoritative: journal.progress.runtimeInstallState === 'installed',
  });
  assertFreshRuntimePromotionProjectRoot(operation);
  return operation.writer.recordRuntimeRolledBack(receipt, mutationOutcome(result.status));
}

async function rollbackAuthoredIfNeeded(
  operation: RuntimePromotionOperation,
  initialReceipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  let receipt = initialReceipt;
  const journal = await operation.controller.verifyOpen(receipt);
  if (journal.progress.phase === 'authored-rolled-back') return receipt;
  if (operation.transaction === null) {
    return operation.writer.recordUnmaterializedAuthoredRolledBack(receipt);
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  await operation.dependencies.bindAuthoredReceipt(operation.transaction, receipt);
  const rolledBack = await operation.dependencies.rollbackAuthored(operation.transaction);
  assertFreshRuntimePromotionProjectRoot(operation);
  receipt = await operation.writer.bindAuthoredRolledBack(rolledBack.receipt);
  operation.authoredSummary = await operation.dependencies.verifyAuthored(
    operation.transaction,
    'preimage',
  );
  return receipt;
}

async function closeRolledBack(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableClosedPromotionJournal> {
  const authority = await verifyRolledBackOperationAuthority(operation, receipt);
  const sealed = await operation.writer.sealRolledBack(receipt, authority);
  await verifyOpenTerminalOperationAuthority(operation, sealed);
  return operation.writer.close(sealed);
}

async function terminalResult(
  operation: RuntimePromotionOperation,
  receipt: DurableClosedPromotionJournal,
): Promise<RuntimePromotionRollbackCompletion> {
  await verifyClosedTerminalOperationAuthority(operation, receipt);
  const journal = await operation.controller.verifyReceipt(receipt, { state: 'closed' });
  const cleanup = await cleanupFreshClosedRuntimePromotion(operation, receipt);
  const resultInput = {
    preflight: operation.preflight,
    authored: operation.authoredSummary,
    sourcePreserved: operation.sourcePreserved,
    cleanupPending: cleanup.cleanupPending,
    startedAt: operation.startedAt,
    now: operation.dependencies.now,
  };
  return {
    result:
      journal.terminal?.outcome === 'committed'
        ? committedResult(resultInput)
        : rolledBackResult(resultInput),
    closedReceipt: cleanup.receipt,
  };
}

async function reconcileTerminalOpen(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
): Promise<RuntimePromotionRollbackCompletion | null> {
  const journal = await operation.controller.verifyOpen(receipt);
  if (journal.terminal === null) return null;
  await verifyOpenTerminalOperationAuthority(operation, receipt);
  return terminalResult(operation, await operation.writer.close(receipt));
}

async function claimCurrent(
  operation: RuntimePromotionOperation,
): Promise<DurablePromotionJournal | null> {
  try {
    return await operation.controller.claim(operation.receipt.operationId);
  } catch {
    return null;
  }
}

/**
 * A fresh failure may roll back only from an exact idle receipt. Any unresolved
 * write-ahead intent is left open for startup recovery; guessing whether its
 * filesystem effect happened would weaken the journal protocol.
 */
export async function rollbackFreshRuntimePromotion(
  operation: RuntimePromotionOperation,
): Promise<RuntimePromotionRollbackCompletion> {
  try {
    assertFreshRuntimePromotionProjectRoot(operation);
    const claimed = await claimCurrent(operation);
    if (claimed === null) return recoveryResult(operation);
    if (claimed.state === 'closed') return await terminalResult(operation, claimed);
    operation.receipt = claimed;
    const terminal = await reconcileTerminalOpen(operation, claimed);
    if (terminal !== null) return terminal;
    let journal = await operation.controller.verifyOpen(operation.receipt);
    if (journal.progress.pendingIntent !== null || !rollbackEvidenceComplete(operation, journal)) {
      return recoveryResult(operation);
    }
    if (journal.progress.direction === 'forward') {
      operation.receipt = await operation.writer.beginRollback(operation.receipt);
    } else if (journal.progress.direction !== 'rollback') {
      return recoveryResult(operation);
    }
    operation.receipt = await rollbackRuntimeIfNeeded(operation, operation.receipt);
    operation.receipt = await rollbackAuthoredIfNeeded(operation, operation.receipt);
    journal = await operation.controller.verifyOpen(operation.receipt);
    if (journal.progress.pendingIntent !== null) return recoveryResult(operation);
    const closed = await closeRolledBack(operation, operation.receipt);
    return await terminalResult(operation, closed);
  } catch (error) {
    if (isRuntimePromotionAuthorityReleaseUnsafe(error)) {
      operation.leaseDisposition.releaseSafe = false;
    }
    return recoveryResult(operation);
  }
}

import {
  isRuntimePromotionAuthorityReleaseUnsafe,
  verifyClosedTerminalReceipt,
  verifyOpenTerminalOperationAuthority,
  verifyRolledBackOperationAuthority,
} from './runtime-promotion-authority-verification.js';
import { cleanupFreshClosedRuntimePromotion } from './runtime-promotion-cleanup.js';
import {
  committedResult,
  recoveryRequiredResult,
  rolledBackResult,
} from './runtime-promotion-result.js';
import {
  assertFreshRuntimePromotionProjectRoot,
  reportInitFailure,
} from './runtime-promotion-root-authority.js';
import { runtimePromotionMutationOutcome } from './runtime-promotion-transitions-common.js';

import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';
import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
  DurablePromotionJournal,
} from './runtime-promotion-journal.js';
import type {
  RuntimePromotionOperation,
  RuntimePromotionRollbackCompletion,
} from './runtime-promotion-types.js';

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

type AuthoredTransaction = NonNullable<RuntimePromotionOperation['transaction']>;

async function bindAuthoredForRollback(
  operation: RuntimePromotionOperation,
  transaction: AuthoredTransaction,
  receipt: DurableOpenPromotionJournal,
): Promise<AuthoredTransaction> {
  await operation.dependencies.bindAuthoredReceipt(transaction, receipt);
  return transaction;
}

async function verifyRolledBackAuthoredState(
  operation: RuntimePromotionOperation,
  transaction: AuthoredTransaction,
  receipt: DurableOpenPromotionJournal,
): Promise<NonNullable<RuntimePromotionOperation['authoredSummary']>> {
  operation.receipt = receipt;
  return operation.dependencies.verifyAuthored(transaction, 'preimage');
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
  return operation.writer.recordRuntimeRolledBack(
    receipt,
    runtimePromotionMutationOutcome(result.status),
  );
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
  const transaction = await bindAuthoredForRollback(operation, operation.transaction, receipt);
  const rolledBack = await operation.dependencies.rollbackAuthored(transaction);
  assertFreshRuntimePromotionProjectRoot(operation);
  receipt = await operation.writer.bindAuthoredRolledBack(rolledBack.receipt);
  operation.authoredSummary = await verifyRolledBackAuthoredState(operation, transaction, receipt);
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

async function cleanupVerifiedTerminal(
  operation: RuntimePromotionOperation,
  receipt: DurableClosedPromotionJournal,
  journal: RuntimePromotionJournal,
): Promise<{
  readonly cleanup: Awaited<ReturnType<typeof cleanupFreshClosedRuntimePromotion>>;
  readonly journal: RuntimePromotionJournal;
}> {
  const cleanup = await cleanupFreshClosedRuntimePromotion(operation, receipt);
  return { cleanup, journal };
}

async function terminalResult(
  operation: RuntimePromotionOperation,
  receipt: DurableClosedPromotionJournal,
): Promise<RuntimePromotionRollbackCompletion> {
  const verifiedReceipt = await verifyClosedTerminalReceipt(operation, receipt);
  const journal = await operation.controller.verifyReceipt(verifiedReceipt, {
    state: 'closed',
  });
  const terminal = await cleanupVerifiedTerminal(operation, verifiedReceipt, journal);
  const cleanup = terminal.cleanup;
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
      terminal.journal.terminal?.outcome === 'committed'
        ? committedResult(resultInput)
        : rolledBackResult(resultInput),
    closedReceipt: cleanup.receipt,
  };
}

async function verifyOpenTerminalForJournal(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
  journal: RuntimePromotionJournal,
): Promise<{
  readonly receipt: DurableOpenPromotionJournal;
  readonly journal: RuntimePromotionJournal;
}> {
  await verifyOpenTerminalOperationAuthority(operation, receipt);
  return { receipt, journal };
}

async function reconcileTerminalOpen(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
): Promise<RuntimePromotionRollbackCompletion | null> {
  const journal = await operation.controller.verifyOpen(receipt);
  if (journal.terminal === null) return null;
  const verified = await verifyOpenTerminalForJournal(operation, receipt, journal);
  const closed = await operation.writer.close(verified.receipt);
  return terminalResult(operation, closed);
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

async function closeRolledBackIfIdle(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
  journal: RuntimePromotionJournal,
): Promise<RuntimePromotionRollbackCompletion | null> {
  if (journal.progress.pendingIntent !== null) return null;
  const closed = await closeRolledBack(operation, receipt);
  return terminalResult(operation, closed);
}

function verifyUnreconciledRollbackReceipt(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
  terminal: null,
): ReturnType<RuntimePromotionOperation['controller']['verifyOpen']> {
  void terminal;
  return operation.controller.verifyOpen(receipt);
}

async function rollbackClaimedOpen(
  operation: RuntimePromotionOperation,
  claimed: DurableOpenPromotionJournal,
): Promise<RuntimePromotionRollbackCompletion> {
  operation.receipt = claimed;
  const terminal = await reconcileTerminalOpen(operation, claimed);
  if (terminal !== null) return terminal;
  let journal = await verifyUnreconciledRollbackReceipt(operation, claimed, terminal);
  if (journal.progress.pendingIntent !== null || !rollbackEvidenceComplete(operation, journal)) {
    return recoveryResult(operation);
  }
  let receipt = claimed;
  if (journal.progress.direction === 'forward') {
    receipt = await operation.writer.beginRollback(receipt);
    operation.receipt = receipt;
  } else if (journal.progress.direction !== 'rollback') {
    return recoveryResult(operation);
  }
  const runtimeRolledBack = await rollbackRuntimeIfNeeded(operation, receipt);
  const authoredRolledBack = await rollbackAuthoredIfNeeded(operation, runtimeRolledBack);
  operation.receipt = authoredRolledBack;
  journal = await operation.controller.verifyOpen(authoredRolledBack);
  const completed = await closeRolledBackIfIdle(operation, authoredRolledBack, journal);
  return completed ?? recoveryResult(operation);
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
    if (claimed.state === 'closed') {
      return await terminalResult(operation, claimed);
    } else {
      return await rollbackClaimedOpen(operation, claimed);
    }
  } catch (error) {
    if (isRuntimePromotionAuthorityReleaseUnsafe(error)) {
      operation.leaseDisposition.releaseSafe = false;
    }
    // A rollback that itself fails is the worst case on this path — the runtime is left
    // mid-promotion — and it reported identically to a clean rollback. The recovery outcome
    // is unchanged; it is no longer the only thing the operator gets.
    reportInitFailure('rollback-failed', error);
    return recoveryResult(operation);
  }
}

import { join } from 'node:path';

import {
  asRecoveryClosed,
  assertRecoveryProjectRoot,
  assertRecoverySourceLocation,
  recoveryAuthoredWasMaterialized,
  recoveryRuntimeAuthority,
  refreshRecoveryJournal,
} from './runtime-promotion-recovery-common.js';
import { recoveryEvidenceMismatch } from './runtime-promotion-root-authority.js';
import { runtimePromotionMutationOutcome } from './runtime-promotion-transitions-common.js';

import type {
  RuntimePromotionJournal,
  RuntimePromotionOwnedSlotName,
} from './runtime-promotion-journal-schema.js';
import type { DurableClosedPromotionJournal } from './runtime-promotion-journal.js';
import type { RuntimePromotionRecoveryOperation } from './runtime-promotion-recovery-types.js';

const RUNTIME_CLEANUP_ORDER = ['runtimeStage', 'destinationBackup', 'sourceTombstone'] as const;
const AUTHORED_CLEANUP_SLOTS = ['authoredStage', 'authoredBackup', 'replayManifest'] as const;

/** @throws {Error} When an operation-owned directory is outside its durable parent authority. */
function assertDirectoryLocation(
  operation: RuntimePromotionRecoveryOperation,
  path: string,
  description: string,
): void {
  const observed = operation.dependencies.classifyPath(path);
  if (observed.status !== 'directory') {
    recoveryEvidenceMismatch(
      `${description} no longer has a safe directory location`,
      'recovery-location-unsafe',
    );
  }
}

/**
 * Closed history is final. Validate only the current authority's canonical
 * location/type; its bytes may legitimately differ after later normal runs.
 */
/** @throws {Error} When closed recovery no longer has current project or journal authority. */
function assertClosedCurrentAuthority(operation: RuntimePromotionRecoveryOperation): void {
  assertRecoveryProjectRoot(operation);
  const terminal = operation.journal.terminal;
  if (terminal === null)
    recoveryEvidenceMismatch(
      'Closed recovery lacks terminal authority',
      'closed-recovery-terminal-authority',
    );
  const authority = recoveryRuntimeAuthority({
    journal: operation.journal,
    outcome: terminal.outcome,
  });
  if (authority.location === 'project') {
    assertDirectoryLocation(
      operation,
      join(operation.input.projectRoot, 'opensip-cli', '.runtime'),
      'The current project runtime authority',
    );
  } else if (authority.location === 'cache') {
    const sourceRuntime = assertRecoverySourceLocation(operation);
    assertDirectoryLocation(operation, sourceRuntime, 'The current cache runtime authority');
  }
  assertRecoveryProjectRoot(operation);
}

async function recordCleanupIntent(
  operation: RuntimePromotionRecoveryOperation,
  slot: RuntimePromotionOwnedSlotName,
): Promise<void> {
  operation.receipt = await operation.writer.recordCleanupIntent(asRecoveryClosed(operation), slot);
  operation.dependencies.checkpoint?.('after-closed-cleanup-transition');
  await refreshRecoveryJournal(operation);
}

/** @throws {Error} When an owned runtime slot cannot be safely reconciled and cleaned. */
async function cleanupRuntimeSlot(
  operation: RuntimePromotionRecoveryOperation,
  slot: (typeof RUNTIME_CLEANUP_ORDER)[number] | 'destinationParent',
): Promise<RuntimePromotionRecoveryOperation> {
  if (operation.journal.cleanup[slot] !== 'pending') return operation;
  const pending = operation.journal.progress.pendingIntent;
  if (pending === null) {
    await recordCleanupIntent(operation, slot);
  } else if (pending.kind !== 'owned-slot-cleanup' || pending.slot !== slot) {
    recoveryEvidenceMismatch(
      'Closed recovery found another unresolved cleanup intent',
      'closed-recovery-unresolved-cleanup-intent',
    );
  }
  assertClosedCurrentAuthority(operation);
  const authority = await operation.dependencies.authorizeFilesystem({
    action: 'owned-slot-cleanup',
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    ...(operation.sourceRuntime === undefined ? {} : { sourceRuntime: operation.sourceRuntime }),
    controller: operation.controller,
    lease: operation.lease,
    receipt: asRecoveryClosed(operation),
    cleanupSlot: slot,
  });
  const result = await operation.dependencies.cleanupOwnedSlot(authority);
  if (result.slot !== slot) {
    recoveryEvidenceMismatch(
      'Closed recovery cleaned a different owned slot',
      'closed-recovery-cleaned-different-owned',
    );
  }
  assertClosedCurrentAuthority(operation);
  operation.receipt = await operation.writer.recordCleanupPostcondition(
    asRecoveryClosed(operation),
    slot,
    runtimePromotionMutationOutcome(result.status),
  );
  operation.dependencies.checkpoint?.('after-closed-cleanup-transition');
  await refreshRecoveryJournal(operation);
  return operation;
}

function authoredCleanupNeeded(journal: RuntimePromotionJournal): boolean {
  return (
    recoveryAuthoredWasMaterialized(journal) ||
    (journal.progress.pendingIntent?.kind === 'owned-slot-cleanup' &&
      journal.progress.pendingIntent.slot !== null &&
      AUTHORED_CLEANUP_SLOTS.includes(
        journal.progress.pendingIntent.slot as (typeof AUTHORED_CLEANUP_SLOTS)[number],
      ))
  );
}

async function cleanupAuthoredArtifacts(
  operation: RuntimePromotionRecoveryOperation,
): Promise<RuntimePromotionRecoveryOperation> {
  if (!authoredCleanupNeeded(operation.journal)) return operation;
  assertClosedCurrentAuthority(operation);
  const transaction = await operation.dependencies.loadClosedAuthored({
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    lease: operation.lease,
    controller: operation.controller,
    receipt: asRecoveryClosed(operation),
  });
  const cleaned = await operation.dependencies.cleanupAuthored(
    transaction,
    asRecoveryClosed(operation),
  );
  operation.receipt = cleaned.receipt;
  operation.authoredSummary = cleaned.summary;
  operation.dependencies.checkpoint?.('after-closed-cleanup-transition');
  await refreshRecoveryJournal(operation);
  assertClosedCurrentAuthority(operation);
  return operation;
}

async function cleanupRuntimeSlots(
  operation: RuntimePromotionRecoveryOperation,
  index = 0,
): Promise<RuntimePromotionRecoveryOperation> {
  const slot = RUNTIME_CLEANUP_ORDER[index];
  if (slot === undefined) return operation;
  const cleaned = await cleanupRuntimeSlot(operation, slot);
  return cleanupRuntimeSlots(cleaned, index + 1);
}

/** @throws {Error} When durable owned-artifact cleanup remains incomplete. */
function assertCleanupComplete(journal: RuntimePromotionJournal): void {
  if (
    journal.progress.pendingIntent !== null ||
    Object.values(journal.cleanup).includes('pending')
  ) {
    recoveryEvidenceMismatch(
      'Closed recovery still has owned cleanup work',
      'closed-recovery-owned-cleanup-work',
    );
  }
}

/**
 * Apply monotonic cleanup to a closed receipt. This function never compares the
 * current authority with the historical terminal manifest and has no rollback
 * or restore path.
 */
/** @throws {Error} When closed recovery cleanup or terminal authority verification fails. */
export async function cleanupRecoveredClosedRuntimePromotion(
  operation: RuntimePromotionRecoveryOperation,
  expectedReceipt: DurableClosedPromotionJournal = asRecoveryClosed(operation),
): Promise<void> {
  operation.receipt = expectedReceipt;
  await refreshRecoveryJournal(operation, expectedReceipt);
  if (operation.receipt.state !== 'closed') {
    recoveryEvidenceMismatch(
      'Closed cleanup received an open promotion journal',
      'closed-cleanup-open-promotion-journal',
    );
  }
  assertClosedCurrentAuthority(operation);
  const runtimeCleaned = await cleanupRuntimeSlots(operation);
  const authoredCleaned = await cleanupAuthoredArtifacts(runtimeCleaned);
  const fullyCleaned = await cleanupRuntimeSlot(authoredCleaned, 'destinationParent');
  assertCleanupComplete(fullyCleaned.journal);
  assertClosedCurrentAuthority(fullyCleaned);
  fullyCleaned.dependencies.checkpoint?.('before-journal-unlink');
  await fullyCleaned.writer.unlinkClean(asRecoveryClosed(fullyCleaned));
  fullyCleaned.journalUnlinked = true;
  fullyCleaned.dependencies.checkpoint?.('after-journal-unlink');
}

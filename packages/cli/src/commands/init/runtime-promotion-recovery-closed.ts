import { join } from 'node:path';

import {
  asRecoveryClosed,
  assertRecoveryProjectRoot,
  assertRecoverySourceLocation,
  recoveryAuthoredWasMaterialized,
  recoveryRuntimeAuthority,
  refreshRecoveryJournal,
  runtimeRecoveryMutationOutcome,
} from './runtime-promotion-recovery-common.js';

import type {
  RuntimePromotionJournal,
  RuntimePromotionOwnedSlotName,
} from './runtime-promotion-journal-schema.js';
import type { RuntimePromotionRecoveryOperation } from './runtime-promotion-recovery-types.js';

const RUNTIME_CLEANUP_ORDER = ['runtimeStage', 'destinationBackup', 'sourceTombstone'] as const;
const AUTHORED_CLEANUP_SLOTS = ['authoredStage', 'authoredBackup', 'replayManifest'] as const;

function assertDirectoryLocation(
  operation: RuntimePromotionRecoveryOperation,
  path: string,
  description: string,
): void {
  const observed = operation.dependencies.classifyPath(path);
  if (observed.status !== 'directory') {
    throw new Error(`${description} no longer has a safe directory location`);
  }
}

/**
 * Closed history is final. Validate only the current authority's canonical
 * location/type; its bytes may legitimately differ after later normal runs.
 */
function assertClosedCurrentAuthority(operation: RuntimePromotionRecoveryOperation): void {
  assertRecoveryProjectRoot(operation);
  const terminal = operation.journal.terminal;
  if (terminal === null) throw new Error('Closed recovery lacks terminal authority');
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

async function cleanupRuntimeSlot(
  operation: RuntimePromotionRecoveryOperation,
  slot: (typeof RUNTIME_CLEANUP_ORDER)[number] | 'destinationParent',
): Promise<void> {
  if (operation.journal.cleanup[slot] !== 'pending') return;
  const pending = operation.journal.progress.pendingIntent;
  if (pending === null) {
    await recordCleanupIntent(operation, slot);
  } else if (pending.kind !== 'owned-slot-cleanup' || pending.slot !== slot) {
    throw new Error('Closed recovery found another unresolved cleanup intent');
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
    throw new Error('Closed recovery cleaned a different owned slot');
  }
  assertClosedCurrentAuthority(operation);
  operation.receipt = await operation.writer.recordCleanupPostcondition(
    asRecoveryClosed(operation),
    slot,
    runtimeRecoveryMutationOutcome(result.status),
  );
  operation.dependencies.checkpoint?.('after-closed-cleanup-transition');
  await refreshRecoveryJournal(operation);
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
): Promise<void> {
  if (!authoredCleanupNeeded(operation.journal)) return;
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
}

function assertCleanupComplete(journal: RuntimePromotionJournal): void {
  if (
    journal.progress.pendingIntent !== null ||
    Object.values(journal.cleanup).includes('pending')
  ) {
    throw new Error('Closed recovery still has owned cleanup work');
  }
}

/**
 * Apply monotonic cleanup to a closed receipt. This function never compares the
 * current authority with the historical terminal manifest and has no rollback
 * or restore path.
 */
export async function cleanupRecoveredClosedRuntimePromotion(
  operation: RuntimePromotionRecoveryOperation,
): Promise<void> {
  await refreshRecoveryJournal(operation);
  if (operation.receipt.state !== 'closed') {
    throw new Error('Closed cleanup received an open promotion journal');
  }
  assertClosedCurrentAuthority(operation);
  for (const slot of RUNTIME_CLEANUP_ORDER) {
    await cleanupRuntimeSlot(operation, slot);
  }
  await cleanupAuthoredArtifacts(operation);
  await cleanupRuntimeSlot(operation, 'destinationParent');
  assertCleanupComplete(operation.journal);
  assertClosedCurrentAuthority(operation);
  operation.dependencies.checkpoint?.('before-journal-unlink');
  await operation.writer.unlinkClean(asRecoveryClosed(operation));
  operation.journalUnlinked = true;
  operation.dependencies.checkpoint?.('after-journal-unlink');
}

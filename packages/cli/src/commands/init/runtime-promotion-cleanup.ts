import {
  isRuntimePromotionAuthorityReleaseUnsafe,
  verifyClosedTerminalOperationAuthority,
} from './runtime-promotion-authority-verification.js';
import { assertFreshRuntimePromotionProjectRoot } from './runtime-promotion-root-authority.js';
import { runtimePromotionMutationOutcome } from './runtime-promotion-transitions-common.js';

import type { RuntimePromotionOwnedSlotName } from './runtime-promotion-journal-schema.js';
import type {
  DurableClosedPromotionJournal,
  DurablePromotionJournal,
} from './runtime-promotion-journal.js';
import type {
  RuntimePromotionCleanupCompletion,
  RuntimePromotionOperation,
} from './runtime-promotion-types.js';

const RUNTIME_CLEANUP_ORDER = ['runtimeStage', 'destinationBackup', 'sourceTombstone'] as const;

/** @throws {Error} When an owned runtime slot cannot be safely cleaned. */
async function cleanupRuntimeSlot(
  operation: RuntimePromotionOperation,
  initialReceipt: DurableClosedPromotionJournal,
  slot: (typeof RUNTIME_CLEANUP_ORDER)[number] | 'destinationParent',
): Promise<DurableClosedPromotionJournal> {
  let receipt = initialReceipt;
  const current = await operation.controller.verifyReceipt(receipt, {
    state: 'closed',
  });
  if (current.cleanup[slot] !== 'pending') return receipt;
  assertFreshRuntimePromotionProjectRoot(operation);
  receipt = await operation.writer.recordCleanupIntent(receipt, slot);
  const authority = await operation.dependencies.authorizeFilesystem({
    action: 'owned-slot-cleanup',
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    ...(operation.preflight.sourceRuntimeDir === undefined
      ? {}
      : { sourceRuntime: operation.preflight.sourceRuntimeDir }),
    controller: operation.controller,
    lease: operation.lease,
    receipt,
    cleanupSlot: slot,
  });
  const result = await operation.dependencies.cleanupOwnedSlot(authority);
  assertFreshRuntimePromotionProjectRoot(operation);
  if (result.slot !== slot) {
    throw new Error('Runtime promotion cleanup returned a different owned slot');
  }
  return operation.writer.recordCleanupPostcondition(
    receipt,
    slot,
    runtimePromotionMutationOutcome(result.status),
  );
}

async function claimClosedAfterFailure(
  operation: RuntimePromotionOperation,
  fallback: DurableClosedPromotionJournal,
): Promise<DurableClosedPromotionJournal> {
  try {
    const claimed: DurablePromotionJournal = await operation.controller.claim(fallback.operationId);
    return claimed.state === 'closed' ? claimed : fallback;
  } catch {
    return fallback;
  }
}

async function verifyCleanupStart(
  operation: RuntimePromotionOperation,
  receipt: DurableClosedPromotionJournal,
): Promise<DurableClosedPromotionJournal> {
  await verifyClosedTerminalOperationAuthority(operation, receipt);
  return receipt;
}

async function cleanupRuntimeSlots(
  operation: RuntimePromotionOperation,
  receipt: DurableClosedPromotionJournal,
  index = 0,
): Promise<DurableClosedPromotionJournal> {
  const slot = RUNTIME_CLEANUP_ORDER[index];
  if (slot === undefined) return receipt;
  const cleaned = await cleanupRuntimeSlot(operation, receipt, slot);
  return cleanupRuntimeSlots(operation, cleaned, index + 1);
}

/** @throws {Error} When closed-journal cleanup is incomplete or cannot be verified. */
async function assertReadyToUnlink(
  operation: RuntimePromotionOperation,
  receipt: DurableClosedPromotionJournal,
): Promise<void> {
  const current = await operation.controller.verifyReceipt(receipt, {
    state: 'closed',
  });
  const pendingSlots = (Object.keys(current.cleanup) as RuntimePromotionOwnedSlotName[]).filter(
    (slot) => current.cleanup[slot] === 'pending',
  );
  if (current.progress.pendingIntent !== null || pendingSlots.length > 0) {
    throw new Error('Runtime promotion cleanup remains incomplete');
  }
}

/**
 * Same-invocation cleanup under the fresh promotion's still-held normal lease.
 * The terminal identity is an exact just-observed authority assertion here; a
 * later recovery flow must use its own current-valid successor proof instead.
 * An identity mismatch or ambiguous artifact leaves the exact closed receipt.
 */
export async function cleanupFreshClosedRuntimePromotion(
  operation: RuntimePromotionOperation,
  initialReceipt: DurableClosedPromotionJournal,
): Promise<RuntimePromotionCleanupCompletion> {
  let receipt = initialReceipt;
  try {
    assertFreshRuntimePromotionProjectRoot(operation);
    receipt = await verifyCleanupStart(operation, receipt);
    receipt = await cleanupRuntimeSlots(operation, receipt);
    if (operation.transaction !== null) {
      assertFreshRuntimePromotionProjectRoot(operation);
      const cleaned = await operation.dependencies.cleanupAuthored(operation.transaction, receipt);
      assertFreshRuntimePromotionProjectRoot(operation);
      receipt = cleaned.receipt;
      operation.authoredSummary = cleaned.summary;
    }
    receipt = await cleanupRuntimeSlot(operation, receipt, 'destinationParent');
    await assertReadyToUnlink(operation, receipt);
    operation.dependencies.checkpoint?.('after-cleanup');
    assertFreshRuntimePromotionProjectRoot(operation);
    await operation.writer.unlinkClean(receipt);
    return { cleanupPending: false, receipt };
  } catch (error) {
    if (isRuntimePromotionAuthorityReleaseUnsafe(error)) {
      operation.leaseDisposition.releaseSafe = false;
    }
    return {
      cleanupPending: true,
      receipt: await claimClosedAfterFailure(operation, receipt),
    };
  }
}

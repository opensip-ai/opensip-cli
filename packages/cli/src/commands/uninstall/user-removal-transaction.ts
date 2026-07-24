/**
 * @fileoverview Receipt-transaction state machine for user-level uninstall.
 *
 * Split out of user-removal.ts (file-length-limit soft cap): the bounded
 * write-ahead receipt state machine that drives marker publish → rename →
 * tombstone deletion → receipt close/unlink, one phase transition at a time.
 * user-removal.ts (orchestration) owns confirm/lease-acquire/present and
 * calls `completeUserRemovalTransaction` once a lease is held.
 */

import { existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  mutateUserUninstallReceipt,
  readUserUninstallReceipt,
  type GlobalRuntimeMaintenanceLease,
  type inspectUserUninstallRecoveryHeader,
} from '@opensip-cli/core';

import {
  contentSha256,
  markerMatches,
  publishExclusiveMarker,
  recoveryFailure,
  removeOwnedTombstone,
  safeDirectoryExists,
} from './user-removal-fs.js';
import {
  advanceReceipt,
  buildOpenReceipt,
  closeReceipt,
  digestMarkerContent,
  newMarkerContent,
  newOperationId,
  newTombstoneBasename,
  parseReceiptBody,
  serializeReceipt,
  USER_UNINSTALL_MARKER_BASENAME,
  type UserUninstallPhase,
  type UserUninstallReceiptBody,
} from './user-uninstall-receipt.js';

/**
 * The subset of `inspectUserUninstallRecoveryHeader`'s return type the
 * transaction can resume from — a malformed header is refused before a
 * transaction ever starts (receipt-only discard owns that path).
 */
type TransactionHeader = Extract<
  ReturnType<typeof inspectUserUninstallRecoveryHeader>,
  { readonly status: 'absent' | 'valid' }
>;

interface ReceiptCursor {
  readonly receipt: UserUninstallReceiptBody;
  readonly sha256: string;
  readonly pendingMarkerContent?: Buffer;
}

interface TransactionContext {
  readonly userRoot: string;
  readonly tombstonePath: string;
  readonly lease: GlobalRuntimeMaintenanceLease;
}

const MAX_RECEIPT_TRANSITIONS = 10;
const MAX_REMOVAL_RECEIPTS = 2;

async function replaceReceipt(
  lease: GlobalRuntimeMaintenanceLease,
  cursor: ReceiptCursor,
  receipt: UserUninstallReceiptBody,
  pendingMarkerContent?: Buffer,
): Promise<ReceiptCursor> {
  const content = serializeReceipt(receipt);
  await mutateUserUninstallReceipt(lease, {
    operation: 'replace',
    content,
    expectedContentSha256: cursor.sha256,
  });
  return {
    receipt,
    sha256: contentSha256(content),
    ...(pendingMarkerContent === undefined ? {} : { pendingMarkerContent }),
  };
}

async function initialReceiptCursor(
  lease: GlobalRuntimeMaintenanceLease,
  header: TransactionHeader,
): Promise<ReceiptCursor> {
  if (header.status === 'valid') {
    const observed = await readUserUninstallReceipt(lease);
    if (observed.status !== 'present') {
      recoveryFailure('the admitted receipt disappeared before recovery');
    }
    const receipt = parseReceiptBody(observed.content);
    if (receipt?.operationId !== header.operationId) {
      recoveryFailure('the bounded receipt body does not match its admitted recovery header');
    }
    return { receipt, sha256: observed.sha256 };
  }

  const operationId = newOperationId();
  const pendingMarkerContent = newMarkerContent();
  const receipt = buildOpenReceipt({
    operationId,
    phase: 'marker-create-intent',
    tombstoneBasename: newTombstoneBasename(operationId),
    markerDigest: digestMarkerContent(pendingMarkerContent),
  });
  const content = serializeReceipt(receipt);
  await mutateUserUninstallReceipt(lease, { operation: 'create', content });
  return {
    receipt,
    sha256: contentSha256(content),
    pendingMarkerContent,
  };
}

async function setReceiptPhase(
  context: TransactionContext,
  cursor: ReceiptCursor,
  phase: UserUninstallPhase,
  pendingMarkerContent?: Buffer,
): Promise<ReceiptCursor> {
  return replaceReceipt(
    context.lease,
    cursor,
    advanceReceipt(
      cursor.receipt,
      phase,
      pendingMarkerContent === undefined
        ? {}
        : { markerDigest: digestMarkerContent(pendingMarkerContent) },
    ),
    pendingMarkerContent,
  );
}

async function handleMarkerCreateIntent(
  context: TransactionContext,
  cursor: ReceiptCursor,
  tombstoneExists: boolean,
): Promise<ReceiptCursor> {
  if (tombstoneExists) {
    if (!markerMatches(context.tombstonePath, cursor.receipt.markerDigest)) {
      recoveryFailure('the tombstone marker does not match the recovery receipt');
    }
    return setReceiptPhase(context, cursor, 'renamed');
  }
  if (markerMatches(context.userRoot, cursor.receipt.markerDigest)) {
    return setReceiptPhase(context, cursor, 'marker-created');
  }
  if (existsSync(join(context.userRoot, USER_UNINSTALL_MARKER_BASENAME))) {
    recoveryFailure('the live user root has a foreign operation marker');
  }

  const markerContent = cursor.pendingMarkerContent ?? newMarkerContent();
  const current =
    cursor.pendingMarkerContent === undefined
      ? await setReceiptPhase(context, cursor, 'marker-create-intent', markerContent)
      : cursor;
  publishExclusiveMarker(context.userRoot, current.receipt.operationId, markerContent);
  if (!markerMatches(context.userRoot, current.receipt.markerDigest)) {
    recoveryFailure('the exclusive operation marker could not be verified after creation');
  }
  return setReceiptPhase(context, current, 'marker-created');
}

async function handleMarkerCreated(
  context: TransactionContext,
  cursor: ReceiptCursor,
  tombstoneExists: boolean,
): Promise<ReceiptCursor> {
  const markerRoot = tombstoneExists ? context.tombstonePath : context.userRoot;
  if (!markerMatches(markerRoot, cursor.receipt.markerDigest)) {
    recoveryFailure('the operation marker does not match the recovery receipt');
  }
  return setReceiptPhase(context, cursor, tombstoneExists ? 'renamed' : 'rename-intent');
}

async function handleRenameIntent(
  context: TransactionContext,
  cursor: ReceiptCursor,
  sourceExists: boolean,
): Promise<ReceiptCursor> {
  if (sourceExists) {
    if (!markerMatches(context.userRoot, cursor.receipt.markerDigest)) {
      recoveryFailure('the live user root marker does not match the recovery receipt');
    }
    renameSync(context.userRoot, context.tombstonePath);
  }
  if (!markerMatches(context.tombstonePath, cursor.receipt.markerDigest)) {
    recoveryFailure('the renamed tombstone marker does not match the recovery receipt');
  }
  return setReceiptPhase(context, cursor, 'renamed');
}

async function advanceRemovalTransaction(
  context: TransactionContext,
  cursor: ReceiptCursor,
  sourceExists: boolean,
  tombstoneExists: boolean,
): Promise<ReceiptCursor> {
  switch (cursor.receipt.phase) {
    case 'marker-create-intent': {
      return handleMarkerCreateIntent(context, cursor, tombstoneExists);
    }
    case 'marker-created': {
      return handleMarkerCreated(context, cursor, tombstoneExists);
    }
    case 'rename-intent': {
      return handleRenameIntent(context, cursor, sourceExists);
    }
    case 'renamed': {
      if (!tombstoneExists || !markerMatches(context.tombstonePath, cursor.receipt.markerDigest)) {
        recoveryFailure('the recovery tombstone does not match the receipt');
      }
      return setReceiptPhase(context, cursor, 'delete-intent');
    }
    case 'delete-intent': {
      if (!tombstoneExists) {
        recoveryFailure('the recovery tombstone is missing');
      }
      removeOwnedTombstone(context.tombstonePath, cursor.receipt.markerDigest);
      return setReceiptPhase(context, cursor, 'deleted');
    }
    case 'deleted': {
      if (tombstoneExists) {
        recoveryFailure('the deleted receipt phase still has its recovery tombstone');
      }
      return replaceReceipt(context.lease, cursor, closeReceipt(cursor.receipt));
    }
  }
}

async function finishOpenRemovalReceipt(
  context: TransactionContext,
  initial: ReceiptCursor,
): Promise<ReceiptCursor> {
  let cursor = initial;
  let transitions = 0;
  while (cursor.receipt.state === 'open') {
    if (transitions >= MAX_RECEIPT_TRANSITIONS) {
      recoveryFailure('the receipt exceeded its bounded transition count');
    }

    const phase = cursor.receipt.phase;
    const sourceExists = safeDirectoryExists(context.userRoot);
    const tombstoneExists = safeDirectoryExists(context.tombstonePath);
    const deletionAlreadyCompleted =
      !tombstoneExists && (phase === 'delete-intent' || (!sourceExists && phase !== 'deleted'));
    if (deletionAlreadyCompleted) {
      cursor = await setReceiptPhase(context, cursor, 'deleted');
    } else {
      // Once a verified tombstone exists, any simultaneous live root is a
      // recreated generation. Finish the tombstone receipt before removing it.
      const sourceBelongsToReceipt = sourceExists && !tombstoneExists;
      cursor = await advanceRemovalTransaction(
        context,
        cursor,
        sourceBelongsToReceipt,
        tombstoneExists,
      );
    }
    transitions += 1;
  }
  return cursor;
}

export async function completeUserRemovalTransaction(input: {
  readonly userRoot: string;
  readonly header: TransactionHeader;
  readonly lease: GlobalRuntimeMaintenanceLease;
}): Promise<void> {
  const cursor = await initialReceiptCursor(input.lease, input.header);
  await settleRemovalReceipts(input, cursor, 0);
}

/**
 * Bounded RECURSION, not a loop: each receipt transition is an ordered,
 * awaited state-machine step (parallelizing would corrupt the receipt), and
 * the depth is capped by MAX_REMOVAL_RECEIPTS × MAX_RECEIPT_TRANSITIONS —
 * `recoveryFailure` throws past either bound.
 */
async function settleRemovalReceipts(
  input: { readonly userRoot: string; readonly lease: GlobalRuntimeMaintenanceLease },
  cursor: ReceiptCursor,
  retiredReceipts: number,
): Promise<void> {
  let nextCursor = cursor;
  let retired = retiredReceipts;
  if (nextCursor.receipt.state === 'closed') {
    await mutateUserUninstallReceipt(input.lease, {
      operation: 'unlink',
      expectedContentSha256: nextCursor.sha256,
    });
    retired += 1;
    if (!safeDirectoryExists(input.userRoot)) return;
    if (retired >= MAX_REMOVAL_RECEIPTS) {
      recoveryFailure('the user root was recreated repeatedly during removal');
    }
    nextCursor = await initialReceiptCursor(input.lease, { status: 'absent' });
  }
  const context: TransactionContext = {
    userRoot: input.userRoot,
    tombstonePath: join(dirname(input.userRoot), nextCursor.receipt.tombstoneBasename),
    lease: input.lease,
  };
  const settled = await finishOpenRemovalReceipt(context, nextCursor);
  return settleRemovalReceipts(input, settled, retired);
}

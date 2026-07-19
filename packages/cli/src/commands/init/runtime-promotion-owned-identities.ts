/** Deterministic, slot-specific basenames that recovery may safely derive from a journal. */

import { createHash } from 'node:crypto';

import {
  RUNTIME_PROMOTION_OPERATION_ID_PATTERN,
  type RuntimePromotionOwnedSlotName,
  type RuntimePromotionOwnedSlots,
} from './runtime-promotion-journal-types.js';

const SLOT_TOKENS: Readonly<Record<RuntimePromotionOwnedSlotName, string>> = {
  destinationParent: 'destination-parent',
  runtimeStage: 'runtime-stage',
  destinationBackup: 'destination-backup',
  sourceTombstone: 'source-tombstone',
  authoredStage: 'authored-stage',
  authoredBackup: 'authored-backup',
  replayManifest: 'replay-manifest',
};

function ownedDigest(
  operationId: string,
  slot: RuntimePromotionOwnedSlotName,
  domain: string,
): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(operationId)
    .update('\0')
    .update(slot)
    .digest('hex');
}

/** Derive the only accepted basename for one operation-owned artifact slot. */
/** @throws {Error} When the operation identity cannot produce a safe owned basename. */
export function runtimePromotionOwnedBasename(
  operationId: string,
  slot: RuntimePromotionOwnedSlotName,
): string {
  if (!RUNTIME_PROMOTION_OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error('Cannot derive a promotion basename from an invalid operation ID');
  }
  const digest = ownedDigest(operationId, slot, 'opensip:init-promotion-basename:v1');
  return `.opensip-init-${SLOT_TOKENS[slot]}-${digest}`;
}

/** Derive the only accepted ownership marker identity for one artifact slot. */
/** @throws {Error} When the operation identity cannot produce a safe ownership identifier. */
export function runtimePromotionOwnershipId(
  operationId: string,
  slot: RuntimePromotionOwnedSlotName,
): string {
  if (!RUNTIME_PROMOTION_OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error('Cannot derive a promotion ownership ID from an invalid operation ID');
  }
  const digest = ownedDigest(operationId, slot, 'opensip:init-promotion-ownership:v1');
  return `opensip-init-ownership-${SLOT_TOKENS[slot]}-${digest}`;
}

/** Derive the complete immutable owned-artifact identity set for one operation. */
export function createRuntimePromotionOwnedSlots(operationId: string): RuntimePromotionOwnedSlots {
  const slot = (name: RuntimePromotionOwnedSlotName) => ({
    basename: runtimePromotionOwnedBasename(operationId, name),
    ownershipId: runtimePromotionOwnershipId(operationId, name),
  });
  return {
    destinationParent: slot('destinationParent'),
    runtimeStage: slot('runtimeStage'),
    destinationBackup: slot('destinationBackup'),
    sourceTombstone: slot('sourceTombstone'),
    authoredStage: slot('authoredStage'),
    authoredBackup: slot('authoredBackup'),
    replayManifest: slot('replayManifest'),
  };
}

import {
  verifyClosedTerminalOperationAuthority,
  verifyCommittedOperationAuthority,
  verifyOpenTerminalOperationAuthority,
} from './runtime-promotion-authority-verification.js';

import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
} from './runtime-promotion-journal.js';
import type { RuntimePromotionOperation } from './runtime-promotion-types.js';

async function verifyCommittedReceipt(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  await verifyCommittedOperationAuthority(operation, receipt);
  return receipt;
}

async function verifyOpenTerminalReceipt(
  operation: RuntimePromotionOperation,
  receipt: DurableOpenPromotionJournal,
): Promise<DurableOpenPromotionJournal> {
  await verifyOpenTerminalOperationAuthority(operation, receipt);
  return receipt;
}

async function verifyClosedTerminalReceipt(
  operation: RuntimePromotionOperation,
  receipt: DurableClosedPromotionJournal,
): Promise<DurableClosedPromotionJournal> {
  await verifyClosedTerminalOperationAuthority(operation, receipt);
  return receipt;
}

export async function sealCommittedRuntimePromotion(
  operation: RuntimePromotionOperation,
): Promise<DurableClosedPromotionJournal> {
  const authority = await verifyCommittedOperationAuthority(operation, operation.receipt);
  const authorityReceipt = await operation.writer.recordAuthorityVerified(
    operation.receipt,
    authority,
  );
  operation.receipt = authorityReceipt;
  const verifiedAuthorityReceipt = await verifyCommittedReceipt(operation, authorityReceipt);
  operation.dependencies.checkpoint?.('after-authority-verified');
  const sealableReceipt = await verifyCommittedReceipt(operation, verifiedAuthorityReceipt);
  const sealedReceipt = await operation.writer.sealCommitted(sealableReceipt);
  operation.receipt = sealedReceipt;
  const verifiedSealedReceipt = await verifyOpenTerminalReceipt(operation, sealedReceipt);
  operation.dependencies.checkpoint?.('after-terminal-sealed');
  const closeableReceipt = await verifyOpenTerminalReceipt(operation, verifiedSealedReceipt);
  const closed = await operation.writer.close(closeableReceipt);
  const verifiedClosed = await verifyClosedTerminalReceipt(operation, closed);
  operation.dependencies.checkpoint?.('after-journal-closed');
  return verifyClosedTerminalReceipt(operation, verifiedClosed);
}

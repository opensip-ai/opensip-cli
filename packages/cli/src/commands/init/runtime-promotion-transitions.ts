import {
  advancePreexistingDestinationReady,
  beginRuntimePromotionRollback,
  recordDestinationBackedUp,
  recordDestinationBackupCreateIntent,
  recordDestinationInstallIntent,
  recordDestinationParentCreateIntent,
  recordDestinationReady,
  recordRuntimeInstalled,
  recordRuntimeRollbackIntent,
  recordRuntimeRolledBack,
  recordRuntimeStageCreateIntent,
  recordRuntimeStaged,
  recordSourceRetired,
  recordSourceRetireIntent,
  verifyPromotionDestination,
  verifyPromotionSource,
} from './runtime-promotion-transitions-runtime.js';
import {
  bindAuthoredCommittedReceipt,
  bindAuthoredPreparedReceipt,
  bindAuthoredRolledBackReceipt,
  closeRuntimePromotion,
  recordAuthorityVerified,
  recordOwnedCleanupIntent,
  recordOwnedCleanupPostcondition,
  recordUnmaterializedAuthoredStateRolledBack,
  sealRuntimePromotionCommitted,
  sealRuntimePromotionRolledBack,
  unlinkCleanRuntimePromotion,
} from './runtime-promotion-transitions-terminal.js';

import type {
  RuntimeManifestIdentity,
  RuntimePromotionOwnedSlotName,
} from './runtime-promotion-journal-schema.js';
import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
  RuntimePromotionJournalController,
} from './runtime-promotion-journal.js';
import type { RuntimeMutationOutcome } from './runtime-promotion-transitions-common.js';

export type { RuntimeMutationOutcome } from './runtime-promotion-transitions-common.js';

export interface RuntimePromotionTransitionDependencies {
  readonly now?: () => number;
}

type OpenTransition = (
  receipt: DurableOpenPromotionJournal,
) => Promise<DurableOpenPromotionJournal>;
type RuntimePostcondition = (
  receipt: DurableOpenPromotionJournal,
  outcome: RuntimeMutationOutcome,
) => Promise<DurableOpenPromotionJournal>;
type ManifestVerification = (
  receipt: DurableOpenPromotionJournal,
  manifest: RuntimeManifestIdentity | null,
) => Promise<DurableOpenPromotionJournal>;

/**
 * The only Task 3.5 journal-writing surface.
 *
 * Each method consumes an exact controller-issued receipt and either emits the
 * one legal next receipt or fails before journal mutation. Callers never
 * assemble a raw journal record, intent, postcondition, counter, or terminal.
 */
export interface RuntimePromotionTransitionWriter {
  readonly verifySource: (
    receipt: DurableOpenPromotionJournal,
    manifest: RuntimeManifestIdentity,
  ) => Promise<DurableOpenPromotionJournal>;
  readonly verifyDestination: ManifestVerification;
  readonly bindAuthoredPrepared: OpenTransition;
  readonly recordDestinationParentCreateIntent: OpenTransition;
  readonly recordDestinationReady: RuntimePostcondition;
  readonly advancePreexistingDestinationReady: OpenTransition;
  readonly recordRuntimeStageCreateIntent: OpenTransition;
  readonly recordRuntimeStaged: (
    receipt: DurableOpenPromotionJournal,
    outcome: RuntimeMutationOutcome,
    manifest: RuntimeManifestIdentity,
  ) => Promise<DurableOpenPromotionJournal>;
  readonly recordDestinationBackupCreateIntent: OpenTransition;
  readonly recordDestinationBackedUp: RuntimePostcondition;
  readonly recordDestinationInstallIntent: OpenTransition;
  readonly recordRuntimeInstalled: RuntimePostcondition;
  readonly bindAuthoredCommitted: OpenTransition;
  readonly recordSourceRetireIntent: OpenTransition;
  readonly recordSourceRetired: RuntimePostcondition;
  readonly recordAuthorityVerified: ManifestVerification;
  readonly sealCommitted: OpenTransition;
  readonly beginRollback: OpenTransition;
  readonly recordRuntimeRollbackIntent: OpenTransition;
  readonly recordRuntimeRolledBack: RuntimePostcondition;
  readonly recordUnmaterializedAuthoredRolledBack: OpenTransition;
  readonly bindAuthoredRolledBack: OpenTransition;
  readonly sealRolledBack: ManifestVerification;
  readonly close: (receipt: DurableOpenPromotionJournal) => Promise<DurableClosedPromotionJournal>;
  readonly recordCleanupIntent: (
    receipt: DurableClosedPromotionJournal,
    slot: RuntimePromotionOwnedSlotName,
  ) => Promise<DurableClosedPromotionJournal>;
  readonly recordCleanupPostcondition: (
    receipt: DurableClosedPromotionJournal,
    slot: RuntimePromotionOwnedSlotName,
    outcome: RuntimeMutationOutcome,
  ) => Promise<DurableClosedPromotionJournal>;
  readonly unlinkClean: (receipt: DurableClosedPromotionJournal) => Promise<void>;
}

export function createRuntimePromotionTransitionWriter(
  controller: RuntimePromotionJournalController,
  dependencies: RuntimePromotionTransitionDependencies = {},
): RuntimePromotionTransitionWriter {
  const context = Object.freeze({
    controller,
    now: dependencies.now ?? Date.now,
  });
  const writer: RuntimePromotionTransitionWriter = {
    verifySource: (receipt, manifest) => verifyPromotionSource(context, receipt, manifest),
    verifyDestination: (receipt, manifest) =>
      verifyPromotionDestination(context, receipt, manifest),
    bindAuthoredPrepared: (receipt) => bindAuthoredPreparedReceipt(context, receipt),
    recordDestinationParentCreateIntent: (receipt) =>
      recordDestinationParentCreateIntent(context, receipt),
    recordDestinationReady: (receipt, outcome) => recordDestinationReady(context, receipt, outcome),
    advancePreexistingDestinationReady: (receipt) =>
      advancePreexistingDestinationReady(context, receipt),
    recordRuntimeStageCreateIntent: (receipt) => recordRuntimeStageCreateIntent(context, receipt),
    recordRuntimeStaged: (receipt, outcome, manifest) =>
      recordRuntimeStaged(context, receipt, outcome, manifest),
    recordDestinationBackupCreateIntent: (receipt) =>
      recordDestinationBackupCreateIntent(context, receipt),
    recordDestinationBackedUp: (receipt, outcome) =>
      recordDestinationBackedUp(context, receipt, outcome),
    recordDestinationInstallIntent: (receipt) => recordDestinationInstallIntent(context, receipt),
    recordRuntimeInstalled: (receipt, outcome) => recordRuntimeInstalled(context, receipt, outcome),
    bindAuthoredCommitted: (receipt) => bindAuthoredCommittedReceipt(context, receipt),
    recordSourceRetireIntent: (receipt) => recordSourceRetireIntent(context, receipt),
    recordSourceRetired: (receipt, outcome) => recordSourceRetired(context, receipt, outcome),
    recordAuthorityVerified: (receipt, manifest) =>
      recordAuthorityVerified(context, receipt, manifest),
    sealCommitted: (receipt) => sealRuntimePromotionCommitted(context, receipt),
    beginRollback: (receipt) => beginRuntimePromotionRollback(context, receipt),
    recordRuntimeRollbackIntent: (receipt) => recordRuntimeRollbackIntent(context, receipt),
    recordRuntimeRolledBack: (receipt, outcome) =>
      recordRuntimeRolledBack(context, receipt, outcome),
    recordUnmaterializedAuthoredRolledBack: (receipt) =>
      recordUnmaterializedAuthoredStateRolledBack(context, receipt),
    bindAuthoredRolledBack: (receipt) => bindAuthoredRolledBackReceipt(context, receipt),
    sealRolledBack: (receipt, manifest) =>
      sealRuntimePromotionRolledBack(context, receipt, manifest),
    close: (receipt) => closeRuntimePromotion(context, receipt),
    recordCleanupIntent: (receipt, slot) => recordOwnedCleanupIntent(context, receipt, slot),
    recordCleanupPostcondition: (receipt, slot, outcome) =>
      recordOwnedCleanupPostcondition(context, receipt, slot, outcome),
    unlinkClean: (receipt) => unlinkCleanRuntimePromotion(context, receipt),
  };
  return Object.freeze(writer);
}

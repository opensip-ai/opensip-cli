import { randomUUID } from 'node:crypto';

import {
  mutateRuntimePromotionJournal,
  readRuntimePromotionJournal,
  type AnchoredRecordReadResult,
  type RuntimeExclusiveLease,
  type RuntimeRecoveryRecordMutation,
} from '@opensip-cli/core';

import {
  PromotionJournalCapabilityRegistry,
  type DurableClosedPromotionJournal,
  type DurableOpenPromotionJournal,
  type DurablePromotionJournal,
  type PromotionJournalReceiptExpectation,
  type ReceiptMetadata,
  type RuntimePromotionJournalController,
} from './runtime-promotion-journal-controller-internal.js';
import {
  assertDesiredIdentity,
  isTerminalSeal,
  journalError,
  parseCanonicalRecord,
  recoveryRequired,
} from './runtime-promotion-journal-controller-validation.js';
import {
  assertInitialRuntimePromotionJournal,
  assertRuntimePromotionTransition,
} from './runtime-promotion-journal-machine.js';
import {
  createJournalMutationCoordinator,
  isExactJournalContent,
  sha256,
} from './runtime-promotion-journal-mutation.js';
import {
  canonicalRuntimePromotionJournal,
  encodeRuntimePromotionJournal,
  type RuntimePromotionJournal,
} from './runtime-promotion-journal-schema.js';
import {
  asClosed,
  asOpen,
  assertExpectation,
  hasCompleteOwnedCleanup,
  hasRuntimeStageIntent,
  isIntentTransition,
  isPostconditionTransition,
  isRecoveryOwnerHandoff,
  isRollbackTransition,
} from './runtime-promotion-journal-transition-guards.js';

export type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
  DurablePromotionJournal,
  AuthoredStateMaterializationAuthority,
  AuthoredStateOwnedBasenames,
  PromotionJournalAllocation,
  PromotionJournalIdentity,
  PromotionJournalReceiptExpectation,
  RecoveryOwnerHandoffIdentity,
  RuntimePromotionJournalController,
  RuntimeStageMaterializationAuthority,
  RuntimeStageMaterializationIdentity,
} from './runtime-promotion-journal-controller-internal.js';

export { RUNTIME_PROMOTION_JOURNAL_FILE } from '@opensip-cli/core';
export { handoffRuntimePromotionRecoveryOwner } from './runtime-promotion-journal-handoff.js';

export type RuntimePromotionJournalCheckpoint =
  | 'after-create-mutation'
  | 'after-replace-mutation'
  | 'after-unlink-mutation'
  | 'before-ambiguity-reconciliation'
  | 'after-reconciliation-mutation';

export interface RuntimePromotionJournalControllerDependencies {
  readonly now: () => number;
  readonly generateOperationId: () => string;
  readonly generateRecoveryOwnerToken: () => string;
  readonly read: (lease: RuntimeExclusiveLease) => Promise<AnchoredRecordReadResult>;
  readonly mutate: (
    lease: RuntimeExclusiveLease,
    mutation: RuntimeRecoveryRecordMutation,
  ) => Promise<unknown>;
  readonly checkpoint?: (checkpoint: RuntimePromotionJournalCheckpoint) => void;
}

/**
 * Bind the fixed promotion journal to one exact live writer lease. All durable
 * capabilities issued by this controller are exact objects held only by this
 * controller's private WeakMap.
 *
 * @throws {SystemError} When a controller operation observes stale or foreign journal authority.
 */
export function createRuntimePromotionJournalController(
  lease: RuntimeExclusiveLease,
  dependencyOverrides: Partial<RuntimePromotionJournalControllerDependencies> = {},
): RuntimePromotionJournalController {
  const dependencies: RuntimePromotionJournalControllerDependencies = {
    now: Date.now,
    generateOperationId: randomUUID,
    generateRecoveryOwnerToken: randomUUID,
    read: readRuntimePromotionJournal,
    mutate: mutateRuntimePromotionJournal,
    ...dependencyOverrides,
  };
  const capabilities = new PromotionJournalCapabilityRegistry((message) => journalError(message));

  /** @throws {SystemError} When the durable journal is absent, foreign, or internally inconsistent. */
  async function readCurrent(): Promise<{
    readonly record: RuntimePromotionJournal;
    readonly content: string;
    readonly sha256: string;
  }> {
    const observed = await dependencies.read(lease);
    if (observed.status === 'absent') {
      throw recoveryRequired('The promotion journal is absent.');
    }
    const record = parseCanonicalRecord(observed.content);
    if (record.coordinationKey !== lease.coordinationKey) {
      throw recoveryRequired('The promotion journal belongs to another project key.');
    }
    if (sha256(observed.content) !== observed.sha256) {
      throw recoveryRequired('The promotion journal read digest is inconsistent.');
    }
    return { record, content: observed.content, sha256: observed.sha256 };
  }

  const metadataForReceipt = (receipt: DurablePromotionJournal): ReceiptMetadata =>
    capabilities.receipt(receipt);

  /** @throws {SystemError} When durable journal bytes no longer match the receipt. */
  async function verifyReceipt(
    receipt: DurablePromotionJournal,
    expectation?: PromotionJournalReceiptExpectation,
  ): Promise<RuntimePromotionJournal> {
    const metadata = metadataForReceipt(receipt);
    const current = await readCurrent();
    if (
      current.content !== metadata.content ||
      current.sha256 !== metadata.sha256 ||
      current.record.operationId !== receipt.operationId ||
      current.record.recoveryOwnerToken !== receipt.recoveryOwnerToken ||
      current.record.revision !== receipt.revision ||
      current.record.state !== receipt.state
    ) {
      capabilities.retire(receipt);
      throw recoveryRequired('The promotion journal changed after this receipt was issued.');
    }
    assertExpectation(current.record, expectation, (message) => journalError(message));
    return current.record;
  }

  /** @throws {SystemError} When a journal mutation cannot be verified exactly. */
  async function verifyDesiredAfterMutation(
    desiredContent: string,
  ): Promise<DurablePromotionJournal> {
    let observed: AnchoredRecordReadResult;
    try {
      observed = await dependencies.read(lease);
    } catch (error) {
      throw recoveryRequired('The promotion journal could not be verified after mutation.', error);
    }
    if (!isExactJournalContent(observed, desiredContent)) {
      throw recoveryRequired('The promotion journal mutation has an ambiguous result.');
    }
    const record = parseCanonicalRecord(observed.content);
    if (record.coordinationKey !== lease.coordinationKey) {
      throw recoveryRequired('The promotion journal changed project authority.');
    }
    return capabilities.issueReceipt(record, observed.content, observed.sha256);
  }

  const mutationCoordinator = createJournalMutationCoordinator({
    read: () => dependencies.read(lease),
    mutate: (mutation) => dependencies.mutate(lease, mutation),
    checkpoint: dependencies.checkpoint,
    recoveryRequired,
  });

  const replace = async (
    receipt: DurablePromotionJournal,
    desiredInput: RuntimePromotionJournal,
    preverifiedCurrent?: RuntimePromotionJournal,
  ): Promise<DurablePromotionJournal> => {
    const metadata = metadataForReceipt(receipt);
    const current = await verifyReceipt(receipt);
    if (
      preverifiedCurrent !== undefined &&
      encodeRuntimePromotionJournal(preverifiedCurrent) !== metadata.content
    ) {
      throw recoveryRequired('The preverified promotion journal no longer matches its receipt.');
    }
    const desired = canonicalRuntimePromotionJournal(desiredInput);
    assertDesiredIdentity(current, desired);
    assertRuntimePromotionTransition(current, desired);
    const desiredContent = encodeRuntimePromotionJournal(desired);
    capabilities.retire(receipt);
    const mutation = {
      operation: 'replace',
      content: desiredContent,
      expectedContentSha256: metadata.sha256,
    } as const;
    return mutationCoordinator.mutateContent(
      mutation,
      metadata.content,
      desiredContent,
      verifyDesiredAfterMutation,
    );
  };

  /** @throws {SystemError} When a requested named transition has the wrong shape. */
  function assertNamedTransition(
    current: RuntimePromotionJournal,
    desired: RuntimePromotionJournal,
    predicate: (
      currentRecord: RuntimePromotionJournal,
      desiredRecord: RuntimePromotionJournal,
    ) => boolean,
    name: string,
  ): void {
    if (!predicate(current, desired)) {
      throw journalError(`The requested ${name} transition has the wrong shape.`);
    }
  }

  const namedOpenTransition = async (
    receipt: DurableOpenPromotionJournal,
    desired: RuntimePromotionJournal,
    predicate: (
      currentRecord: RuntimePromotionJournal,
      desiredRecord: RuntimePromotionJournal,
    ) => boolean,
    name: string,
  ): Promise<DurableOpenPromotionJournal> => {
    const current = await verifyReceipt(receipt, { state: 'open' });
    assertNamedTransition(current, desired, predicate, name);
    return asOpen(await replace(receipt, desired, current), (message) => journalError(message));
  };

  const namedClosedTransition = async (
    receipt: DurableClosedPromotionJournal,
    desired: RuntimePromotionJournal,
    predicate: (
      currentRecord: RuntimePromotionJournal,
      desiredRecord: RuntimePromotionJournal,
    ) => boolean,
    name: string,
  ): Promise<DurableClosedPromotionJournal> => {
    const current = await verifyReceipt(receipt, { state: 'closed' });
    assertNamedTransition(current, desired, predicate, name);
    return asClosed(await replace(receipt, desired, current), (message) => journalError(message));
  };

  const controller: RuntimePromotionJournalController = {
    /** @throws {SystemError} When the allocated initial record has invalid identity. */
    allocate: (build) => {
      const identity = Object.freeze({
        operationId: dependencies.generateOperationId(),
        recoveryOwnerToken: dependencies.generateRecoveryOwnerToken(),
        createdAt: dependencies.now(),
      });
      const record = canonicalRuntimePromotionJournal(build(identity));
      assertInitialRuntimePromotionJournal(record);
      if (
        record.coordinationKey !== lease.coordinationKey ||
        record.operationId !== identity.operationId ||
        record.recoveryOwnerToken !== identity.recoveryOwnerToken ||
        record.timestamps.createdAt !== identity.createdAt ||
        record.state !== 'open' ||
        record.progress.phase !== 'prepared'
      ) {
        throw journalError('The initial promotion journal has invalid allocation identity.');
      }
      const content = encodeRuntimePromotionJournal(record);
      return capabilities.allocate(identity, record, content);
    },
    create: async (allocation) => {
      const metadata = capabilities.takeAllocation(allocation);
      const mutation = {
        operation: 'create',
        content: metadata.content,
      } as const;
      const receipt = await mutationCoordinator.mutateContent(
        mutation,
        undefined,
        metadata.content,
        verifyDesiredAfterMutation,
      );
      return asOpen(receipt, (message) => journalError(message));
    },
    /** @throws {SystemError} When the durable journal cannot be claimed for the expected operation. */
    claim: async (expectedOperationId) => {
      const current = await readCurrent();
      if (expectedOperationId !== undefined && current.record.operationId !== expectedOperationId) {
        throw recoveryRequired('The promotion journal operation does not match recovery input.');
      }
      return capabilities.issueReceipt(current.record, current.content, current.sha256);
    },
    verifyOpen: (receipt) => verifyReceipt(receipt, { state: 'open' }),
    verifyReceipt,
    replace,
    /** @throws {SystemError} When recovery-owner handoff identity or transition is invalid. */
    handoffRecoveryOwner: async (receipt, build) => {
      const current = await verifyReceipt(receipt);
      const identity = Object.freeze({
        recoveryOwnerToken: dependencies.generateRecoveryOwnerToken(),
        claimedAt: dependencies.now(),
      });
      const desired = build(current, identity);
      if (
        desired.recoveryOwnerToken !== identity.recoveryOwnerToken ||
        desired.timestamps.updatedAt !== identity.claimedAt
      ) {
        throw journalError('The recovery-owner handoff does not match its controller allocation.');
      }
      assertNamedTransition(current, desired, isRecoveryOwnerHandoff, 'recovery-owner handoff');
      return replace(receipt, desired);
    },
    recordIntent: (receipt, desired) =>
      namedOpenTransition(receipt, desired, isIntentTransition, 'intent'),
    recordPostcondition: (receipt, desired) =>
      namedOpenTransition(receipt, desired, isPostconditionTransition, 'postcondition'),
    beginRollback: (receipt, desired) =>
      namedOpenTransition(receipt, desired, isRollbackTransition, 'rollback'),
    sealCommitted: (receipt, desired) =>
      namedOpenTransition(
        receipt,
        desired,
        (_current, next) => isTerminalSeal(next, 'committed'),
        'committed seal',
      ),
    sealRolledBack: (receipt, desired) =>
      namedOpenTransition(
        receipt,
        desired,
        (_current, next) => isTerminalSeal(next, 'rolled-back'),
        'rolled-back seal',
      ),
    close: async (receipt, desired) => {
      const current = await verifyReceipt(receipt, { state: 'open' });
      assertNamedTransition(
        current,
        desired,
        (_previous, next) => next.state === 'closed',
        'close',
      );
      return asClosed(await replace(receipt, desired), (message) => journalError(message));
    },
    recordCleanupIntent: (receipt, desired) =>
      namedClosedTransition(receipt, desired, isIntentTransition, 'cleanup intent'),
    recordCleanupPostcondition: (receipt, desired) =>
      namedClosedTransition(receipt, desired, isPostconditionTransition, 'cleanup postcondition'),
    /** @throws {SystemError} When owned cleanup is incomplete or the closed journal cannot be unlinked. */
    unlinkClosed: async (receipt) => {
      const metadata = metadataForReceipt(receipt);
      const record = await verifyReceipt(receipt, { state: 'closed' });
      if (!hasCompleteOwnedCleanup(record)) {
        throw journalError('The closed promotion journal still has owned cleanup work.');
      }
      capabilities.retire(receipt);
      const mutation = {
        operation: 'unlink',
        expectedContentSha256: metadata.sha256,
      } as const;
      await mutationCoordinator.unlinkClosed(mutation, metadata.content);
    },
    /** @throws {SystemError} When no exact durable runtime-stage creation intent exists. */
    authorizeRuntimeStage: async (receipt, stageBasename) => {
      const record = await verifyReceipt(receipt, {
        state: 'open',
        ownedSlot: { name: 'runtimeStage', basename: stageBasename },
      });
      if (!hasRuntimeStageIntent(record)) {
        throw journalError('Runtime-stage materialization requires a durable creation intent.');
      }
      return capabilities.issueRuntimeStageAuthority(receipt, record, stageBasename);
    },
    assertRuntimeStageAuthority: (authority, stageBasename) =>
      capabilities.consumeRuntimeStageAuthority(authority, stageBasename),
    /** @throws {SystemError} When the candidate is not the controller-bound writer lease. */
    assertBoundLease: (candidate) => {
      if (candidate !== lease) {
        throw journalError('The promotion-journal controller is bound to another writer lease.');
      }
    },
    /** @throws {SystemError} When durable authored-state materialization authority is absent. */
    authorizeAuthoredState: async (receipt, candidate) => {
      if (candidate !== lease) {
        throw journalError('Authored-state materialization requires the controller-bound lease.');
      }
      const record = await verifyReceipt(receipt, { state: 'open' });
      const pending = record.progress.pendingIntent;
      if (
        record.progress.direction !== 'forward' ||
        pending?.kind !== 'authored-prepare' ||
        pending.slot !== 'authoredStage' ||
        pending.cursor !== null ||
        record.cleanup.authoredStage !== 'unmaterialized' ||
        record.cleanup.authoredBackup !== 'unmaterialized' ||
        record.cleanup.replayManifest !== 'unmaterialized'
      ) {
        throw journalError(
          'Authored-state materialization requires its exact durable preparation intent.',
        );
      }
      return capabilities.issueAuthoredStateAuthority(receipt, record);
    },
    assertAuthoredStateAuthority: (authority, basenames) =>
      capabilities.consumeAuthoredStateAuthority(authority, basenames),
  };
  return Object.freeze(controller);
}

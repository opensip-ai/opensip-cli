import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';
import type { RuntimeExclusiveLease } from '@opensip-cli/core';

declare const ALLOCATION_BRAND: unique symbol;
declare const OPEN_RECEIPT_BRAND: unique symbol;
declare const CLOSED_RECEIPT_BRAND: unique symbol;
declare const RUNTIME_STAGE_AUTHORITY_BRAND: unique symbol;
declare const AUTHORED_STATE_AUTHORITY_BRAND: unique symbol;

export interface PromotionJournalIdentity {
  readonly operationId: string;
  readonly recoveryOwnerToken: string;
  readonly createdAt: number;
}

export interface RecoveryOwnerHandoffIdentity {
  readonly recoveryOwnerToken: string;
  readonly claimedAt: number;
}

/** An in-memory allocation is not proof that the journal is durable. */
export interface PromotionJournalAllocation extends PromotionJournalIdentity {
  readonly [ALLOCATION_BRAND]: never;
}

interface DurablePromotionJournalReceipt extends PromotionJournalIdentity {
  readonly coordinationKey: string;
  readonly revision: number;
  readonly sha256: string;
}

/** Exact-object proof that a matching open journal was durably observed. */
export interface DurableOpenPromotionJournal extends DurablePromotionJournalReceipt {
  readonly state: 'open';
  readonly [OPEN_RECEIPT_BRAND]: never;
}

/** Exact-object proof that a matching closed journal was durably observed. */
export interface DurableClosedPromotionJournal extends DurablePromotionJournalReceipt {
  readonly state: 'closed';
  readonly [CLOSED_RECEIPT_BRAND]: never;
}

export type DurablePromotionJournal = DurableOpenPromotionJournal | DurableClosedPromotionJournal;

/**
 * Path-neutral, exact-object authority for Task 3.2 stage materialization.
 * It is useful only with the controller instance that issued it.
 */
export interface RuntimeStageMaterializationAuthority {
  readonly coordinationKey: string;
  readonly operationId: string;
  readonly revision: number;
  readonly stageBasename: string;
  readonly ownershipId: string;
  readonly [RUNTIME_STAGE_AUTHORITY_BRAND]: never;
}

export interface RuntimeStageMaterializationIdentity {
  readonly operationId: string;
  readonly stageBasename: string;
  readonly ownershipId: string;
}

export interface AuthoredStateMaterializationAuthority {
  readonly coordinationKey: string;
  readonly operationId: string;
  readonly revision: number;
  readonly [AUTHORED_STATE_AUTHORITY_BRAND]: never;
}

export interface AuthoredStateOwnedBasenames {
  readonly authoredStage: string;
  readonly authoredBackup: string;
  readonly replayManifest: string;
}

export interface PromotionJournalReceiptExpectation {
  readonly state?: 'open' | 'closed';
  readonly allowedPhases?: readonly RuntimePromotionJournal['progress']['phase'][];
  readonly ownedSlot?: {
    readonly name: keyof RuntimePromotionJournal['owned'];
    readonly basename: string;
  };
}

type OpenJournalTransition = (
  receipt: DurableOpenPromotionJournal,
  desired: RuntimePromotionJournal,
) => Promise<DurableOpenPromotionJournal>;

type ClosedJournalTransition = (
  receipt: DurableClosedPromotionJournal,
  desired: RuntimePromotionJournal,
) => Promise<DurableClosedPromotionJournal>;

export interface RuntimePromotionJournalController {
  readonly allocate: (
    build: (identity: PromotionJournalIdentity) => RuntimePromotionJournal,
  ) => PromotionJournalAllocation;
  readonly create: (allocation: PromotionJournalAllocation) => Promise<DurableOpenPromotionJournal>;
  readonly claim: (expectedOperationId?: string) => Promise<DurablePromotionJournal>;
  readonly verifyOpen: (receipt: DurableOpenPromotionJournal) => Promise<RuntimePromotionJournal>;
  readonly verifyReceipt: (
    receipt: DurablePromotionJournal,
    expectation?: PromotionJournalReceiptExpectation,
  ) => Promise<RuntimePromotionJournal>;
  readonly replace: (
    receipt: DurablePromotionJournal,
    desired: RuntimePromotionJournal,
  ) => Promise<DurablePromotionJournal>;
  readonly handoffRecoveryOwner: (
    receipt: DurablePromotionJournal,
    build: (
      current: RuntimePromotionJournal,
      identity: RecoveryOwnerHandoffIdentity,
    ) => RuntimePromotionJournal,
  ) => Promise<DurablePromotionJournal>;
  readonly recordIntent: OpenJournalTransition;
  readonly recordPostcondition: OpenJournalTransition;
  readonly beginRollback: OpenJournalTransition;
  readonly sealCommitted: OpenJournalTransition;
  readonly sealRolledBack: OpenJournalTransition;
  readonly close: (
    receipt: DurableOpenPromotionJournal,
    desired: RuntimePromotionJournal,
  ) => Promise<DurableClosedPromotionJournal>;
  readonly recordCleanupIntent: ClosedJournalTransition;
  readonly recordCleanupPostcondition: ClosedJournalTransition;
  readonly unlinkClosed: (receipt: DurableClosedPromotionJournal) => Promise<void>;
  readonly authorizeRuntimeStage: (
    receipt: DurableOpenPromotionJournal,
    stageBasename: string,
  ) => Promise<RuntimeStageMaterializationAuthority>;
  readonly assertRuntimeStageAuthority: (
    authority: RuntimeStageMaterializationAuthority,
    stageBasename: string,
  ) => RuntimeStageMaterializationIdentity;
  readonly assertBoundLease: (lease: RuntimeExclusiveLease) => void;
  readonly authorizeAuthoredState: (
    receipt: DurableOpenPromotionJournal,
    lease: RuntimeExclusiveLease,
  ) => Promise<AuthoredStateMaterializationAuthority>;
  readonly assertAuthoredStateAuthority: (
    authority: AuthoredStateMaterializationAuthority,
    basenames: AuthoredStateOwnedBasenames,
  ) => void;
}

export interface AllocationMetadata {
  readonly kind: 'allocation';
  readonly record: RuntimePromotionJournal;
  readonly content: string;
}

export interface ReceiptMetadata {
  readonly kind: 'receipt';
  readonly record: RuntimePromotionJournal;
  readonly content: string;
  readonly sha256: string;
}

interface RuntimeStageAuthorityMetadata {
  readonly kind: 'runtime-stage-authority';
  readonly receipt: DurableOpenPromotionJournal;
  readonly identity: RuntimeStageMaterializationIdentity;
}

interface AuthoredStateAuthorityMetadata {
  readonly kind: 'authored-state-authority';
  readonly receipt: DurableOpenPromotionJournal;
  readonly basenames: AuthoredStateOwnedBasenames;
}

type CapabilityMetadata =
  | AllocationMetadata
  | ReceiptMetadata
  | RuntimeStageAuthorityMetadata
  | AuthoredStateAuthorityMetadata;

type JournalErrorFactory = (message: string) => Error;

export class PromotionJournalCapabilityRegistry {
  readonly #capabilities = new WeakMap<object, CapabilityMetadata>();
  readonly #journalError: JournalErrorFactory;
  #currentAllocation: PromotionJournalAllocation | undefined;
  #currentReceipt: DurablePromotionJournal | undefined;

  constructor(journalError: JournalErrorFactory) {
    this.#journalError = journalError;
  }

  allocate(
    identity: PromotionJournalIdentity,
    record: RuntimePromotionJournal,
    content: string,
  ): PromotionJournalAllocation {
    const allocation = Object.freeze(identity) as PromotionJournalAllocation;
    if (this.#currentAllocation !== undefined) {
      this.#capabilities.delete(this.#currentAllocation);
    }
    this.#capabilities.set(allocation, { kind: 'allocation', record, content });
    this.#currentAllocation = allocation;
    return allocation;
  }

  /** @throws {Error} When the allocation capability is stale or foreign. */
  takeAllocation(allocation: PromotionJournalAllocation): AllocationMetadata {
    const metadata = this.#capabilities.get(allocation);
    if (metadata?.kind !== 'allocation') {
      throw this.#journalError('The promotion-journal allocation is stale or foreign.');
    }
    this.#capabilities.delete(allocation);
    if (this.#currentAllocation === allocation) {
      this.#currentAllocation = undefined;
    }
    return metadata;
  }

  issueReceipt(
    record: RuntimePromotionJournal,
    content: string,
    sha256: string,
  ): DurablePromotionJournal {
    if (this.#currentReceipt !== undefined) {
      this.#capabilities.delete(this.#currentReceipt);
    }
    const receipt = Object.freeze({
      operationId: record.operationId,
      recoveryOwnerToken: record.recoveryOwnerToken,
      createdAt: record.timestamps.createdAt,
      coordinationKey: record.coordinationKey,
      revision: record.revision,
      sha256,
      state: record.state,
    }) as DurablePromotionJournal;
    this.#capabilities.set(receipt, {
      kind: 'receipt',
      record,
      content,
      sha256,
    });
    this.#currentReceipt = receipt;
    return receipt;
  }

  /** @throws {Error} When the receipt capability is stale, foreign, or altered. */
  receipt(receipt: DurablePromotionJournal): ReceiptMetadata {
    const metadata = this.#capabilities.get(receipt);
    if (metadata?.kind !== 'receipt') {
      throw this.#journalError('The promotion-journal receipt is stale or foreign.');
    }
    if (
      receipt.operationId !== metadata.record.operationId ||
      receipt.recoveryOwnerToken !== metadata.record.recoveryOwnerToken ||
      receipt.coordinationKey !== metadata.record.coordinationKey ||
      receipt.revision !== metadata.record.revision ||
      receipt.state !== metadata.record.state ||
      receipt.sha256 !== metadata.sha256
    ) {
      throw this.#journalError('The promotion-journal receipt projection was altered.');
    }
    return metadata;
  }

  retire(receipt: DurablePromotionJournal): void {
    this.#capabilities.delete(receipt);
    if (this.#currentReceipt === receipt) {
      this.#currentReceipt = undefined;
    }
  }

  issueRuntimeStageAuthority(
    receipt: DurableOpenPromotionJournal,
    record: RuntimePromotionJournal,
    stageBasename: string,
  ): RuntimeStageMaterializationAuthority {
    const identity = Object.freeze({
      operationId: record.operationId,
      stageBasename,
      ownershipId: record.owned.runtimeStage.ownershipId,
    });
    const authority = Object.freeze({
      coordinationKey: record.coordinationKey,
      operationId: record.operationId,
      revision: record.revision,
      stageBasename,
      ownershipId: identity.ownershipId,
    }) as RuntimeStageMaterializationAuthority;
    this.#capabilities.set(authority, {
      kind: 'runtime-stage-authority',
      receipt,
      identity,
    });
    return authority;
  }

  /** @throws {Error} When runtime-stage materialization authority is stale or foreign. */
  consumeRuntimeStageAuthority(
    authority: RuntimeStageMaterializationAuthority,
    stageBasename: string,
  ): RuntimeStageMaterializationIdentity {
    const metadata = this.#capabilities.get(authority);
    if (
      metadata?.kind !== 'runtime-stage-authority' ||
      metadata.identity.stageBasename !== stageBasename ||
      authority.coordinationKey !== metadata.receipt.coordinationKey ||
      authority.operationId !== metadata.identity.operationId ||
      authority.revision !== metadata.receipt.revision ||
      authority.stageBasename !== metadata.identity.stageBasename ||
      authority.ownershipId !== metadata.identity.ownershipId ||
      this.#capabilities.get(metadata.receipt)?.kind !== 'receipt'
    ) {
      throw this.#journalError('The runtime-stage authority is stale or foreign.');
    }
    this.#capabilities.delete(authority);
    return metadata.identity;
  }

  issueAuthoredStateAuthority(
    receipt: DurableOpenPromotionJournal,
    record: RuntimePromotionJournal,
  ): AuthoredStateMaterializationAuthority {
    const authority = Object.freeze({
      coordinationKey: record.coordinationKey,
      operationId: record.operationId,
      revision: record.revision,
    }) as AuthoredStateMaterializationAuthority;
    this.#capabilities.set(authority, {
      kind: 'authored-state-authority',
      receipt,
      basenames: {
        authoredStage: record.owned.authoredStage.basename,
        authoredBackup: record.owned.authoredBackup.basename,
        replayManifest: record.owned.replayManifest.basename,
      },
    });
    return authority;
  }

  /** @throws {Error} When authored-state materialization authority is stale or foreign. */
  consumeAuthoredStateAuthority(
    authority: AuthoredStateMaterializationAuthority,
    basenames: AuthoredStateOwnedBasenames,
  ): void {
    const metadata = this.#capabilities.get(authority);
    if (
      metadata?.kind !== 'authored-state-authority' ||
      metadata.basenames.authoredStage !== basenames.authoredStage ||
      metadata.basenames.authoredBackup !== basenames.authoredBackup ||
      metadata.basenames.replayManifest !== basenames.replayManifest ||
      this.#capabilities.get(metadata.receipt)?.kind !== 'receipt'
    ) {
      throw this.#journalError('The authored-state authority is stale or foreign.');
    }
    this.#capabilities.delete(authority);
  }
}

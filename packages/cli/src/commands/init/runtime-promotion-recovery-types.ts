import type {
  AuthoredStateSummary,
  InitAuthoredTransaction,
} from './authored-state-transaction.js';
import type { InitAuthoredMode } from './init-authored-plan.js';
import type { VerifiedRuntimeManifest } from './runtime-manifest.js';
import type {
  RuntimePromotionFilesystemAuthority,
  RuntimePromotionBackupResult,
  RuntimePromotionDestinationParentResult,
  RuntimePromotionInstallResult,
  RuntimePromotionOwnedCleanupResult,
  RuntimePromotionPathClassification,
  RuntimePromotionRetireResult,
  RuntimePromotionRollbackInput,
  RuntimePromotionRollbackResult,
  RuntimePromotionStageReconcileResult,
} from './runtime-promotion-filesystem.js';
import type {
  RuntimePromotionConflictPolicy,
  RuntimePromotionJournal,
  RuntimePromotionLanguage,
  RuntimePromotionSource,
} from './runtime-promotion-journal-schema.js';
import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
  DurablePromotionJournal,
  RuntimePromotionJournalController,
} from './runtime-promotion-journal.js';
import type { RuntimePromotionDatastoreIdentity } from './runtime-promotion-preflight-datastore-types.js';
import type { RuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';
import type { RuntimePromotionTransitionWriter } from './runtime-promotion-transitions.js';
import type { RecoveryHeaderInspection, RuntimeExclusiveLease } from '@opensip-cli/core';
import type { DataStoreLockContext } from '@opensip-cli/datastore';

export interface RuntimePromotionRecoveryExplicitInputs {
  /** Present only when this retry supplied `--language`. */
  readonly languages?: readonly RuntimePromotionLanguage[];
  /** Present only when this retry supplied `--keep` or `--remove`. */
  readonly authoredMode?: Extract<InitAuthoredMode, 'keep' | 'remove'>;
  /** Present only when this retry supplied `--runtime-conflict`. */
  readonly conflict?: RuntimePromotionConflictPolicy;
}

export interface RecoverRuntimePromotionInput {
  /** Canonical project root chosen by bootstrap; aliases are rejected. */
  readonly projectRoot: string;
  readonly datastoreLockContext: DataStoreLockContext;
  readonly explicit?: RuntimePromotionRecoveryExplicitInputs;
}

export type RuntimePromotionRecoveryCheckpoint =
  | 'after-header-inspection'
  | 'after-lease-acquired'
  | 'after-journal-claimed'
  | 'after-owner-handoff'
  | 'after-root-authority-captured'
  | 'after-datastore-checkpoint'
  | 'after-open-intent-reconciled'
  | 'after-open-transition'
  | 'after-terminal-close'
  | 'after-closed-cleanup-transition'
  | 'before-journal-unlink'
  | 'after-journal-unlink';

export interface RuntimePromotionRecoveryDependencies {
  readonly now: () => number;
  readonly checkpoint?: (checkpoint: RuntimePromotionRecoveryCheckpoint) => void;
  /** Attempt-local observer for validated durable inputs; never serialized or rendered directly. */
  readonly onJournal?: (journal: RuntimePromotionJournal) => void;
  readonly canonicalizeProjectRoot: (projectRoot: string) => string;
  readonly inspectHeader: (projectRoot: string) => RecoveryHeaderInspection;
  readonly acquireLease: (input: {
    readonly projectDir: string;
    readonly posture: 'init-recovery';
    readonly recoveryOperationId: string;
    readonly command: string;
    readonly cwdBasename: string;
  }) => Promise<RuntimeExclusiveLease>;
  readonly ephemeralProjectsDir: () => string;
  readonly assertSourceAuthority: (input: {
    readonly projectRoot: string;
    readonly sourceRuntime: string;
    readonly source: RuntimePromotionSource;
    readonly lease: RuntimeExclusiveLease;
  }) => void;
  readonly assertSourceLocation: (input: {
    readonly projectRoot: string;
    readonly sourceRuntime: string;
    readonly source: RuntimePromotionSource;
    readonly lease: RuntimeExclusiveLease;
  }) => void;
  readonly checkpointDatastores: (input: {
    readonly candidates: readonly (
      | { readonly kind: 'source'; readonly runtimeDir: string }
      | { readonly kind: 'destination'; readonly runtimeDir: string }
    )[];
    readonly lockContext: DataStoreLockContext;
    readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
    readonly lease: RuntimeExclusiveLease;
    readonly controller: RuntimePromotionJournalController;
    readonly receipt: DurableOpenPromotionJournal;
  }) =>
    | readonly RuntimePromotionDatastoreIdentity[]
    | Promise<readonly RuntimePromotionDatastoreIdentity[]>;
  readonly createController: (lease: RuntimeExclusiveLease) => RuntimePromotionJournalController;
  readonly createWriter: (
    controller: RuntimePromotionJournalController,
  ) => RuntimePromotionTransitionWriter;
  readonly captureProjectRootAuthority: (input: {
    readonly lease: RuntimeExclusiveLease;
    readonly projectRoot: string;
    readonly destinationParentPreexisting: boolean;
  }) => RuntimePromotionProjectRootAuthority;
  readonly assertProjectRootAuthority: (input: {
    readonly lease: RuntimeExclusiveLease;
    readonly authority: RuntimePromotionProjectRootAuthority;
  }) => void;
  readonly assertDestinationRootAuthority: (input: {
    readonly runtimeDir: string;
    readonly journal: RuntimePromotionJournal;
  }) => void;
  readonly inspectManifest: (
    runtimeDir: string,
    posture: 'cache-source' | 'project-runtime',
  ) => VerifiedRuntimeManifest;
  readonly classifyPath: (path: string) => RuntimePromotionPathClassification;
  readonly copyStage: (input: {
    readonly controller: RuntimePromotionJournalController;
    readonly receipt: DurableOpenPromotionJournal;
    readonly sourceDir: string;
    readonly sourcePosture: 'cache-source';
    readonly destinationParent: string;
    readonly stageBasename: string;
    readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
    readonly lease: RuntimeExclusiveLease;
  }) => Promise<{
    readonly stage: VerifiedRuntimeManifest;
  }>;
  readonly loadAuthored: (input: {
    readonly projectRoot: string;
    readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
    readonly lease: RuntimeExclusiveLease;
    readonly controller: RuntimePromotionJournalController;
    readonly receipt: DurableOpenPromotionJournal;
  }) => Promise<{
    readonly transaction: InitAuthoredTransaction;
    readonly receipt: DurableOpenPromotionJournal;
    readonly summary: AuthoredStateSummary;
  }>;
  readonly abortAuthoredPreparation: (input: {
    readonly projectRoot: string;
    readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
    readonly lease: RuntimeExclusiveLease;
    readonly controller: RuntimePromotionJournalController;
    readonly receipt: DurableOpenPromotionJournal;
  }) => Promise<{
    readonly transaction: InitAuthoredTransaction;
    readonly receipt: DurableOpenPromotionJournal;
    readonly summary: AuthoredStateSummary;
  }>;
  readonly bindAuthoredReceipt: (
    transaction: InitAuthoredTransaction,
    receipt: DurableOpenPromotionJournal,
  ) => Promise<void>;
  readonly commitAuthored: (transaction: InitAuthoredTransaction) => Promise<{
    readonly receipt: DurableOpenPromotionJournal;
    readonly summary: AuthoredStateSummary;
  }>;
  readonly rollbackAuthored: (transaction: InitAuthoredTransaction) => Promise<{
    readonly receipt: DurableOpenPromotionJournal;
    readonly summary: AuthoredStateSummary;
  }>;
  readonly verifyAuthored: (
    transaction: InitAuthoredTransaction,
    expected: 'desired' | 'preimage',
  ) => Promise<AuthoredStateSummary>;
  readonly loadClosedAuthored: (input: {
    readonly projectRoot: string;
    readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
    readonly lease: RuntimeExclusiveLease;
    readonly controller: RuntimePromotionJournalController;
    readonly receipt: DurableClosedPromotionJournal;
  }) => Promise<InitAuthoredTransaction>;
  readonly cleanupAuthored: (
    transaction: InitAuthoredTransaction,
    receipt: DurableClosedPromotionJournal,
  ) => Promise<{
    readonly receipt: DurableClosedPromotionJournal;
    readonly summary: AuthoredStateSummary;
  }>;
  readonly authorizeFilesystem: (input: {
    readonly action:
      | 'destination-parent-create'
      | 'runtime-stage-reconcile'
      | 'destination-backup-create'
      | 'destination-install'
      | 'source-retire'
      | 'runtime-rollback'
      | 'owned-slot-cleanup';
    readonly projectRoot: string;
    readonly sourceRuntime?: string;
    readonly controller: RuntimePromotionJournalController;
    readonly lease: RuntimeExclusiveLease;
    readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
    readonly receipt: DurablePromotionJournal;
    readonly cleanupSlot?: keyof RuntimePromotionJournal['cleanup'];
  }) => Promise<RuntimePromotionFilesystemAuthority>;
  readonly createDestinationParent: (
    authority: RuntimePromotionFilesystemAuthority,
  ) => Promise<RuntimePromotionDestinationParentResult>;
  readonly reconcileStage: (
    authority: RuntimePromotionFilesystemAuthority,
    input: { readonly expected: VerifiedRuntimeManifest },
  ) => Promise<RuntimePromotionStageReconcileResult>;
  readonly backupDestination: (
    authority: RuntimePromotionFilesystemAuthority,
    expected: NonNullable<RuntimePromotionJournal['manifests']['destination']>,
  ) => Promise<RuntimePromotionBackupResult>;
  readonly installStage: (
    authority: RuntimePromotionFilesystemAuthority,
    expected: NonNullable<RuntimePromotionJournal['manifests']['runtimeStage']>,
  ) => Promise<RuntimePromotionInstallResult>;
  readonly retireSource: (
    authority: RuntimePromotionFilesystemAuthority,
    expected: NonNullable<RuntimePromotionJournal['manifests']['source']>,
  ) => Promise<RuntimePromotionRetireResult>;
  readonly rollbackRuntime: (
    authority: RuntimePromotionFilesystemAuthority,
    input: RuntimePromotionRollbackInput,
  ) => Promise<RuntimePromotionRollbackResult>;
  readonly cleanupOwnedSlot: (
    authority: RuntimePromotionFilesystemAuthority,
  ) => Promise<RuntimePromotionOwnedCleanupResult>;
}

export interface RuntimePromotionRecoveryOperation {
  readonly input: Readonly<{
    projectRoot: string;
    datastoreLockContext: DataStoreLockContext;
  }>;
  readonly dependencies: RuntimePromotionRecoveryDependencies;
  readonly startedAt: number;
  readonly lease: RuntimeExclusiveLease;
  readonly controller: RuntimePromotionJournalController;
  readonly writer: RuntimePromotionTransitionWriter;
  readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
  readonly sourceRuntime?: string;
  receipt: DurablePromotionJournal;
  journal: RuntimePromotionJournal;
  transaction: InitAuthoredTransaction | null;
  authoredSummary: AuthoredStateSummary | null;
  journalUnlinked: boolean;
}

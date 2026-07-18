import type { ToolScaffold } from '../shared.js';
import type {
  AuthoredStateCleanupResult,
  AuthoredStateSummary,
  AuthoredStateTransitionResult,
  InitAuthoredTransaction,
  LoadClosedAuthoredStateInput,
  PreparedAuthoredState,
} from './authored-state-transaction.js';
import type { InitAuthoredMode, InitAuthoredPlan } from './init-authored-plan.js';
import type {
  RuntimeTreePosture,
  VerifiedRuntimeManifest,
  VerifiedRuntimeStage,
} from './runtime-manifest.js';
import type {
  RuntimePromotionFilesystemAction,
  RuntimePromotionFilesystemAuthority,
  RuntimePromotionOwnedCleanupResult,
  RuntimePromotionRetireResult,
  RuntimePromotionRollbackInput,
  RuntimePromotionRollbackResult,
  RuntimePromotionStageReconcileResult,
} from './runtime-promotion-filesystem-types.js';
import type {
  RuntimeManifestIdentity,
  RuntimePromotionConflictPolicy,
  RuntimePromotionLanguage,
  RuntimePromotionOwnedSlotName,
} from './runtime-promotion-journal-schema.js';
import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
  RuntimePromotionJournalController,
} from './runtime-promotion-journal.js';
import type {
  RuntimePromotionDatastoreCandidate,
  RuntimePromotionDatastoreIdentity,
} from './runtime-promotion-preflight-datastore-types.js';
import type {
  RuntimePromotionPreflightResult,
  RuntimePromotionPreflightSelected,
  RuntimePromotionSourceRetirementProof,
} from './runtime-promotion-preflight-types.js';
import type { RuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';
import type { RuntimePromotionTransitionWriter } from './runtime-promotion-transitions.js';
import type { RuntimeAdoptionResult } from '@opensip-cli/contracts';
import type { RuntimeExclusiveLease } from '@opensip-cli/core';
import type { DataStoreLockContext } from '@opensip-cli/datastore';

export interface FreshRuntimePromotionInput {
  readonly projectRoot: string;
  readonly languages: readonly RuntimePromotionLanguage[];
  readonly languageExplicit: boolean;
  readonly authoredMode: InitAuthoredMode;
  readonly toolScaffolds: readonly ToolScaffold[];
  readonly datastoreLockContext: DataStoreLockContext;
  readonly conflict?: RuntimePromotionConflictPolicy;
}

export type RuntimePromotionCheckpoint =
  | 'after-lease-acquired'
  | 'after-preflight'
  | 'after-authored-plan'
  | 'after-journal-created'
  | 'after-datastore-checkpoint'
  | 'after-source-verified'
  | 'after-destination-verified'
  | 'after-authored-prepared'
  | 'after-destination-ready'
  | 'after-runtime-staged'
  | 'after-destination-backed-up'
  | 'after-runtime-installed'
  | 'after-authored-committed'
  | 'after-authored-verified'
  | 'after-source-retired'
  | 'after-authority-verified'
  | 'after-terminal-sealed'
  | 'after-journal-closed'
  | 'after-cleanup';

interface RuntimePromotionFilesystemAuthorityInput {
  readonly action: RuntimePromotionFilesystemAction;
  readonly projectRoot: string;
  readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
  readonly sourceRuntime?: string;
  readonly controller: RuntimePromotionJournalController;
  readonly lease: RuntimeExclusiveLease;
  readonly receipt: DurableOpenPromotionJournal | DurableClosedPromotionJournal;
  readonly cleanupSlot?: RuntimePromotionOwnedSlotName;
}

export interface RuntimePromotionDependencies {
  readonly now: () => number;
  readonly checkpoint?: (checkpoint: RuntimePromotionCheckpoint) => void;
  readonly acquireLease: (input: {
    readonly projectDir: string;
    readonly posture: 'normal';
    readonly command: string;
    readonly cwdBasename: string;
  }) => Promise<RuntimeExclusiveLease>;
  readonly preflight: (input: {
    readonly projectRoot: string;
    readonly lease: RuntimeExclusiveLease;
    readonly conflict?: RuntimePromotionConflictPolicy;
  }) => RuntimePromotionPreflightResult;
  readonly assertPreflightUnchanged: (input: {
    readonly lease: RuntimeExclusiveLease;
    readonly token: RuntimePromotionPreflightSelected['revalidation'];
  }) => void;
  readonly bindProjectRootAuthority: (input: {
    readonly lease: RuntimeExclusiveLease;
    readonly token: RuntimePromotionPreflightSelected['revalidation'];
  }) => RuntimePromotionProjectRootAuthority;
  readonly assertProjectRootAuthority: (input: {
    readonly lease: RuntimeExclusiveLease;
    readonly authority: RuntimePromotionProjectRootAuthority;
  }) => void;
  readonly checkpointDatastores: (input: {
    readonly candidates: readonly RuntimePromotionDatastoreCandidate[];
    readonly lockContext: DataStoreLockContext;
    readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
    readonly lease: RuntimeExclusiveLease;
    readonly controller: RuntimePromotionJournalController;
    readonly receipt: DurableOpenPromotionJournal;
  }) =>
    | readonly RuntimePromotionDatastoreIdentity[]
    | Promise<readonly RuntimePromotionDatastoreIdentity[]>;
  readonly createPlan: (input: {
    readonly projectRoot: string;
    readonly languages: readonly RuntimePromotionLanguage[];
    readonly mode: InitAuthoredMode;
    readonly toolScaffolds: readonly ToolScaffold[];
  }) => InitAuthoredPlan;
  readonly createController: (lease: RuntimeExclusiveLease) => RuntimePromotionJournalController;
  readonly createWriter: (
    controller: RuntimePromotionJournalController,
  ) => RuntimePromotionTransitionWriter;
  readonly inspectManifest: (
    runtimeDir: string,
    posture: Exclude<RuntimeTreePosture, 'promotion-stage'>,
  ) => VerifiedRuntimeManifest;
  readonly copyStage: (input: {
    readonly controller: RuntimePromotionJournalController;
    readonly receipt: DurableOpenPromotionJournal;
    readonly sourceDir: string;
    readonly sourcePosture: 'cache-source';
    readonly destinationParent: string;
    readonly stageBasename: string;
    readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
    readonly lease: RuntimeExclusiveLease;
  }) => Promise<VerifiedRuntimeStage>;
  readonly prepareAuthored: (input: {
    readonly projectRoot: string;
    readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
    readonly lease: RuntimeExclusiveLease;
    readonly controller: RuntimePromotionJournalController;
    readonly receipt: DurableOpenPromotionJournal;
    readonly plan: InitAuthoredPlan;
  }) => Promise<PreparedAuthoredState>;
  readonly bindAuthoredReceipt: (
    transaction: InitAuthoredTransaction,
    receipt: DurableOpenPromotionJournal,
  ) => Promise<void>;
  readonly loadClosedAuthored: (
    input: LoadClosedAuthoredStateInput,
  ) => Promise<InitAuthoredTransaction>;
  readonly commitAuthored: (
    transaction: InitAuthoredTransaction,
  ) => Promise<AuthoredStateTransitionResult>;
  readonly rollbackAuthored: (
    transaction: InitAuthoredTransaction,
  ) => Promise<AuthoredStateTransitionResult>;
  readonly verifyAuthored: (
    transaction: InitAuthoredTransaction,
    expected: 'desired' | 'preimage',
  ) => Promise<AuthoredStateSummary>;
  readonly cleanupAuthored: (
    transaction: InitAuthoredTransaction,
    receipt: DurableClosedPromotionJournal,
  ) => Promise<AuthoredStateCleanupResult>;
  readonly authorizeFilesystem: (
    input: RuntimePromotionFilesystemAuthorityInput,
  ) => Promise<RuntimePromotionFilesystemAuthority>;
  readonly createDestinationParent: (
    authority: RuntimePromotionFilesystemAuthority,
  ) => Promise<{ readonly status: 'created' | 'already-created' }>;
  readonly reconcileStage: (
    authority: RuntimePromotionFilesystemAuthority,
    input: { readonly expected: VerifiedRuntimeManifest },
  ) => Promise<RuntimePromotionStageReconcileResult>;
  readonly backupDestination: (
    authority: RuntimePromotionFilesystemAuthority,
    expected: RuntimeManifestIdentity,
  ) => Promise<{ readonly status: 'applied' | 'already-applied' }>;
  readonly installStage: (
    authority: RuntimePromotionFilesystemAuthority,
    expected: RuntimeManifestIdentity,
  ) => Promise<{ readonly status: 'applied' | 'already-applied' }>;
  readonly refreshSourceRetirementProof: (input: {
    readonly lease: RuntimeExclusiveLease;
    readonly preflight: RuntimePromotionPreflightSelected;
    readonly verifiedSource: RuntimeManifestIdentity;
  }) => RuntimePromotionSourceRetirementProof;
  readonly assertSourceRetirementUnchanged: (input: {
    readonly lease: RuntimeExclusiveLease;
    readonly proof: RuntimePromotionSourceRetirementProof;
  }) => void;
  readonly retireSource: (
    authority: RuntimePromotionFilesystemAuthority,
    expected: RuntimeManifestIdentity,
  ) => Promise<RuntimePromotionRetireResult>;
  readonly rollbackRuntime: (
    authority: RuntimePromotionFilesystemAuthority,
    input: RuntimePromotionRollbackInput,
  ) => Promise<RuntimePromotionRollbackResult>;
  readonly cleanupOwnedSlot: (
    authority: RuntimePromotionFilesystemAuthority,
  ) => Promise<RuntimePromotionOwnedCleanupResult>;
}

export interface RuntimePromotionOperation {
  readonly input: FreshRuntimePromotionInput;
  readonly dependencies: RuntimePromotionDependencies;
  readonly startedAt: number;
  readonly lease: RuntimeExclusiveLease;
  /** Attempt-local only; false leaves the process-owned lease record in place. */
  readonly leaseDisposition: { releaseSafe: boolean };
  readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
  readonly preflight: RuntimePromotionPreflightSelected;
  readonly plan: InitAuthoredPlan;
  readonly controller: RuntimePromotionJournalController;
  readonly writer: RuntimePromotionTransitionWriter;
  receipt: DurableOpenPromotionJournal;
  /** Attempt-local proof that the selected source still exists, either in place or owned. */
  sourcePreserved: boolean;
  sourceManifest: VerifiedRuntimeManifest | null;
  destinationManifest: VerifiedRuntimeManifest | null;
  transaction: InitAuthoredTransaction | null;
  authoredSummary: AuthoredStateSummary | null;
}

export interface RuntimePromotionCleanupCompletion {
  readonly cleanupPending: boolean;
  readonly receipt: DurableClosedPromotionJournal;
}

export interface RuntimePromotionRollbackCompletion {
  readonly result: RuntimeAdoptionResult;
  readonly closedReceipt?: DurableClosedPromotionJournal;
}

import type {
  AuthoredReplayManifest,
  InitAuthoredMutation,
  InitAuthoredPlan,
} from "./init-authored-plan.js";
import type {
  DurableClosedPromotionJournal,
  DurableOpenPromotionJournal,
  DurablePromotionJournal,
  RuntimePromotionJournalController,
} from "./runtime-promotion-journal.js";
import type { RuntimeExclusiveLease } from "@opensip-cli/core";

declare const AUTHORED_TRANSACTION_BRAND: unique symbol;

export const AUTHORED_ARTIFACT_OWNER_FILE = ".opensip-owner.json";
export const AUTHORED_ARTIFACT_OWNER_KIND =
  "opensip-init-authored-artifact" as const;
export const AUTHORED_ARTIFACT_OWNER_VERSION = 1 as const;

export type AuthoredArtifactRole = "stage" | "backup";

/**
 * Exact-object transaction handle. Filesystem authority and absolute paths are
 * held in a private WeakMap by the facade, never projected on this value.
 */
export interface InitAuthoredTransaction {
  readonly operationId: string;
  readonly mutationCount: number;
  readonly [AUTHORED_TRANSACTION_BRAND]: never;
}

export interface AuthoredStateSummary {
  readonly total: number;
  readonly created: number;
  readonly replaced: number;
  readonly deleted: number;
  readonly preserved: number;
  readonly completed: number;
  readonly rolledBack: number;
  readonly verified: boolean;
  /** False only after the replay manifest itself was durably cleaned. */
  readonly actionsKnown: boolean;
}

export interface PreparedAuthoredState {
  readonly transaction: InitAuthoredTransaction;
  readonly receipt: DurableOpenPromotionJournal;
  readonly summary: AuthoredStateSummary;
}

export interface AuthoredStateTransitionResult {
  readonly receipt: DurableOpenPromotionJournal;
  readonly summary: AuthoredStateSummary;
}

export interface AuthoredStateCleanupResult {
  readonly receipt: DurableClosedPromotionJournal;
  readonly summary: AuthoredStateSummary;
}

export type AuthoredStateCheckpoint =
  | "before-prepare-intent"
  | "after-prepare-intent"
  | "before-manifest-materialization"
  | "after-stage-materialization"
  | "after-backup-materialization"
  | "after-replay-materialization"
  | "after-stage-root-mkdir"
  | "after-stage-marker-open"
  | "after-stage-marker-partial-write"
  | "after-stage-marker-fsync"
  | "after-stage-blob-directory-mkdir"
  | "after-stage-blob-open"
  | "after-stage-blob-partial-write"
  | "after-stage-blob-fsync"
  | "after-backup-root-mkdir"
  | "after-backup-marker-open"
  | "after-backup-marker-partial-write"
  | "after-backup-marker-fsync"
  | "after-backup-blob-directory-mkdir"
  | "after-backup-blob-open"
  | "after-backup-blob-partial-write"
  | "after-backup-blob-fsync"
  | "after-manifest-materialization"
  | "before-prepare-postcondition"
  | "after-prepare-postcondition"
  | "before-abort-cleanup"
  | "after-abort-cleanup"
  | "before-abort-postcondition"
  | "after-abort-postcondition"
  | "before-target-intent"
  | "after-target-intent"
  | "before-target-mutation"
  | "after-target-mutation"
  | "before-target-postcondition"
  | "after-target-postcondition"
  | "before-verify"
  | "after-verify"
  | "before-rollback"
  | "after-rollback"
  | "before-cleanup-intent"
  | "after-cleanup-intent"
  | "before-cleanup-mutation"
  | "after-cleanup-mutation"
  | "before-cleanup-postcondition"
  | "after-cleanup-postcondition";

export interface AuthoredStateTransactionDependencies {
  readonly now?: () => number;
  readonly checkpoint?: (
    checkpoint: AuthoredStateCheckpoint,
    cursor?: number,
  ) => void;
}

interface AuthoredStateAuthorityInput {
  readonly projectRoot: string;
  readonly lease: RuntimeExclusiveLease;
  readonly controller: RuntimePromotionJournalController;
  readonly receipt: DurableOpenPromotionJournal;
  readonly dependencies?: AuthoredStateTransactionDependencies;
}

export interface PrepareAuthoredStateInput extends AuthoredStateAuthorityInput {
  readonly plan: InitAuthoredPlan;
}

export type LoadAuthoredStateInput = AuthoredStateAuthorityInput;
export type AbortPendingAuthoredPreparationInput = AuthoredStateAuthorityInput;

export interface LoadClosedAuthoredStateInput {
  readonly projectRoot: string;
  readonly lease: RuntimeExclusiveLease;
  readonly controller: RuntimePromotionJournalController;
  readonly receipt: DurableClosedPromotionJournal;
  readonly dependencies?: AuthoredStateTransactionDependencies;
}

export interface AuthoredArtifactOwner {
  readonly kind: typeof AUTHORED_ARTIFACT_OWNER_KIND;
  readonly version: typeof AUTHORED_ARTIFACT_OWNER_VERSION;
  readonly operationId: string;
  readonly ownershipId: string;
  readonly role: AuthoredArtifactRole;
}

export interface AuthoredArtifactPaths {
  readonly projectRoot: string;
  readonly stageRoot: string;
  readonly backupRoot: string;
  readonly replayManifest: string;
}

export interface AuthoredTransactionState {
  readonly projectRoot: string;
  readonly lease: RuntimeExclusiveLease;
  readonly controller: RuntimePromotionJournalController;
  readonly manifest: AuthoredReplayManifest | null;
  readonly manifestBytes: string | null;
  readonly executionOrder: readonly InitAuthoredMutation[];
  readonly executionIndexBySequence: ReadonlyMap<number, number>;
  readonly mutationCount: number;
  readonly paths: AuthoredArtifactPaths;
  readonly dependencies: Required<AuthoredStateTransactionDependencies>;
  receipt: DurablePromotionJournal;
}

export interface AuthoredBlobAvailability {
  readonly desiredConsumed: ReadonlySet<number>;
  readonly preimageConsumed: ReadonlySet<number>;
}

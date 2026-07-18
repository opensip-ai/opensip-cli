import type { VerifiedRuntimeManifest } from './runtime-manifest.js';
import type {
  RuntimeManifestIdentity,
  RuntimePromotionOwnedSlotName,
} from './runtime-promotion-journal-schema.js';
import type {
  DurablePromotionJournal,
  RuntimePromotionJournalController,
} from './runtime-promotion-journal.js';
import type { RuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';
import type { RuntimeExclusiveLease } from '@opensip-cli/core';

declare const RUNTIME_PROMOTION_FILESYSTEM_AUTHORITY_BRAND: unique symbol;

export type RuntimePromotionFilesystemAction =
  | 'destination-parent-create'
  | 'runtime-stage-reconcile'
  | 'destination-backup-create'
  | 'destination-install'
  | 'source-retire'
  | 'runtime-rollback'
  | 'owned-slot-cleanup';

/**
 * Exact-object, one-use filesystem authority. Paths and the live controller,
 * lease, receipt, and journal body remain in a private WeakMap.
 */
export interface RuntimePromotionFilesystemAuthority {
  readonly operationId: string;
  readonly revision: number;
  readonly action: RuntimePromotionFilesystemAction;
  readonly [RUNTIME_PROMOTION_FILESYSTEM_AUTHORITY_BRAND]: never;
}

export interface AuthorizeRuntimePromotionFilesystemInput {
  readonly action: RuntimePromotionFilesystemAction;
  readonly projectRoot: string;
  readonly sourceRuntime?: string;
  readonly controller: RuntimePromotionJournalController;
  readonly lease: RuntimeExclusiveLease;
  readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
  readonly receipt: DurablePromotionJournal;
  /** Required, and exact, for `owned-slot-cleanup`. */
  readonly cleanupSlot?: RuntimePromotionOwnedSlotName;
  readonly dependencies?: RuntimePromotionFilesystemDependencies;
}

export interface RuntimePromotionFilesystemPaths {
  readonly projectRoot: string;
  readonly destinationParent: string;
  readonly destinationParentStage: string;
  readonly destinationRuntime: string;
  readonly runtimeStage: string;
  readonly destinationBackup: string;
  readonly destinationParentMarker: string;
  readonly destinationBackupMarker: string;
  readonly sourceRuntime?: string;
  readonly sourceTombstone?: string;
  readonly sourceTombstoneMarker?: string;
}

export type RuntimePromotionPathClassification =
  | { readonly status: 'absent' }
  | {
      readonly status: 'directory';
      readonly mode: number;
      readonly owner: 'current' | 'unknown';
    }
  | {
      readonly status: 'file';
      readonly mode: number;
      readonly links: number;
      readonly owner: 'current' | 'unknown';
    }
  | { readonly status: 'symlink' }
  | { readonly status: 'special' };

export type RuntimePromotionFilesystemMutation =
  | 'destination-parent-marker-create'
  | 'destination-parent-mkdir'
  | 'destination-parent-chmod'
  | 'destination-parent-install-rename'
  | 'runtime-stage-marker-unlink'
  | 'destination-backup-marker-create'
  | 'destination-backup-rename'
  | 'destination-install-rename'
  | 'source-tombstone-marker-create'
  | 'source-retire-rename'
  | 'rollback-marker-create'
  | 'rollback-destination-remove'
  | 'destination-backup-restore'
  | 'owned-cleanup-marker-create'
  | 'owned-entry-unlink'
  | 'owned-directory-remove'
  | 'owned-marker-unlink';

export interface RuntimePromotionFilesystemCheckpoint {
  readonly boundary: 'before' | 'after';
  readonly effect: 'mutation' | 'fsync';
  readonly operation: RuntimePromotionFilesystemMutation | 'file' | 'directory';
}

export interface RuntimePromotionFilesystemDependencies {
  readonly checkpoint?: (checkpoint: RuntimePromotionFilesystemCheckpoint) => void;
}

export interface RuntimePromotionStageReconcileInput {
  readonly expected: VerifiedRuntimeManifest;
}

export interface RuntimePromotionDestinationParentResult {
  readonly status: 'created' | 'already-created';
}

export type RuntimePromotionStageReconcileResult =
  | { readonly status: 'absent' }
  | { readonly status: 'verified'; readonly manifest: VerifiedRuntimeManifest }
  | { readonly status: 'discarded-incomplete' };

export interface RuntimePromotionBackupResult {
  readonly status: 'applied' | 'already-applied';
  readonly manifest: VerifiedRuntimeManifest;
}

export interface RuntimePromotionInstallResult {
  readonly status: 'applied' | 'already-applied';
  readonly manifest: VerifiedRuntimeManifest;
}

export interface RuntimePromotionRetireResult {
  readonly status: 'applied' | 'already-applied';
  readonly manifest: VerifiedRuntimeManifest;
}

export interface RuntimePromotionRollbackInput {
  readonly installed: RuntimeManifestIdentity | null;
  readonly backup: RuntimeManifestIdentity | null;
  /**
   * `true` reconciles an installed destination. `false` restores a backup
   * taken before install (the rollback-started/not-installed crash window).
   */
  readonly installedWasAuthoritative: boolean;
}

export interface RuntimePromotionRollbackResult {
  readonly status: 'rolled-back' | 'already-rolled-back';
  readonly runtimeInstallState: 'rolled-back' | 'backup-restored';
  readonly restored: VerifiedRuntimeManifest | null;
}

export interface RuntimePromotionOwnedCleanupResult {
  readonly slot: RuntimePromotionOwnedSlotName;
  readonly status: 'removed' | 'already-absent';
}

export interface RuntimePromotionArtifactMarker {
  readonly kind: 'opensip-init-runtime-artifact';
  readonly version: 1;
  readonly operationId: string;
  readonly slot: 'destinationParent' | 'runtimeStage' | 'destinationBackup' | 'sourceTombstone';
  readonly ownershipId: string;
  readonly artifactBasename: string;
  readonly purpose: 'owner' | 'cleanup' | 'rollback';
  readonly rootIdentity: {
    readonly device: string;
    readonly inode: string;
  } | null;
  readonly manifest: RuntimeManifestIdentity | null;
}

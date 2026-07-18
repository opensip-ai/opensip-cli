/**
 * Journal-bound runtime filesystem transaction substrate.
 *
 * Each mutating call consumes one exact-object authority tied to the live
 * controller, lease, receipt revision, action, canonical project root, and
 * (when relevant) Core-anchored ephemeral cache parent.
 */

export { authorizeRuntimePromotionFilesystem } from './runtime-promotion-filesystem-authority.js';
export { cleanupRuntimePromotionOwnedSlot } from './runtime-promotion-filesystem-cleanup.js';
export {
  backupRuntimePromotionDestination,
  createRuntimePromotionDestinationParent,
  installRuntimePromotionStage,
  reconcileRuntimePromotionStage,
} from './runtime-promotion-filesystem-forward.js';
export { classifyRuntimePromotionPath } from './runtime-promotion-filesystem-io.js';
export {
  encodeRuntimePromotionArtifactMarker,
  parseRuntimePromotionArtifactMarker,
  RUNTIME_PROMOTION_ARTIFACT_MARKER_MAX_BYTES,
  runtimePromotionCleanupMarkerBasename,
  runtimePromotionOwnerMarkerBasename,
  runtimePromotionRollbackMarkerBasename,
} from './runtime-promotion-filesystem-marker.js';
export { retireRuntimePromotionSource } from './runtime-promotion-filesystem-retire.js';
export { rollbackRuntimePromotion } from './runtime-promotion-filesystem-rollback.js';

export type {
  AuthorizeRuntimePromotionFilesystemInput,
  RuntimePromotionArtifactMarker,
  RuntimePromotionBackupResult,
  RuntimePromotionDestinationParentResult,
  RuntimePromotionFilesystemAction,
  RuntimePromotionFilesystemAuthority,
  RuntimePromotionFilesystemCheckpoint,
  RuntimePromotionFilesystemDependencies,
  RuntimePromotionInstallResult,
  RuntimePromotionOwnedCleanupResult,
  RuntimePromotionPathClassification,
  RuntimePromotionRetireResult,
  RuntimePromotionRollbackInput,
  RuntimePromotionRollbackResult,
  RuntimePromotionStageReconcileInput,
  RuntimePromotionStageReconcileResult,
} from './runtime-promotion-filesystem-types.js';

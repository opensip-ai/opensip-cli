/** Closed v1 type vocabulary for Init's fixed promotion journal. */

export const RUNTIME_PROMOTION_JOURNAL_KIND = 'init-promotion' as const;
export const RUNTIME_PROMOTION_JOURNAL_VERSION = 1 as const;
export const RUNTIME_PROMOTION_JOURNAL_MAX_BYTES = 24 * 1024;

export const RUNTIME_PROMOTION_JOURNAL_CAPS = Object.freeze({
  maxBytes: RUNTIME_PROMOTION_JOURNAL_MAX_BYTES,
  maxReasonBytes: 96,
  maxBasenameBytes: 128,
  maxOwnershipIdBytes: 128,
  maxAuthoredMutations: 4096,
  maxRuntimeEntries: 100_000,
  maxRuntimeBytes: Number.MAX_SAFE_INTEGER,
  maxRevision: 1_000_000,
  maxRecoveryAttempts: 1_000_000,
  maxTimestamp: Number.MAX_SAFE_INTEGER,
  maxSqliteUserVersion: 2_147_483_647,
});

export const RUNTIME_PROMOTION_COORDINATION_KEY_PATTERN = /^[a-f0-9]{24}$/u;
export const RUNTIME_PROMOTION_CACHE_KEY_PATTERN = /^[a-f0-9]{24}$/u;
export const RUNTIME_PROMOTION_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
export const RUNTIME_PROMOTION_OPERATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
export const RUNTIME_PROMOTION_OWNER_TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{15,127}$/u;
export const RUNTIME_PROMOTION_OWNERSHIP_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,127}$/u;
export const RUNTIME_PROMOTION_SAFE_BASENAME_PATTERN = /^(?!\.{1,2}$)[a-zA-Z0-9._-]{1,128}$/u;

export const RUNTIME_PROMOTION_ROUTES = [
  'authored-only',
  'project-authority',
  'promote-cache',
  'keep-project',
  'deduplicate-cache',
] as const;
export type RuntimePromotionRoute = (typeof RUNTIME_PROMOTION_ROUTES)[number];

export const RUNTIME_PROMOTION_SOURCE_CLASSIFICATIONS = [
  'none',
  'generation-bound',
  'path-only',
  'legacy',
] as const;
export type RuntimePromotionSourceClassification =
  (typeof RUNTIME_PROMOTION_SOURCE_CLASSIFICATIONS)[number];

export const RUNTIME_PROMOTION_CONFLICT_POLICIES = ['abort', 'keep-project', 'use-cache'] as const;
export type RuntimePromotionConflictPolicy = (typeof RUNTIME_PROMOTION_CONFLICT_POLICIES)[number];

export const RUNTIME_PROMOTION_AUTHORED_MODES = ['fresh', 'refresh', 'keep', 'remove'] as const;
export type RuntimePromotionAuthoredMode = (typeof RUNTIME_PROMOTION_AUTHORED_MODES)[number];

export const RUNTIME_PROMOTION_LANGUAGES = [
  'typescript',
  'rust',
  'python',
  'go',
  'java',
  'cpp',
] as const;
export type RuntimePromotionLanguage = (typeof RUNTIME_PROMOTION_LANGUAGES)[number];

export const RUNTIME_PROMOTION_OWNED_SLOT_NAMES = [
  'destinationParent',
  'runtimeStage',
  'destinationBackup',
  'sourceTombstone',
  'authoredStage',
  'authoredBackup',
  'replayManifest',
] as const;
export type RuntimePromotionOwnedSlotName = (typeof RUNTIME_PROMOTION_OWNED_SLOT_NAMES)[number];

export const RUNTIME_PROMOTION_PHASES = [
  'prepared',
  'source-verified',
  'destination-verified',
  'authored-prepared',
  'destination-ready',
  'runtime-staged',
  'destination-backed-up',
  'runtime-installed',
  'authored-committed',
  'source-retired',
  'authority-verified',
  'committed',
  'rollback-started',
  'runtime-rolled-back',
  'authored-rolled-back',
  'rolled-back',
  'closed',
  'cleanup',
] as const;
export type RuntimePromotionPhase = (typeof RUNTIME_PROMOTION_PHASES)[number];

export const RUNTIME_PROMOTION_DIRECTIONS = ['forward', 'rollback', 'cleanup'] as const;
export type RuntimePromotionDirection = (typeof RUNTIME_PROMOTION_DIRECTIONS)[number];

export const RUNTIME_PROMOTION_RUNTIME_INSTALL_STATES = [
  'not-installed',
  'installed',
  'rolled-back',
  'backup-restored',
] as const;
export type RuntimePromotionRuntimeInstallState =
  (typeof RUNTIME_PROMOTION_RUNTIME_INSTALL_STATES)[number];

export const RUNTIME_PROMOTION_INTENT_KINDS = [
  'runtime-stage-create',
  'destination-parent-create',
  'destination-backup-create',
  'destination-install',
  'authored-prepare',
  'authored-target-commit',
  'source-retire',
  'runtime-rollback',
  'authored-target-rollback',
  'owned-slot-cleanup',
] as const;
export type RuntimePromotionIntentKind = (typeof RUNTIME_PROMOTION_INTENT_KINDS)[number];

export const RUNTIME_PROMOTION_POSTCONDITION_OUTCOMES = [
  'applied',
  'already-satisfied',
  'aborted',
] as const;
export type RuntimePromotionPostconditionOutcome =
  (typeof RUNTIME_PROMOTION_POSTCONDITION_OUTCOMES)[number];

export const RUNTIME_PROMOTION_CLEANUP_STATES = ['unmaterialized', 'pending', 'removed'] as const;
export type RuntimePromotionCleanupState = (typeof RUNTIME_PROMOTION_CLEANUP_STATES)[number];

export const RUNTIME_PROMOTION_TERMINAL_OUTCOMES = ['committed', 'rolled-back'] as const;
export type RuntimePromotionTerminalOutcome = (typeof RUNTIME_PROMOTION_TERMINAL_OUTCOMES)[number];
export const RUNTIME_PROMOTION_AUTHORITIES = ['project', 'cache', 'none'] as const;
export type RuntimePromotionAuthority = (typeof RUNTIME_PROMOTION_AUTHORITIES)[number];

/**
 * Only relative, non-escaping, non-dangling in-tree links are supported.
 * The journal stores their count, never entry names or link targets.
 */
export const RUNTIME_MANIFEST_RELATIVE_SYMLINK_POLICY = 'relative-in-tree-only' as const;

export interface RuntimePromotionSource {
  readonly classification: RuntimePromotionSourceClassification;
  readonly cacheKey: string | null;
  readonly generationDigest: string | null;
  readonly markerSha256: string | null;
}

export interface RuntimePromotionInputs {
  readonly conflict: RuntimePromotionConflictPolicy;
  readonly authoredMode: RuntimePromotionAuthoredMode;
  readonly languages: readonly RuntimePromotionLanguage[];
  readonly languageExplicit: boolean;
}

export interface RuntimePromotionPlanIdentity {
  readonly authoredDigest: string;
  readonly replayDigest: string;
  readonly mutationCount: number;
}

export interface RuntimePromotionOwnedSlot {
  readonly basename: string;
  readonly ownershipId: string;
}
export type RuntimePromotionOwnedSlots = Readonly<
  Record<RuntimePromotionOwnedSlotName, RuntimePromotionOwnedSlot>
>;

export type RuntimeManifestSqliteIdentity =
  | { readonly status: 'absent' }
  | {
      readonly status: 'verified';
      readonly sha256: string;
      readonly userVersion: number;
    };

/** Bounded whole-runtime identity; it intentionally has no entry list. */
export interface RuntimeManifestIdentity {
  readonly digest: string;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly symlinkCount: number;
  readonly rootMode: number;
  readonly totalBytes: number;
  readonly sqlite: RuntimeManifestSqliteIdentity;
}

export interface RuntimePromotionManifestIdentities {
  readonly source: RuntimeManifestIdentity | null;
  readonly destination: RuntimeManifestIdentity | null;
  readonly runtimeStage: RuntimeManifestIdentity | null;
}

export interface RuntimePromotionPendingIntent {
  readonly sequence: number;
  readonly kind: RuntimePromotionIntentKind;
  readonly slot: RuntimePromotionOwnedSlotName | null;
  readonly cursor: number | null;
  readonly recordedAt: number;
}

export interface RuntimePromotionPostcondition extends RuntimePromotionPendingIntent {
  readonly outcome: RuntimePromotionPostconditionOutcome;
}

export interface RuntimePromotionProgress {
  readonly phase: RuntimePromotionPhase;
  readonly direction: RuntimePromotionDirection;
  readonly runtimeInstallState: RuntimePromotionRuntimeInstallState;
  readonly authoredCursor: number;
  readonly rollbackCursor: number;
  readonly pendingIntent: RuntimePromotionPendingIntent | null;
  readonly lastPostcondition: RuntimePromotionPostcondition | null;
}

export interface RuntimePromotionTerminal {
  readonly outcome: RuntimePromotionTerminalOutcome;
  readonly authority: RuntimePromotionAuthority;
  readonly runtimeManifest: RuntimeManifestIdentity | null;
  readonly authoredVerified: boolean;
  readonly sourcePreserved: boolean;
  readonly verifiedAt: number;
}

export type RuntimePromotionCleanup = Readonly<
  Record<RuntimePromotionOwnedSlotName, RuntimePromotionCleanupState>
>;

export interface RuntimePromotionCounts {
  readonly intentCount: number;
  readonly postconditionCount: number;
  readonly authoredCompleted: number;
  readonly authoredRolledBack: number;
  readonly cleanupCompleted: number;
}

export interface RuntimePromotionTimestamps {
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
}

export interface RuntimePromotionJournal {
  readonly kind: typeof RUNTIME_PROMOTION_JOURNAL_KIND;
  readonly version: typeof RUNTIME_PROMOTION_JOURNAL_VERSION;
  readonly coordinationKey: string;
  readonly operationId: string;
  readonly state: 'open' | 'closed';
  readonly revision: number;
  readonly recoveryOwnerToken: string;
  readonly recoveryAttempt: number;
  readonly route: RuntimePromotionRoute;
  readonly destinationParentPreexisting: boolean;
  readonly destinationRuntimePreexisting: boolean;
  readonly source: RuntimePromotionSource;
  readonly inputs: RuntimePromotionInputs;
  readonly plan: RuntimePromotionPlanIdentity;
  readonly owned: RuntimePromotionOwnedSlots;
  readonly manifests: RuntimePromotionManifestIdentities;
  readonly progress: RuntimePromotionProgress;
  readonly terminal: RuntimePromotionTerminal | null;
  readonly cleanup: RuntimePromotionCleanup;
  readonly counts: RuntimePromotionCounts;
  readonly timestamps: RuntimePromotionTimestamps;
  readonly reason?: string;
}

export interface CreateRuntimePromotionJournalInput {
  readonly coordinationKey: string;
  readonly operationId: string;
  readonly recoveryOwnerToken: string;
  readonly route: RuntimePromotionRoute;
  readonly destinationParentPreexisting: boolean;
  readonly destinationRuntimePreexisting: boolean;
  readonly source: RuntimePromotionSource;
  readonly inputs: RuntimePromotionInputs;
  readonly plan: RuntimePromotionPlanIdentity;
  readonly owned: RuntimePromotionOwnedSlots;
  readonly createdAt: number;
  readonly reason?: string;
}

export interface RuntimePromotionJournalBinding {
  readonly coordinationKey?: string;
  readonly operationId?: string;
  readonly state?: 'open' | 'closed';
}

export class RuntimePromotionJournalValidationError extends Error {
  constructor(message: string) {
    super(`Invalid runtime promotion journal: ${message}`);
    this.name = 'RuntimePromotionJournalValidationError';
  }
}

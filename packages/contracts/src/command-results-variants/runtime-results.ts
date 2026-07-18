import type { StoredRun, StoredRunStep } from '../run-types.js';

/** The customer-visible local storage plane selected for this project. */
export type RuntimeStoragePlane = 'cache' | 'project' | 'none';

/** Current relationship between the cache candidate and project runtime. */
export type RuntimeAdoptionState =
  'ready' | 'not-needed' | 'legacy-unverified' | 'conflict' | 'busy' | 'recovery-required';

/** Strength of the evidence tying a runtime to this repository generation. */
export type RuntimeIdentityStrength = 'generation-bound' | 'path-only' | 'legacy-unverified';

/**
 * Bounded, path-free projection of one possible runtime location.
 *
 * Absolute paths and identity digests are intentionally not part of this
 * public contract.
 */
export interface RuntimeLocationProjection {
  readonly exists: boolean;
  /** Present only when the location is a cache candidate with an identity claim. */
  readonly identityStrength?: RuntimeIdentityStrength;
  readonly sizeBytes?: number;
  readonly sizeTruncated?: boolean;
  readonly lastUsedAt?: string;
}

/** Cache locations always disclose how strongly they are tied to this repository. */
export interface RuntimeCacheLocationProjection extends RuntimeLocationProjection {
  readonly identityStrength: RuntimeIdentityStrength;
}

/** Bounded projection of the SQLite evidence file in the selected runtime. */
export interface RuntimeEvidenceDatabaseProjection {
  readonly exists: boolean;
  readonly sizeBytes?: number;
}

/** Host-owned cache-entry retention policy. */
export interface RuntimeCacheRetentionPolicy {
  readonly keep: number;
  readonly maxAgeDays: number;
}

/** Effective local Session/evidence retention policy. */
export interface RuntimeEvidenceRetentionPolicy {
  readonly keep: number;
  readonly maxAgeDays: number;
  readonly maxSizeMb: number;
}

/** Optional bounded activity projection populated by the runtime lease plane. */
export interface RuntimeLeaseActivity {
  readonly activeReaders: number;
  readonly writerPending: boolean;
  readonly busy: boolean;
}

/** Coarse, customer-safe recovery phase. Internal journal phases stay private. */
export type RuntimeRecoveryPhase =
  | 'prepared'
  | 'source-verification'
  | 'runtime-staging'
  | 'destination-backup'
  | 'destination-install'
  | 'authored-prepare'
  | 'authored-commit'
  | 'source-retirement'
  | 'rollback'
  | 'cleanup'
  | 'unknown';

/** Closed recovery reason vocabulary safe to expose to humans and agents. */
export type RuntimeRecoveryReasonCode =
  | 'operation-interrupted'
  | 'operation-failed'
  | 'journal-malformed'
  | 'journal-oversize'
  | 'journal-key-mismatch'
  | 'journal-phase-invalid'
  | 'source-unverified'
  | 'artifact-missing'
  | 'artifact-mismatch'
  | 'state-ambiguous'
  | 'rollback-incomplete'
  | 'cleanup-pending';

/** Exact safe commands recovery/status may recommend. */
export type RuntimeRecoveryCommand =
  | 'opensip init'
  | 'opensip init --runtime-conflict keep-project'
  | 'opensip init --runtime-conflict use-cache';

/** Exact, safe follow-up commands returned by the read-only status surface. */
export type RuntimeNextCommand =
  | RuntimeRecoveryCommand
  | 'opensip runs list --json'
  | 'opensip sessions list --json'
  | 'opensip uninstall --project --dry-run';

/** Terminal or actionable result of Init's runtime-adoption coordinator. */
export type RuntimeAdoptionStatus =
  | 'not-found'
  | 'promoted'
  | 'already-project'
  | 'deduplicated'
  | 'kept-project'
  | 'conflict'
  | 'busy'
  | 'recovery-required'
  | 'rolled-back'
  | 'cleanup-pending';

/** Closed, bounded reason vocabulary for an adoption result. */
export type RuntimeAdoptionReasonCode =
  | 'source-absent'
  | 'destination-absent'
  | 'equivalent'
  | 'divergent'
  | 'weak-source-requires-selection'
  | 'destination-unverified'
  | 'lease-busy'
  | RuntimeRecoveryReasonCode;

/** Bounded counts for Init-authored state affected by one adoption operation. */
export interface RuntimeAuthoredMutationSummary {
  readonly created: number;
  readonly replaced: number;
  readonly deleted: number;
  readonly preserved: number;
}

/**
 * Public Init adoption result. It deliberately carries no runtime path,
 * manifest digest, journal token, or arbitrary exception text.
 */
export interface RuntimeAdoptionResult {
  readonly status: RuntimeAdoptionStatus;
  readonly proofStrength?: RuntimeIdentityStrength;
  readonly sourcePreserved: boolean;
  readonly sourceRetired?: boolean;
  readonly cleanupPending?: boolean;
  readonly authored?: RuntimeAuthoredMutationSummary;
  readonly durationMs: number;
  readonly reasonCode?: RuntimeAdoptionReasonCode;
  readonly nextCommand?: RuntimeRecoveryCommand;
}

interface RuntimeStatusBase {
  readonly type: 'runtime-status';
  readonly projectInitialized: boolean;
  readonly activePlane: RuntimeStoragePlane;
  readonly cache: RuntimeCacheLocationProjection;
  readonly project: RuntimeLocationProjection;
  readonly evidenceDatabase: RuntimeEvidenceDatabaseProjection;
  readonly retention: {
    readonly cache: RuntimeCacheRetentionPolicy;
    readonly evidence: RuntimeEvidenceRetentionPolicy;
  };
  readonly leaseActivity?: RuntimeLeaseActivity;
  readonly nextCommands: readonly RuntimeNextCommand[];
}

interface RuntimeStatusWithoutRecovery {
  readonly adoptionState: Exclude<RuntimeAdoptionState, 'recovery-required'>;
  readonly recoveryPhase?: never;
  readonly recoveryReasonCode?: never;
  readonly sourcePreserved?: never;
  readonly cleanupPending?: never;
  readonly recoveryCommand?: never;
}

interface RuntimeStatusRecoveryRequired {
  readonly adoptionState: 'recovery-required';
  readonly recoveryPhase: RuntimeRecoveryPhase;
  readonly recoveryReasonCode: RuntimeRecoveryReasonCode;
  readonly sourcePreserved: boolean;
  readonly cleanupPending?: never;
  readonly recoveryCommand: RuntimeRecoveryCommand;
}

interface RuntimeStatusCleanupPending {
  readonly adoptionState: Exclude<RuntimeAdoptionState, 'recovery-required'>;
  readonly recoveryPhase: 'cleanup';
  readonly recoveryReasonCode: 'cleanup-pending';
  readonly sourcePreserved: boolean;
  readonly cleanupPending: true;
  readonly recoveryCommand: 'opensip init';
}

/** Read-only answer to `opensip status`, with recovery fields kept coherent. */
export type RuntimeStatusResult = RuntimeStatusBase &
  (RuntimeStatusWithoutRecovery | RuntimeStatusRecoveryRequired | RuntimeStatusCleanupPending);

/** One exact parent Run in a bounded history response. */
export interface ParentRunSummary {
  readonly run: StoredRun;
  readonly showCommand: string;
}

/** Canonical parent execution history returned by `opensip runs list`. */
export interface RunHistoryResult {
  readonly type: 'run-history';
  readonly runs: readonly ParentRunSummary[];
  readonly requestedLimit: number;
  readonly effectiveLimit: number;
  readonly truncated: boolean;
}

/** Follow-up command for a Tool Session linked from a parent RunStep. */
export interface RunSessionFollowUp {
  readonly runStepId: string;
  readonly sessionId: string;
  readonly showCommand: string;
}

/** Exact, bounded parent Run detail returned by `opensip runs show`. */
export interface RunDetailResult {
  readonly type: 'run-detail';
  readonly run: StoredRun;
  readonly steps: readonly StoredRunStep[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly nextOffset?: number;
  readonly sessionFollowUps: readonly RunSessionFollowUp[];
}

/**
 * @fileoverview Shared-reader/exclusive-maintainer runtime coordination.
 *
 * Coordination lives outside the deletable OpenSIP user-data tree. All state
 * transitions are serialized through one short mutex; long-lived leases are
 * represented by bounded, heartbeat-bearing records rather than by holding an
 * OS file descriptor. The portable mutation fallback retains and revalidates a
 * trusted parent handle around every path-based mutation. This detects parent
 * replacement but does not claim isolation from an actively malicious same-UID
 * process in the unobservable syscall window.
 */

// @fitness-ignore-file file-length-limit -- one security-sensitive lease state machine
/* eslint-disable sonarjs/cognitive-complexity, sonarjs/no-duplicate-string -- audited state-machine branches */

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { coreErrorCatalog } from './errors/core-error-catalog.js';
import {
  ConfigurationError,
  SystemError,
  TimeoutError,
  createToolError,
  type ToolError,
} from './errors.js';
import { type FileLockEvent, type StateLockPolicy } from './file-lock.js';
import {
  createSafetyBiasedProcessInspector,
  defaultHostInstanceIdentity,
  deriveHostIdentity,
  inspectProcessIncarnation,
  type ProcessIncarnationInspection,
  type SafetyBiasedProcessInspector,
} from './host-process-identity.js';
import { generateUUID } from './ids.js';
import {
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  opendirSync,
  readSync,
  realpathSync,
} from './node-fs-inspect.js';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from './node-fs-mutate.js';
import {
  projectCoordinationKey,
  resolveCoordinationPaths,
  RUNTIME_PROMOTION_JOURNAL_FILE,
  type CoordinationPaths,
  USER_UNINSTALL_RECEIPT_FILE,
} from './paths.js';

import type { ErrorDefinition } from './error-definition.js';
import type { BigIntStats } from 'node:fs';

const STATE_VERSION = 1;
const MAX_RECORD_BYTES = 4096;
/** Maximum UTF-8 body size accepted by the general anchored-record seam. */
export const ANCHORED_RECORD_MAX_BYTES = 4 * 1024 * 1024;
/** Maximum entries inspected lazily while proving a linked-create peer. */
export const ANCHORED_CREATE_RECOVERY_MAX_ENTRIES = 100_000;
/** Version of the bounded header shared by fixed runtime recovery records. */
export const RUNTIME_RECOVERY_HEADER_VERSION = 1;
/** Maximum UTF-8 body size for a fixed runtime recovery record. */
export const RUNTIME_RECOVERY_RECORD_MAX_BYTES = 24 * 1024;
const ANCHORED_TEMP_BASENAME_MAX_BYTES = 255;
const MAX_WRITER_QUEUE = 8;
const MAX_PROJECT_KEYS = 256;
const MAX_READERS_PER_DIMENSION = 128;
const MAX_MUTEX_TEMPS = 256;
const MAX_REFERENCES_PER_OWNER = 64;
const MAX_SAFE_TEXT = 96;
const MAX_HOST_IDENTITY_BYTES = 32;
const MAX_METADATA_TEXT_BYTES = 32;
const MAX_NEW_METADATA_TEXT_BYTES = 16;
const MAX_WAIT_MS = 60 * 60 * 1000;
const MAX_STALE_MS = 24 * 60 * 60 * 1000;
const MIN_HEARTBEAT_MS = 10;
const MAX_HEARTBEAT_MS = 60 * 1000;
const MAX_POLL_MS = 10 * 1000;
const MAX_FAILED_PUBLICATION_CLEANUP_WAIT_MS = 1000;
const MAX_CACHED_PROCESS_INSPECTIONS = 256;
const RUNTIME_MUTEX_PROCESS_PROBE_CACHE_MS = 250;
const MAX_DEFERRED_PUBLICATION_CLEANUPS = 256;
const MAX_CONCURRENT_DEFERRED_CLEANUPS = 2;
const DEFERRED_CLEANUP_TICK_MS = 50;
const MAX_DEFERRED_CLEANUP_BACKOFF_MS = 30_000;
const RUNTIME_MUTEX_EVENT_PATH = 'coordination.lock';
const PROJECT_KEY_PATTERN = /^[a-f0-9]{24}$/u;
const REFERENCE_TOKEN_PATTERN = /^[a-f0-9]{24}$/u;
const OWNER_TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{15,127}$/u;
const OPERATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const ANCHORED_CREATE_IDENTITY_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{14,126}[a-zA-Z0-9])$/u;
const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PROCESS_INCARNATION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,95}$/u;
const READER_FILE_PATTERN = /^reader-([a-zA-Z0-9][a-zA-Z0-9-]{15,127})\.json$/u;
const READER_TEMP_FILE_PATTERN =
  /^\.((?:reader-[a-zA-Z0-9][a-zA-Z0-9-]{15,127}\.json))\.tmp-[a-zA-Z0-9-]{16,128}$/u;
const MUTEX_TEMP_FILE_PATTERN = /^\.coordination\.lock\.tmp-[a-zA-Z0-9-]{16,128}$/u;
const ROOT_TRANSITION_TEMP_FILE_PATTERN =
  /^\.(state\.json|user-uninstall\.json)\.tmp-[a-zA-Z0-9-]{16,128}$/u;
const PROJECT_TRANSITION_TEMP_FILE_PATTERN =
  /^\.(runtime-promotion\.json)\.tmp-[a-zA-Z0-9-]{16,128}$/u;
const ROOT_ENTRY_PATTERN =
  /^(?:coordination\.lock|state\.json|projects|user-readers|user-uninstall\.json|\.(?:coordination\.lock|state\.json|user-uninstall\.json)\.tmp-[a-zA-Z0-9-]{16,128})$/u;
const PROJECT_ENTRY_PATTERN =
  /^(?:readers|runtime-promotion\.json|\.runtime-promotion\.json\.tmp-[a-zA-Z0-9-]{16,128})$/u;

/** Default bounded polling and stale-owner policy. */
export const DEFAULT_RUNTIME_LEASE_POLICY: RuntimeLeasePolicy = Object.freeze({
  waitMs: 35_000,
  staleMs: 30_000,
  heartbeatMs: 5000,
  pollMs: 25,
});

/** Policy shared by all runtime lease acquisition forms. */
export interface RuntimeLeasePolicy extends StateLockPolicy {
  readonly pollMs: number;
}

/** Recovery posture for one project runtime. */
export type RuntimeExclusivePosture = 'normal' | 'init-recovery' | 'destructive-discard';

/** Recovery posture for global user-state maintenance. */
export type GlobalRuntimeMaintenancePosture = 'normal' | 'user-recovery' | 'receipt-only-discard';

/** Stable timeout discriminator for customer-facing lease diagnostics. */
export type RuntimeLeaseWaitKind =
  | 'runtime-read'
  | 'runtime-exclusive'
  | 'runtime-access-composite'
  | 'user-state-read'
  | 'runtime-global-maintenance';

/** Safe lifecycle event. Raw owner tokens are never included. */
export interface RuntimeLeaseEvent {
  readonly kind:
    | 'lease.acquire.start'
    | 'lease.acquire.wait'
    | 'lease.acquire.complete'
    | 'lease.release'
    | 'lease.stale.recovered'
    | 'lease.recovery.required';
  readonly resource: 'runtime';
  readonly operation: RuntimeLeaseWaitKind;
  readonly waitMs?: number;
  readonly ownerPid?: number;
  readonly ownerHostname?: string;
}

interface RuntimeLeaseCommonInput {
  readonly ownerToken?: string;
  readonly command?: string;
  readonly cwdBasename?: string;
  readonly policy?: Partial<RuntimeLeasePolicy>;
  readonly onEvent?: (event: RuntimeLeaseEvent | FileLockEvent) => void;
  readonly signal?: AbortSignal;
}

type LinkedCreateCheckpoint =
  | 'after-linked-create-target-proof'
  | 'after-linked-create-peer-selection'
  | 'after-linked-create-temporary-proof'
  | 'after-linked-create-final-stats';

/** Injectable process/time seams for deterministic lease and stale-owner tests. */
export interface RuntimeLeaseEnvironment {
  readonly now: () => number;
  readonly monotonicNow: () => number;
  readonly hostname: () => string;
  /** Stable local machine/boot identity; absent means hostname-only is unproven. */
  readonly hostInstanceIdentity: () => string | undefined;
  /** Proven process-start identity when the platform can distinguish PID reuse. */
  readonly inspectProcessIncarnation: (pid: number) => ProcessIncarnationInspection;
  readonly pid: number;
  /** Direct OS parent PID, captured for bounded child-reader inheritance. */
  readonly parentPid: number;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly generateToken: () => string;
  readonly poll: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly pollSync: (ms: number) => void;
  /**
   * Conservative per-scan process-inspection bound for direct test/embedding
   * coordinators. Values are clamped to [1, 256]; production omits this field
   * and retains the full 256-probe cap. Exhaustion preserves owners.
   */
  readonly maxProcessInspectionsPerScan?: number;
  readonly transition?: (name: string) => void;
  /** Direct-module fault harness; intentionally absent from the public barrel. */
  readonly coordinationCheckpoint?: (
    name:
      | 'mutex-entered'
      | 'before-mutex-postcondition'
      | 'after-mutex-unlink'
      | LinkedCreateCheckpoint
      | 'before-stale-mutex-digest-read'
      | 'before-stale-mutex-final-identity'
      | 'before-stale-mutex-mutation'
      | 'before-stale-mutex-unlink'
      | 'before-stale-reader-unlink'
      | 'empty-scaffold-parents-opened'
      | 'before-fixed-recovery-read-parent-revalidation'
      | 'before-fixed-recovery-parent-fsync',
  ) => void;
}

const RUNTIME_ENVIRONMENT = Symbol('runtime-lease-environment');
type InternalRuntimeLeaseInput = RuntimeLeaseCommonInput & {
  readonly [RUNTIME_ENVIRONMENT]?: RuntimeLeaseEnvironment;
};

interface RuntimeWriterAuthority {
  readonly ownerToken: string;
  readonly acquiredAt: number;
  readonly sequence: number;
  readonly kind: 'project' | 'global';
  readonly coordinationKey?: string;
  readonly mutationCapability:
    'project-record' | 'project-discard-only' | 'user-record' | 'receipt-discard-only';
  readonly environment: RuntimeLeaseEnvironment;
}

type WriterLeaseWithAuthority = RuntimeExclusiveLease | GlobalRuntimeMaintenanceLease;

/**
 * An exact-object capability registry. Returning the authority as an own
 * property (including a symbol property) would let callers reflect, copy, and
 * alter it. WeakMap branding keeps recovery authority unforgeable while
 * allowing released lease objects to be collected.
 */
const RUNTIME_WRITER_AUTHORITIES = new WeakMap<object, Readonly<RuntimeWriterAuthority>>();

export interface AcquireRuntimeReadLeaseInput extends RuntimeLeaseCommonInput {
  readonly projectDir: string;
}

export interface AcquireRuntimeExclusiveLeaseInput extends RuntimeLeaseCommonInput {
  readonly projectDir: string;
  readonly posture?: RuntimeExclusivePosture;
  /** Required for `init-recovery`; compared only with the bounded core header. */
  readonly recoveryOperationId?: string;
}

export type AcquireUserStateReadLeaseInput = RuntimeLeaseCommonInput;

export interface AcquireGlobalRuntimeMaintenanceLeaseInput extends RuntimeLeaseCommonInput {
  readonly posture?: GlobalRuntimeMaintenancePosture;
  /** Required for `user-recovery`; compared only with the bounded core header. */
  readonly recoveryOperationId?: string;
}

export interface AcquireRuntimeAccessLeaseInput extends RuntimeLeaseCommonInput {
  readonly projectRead?: { readonly projectDir: string } | false;
  readonly userStateRead?: boolean;
  /**
   * Admit a fresh child-owned composite reader at a live direct parent's
   * earlier sequence. Both parent dimensions, host/process identity, and the OS
   * direct-parent relationship are discovered and revalidated under the
   * coordination mutex; no persistent or transported grant is accepted.
   */
  readonly inheritFromParent?: boolean;
}

/** Idempotent synchronous lease handle suitable for `RunScope.onDispose`. */
export interface RuntimeLease {
  readonly ownerToken: string;
  readonly acquiredAt: number;
  readonly release: () => void;
}

export interface RuntimeReadLease extends RuntimeLease {
  readonly kind: 'runtime-read';
  readonly coordinationKey: string;
}

export interface RuntimeExclusiveLease extends RuntimeLease {
  readonly kind: 'runtime-exclusive';
  readonly coordinationKey: string;
  readonly posture: RuntimeExclusivePosture;
}

export interface UserStateReadLease extends RuntimeLease {
  readonly kind: 'user-state-read';
}

export interface GlobalRuntimeMaintenanceLease extends RuntimeLease {
  readonly kind: 'runtime-global-maintenance';
  readonly posture: GlobalRuntimeMaintenancePosture;
  /**
   * True only for the malformed-receipt posture. It authorizes callers to
   * unlink the fixed receipt basename and no other path.
   */
  readonly receiptOnlyDiscard: boolean;
}

export interface RuntimeAccessLease extends RuntimeLease {
  readonly kind: 'runtime-access-composite';
  readonly coordinationKey?: string;
  readonly projectRead: boolean;
  readonly userStateRead: boolean;
}

export type RecoveryHeaderInspection =
  | { readonly status: 'absent' }
  | {
      readonly status: 'valid';
      readonly state: 'open' | 'closed';
      readonly operationId: string;
      readonly reason?: string;
    }
  | {
      readonly status: 'malformed';
      readonly reason:
        | 'oversize'
        | 'unsafe-file'
        | 'invalid-json'
        | 'invalid-header'
        | 'coordination-key-mismatch';
    };

export type RuntimeRecoveryStateProjection =
  | { readonly status: 'absent' }
  | { readonly status: 'valid'; readonly state: 'open' | 'closed' }
  | { readonly status: 'malformed' };

/** Bounded, stable current-project coordination projection. */
export interface StableRuntimeLeaseStateInspection {
  readonly status: 'stable';
  readonly projectReaders: number;
  readonly userStateReaders: number;
  readonly writer: 'none' | 'queued' | 'intent';
  readonly globalWriter: 'none' | 'queued' | 'intent';
  readonly promotion: RuntimeRecoveryStateProjection;
  readonly userUninstall: RuntimeRecoveryStateProjection;
}

/** Read-only inspection refuses to combine records that changed mid-snapshot. */
export interface BusyRuntimeLeaseStateInspection {
  readonly status: 'busy';
  readonly reason: 'changed-during-inspection';
}

export type RuntimeLeaseStateInspection =
  StableRuntimeLeaseStateInspection | BusyRuntimeLeaseStateInspection;

/** Optional bounded coordination policy for active-key cache-prune inspection. */
export interface ListActiveRuntimeLeaseKeysInput {
  readonly policy?: Partial<RuntimeLeasePolicy>;
  readonly onEvent?: (event: RuntimeLeaseEvent | FileLockEvent) => void;
}

/** Portable Node currently exposes no proven descriptor-relative renameat/unlinkat seam. */
export const COORDINATION_MUTATION_STRATEGY = 'portable-anchored' as const;

export interface CoordinationRecordMutation {
  readonly parentDir: string;
  readonly basename: string;
  readonly operation: 'create' | 'replace' | 'unlink';
  readonly content?: string;
  readonly maxBytes?: number;
  /**
   * Optional caller-observed conflict proof for replace/unlink. Portable Node
   * cannot make the final digest-check-to-rename/unlink window linearizable;
   * callers coordinating multiple writers must hold an external lock.
   */
  readonly expectedContentSha256?: string;
}

/** Fixed recovery-record mutation; parent and basename are never caller-controlled. */
export type RuntimeRecoveryRecordMutation =
  | {
      readonly operation: 'create';
      readonly content: string;
    }
  | {
      readonly operation: 'replace';
      readonly content: string;
      readonly expectedContentSha256: string;
    }
  | {
      readonly operation: 'unlink';
      readonly expectedContentSha256: string;
    };

/** General anchored mutation seam used by coordination and cache metadata. */
export interface AnchoredRecordMutation extends CoordinationRecordMutation {
  /** Existing trusted containment root; it is never created by this primitive. */
  readonly trustedAnchorDir: string;
  /**
   * Coordination uses `private`; cache metadata may use owner-controlled 0755
   * parents while still rejecting group/world-writable directories.
   */
  readonly permissionPosture?: 'private' | 'owner-controlled';
  /** Record permissions; defaults to the parent posture for compatibility. */
  readonly recordPosture?: 'private' | 'owner-controlled';
  /**
   * Operation-bound identity for one deterministic create temporary. When
   * supplied, retry/recovery may reconcile only that exact derived basename.
   */
  readonly createIdentity?: string;
}

interface AnchoredRecordMutationRuntimeOptions {
  /**
   * A fixed coordination pathname may briefly name a two-link successor while
   * another process completes its anchored create. Treat that state as
   * contention; ordinary generic mutations retain the strict single-link rule.
   */
  readonly linkedTargetCanBeBusy?: boolean;
  readonly assertPublicationAllowed?: () => void;
  readonly afterUnlink?: () => void;
  readonly linkedCreateCheckpoint?: (name: LinkedCreateCheckpoint) => void;
  readonly beforeExpectedDigest?: () => void;
  readonly beforeFinalUnlinkIdentity?: () => void;
  readonly beforeFinalUnlink?: () => void;
}

type CoordinationRecordMutationRuntimeOptions = Omit<
  AnchoredRecordMutationRuntimeOptions,
  'assertPublicationAllowed' | 'afterUnlink' | 'linkedCreateCheckpoint'
>;

export type AnchoredLinkedCreateRecovery =
  | {
      /** Explicit authority to settle a linked random-UUID create only. */
      readonly effect: 'settle-linked-create';
      readonly expectedContentSha256: string;
      /** Optional stricter inspection limit; never exceeds the exported cap. */
      readonly maxEntries?: number;
    }
  | {
      /** Also authorizes discard of this operation's exact unlinked temporary. */
      readonly effect: 'settle-or-discard-owned-temporary';
      readonly expectedContentSha256: string;
      readonly createIdentity: string;
      /** Optional stricter inspection limit; never exceeds the exported cap. */
      readonly maxEntries?: number;
    };

export interface AnchoredRecordRead {
  readonly trustedAnchorDir: string;
  readonly parentDir: string;
  readonly basename: string;
  readonly maxBytes?: number;
  readonly permissionPosture?: 'private' | 'owner-controlled';
  /** Record permissions; defaults to the parent posture for compatibility. */
  readonly recordPosture?: 'private' | 'owner-controlled';
  /** Explicit mutation authority for crash-safe linked-create reconciliation. */
  readonly linkedCreateRecovery?: AnchoredLinkedCreateRecovery;
}

export type AnchoredRecordReadResult =
  | { readonly status: 'absent' }
  | {
      readonly status: 'present';
      readonly content: string;
      readonly sha256: string;
    };

interface RecordMetadata {
  readonly ownerToken: string;
  readonly pid: number;
  readonly hostname: string;
  readonly hostIdentityProven: boolean;
  readonly processIncarnation?: string;
  readonly command: string;
  readonly cwdBasename: string;
  readonly acquiredAt: number;
  readonly lastHeartbeatAt: number;
  /** Owner-selected bounded expiry horizon; contenders must never shorten it. */
  readonly staleMs: number;
  readonly sequence: number;
}

interface ReaderRecord extends RecordMetadata {
  readonly version: 1;
  readonly dimension: 'project' | 'user';
  readonly refs: number;
  readonly references: readonly string[];
}

interface WriterRecord extends RecordMetadata {
  readonly kind: 'project' | 'global';
  readonly coordinationKey?: string;
  readonly phase: 'queued' | 'intent';
}

interface LeaseStateFile {
  readonly version: 1;
  readonly nextSequence: number;
  readonly writers: readonly WriterRecord[];
}

// Bound once at module load so a typo is a load-time failure rather than a runtime one on a
// path that only executes when something has already gone wrong.
const UNSAFE_STATE = coreErrorCatalog.require('CORE.RUNTIME_COORDINATION.UNSAFE_STATE');
const PROBE_FAILED = coreErrorCatalog.require('CORE.RUNTIME_COORDINATION.PROBE_FAILED');
const CORRUPT_RECORD = coreErrorCatalog.require('CORE.RUNTIME_COORDINATION.CORRUPT_RECORD');
const COORDINATION_CONFLICT = coreErrorCatalog.require('CORE.RUNTIME_COORDINATION.CONFLICT');
const COORDINATION_BUSY = coreErrorCatalog.require('CORE.RUNTIME_COORDINATION.BUSY');
const COORDINATION_INPUT = coreErrorCatalog.require('CORE.RUNTIME_COORDINATION.INPUT');
const LEASE_CAPACITY = coreErrorCatalog.require('CORE.RUNTIME_LEASE.CAPACITY');
const RECOVERY_REQUIRED = coreErrorCatalog.require('CORE.RUNTIME_RECOVERY.REQUIRED');
const COORDINATION_MUTEX_TIMEOUT = coreErrorCatalog.require('CORE.RUNTIME_COORDINATION.MUTEX');

/**
 * The coordination root is in a state this process refuses to touch.
 *
 * `security` kind: a foreign entry, a symlinked segment, an unexpected owner or a permission
 * posture that cannot be secured are CONTAINMENT refusals, and fail-closed is the guard
 * working. Under the previous `SYSTEM.RUNTIME_COORDINATION.UNSAFE` literal — which had no
 * catalog entry and fell through `legacyFamilyCode`'s `SYSTEM` head to `SYSTEM_ERROR` — every
 * one of them was reported as `kind: 'invariant'`, `retry: 'never'`, "report a bug".
 *
 * The siblings below exist because this one code was carrying ~115 distinct conditions.
 */
function unsafeCoordination(message: string, condition?: string): ToolError {
  return createToolError(UNSAFE_STATE, message, condition ? { metadata: { condition } } : {});
}

/**
 * A filesystem probe the coordination walk depends on failed for a reason other than absence.
 *
 * Reported as UNSAFE before, which made a transient `EACCES` or `EMFILE` indistinguishable
 * from a genuinely hostile directory — and the enclosing retry then reinterpreted it as
 * "changed during inspection" and retried forever.
 */
function coordinationProbeFailed(message: string, condition?: string): ToolError {
  return createToolError(PROBE_FAILED, message, condition ? { metadata: { condition } } : {});
}

/**
 * A persisted coordination record is structurally invalid.
 *
 * `integrity`, distinct from `unsafeCoordination`: the filesystem is behaving, the RECORD is
 * wrong. That is what lets support tell tampering or a partial write from a hostile mount,
 * and the recovery differs — remove the record, rather than inspect the directory.
 */
function corruptCoordinationRecord(message: string, condition?: string): ToolError {
  return createToolError(CORRUPT_RECORD, message, condition ? { metadata: { condition } } : {});
}

/**
 * A normal, expected precondition blocks this operation.
 *
 * An active maintenance writer or a pending uninstall receipt is routine contention. Raising
 * it as a security verdict forced the prune caller to treat "someone else is working" as
 * corruption.
 */
function coordinationConflict(message: string, condition?: string): ToolError {
  return createToolError(
    COORDINATION_CONFLICT,
    message,
    condition ? { metadata: { condition } } : {},
  );
}

/**
 * A caller passed an unusable value to the coordination API.
 *
 * `tool-author` / `validation`: reachable only from an untyped JS caller or a caller bug,
 * never from user configuration. A distinct code lets a caller pre-empt the refusal instead
 * of parsing a message.
 */
function coordinationInputInvalid(message: string, field?: string): ToolError {
  return createToolError(COORDINATION_INPUT, message, field ? { metadata: { field } } : {});
}

/**
 * A bounded coordination registry is full.
 *
 * `resource` / `caller-policy`, not `invariant` / `never`: these bounds are reached by
 * legitimate nesting and by contention, so the caller needs a policy handle rather than a bug
 * report. The anti-DoS bound is doing its job when this fires.
 */
function coordinationCapacity(message: string, bound?: string): ToolError {
  return createToolError(LEASE_CAPACITY, message, bound ? { metadata: { bound } } : {});
}

/**
 * Resolve a project coordination key at a boundary where the project dimension is mandatory.
 *
 * @throws {SystemError} When project coordination state omits or corrupts its required key.
 */
function requiredProjectCoordinationKey(value: string | undefined): string {
  if (value === undefined || !PROJECT_KEY_PATTERN.test(value)) {
    throw coordinationInputInvalid('Project runtime coordination key is missing or invalid', 'key');
  }
  return value;
}

/**
 * Transient contention: another holder is doing the same work right now.
 *
 * The ledger calls this class "the single migration point", and it is: 35 constructions and
 * ten `instanceof` branches depend on it, so re-pointing the definition fixes all of them at
 * once. The class STAYS — every caller that branches on it keeps working — but it no longer
 * resolves to `SYSTEM_ERROR`, whose `retry: 'never'` contradicted the very reason the type
 * exists. The retry loops around it had to special-case the class precisely because the
 * definition said the opposite of what the type meant.
 */
class RuntimeSnapshotChangedError extends SystemError {
  constructor(message: string) {
    super(message, { code: COORDINATION_BUSY.code, definition: COORDINATION_BUSY });
  }
}

/**
 * An interrupted `init` / `uninstall` journal blocks this operation until recovery runs.
 *
 * The code resolved to the CONFIGURATION_ERROR family, whose operator action is "Check
 * opensip-cli.config.yml and CLI flags" — wrong, and actively misleading, for a state whose
 * only forward path is the recovery command. This is the module's most user-visible refusal
 * and the actionable step existed only inside the message.
 *
 * The class stays `ConfigurationError` so the exit code is unchanged (the subclass ladder
 * short-circuits before `definition.exitClass`); only the axes and the operator action move.
 */
function recoveryRequired(message: string): ConfigurationError {
  return new ConfigurationError(message, {
    code: RECOVERY_REQUIRED.code,
    definition: RECOVERY_REQUIRED,
  });
}

/**
 * Registered timeout definition per lease wait kind.
 *
 * Replaces `code: \`TIMEOUT.${kind.toUpperCase().replaceAll('-', '_')}\`` — a dynamically
 * minted TWO-segment code, which `CODE_GRAMMAR` rejects, so none of these could ever be
 * registered and all five inherited the generic `TIMEOUT` axes. An explicit map also means a
 * new wait kind is a compile error here rather than a silently unregistered code at runtime.
 */
const LEASE_WAIT_TIMEOUTS: Record<RuntimeLeaseWaitKind, ErrorDefinition> = {
  'runtime-read': coreErrorCatalog.require('CORE.RUNTIME_LEASE.READ'),
  'runtime-exclusive': coreErrorCatalog.require('CORE.RUNTIME_LEASE.EXCLUSIVE'),
  'runtime-access-composite': coreErrorCatalog.require('CORE.RUNTIME_LEASE.ACCESS_COMPOSITE'),
  'user-state-read': coreErrorCatalog.require('CORE.RUNTIME_LEASE.USER_STATE_READ'),
  'runtime-global-maintenance': coreErrorCatalog.require('CORE.RUNTIME_LEASE.GLOBAL_MAINTENANCE'),
};

function timeoutError(kind: RuntimeLeaseWaitKind, waitMs: number): TimeoutError {
  const guidance =
    kind === 'runtime-exclusive' || kind === 'runtime-global-maintenance'
      ? ' Stop or reconnect long-lived OpenSIP processes (including `opensip mcp`) and retry.'
      : '';
  const definition = LEASE_WAIT_TIMEOUTS[kind];
  return new TimeoutError(
    `Timed out waiting for ${kind} coordination after ${waitMs}ms.${guidance}`,
    { code: definition.code, definition, metadata: { waitMs } },
  );
}

/** @throws {Error} Always rethrows the input error or maps a coordination timeout. */
function mapCoordinationTimeout(error: unknown, kind: RuntimeLeaseWaitKind, waitMs: number): never {
  if (error instanceof TimeoutError && error.code === 'CORE.RUNTIME_COORDINATION.MUTEX') {
    throw timeoutError(kind, waitMs);
  }
  throw error;
}

function boundedPolicyDuration(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate < 0) {
    throw new SystemError(`Runtime lease ${field} policy is invalid`, {
      code: 'CORE.RUNTIME_LEASE.INVALID_POLICY',
    });
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(candidate)));
}

/** @throws {SystemError} When the requested record-size bound is invalid. */
function boundedRecordSize(value: number | undefined): number {
  const candidate = value ?? MAX_RECORD_BYTES;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > ANCHORED_RECORD_MAX_BYTES) {
    throw coordinationInputInvalid('Anchored record size bound is invalid', 'bound');
  }
  return candidate;
}

/** @throws {SystemError} When the requested recovery-scan bound is invalid. */
function boundedAnchoredRecoveryEntries(value: number | undefined): number {
  const candidate = value ?? ANCHORED_CREATE_RECOVERY_MAX_ENTRIES;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > ANCHORED_CREATE_RECOVERY_MAX_ENTRIES
  ) {
    throw coordinationInputInvalid('Anchored create recovery entry bound is invalid', 'bound');
  }
  return candidate;
}

/** @throws {SystemError} When an anchored-record permission posture is invalid. */
function anchoredPermissionPosture(
  value: 'private' | 'owner-controlled' | undefined,
  fallback: 'private' | 'owner-controlled',
  field: string,
): 'private' | 'owner-controlled' {
  const candidate = value ?? fallback;
  if (candidate !== 'private' && candidate !== 'owner-controlled') {
    throw coordinationInputInvalid(`Anchored record ${field} is invalid`, 'field');
  }
  return candidate;
}

function normalizePolicy(policy?: Partial<RuntimeLeasePolicy>): RuntimeLeasePolicy {
  const heartbeatMs = boundedPolicyDuration(
    policy?.heartbeatMs,
    DEFAULT_RUNTIME_LEASE_POLICY.heartbeatMs,
    MIN_HEARTBEAT_MS,
    MAX_HEARTBEAT_MS,
    'heartbeatMs',
  );
  return {
    waitMs: boundedPolicyDuration(
      policy?.waitMs,
      DEFAULT_RUNTIME_LEASE_POLICY.waitMs,
      0,
      MAX_WAIT_MS,
      'waitMs',
    ),
    staleMs: boundedPolicyDuration(
      policy?.staleMs,
      DEFAULT_RUNTIME_LEASE_POLICY.staleMs,
      heartbeatMs * 3,
      MAX_STALE_MS,
      'staleMs',
    ),
    heartbeatMs,
    pollMs: boundedPolicyDuration(
      policy?.pollMs,
      DEFAULT_RUNTIME_LEASE_POLICY.pollMs,
      1,
      MAX_POLL_MS,
      'pollMs',
    ),
  };
}

function safeText(value: string | undefined, fallback: string, maxBytes = MAX_SAFE_TEXT): string {
  let candidate = '';
  for (const character of value ?? fallback) {
    const code = character.codePointAt(0) ?? 0;
    const sanitized = code < 32 || code === 127 ? '?' : character;
    if (Buffer.byteLength(candidate + sanitized, 'utf8') > maxBytes) break;
    candidate += sanitized;
  }
  if (candidate.length > 0) return candidate;
  return Buffer.from(fallback, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function noHostInstanceIdentity(): string | undefined {
  return;
}

interface RuntimeHostIdentity {
  readonly id: string;
  readonly proven: boolean;
}

function runtimeHostIdentity(environment: RuntimeLeaseEnvironment): RuntimeHostIdentity {
  return deriveHostIdentity(environment.hostname(), environment.hostInstanceIdentity());
}

function sameProvenRuntimeHost(
  record: { readonly hostname: string; readonly hostIdentityProven: boolean },
  environment: RuntimeLeaseEnvironment,
): boolean {
  const local = runtimeHostIdentity(environment);
  return record.hostIdentityProven && local.proven && record.hostname === local.id;
}

interface ProcessInspectionCache {
  readonly present: Map<number, ProcessIncarnationInspection & { readonly status: 'present' }>;
  readonly maxProbes: number;
  probes: number;
}

function boundedProcessInspectionBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_CACHED_PROCESS_INSPECTIONS;
  return Math.min(MAX_CACHED_PROCESS_INSPECTIONS, Math.max(1, Math.floor(value)));
}

function createProcessInspectionCache(maxProbes?: number): ProcessInspectionCache {
  return {
    present: new Map(),
    maxProbes: boundedProcessInspectionBudget(maxProbes),
    probes: 0,
  };
}

function inspectProcessForStaleScan(
  pid: number,
  environment: RuntimeLeaseEnvironment,
  cache?: ProcessInspectionCache,
  fresh = false,
): ProcessIncarnationInspection {
  if (cache === undefined) return environment.inspectProcessIncarnation(pid);
  if (!fresh) {
    const cached = cache.present.get(pid);
    if (cached !== undefined) return cached;
  }
  if (cache.probes >= cache.maxProbes) {
    // Preserve excess owners rather than performing an unbounded number of
    // synchronous platform probes while the coordination mutex is held.
    return { status: 'unknown' };
  }
  cache.probes += 1;
  const inspection = environment.inspectProcessIncarnation(pid);
  if (!fresh && inspection.status === 'present') cache.present.set(pid, inspection);
  // Absence is deliberately not cached. A fresh probe is required immediately
  // before exact stale-record deletion.
  return inspection;
}

function ownedByRuntimeProcess(
  record: {
    readonly pid: number;
    readonly hostname: string;
    readonly hostIdentityProven: boolean;
    readonly processIncarnation?: string;
  },
  environment: RuntimeLeaseEnvironment,
): boolean {
  const local = runtimeHostIdentity(environment);
  const currentProcess =
    record.processIncarnation === undefined
      ? undefined
      : environment.inspectProcessIncarnation(environment.pid);
  return (
    record.pid === environment.pid &&
    record.hostname === local.id &&
    record.hostIdentityProven === local.proven &&
    (record.processIncarnation === undefined ||
      (currentProcess?.status === 'present' &&
        currentProcess.identity === record.processIncarnation))
  );
}

function currentProcessIncarnation(environment: RuntimeLeaseEnvironment): string | undefined {
  const processIdentity = environment.inspectProcessIncarnation(environment.pid);
  return processIdentity.status === 'present' ? processIdentity.identity : undefined;
}

function sameHostOwnerIsStale(
  record: {
    readonly pid: number;
    readonly processIncarnation?: string;
  },
  environment: RuntimeLeaseEnvironment,
  processInspectionCache?: ProcessInspectionCache,
  freshProcessProof = false,
): boolean {
  if (record.processIncarnation === undefined) {
    // Legacy/unproven process records retain the conservative ESRCH-only rule.
    return !environment.isProcessAlive(record.pid);
  }
  const current = inspectProcessForStaleScan(
    record.pid,
    environment,
    processInspectionCache,
    freshProcessProof,
  );
  if (current.status === 'absent') return true;
  if (current.status === 'unknown') return false;
  return current.identity !== record.processIncarnation;
}

function validateOwnerToken(ownerToken: string): void {
  if (!OWNER_TOKEN_PATTERN.test(ownerToken)) {
    throw new SystemError('Runtime lease owner token is invalid', {
      code: 'CORE.RUNTIME_LEASE.INVALID_OWNER',
    });
  }
}

function validateOperationId(operationId: string | undefined): operationId is string {
  return operationId !== undefined && OPERATION_ID_PATTERN.test(operationId);
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function isContainedPath(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface RecordIdentity extends DirectoryIdentity {
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/** @throws {SystemError} When a coordination directory fails its identity or permission proof. */
function assertDirectory(
  path: string,
  root?: string,
  permissionPosture: 'private' | 'owner-controlled' = 'private',
): DirectoryIdentity {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch {
    throw coordinationProbeFailed('Runtime coordination directory is unavailable', 'probe');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1n) {
    throw unsafeCoordination('Runtime coordination directory has an unsafe type');
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== BigInt(uid)) {
    throw unsafeCoordination('Runtime coordination directory has an unexpected owner');
  }
  const mode = Number(stat.mode & 0o777n);
  if (
    process.platform !== 'win32' &&
    // Owner-controlled hops are uid-verified above; group-write is the normal
    // umask-002 customer layout, so only other-write is refused (scoped
    // group-controlled posture). Private coordination dirs stay exactly 0700.
    (permissionPosture === 'private' ? mode !== 0o700 : (mode & 0o002) !== 0)
  ) {
    throw unsafeCoordination(
      permissionPosture === 'private'
        ? 'Runtime coordination directory permissions must be 0700'
        : 'Anchored directory must not be world writable',
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw coordinationProbeFailed(
      'Runtime coordination directory cannot be canonicalized',
      'probe',
    );
  }
  if (root !== undefined) {
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(root);
    } catch {
      throw coordinationProbeFailed('Runtime coordination root cannot be canonicalized', 'probe');
    }
    if (!isContainedPath(canonical, canonicalRoot)) {
      throw unsafeCoordination('Runtime coordination directory escapes its trusted root');
    }
  }
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function recordIdentity(stat: BigIntStats): RecordIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameRecordIdentity(left: RecordIdentity, right: RecordIdentity): boolean {
  return (
    sameIdentity(left, right) &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** @throws {SystemError} When coordination-record metadata violates its configured bounds. */
function assertRecordStatMetadata(
  stat: BigIntStats,
  maxBytes: number | undefined,
  permissionPosture: 'private' | 'owner-controlled' = 'private',
): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw unsafeCoordination('Runtime coordination record has an unsafe type');
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== BigInt(uid)) {
    throw unsafeCoordination('Runtime coordination record has an unexpected owner');
  }
  const mode = Number(stat.mode & 0o777n);
  if (
    process.platform !== 'win32' &&
    // Same scoped posture as assertDirectory: uid-verified owner-controlled
    // records accept group-write (umask 002); other-write is refused.
    (permissionPosture === 'private' ? mode !== 0o600 : (mode & 0o002) !== 0)
  ) {
    throw unsafeCoordination(
      permissionPosture === 'private'
        ? 'Runtime coordination record permissions must be 0600'
        : 'Anchored record must not be world writable',
    );
  }
  if (maxBytes !== undefined && stat.size > BigInt(maxBytes)) {
    throw coordinationCapacity('Runtime coordination record exceeds its size bound', 'bytes');
  }
}

/** @throws {SystemError} When a coordination record is not a safe single-link regular file. */
function assertRegularRecordStat(
  stat: BigIntStats,
  maxBytes: number | undefined,
  permissionPosture: 'private' | 'owner-controlled' = 'private',
): void {
  assertRecordStatMetadata(stat, maxBytes, permissionPosture);
  if (stat.nlink !== 1n) {
    throw corruptCoordinationRecord(
      'Runtime coordination record has an unsafe link count',
      'link-count',
    );
  }
}

/** @throws {SystemError} When a coordination record is absent or fails its safety proof. */
function assertRegularRecord(
  path: string,
  maxBytes: number,
  permissionPosture: 'private' | 'owner-controlled' = 'private',
): void {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch {
    throw coordinationProbeFailed('Runtime coordination record is unavailable', 'probe');
  }
  assertRegularRecordStat(stat, maxBytes, permissionPosture);
}

/** @throws {SystemError} When a private coordination directory cannot be created and proven. */
function mkdirSecure(path: string, root?: string): void {
  let created = false;
  try {
    mkdirSync(path, { recursive: false, mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (created && process.platform !== 'win32') {
    try {
      chmodSync(path, 0o700);
    } catch {
      throw unsafeCoordination('Runtime coordination directory permissions cannot be secured');
    }
  }
  assertDirectory(path, root);
}

function readDirectoryBounded(path: string, cap: number, description: string): readonly string[] {
  const directory = opendirSync(path);
  const entries: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) return entries;
      entries.push(entry.name);
      if (entries.length > cap) {
        throw coordinationCapacity(`${description} exceeds its entry bound`, 'entries');
      }
    }
  } finally {
    directory.closeSync();
  }
}

/** @throws {SystemError} When an existing coordination path cannot be safely inspected. */
function lstatIfPresent(path: string, description: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw coordinationProbeFailed(`${description} cannot be inspected`, 'probe');
  }
}

/** @throws {SystemError} When a private coordination record has an unsafe filesystem posture. */
function assertPrivateRecordEntry(
  path: string,
  maxBytes: number | undefined,
  allowedLinks: readonly bigint[] = [1n],
  allowConcurrentAbsence = false,
): BigIntStats | undefined {
  const stat = lstatIfPresent(path, 'Runtime coordination record');
  if (stat === undefined && allowConcurrentAbsence) return undefined;
  if (
    stat === undefined ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !allowedLinks.includes(stat.nlink) ||
    (maxBytes !== undefined && stat.size > BigInt(maxBytes))
  ) {
    // Mutex/create temps can briefly look malformed while another process is
    // publishing or unlinking them. Concurrent absence paths treat that as
    // contention rather than permanent corruption of the coordination root.
    if (allowConcurrentAbsence) {
      throw new RuntimeSnapshotChangedError(
        'Runtime coordination temporary record changed during inspection',
      );
    }
    throw corruptCoordinationRecord(
      'Runtime coordination record has an unsafe type, size, or link count',
      'record-shape',
    );
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== BigInt(uid)) {
    throw unsafeCoordination('Runtime coordination record has an unexpected owner');
  }
  if (process.platform !== 'win32' && Number(stat.mode & 0o777n) !== 0o600) {
    throw unsafeCoordination('Runtime coordination record permissions must be 0600');
  }
  return stat;
}

/** @throws {SystemError} When a reader directory contains unbounded or unexpected entries. */
function validateReaderDirectoryEntries(
  readersDir: string,
  coordinationRoot: string,
  guard?: RuntimeMutexGuard,
): readonly string[] {
  assertDirectory(readersDir, coordinationRoot);
  const entries = readDirectoryBounded(
    readersDir,
    MAX_READERS_PER_DIMENSION * 2,
    'Runtime reader directory',
  );
  for (const [index, entry] of entries.entries()) {
    if (index % 16 === 0) guard?.refresh();
    if (READER_FILE_PATTERN.test(entry)) {
      assertPrivateRecordEntry(join(readersDir, entry), MAX_RECORD_BYTES);
    } else if (READER_TEMP_FILE_PATTERN.test(entry)) {
      assertPrivateRecordEntry(join(readersDir, entry), MAX_RECORD_BYTES, [1n, 2n]);
    } else {
      throw unsafeCoordination('Runtime reader directory contains an unexpected entry');
    }
  }
  return entries;
}

/** @throws {SystemError} When a project coordination directory is incomplete or malformed. */
function validateProjectCoordinationEntries(
  paths: CoordinationPaths,
  coordinationKey: string,
  guard?: RuntimeMutexGuard,
): void {
  guard?.refresh();
  const projectPaths = paths.forProject(coordinationKey);
  assertDirectory(projectPaths.projectCoordinationDir, paths.coordinationDir);
  const entries = readDirectoryBounded(
    projectPaths.projectCoordinationDir,
    MAX_MUTEX_TEMPS + 2,
    'Runtime project coordination directory',
  );
  let hasReaders = false;
  for (const entry of entries) {
    if (entry === 'readers') {
      hasReaders = true;
      validateReaderDirectoryEntries(projectPaths.readersDir, paths.coordinationDir, guard);
    } else if (entry === RUNTIME_PROMOTION_JOURNAL_FILE) {
      // The fixed header may be oversize after a crash/corrupt write. Its
      // posture-specific inspector classifies that state without reading it,
      // so destructive recovery remains reachable.
      assertPrivateRecordEntry(projectPaths.promotionJournalFile, undefined, [1n, 2n]);
    } else if (PROJECT_ENTRY_PATTERN.test(entry)) {
      assertPrivateRecordEntry(
        join(projectPaths.projectCoordinationDir, entry),
        RUNTIME_RECOVERY_RECORD_MAX_BYTES,
        [1n, 2n],
      );
      if (guard !== undefined) {
        const targetBasename = PROJECT_TRANSITION_TEMP_FILE_PATTERN.exec(entry)?.[1];
        if (targetBasename !== undefined) {
          reconcileOrphanedTransitionTemp(
            projectPaths.projectCoordinationDir,
            entry,
            targetBasename,
            RUNTIME_RECOVERY_RECORD_MAX_BYTES,
            guard,
          );
        }
      }
    } else {
      throw unsafeCoordination(
        'Runtime project coordination directory contains an unexpected entry',
      );
    }
  }
  if (!hasReaders) {
    throw corruptCoordinationRecord(
      'Runtime project coordination directory is incomplete',
      'incomplete',
    );
  }
}

/** @throws {SystemError} When the coordination root contains an unsafe entry set. */
function validateCoordinationRootEntries(
  paths: CoordinationPaths,
  guard?: RuntimeMutexGuard,
): void {
  const entries = readDirectoryBounded(
    paths.coordinationDir,
    MAX_MUTEX_TEMPS + 8,
    'Runtime coordination root',
  );
  for (const [index, entry] of entries.entries()) {
    if (index % 16 === 0) guard?.refresh();
    const path = join(paths.coordinationDir, entry);
    if (entry === 'projects') {
      assertDirectory(path, paths.coordinationDir);
    } else if (entry === 'user-readers') {
      validateReaderDirectoryEntries(path, paths.coordinationDir, guard);
    } else if (
      entry === 'coordination.lock' ||
      entry === 'state.json' ||
      entry === USER_UNINSTALL_RECEIPT_FILE
    ) {
      assertPrivateRecordEntry(
        path,
        entry === USER_UNINSTALL_RECEIPT_FILE ? undefined : MAX_RECORD_BYTES,
        [1n, 2n],
      );
    } else if (ROOT_ENTRY_PATTERN.test(entry)) {
      assertPrivateRecordEntry(
        path,
        entry.includes(USER_UNINSTALL_RECEIPT_FILE)
          ? RUNTIME_RECOVERY_RECORD_MAX_BYTES
          : MAX_RECORD_BYTES,
        [1n, 2n],
        entry.startsWith('.coordination.lock.tmp-'),
      );
      if (guard !== undefined) {
        if (MUTEX_TEMP_FILE_PATTERN.test(entry)) {
          reconcileOrphanedMutexTemp(paths, entry, guard);
        } else {
          const targetBasename = ROOT_TRANSITION_TEMP_FILE_PATTERN.exec(entry)?.[1];
          if (targetBasename !== undefined) {
            reconcileOrphanedTransitionTemp(
              paths.coordinationDir,
              entry,
              targetBasename,
              targetBasename === USER_UNINSTALL_RECEIPT_FILE
                ? RUNTIME_RECOVERY_RECORD_MAX_BYTES
                : MAX_RECORD_BYTES,
              guard,
            );
          }
        }
      }
    } else {
      throw unsafeCoordination('Runtime coordination root contains an unexpected entry');
    }
  }
}

function ensureCoordinationScaffold(): CoordinationPaths {
  const paths = resolveCoordinationPaths();
  mkdirSecure(paths.coordinationDir);
  mkdirSecure(paths.projectsDir, paths.coordinationDir);
  mkdirSecure(paths.userReadersDir, paths.coordinationDir);
  return paths;
}

/** @throws {SystemError} When the project scaffold cannot be created and proven safely. */
function ensureProjectScaffold(
  paths: CoordinationPaths,
  coordinationKey: string,
  guard?: RuntimeMutexGuard,
): void {
  if (!PROJECT_KEY_PATTERN.test(coordinationKey)) {
    throw coordinationInputInvalid('Runtime coordination key is invalid', 'key');
  }
  const projectPaths = paths.forProject(coordinationKey);
  const projectStat = lstatIfPresent(
    projectPaths.projectCoordinationDir,
    'Runtime project coordination state',
  );
  const projectExists = projectStat !== undefined;
  if (projectStat !== undefined) {
    assertDirectory(projectPaths.projectCoordinationDir, paths.coordinationDir);
    const entries = readDirectoryBounded(
      projectPaths.projectCoordinationDir,
      MAX_MUTEX_TEMPS + 2,
      'Runtime project coordination directory',
    );
    if (!entries.includes('readers') && entries.length === 0) {
      // A process can stop between creating the key directory and its readers
      // directory (including cleanup stopping between the inverse operations).
      // Repair only the uniquely provable empty scaffold, while holding the
      // coordination mutex. Any content makes the state ambiguous and the
      // ordinary validator below fails closed.
      if (guard === undefined) {
        throw corruptCoordinationRecord(
          'Runtime project coordination directory is incomplete',
          'incomplete',
        );
      }
      guard.refresh();
      mkdirSecure(projectPaths.readersDir, paths.coordinationDir);
    }
  }
  let existingKeys = listProjectCoordinationKeys(paths, guard);
  if (!projectExists && existingKeys.length >= MAX_PROJECT_KEYS && guard !== undefined) {
    const cleanupPolicy = normalizePolicy({ waitMs: 250 });
    for (const existingKey of existingKeys) {
      guard.refresh();
      cleanupEmptyRuntimeLeaseKeyWhileOwned(
        paths,
        existingKey,
        cleanupPolicy,
        DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
        guard,
      );
      if (
        readDirectoryBounded(paths.projectsDir, MAX_PROJECT_KEYS, 'Runtime coordination projects')
          .length < MAX_PROJECT_KEYS
      ) {
        break;
      }
    }
    existingKeys = listProjectCoordinationKeys(paths, guard);
  }
  if (!projectExists && existingKeys.length >= MAX_PROJECT_KEYS) {
    throw new SystemError('Runtime project coordination capacity is exhausted', {
      code: 'CORE.RUNTIME_LEASE.CAPACITY',
    });
  }
  guard?.refresh();
  mkdirSecure(projectPaths.projectCoordinationDir, paths.coordinationDir);
  guard?.refresh();
  mkdirSecure(projectPaths.readersDir, paths.coordinationDir);
  validateProjectCoordinationEntries(paths, coordinationKey, guard);
}

/** @throws {SystemError} When the parent directory cannot be opened with a stable identity. */
function openParentIdentity(
  parentDir: string,
  root: string,
): {
  readonly fd: number;
  readonly identity: DirectoryIdentity;
} {
  const validated = assertDirectory(parentDir, root);
  const fd = openSync(parentDir, 'r');
  try {
    const stat = fstatSync(fd, { bigint: true });
    const opened = { dev: stat.dev, ino: stat.ino };
    const uid = currentUid();
    if (
      !stat.isDirectory() ||
      !sameIdentity(validated, opened) ||
      (uid !== undefined && stat.uid !== BigInt(uid)) ||
      (process.platform !== 'win32' && Number(stat.mode & 0o777n) !== 0o700)
    ) {
      throw unsafeCoordination('Runtime coordination parent changed before its handle was opened');
    }
    return { fd, identity: opened };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** @throws {SystemError} When an anchored parent cannot be opened and proven contained. */
function openAnchoredParentIdentity(
  parentDir: string,
  root: string,
  permissionPosture: 'private' | 'owner-controlled',
): {
  readonly fd: number;
  readonly identity: DirectoryIdentity;
} {
  assertNoFollowDirectoryWalk(parentDir, root, permissionPosture);
  const validated = assertDirectory(parentDir, root, permissionPosture);
  const fd = openSync(parentDir, 'r');
  try {
    const stat = fstatSync(fd, { bigint: true });
    const opened = { dev: stat.dev, ino: stat.ino };
    const uid = currentUid();
    const mode = Number(stat.mode & 0o777n);
    if (
      !stat.isDirectory() ||
      !sameIdentity(validated, opened) ||
      (uid !== undefined && stat.uid !== BigInt(uid)) ||
      (process.platform !== 'win32' &&
        (permissionPosture === 'private' ? mode !== 0o700 : (mode & 0o002) !== 0))
    ) {
      throw unsafeCoordination('Anchored parent changed before its handle was opened');
    }
    return { fd, identity: opened };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** @throws {SystemError} When a no-follow directory walk changes identity or escapes its anchor. */
function assertNoFollowDirectoryWalk(
  parentDir: string,
  root: string,
  permissionPosture: 'private' | 'owner-controlled',
): void {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    throw coordinationProbeFailed('Anchored root cannot be canonicalized', 'probe');
  }
  const rel = relative(root, parentDir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw unsafeCoordination('Anchored parent escapes its trusted root');
  }
  assertDirectory(root, undefined, permissionPosture);
  let cursor = root;
  if (rel === '') return;
  for (const segment of rel.split(sep)) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw coordinationInputInvalid('Anchored parent contains an invalid segment', 'segment');
    }
    cursor = join(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch {
      throw coordinationProbeFailed(
        'Anchored directory walk encountered an unavailable component',
        'probe',
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw unsafeCoordination('Anchored directory walk encountered a symlink or non-directory');
    }
    assertDirectory(cursor, root, permissionPosture);
  }
  let canonicalCursor: string;
  let canonicalParent: string;
  try {
    canonicalCursor = realpathSync(cursor);
    canonicalParent = realpathSync(parentDir);
  } catch {
    throw coordinationProbeFailed('Anchored parent cannot be canonicalized', 'probe');
  }
  if (canonicalCursor !== canonicalParent || !isContainedPath(canonicalCursor, canonicalRoot)) {
    throw unsafeCoordination('Anchored directory walk changed during validation');
  }
}

/** @throws {SystemError} When a coordination parent changes during mutation. */
function assertParentUnchanged(
  fd: number,
  before: DirectoryIdentity,
  parentDir: string,
  root: string,
): void {
  const handle = fstatSync(fd, { bigint: true });
  const fromHandle = { dev: handle.dev, ino: handle.ino };
  const fromPath = assertDirectory(parentDir, root);
  if (!sameIdentity(before, fromHandle) || !sameIdentity(before, fromPath)) {
    throw unsafeCoordination('Runtime coordination parent changed during mutation');
  }
}

/** @throws {SystemError} When an anchored parent changes during mutation. */
function assertAnchoredParentUnchanged(
  fd: number,
  before: DirectoryIdentity,
  parentDir: string,
  root: string,
  permissionPosture: 'private' | 'owner-controlled',
): void {
  const handle = fstatSync(fd, { bigint: true });
  const fromHandle = { dev: handle.dev, ino: handle.ino };
  const fromPath = assertDirectory(parentDir, root, permissionPosture);
  if (!sameIdentity(before, fromHandle) || !sameIdentity(before, fromPath)) {
    throw unsafeCoordination('Anchored parent changed during mutation');
  }
}

/** @throws {SystemError} When a record basename could escape or alias its intended parent. */
function assertSafeBasename(value: string): void {
  if (
    value.length === 0 ||
    value.length > 180 ||
    basename(value) !== value ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value === '.' ||
    value === '..'
  ) {
    throw coordinationInputInvalid('Runtime coordination record basename is invalid', 'basename');
  }
}

/**
 * Derive the one deterministic temporary basename owned by an anchored create.
 * Callers persist `createIdentity`; Core owns and validates the path grammar.
 *
 * @throws {SystemError} When the target or operation identity is not a safe basename component.
 */
export function anchoredRecordTemporaryBasename(
  basenameValue: string,
  createIdentity: string,
): string {
  assertSafeBasename(basenameValue);
  if (!ANCHORED_CREATE_IDENTITY_PATTERN.test(createIdentity)) {
    throw coordinationInputInvalid('Anchored create identity is invalid', 'identity');
  }
  const temporary = `.${basenameValue}.tmp-${createIdentity}`;
  if (Buffer.byteLength(temporary, 'utf8') > ANCHORED_TEMP_BASENAME_MAX_BYTES) {
    throw coordinationInputInvalid('Anchored create temporary basename is too long', 'basename');
  }
  return temporary;
}

/** @throws {SystemError} When an existing record cannot be inspected or proven safe. */
function targetIdentity(
  path: string,
  maxBytes: number,
  permissionPosture: 'private' | 'owner-controlled' = 'private',
  linkedCreateCanBeBusy = false,
): RecordIdentity | undefined {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw coordinationProbeFailed('Runtime coordination record cannot be inspected', 'probe');
  }
  if (linkedCreateCanBeBusy && (stat.nlink === 0n || stat.nlink === 2n)) {
    assertRecordStatMetadata(stat, maxBytes, permissionPosture);
    throw new RuntimeSnapshotChangedError('Anchored create publication is still in progress');
  }
  assertRegularRecordStat(stat, maxBytes, permissionPosture);
  return recordIdentity(stat);
}

function fsyncParent(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && (code === 'EINVAL' || code === 'ENOTSUP')) return;
    throw error;
  }
}

/** @throws {Error} When an exclusive coordination record cannot be safely published. */
function createExclusiveRecord(
  path: string,
  content: string,
  permissionPosture: 'private' | 'owner-controlled' = 'private',
): RecordIdentity {
  let fd: number | undefined;
  let identity: RecordIdentity | undefined;
  let openedIdentity: DirectoryIdentity | undefined;
  const desiredMode = permissionPosture === 'private' ? 0o600 : 0o644;
  try {
    fd = openSync(path, 'wx', desiredMode);
    const opened = fstatSync(fd, { bigint: true });
    openedIdentity = { dev: opened.dev, ino: opened.ino };
    if (process.platform !== 'win32') fchmodSync(fd, desiredMode);
    writeFileSync(fd, content, 'utf8');
    const stat = fstatSync(fd, { bigint: true });
    const uid = currentUid();
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.size !== BigInt(Buffer.byteLength(content, 'utf8')) ||
      (uid !== undefined && stat.uid !== BigInt(uid)) ||
      (process.platform !== 'win32' && Number(stat.mode & 0o777n) !== desiredMode)
    ) {
      throw corruptCoordinationRecord(
        'Anchored create could not prove its temporary record',
        'unproven-temp',
      );
    }
    fsyncSync(fd);
    identity = recordIdentity(fstatSync(fd, { bigint: true }));
  } catch (error) {
    if (fd !== undefined && openedIdentity !== undefined) {
      try {
        const descriptor = fstatSync(fd, { bigint: true });
        const target = lstatSync(path, { bigint: true });
        if (
          descriptor.dev === openedIdentity.dev &&
          descriptor.ino === openedIdentity.ino &&
          target.dev === openedIdentity.dev &&
          target.ino === openedIdentity.ino &&
          descriptor.nlink === 1n &&
          target.nlink === 1n
        ) {
          unlinkSync(path);
        }
      } catch {
        // @swallow-ok Ambiguous failure cleanup preserves the path and rethrows the primary error.
        // Fail closed: never erase a path whose exact create identity cannot
        // still be proven after a partial write/fsync failure.
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (identity === undefined) {
    throw corruptCoordinationRecord(
      'Anchored create did not capture its temporary record identity',
      'no-identity',
    );
  }
  return identity;
}

interface LinkedRecordProof {
  readonly identity: RecordIdentity;
  readonly sha256: string;
}

interface LinkedCreateReconciliation {
  readonly trustedAnchorDir: string;
  readonly parentDir: string;
  readonly basename: string;
  readonly target: string;
  readonly maxBytes: number;
  readonly parentPosture: 'private' | 'owner-controlled';
  readonly recordPosture: 'private' | 'owner-controlled';
  readonly expectedContentSha256: string;
  /**
   * Ordinary create contention may encounter another creator after its target
   * link is published but before its temporary link is removed. That incumbent
   * owns the target content identity; settle its proven target/peer pair before
   * reporting EXISTS. Explicit recovery remains strict to the caller's digest.
   */
  readonly linkedContentIdentity: 'expected' | 'observed-incumbent';
  /** Deterministic transition seam for direct coordination fault tests. */
  readonly checkpoint?: (name: LinkedCreateCheckpoint) => void;
  readonly exactTemporaryBasename?: string;
  readonly discardExactUnlinkedTemporary: boolean;
  readonly proveCompleteTarget: boolean;
  readonly maxEntries: number;
}

/** @throws {SystemError} When a linked create peer does not match its expected proof. */
function readLinkedRecordProof(
  path: string,
  maxBytes: number,
  recordPosture: 'private' | 'owner-controlled',
  expectedLinks: bigint,
): LinkedRecordProof {
  const before = lstatIfPresent(path, 'Anchored create');
  if (before === undefined) {
    throw new RuntimeSnapshotChangedError('Anchored create disappeared before proof read');
  }
  assertRecordStatMetadata(before, maxBytes, recordPosture);
  if (before.nlink !== expectedLinks) {
    throw new RuntimeSnapshotChangedError('Anchored create link state changed before proof read');
  }
  const beforeIdentity = recordIdentity(before);
  let fd: number | undefined;
  try {
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      // TOCTOU: peer unlinked between lstat and open under multi-process cold start.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RuntimeSnapshotChangedError('Anchored create disappeared before proof open');
      }
      throw error;
    }
    const opened = fstatSync(fd, { bigint: true });
    if (!sameRecordIdentity(beforeIdentity, recordIdentity(opened))) {
      throw new RuntimeSnapshotChangedError('Anchored create changed before proof read');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) {
      throw coordinationCapacity('Anchored create exceeds its size bound', 'bytes');
    }
    const openedAfter = recordIdentity(fstatSync(fd, { bigint: true }));
    const pathAfterStat = lstatIfPresent(path, 'Anchored create');
    if (pathAfterStat === undefined) {
      throw new RuntimeSnapshotChangedError('Anchored create disappeared during proof read');
    }
    const pathAfter = recordIdentity(pathAfterStat);
    if (
      !sameRecordIdentity(beforeIdentity, openedAfter) ||
      !sameRecordIdentity(beforeIdentity, pathAfter)
    ) {
      throw new RuntimeSnapshotChangedError('Anchored create changed during proof read');
    }
    return {
      identity: beforeIdentity,
      sha256: createHash('sha256').update(buffer.subarray(0, offset)).digest('hex'),
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** @throws {SystemError} When linked-create recovery encounters ambiguous or excessive entries. */
function scanLinkedCreatePeer(
  parentDir: string,
  prefix: string,
  targetIdentityValue: RecordIdentity,
  maxEntries: number,
): string | undefined {
  const directory = opendirSync(parentDir);
  let inspected = 0;
  let matching: string | undefined;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      inspected += 1;
      if (inspected > maxEntries) {
        throw coordinationCapacity(
          'Anchored parent recovery scan exceeds its entry bound',
          'entries',
        );
      }
      if (
        Buffer.byteLength(entry.name, 'utf8') > ANCHORED_TEMP_BASENAME_MAX_BYTES ||
        !entry.name.startsWith(prefix) ||
        !UUID_V4_PATTERN.test(entry.name.slice(prefix.length))
      ) {
        continue;
      }
      const stat = lstatIfPresent(join(parentDir, entry.name), 'Anchored create candidate');
      if (stat?.dev !== targetIdentityValue.dev || stat.ino !== targetIdentityValue.ino) {
        continue;
      }
      if (matching !== undefined) {
        throw corruptCoordinationRecord('Anchored create link recovery is ambiguous', 'ambiguous');
      }
      matching = entry.name;
    }
  } finally {
    directory.closeSync();
  }
  return matching;
}

function samePublishedRecord(left: RecordIdentity, right: RecordIdentity): boolean {
  return (
    sameIdentity(left, right) &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

/**
 * Accept a creator that completed publication after this reconciler proved the
 * same target at two links. The completed target must retain the exact inode,
 * metadata, and content identity; a different target never becomes contention.
 *
 * @throws {SystemError} When completed publication cannot retain the proven
 *   target, content, temporary-path, durability, or parent identity.
 */
function proveConcurrentLinkedSettlement(
  input: LinkedCreateReconciliation,
  parent: { readonly fd: number; readonly identity: DirectoryIdentity },
  targetProof: LinkedRecordProof,
  contentIdentity: string,
): boolean {
  const completedStat = lstatIfPresent(input.target, 'Anchored completed create target');
  if (completedStat === undefined) return false;
  assertRecordStatMetadata(completedStat, input.maxBytes, input.recordPosture);
  if (completedStat.nlink !== 1n) return false;
  const exactTemporaryPath =
    input.exactTemporaryBasename === undefined
      ? undefined
      : join(input.parentDir, input.exactTemporaryBasename);
  if (
    exactTemporaryPath !== undefined &&
    lstatIfPresent(exactTemporaryPath, 'Anchored owned temporary') !== undefined
  ) {
    throw coordinationConflict(
      'Anchored complete target collides with its owned temporary',
      'temp-collision',
    );
  }
  const completed = readLinkedRecordProof(input.target, input.maxBytes, input.recordPosture, 1n);
  if (
    completed.sha256 !== contentIdentity ||
    !samePublishedRecord(targetProof.identity, completed.identity)
  ) {
    throw corruptCoordinationRecord(
      'Anchored completed create does not match expected identity',
      'content-identity',
    );
  }
  assertAnchoredParentUnchanged(
    parent.fd,
    parent.identity,
    input.parentDir,
    input.trustedAnchorDir,
    input.parentPosture,
  );
  fsyncParent(parent.fd);
  assertAnchoredParentUnchanged(
    parent.fd,
    parent.identity,
    input.parentDir,
    input.trustedAnchorDir,
    input.parentPosture,
  );
  const durable = readLinkedRecordProof(input.target, input.maxBytes, input.recordPosture, 1n);
  if (
    durable.sha256 !== contentIdentity ||
    !sameRecordIdentity(completed.identity, durable.identity)
  ) {
    throw unsafeCoordination('Anchored completed create changed during durability proof');
  }
  if (
    exactTemporaryPath !== undefined &&
    lstatIfPresent(exactTemporaryPath, 'Anchored owned temporary') !== undefined
  ) {
    throw coordinationConflict(
      'Anchored complete target collides with its owned temporary',
      'temp-collision',
    );
  }
  assertAnchoredParentUnchanged(
    parent.fd,
    parent.identity,
    input.parentDir,
    input.trustedAnchorDir,
    input.parentPosture,
  );
  return true;
}

/** @throws {SystemError} When an owned unlinked temporary cannot be discarded exactly. */
function discardExactUnlinkedTemporary(
  input: LinkedCreateReconciliation,
  parent: { readonly fd: number; readonly identity: DirectoryIdentity },
): void {
  const temporaryBasename = input.exactTemporaryBasename;
  if (temporaryBasename === undefined) return;
  const temporaryPath = join(input.parentDir, temporaryBasename);
  const temporary = lstatIfPresent(temporaryPath, 'Anchored owned temporary');
  if (temporary === undefined) {
    assertAnchoredParentUnchanged(
      parent.fd,
      parent.identity,
      input.parentDir,
      input.trustedAnchorDir,
      input.parentPosture,
    );
    fsyncParent(parent.fd);
    assertAnchoredParentUnchanged(
      parent.fd,
      parent.identity,
      input.parentDir,
      input.trustedAnchorDir,
      input.parentPosture,
    );
    if (
      lstatIfPresent(temporaryPath, 'Anchored owned temporary') !== undefined ||
      lstatIfPresent(input.target, 'Anchored create target') !== undefined
    ) {
      throw unsafeCoordination('Anchored owned temporary absence did not converge');
    }
    return;
  }
  assertRegularRecordStat(temporary, input.maxBytes, input.recordPosture);
  const identity = recordIdentity(temporary);
  assertAnchoredParentUnchanged(
    parent.fd,
    parent.identity,
    input.parentDir,
    input.trustedAnchorDir,
    input.parentPosture,
  );
  const immediatelyBefore = lstatSync(temporaryPath, { bigint: true });
  assertRegularRecordStat(immediatelyBefore, input.maxBytes, input.recordPosture);
  if (
    !sameRecordIdentity(identity, recordIdentity(immediatelyBefore)) ||
    lstatIfPresent(input.target, 'Anchored create target') !== undefined
  ) {
    throw new RuntimeSnapshotChangedError('Anchored owned temporary changed before discard');
  }
  unlinkSync(temporaryPath);
  fsyncParent(parent.fd);
  assertAnchoredParentUnchanged(
    parent.fd,
    parent.identity,
    input.parentDir,
    input.trustedAnchorDir,
    input.parentPosture,
  );
  if (
    lstatIfPresent(temporaryPath, 'Anchored owned temporary') !== undefined ||
    lstatIfPresent(input.target, 'Anchored create target') !== undefined
  ) {
    throw unsafeCoordination('Anchored owned temporary discard did not converge');
  }
}

/** @throws {SystemError} When linked-create settlement cannot prove a single valid survivor. */
function settleLinkedCreate(
  input: LinkedCreateReconciliation,
  parent: { readonly fd: number; readonly identity: DirectoryIdentity },
  targetProof: LinkedRecordProof,
): void {
  const contentIdentity =
    input.linkedContentIdentity === 'observed-incumbent'
      ? targetProof.sha256
      : input.expectedContentSha256;
  if (targetProof.sha256 !== contentIdentity) {
    throw corruptCoordinationRecord(
      'Anchored create content does not match expected identity',
      'content-identity',
    );
  }
  if (proveConcurrentLinkedSettlement(input, parent, targetProof, contentIdentity)) return;
  const temporaryBasename =
    input.exactTemporaryBasename ??
    scanLinkedCreatePeer(
      input.parentDir,
      `.${input.basename}.tmp-`,
      targetProof.identity,
      input.maxEntries,
    );
  if (temporaryBasename === undefined) {
    if (proveConcurrentLinkedSettlement(input, parent, targetProof, contentIdentity)) return;
    throw corruptCoordinationRecord(
      'Anchored create link recovery has no proven temporary peer',
      'no-peer',
    );
  }
  const temporaryPath = join(input.parentDir, temporaryBasename);
  input.checkpoint?.('after-linked-create-peer-selection');
  let temporaryProof: LinkedRecordProof;
  try {
    temporaryProof = readLinkedRecordProof(temporaryPath, input.maxBytes, input.recordPosture, 2n);
  } catch (error) {
    if (
      error instanceof RuntimeSnapshotChangedError &&
      proveConcurrentLinkedSettlement(input, parent, targetProof, contentIdentity)
    ) {
      return;
    }
    throw error;
  }
  if (
    temporaryProof.sha256 !== contentIdentity ||
    !sameRecordIdentity(targetProof.identity, temporaryProof.identity)
  ) {
    throw corruptCoordinationRecord(
      'Anchored create temporary peer is not content-bound',
      'unbound-peer',
    );
  }
  input.checkpoint?.('after-linked-create-temporary-proof');
  assertAnchoredParentUnchanged(
    parent.fd,
    parent.identity,
    input.parentDir,
    input.trustedAnchorDir,
    input.parentPosture,
  );
  const finalTarget = lstatIfPresent(input.target, 'Anchored create target');
  const finalTemporary = lstatIfPresent(temporaryPath, 'Anchored create temporary');
  if (finalTarget === undefined || finalTemporary === undefined) {
    if (proveConcurrentLinkedSettlement(input, parent, targetProof, contentIdentity)) return;
    throw new RuntimeSnapshotChangedError(
      'Anchored create disappeared immediately before settlement',
    );
  }
  assertRecordStatMetadata(finalTarget, input.maxBytes, input.recordPosture);
  assertRecordStatMetadata(finalTemporary, input.maxBytes, input.recordPosture);
  if (
    finalTarget.nlink !== 2n ||
    finalTemporary.nlink !== 2n ||
    !sameRecordIdentity(targetProof.identity, recordIdentity(finalTarget)) ||
    !sameRecordIdentity(temporaryProof.identity, recordIdentity(finalTemporary))
  ) {
    if (proveConcurrentLinkedSettlement(input, parent, targetProof, contentIdentity)) return;
    throw new RuntimeSnapshotChangedError('Anchored create changed immediately before settlement');
  }
  input.checkpoint?.('after-linked-create-final-stats');
  try {
    unlinkSync(temporaryPath);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      proveConcurrentLinkedSettlement(input, parent, targetProof, contentIdentity)
    ) {
      return;
    }
    throw error;
  }
  fsyncParent(parent.fd);
  assertAnchoredParentUnchanged(
    parent.fd,
    parent.identity,
    input.parentDir,
    input.trustedAnchorDir,
    input.parentPosture,
  );
  if (lstatIfPresent(temporaryPath, 'Anchored create temporary') !== undefined) {
    throw unsafeCoordination('Anchored create temporary remained after settlement');
  }
  const settled = readLinkedRecordProof(input.target, input.maxBytes, input.recordPosture, 1n);
  if (
    settled.sha256 !== contentIdentity ||
    !samePublishedRecord(targetProof.identity, settled.identity)
  ) {
    throw unsafeCoordination('Anchored create settlement lost its content identity');
  }
  assertAnchoredParentUnchanged(
    parent.fd,
    parent.identity,
    input.parentDir,
    input.trustedAnchorDir,
    input.parentPosture,
  );
}

/** @throws {SystemError} When anchored-create recovery cannot prove the requested outcome. */
function reconcileAnchoredCreate(
  input: LinkedCreateReconciliation,
  parent: { readonly fd: number; readonly identity: DirectoryIdentity },
): 'absent' | 'present' {
  const targetStat = lstatIfPresent(input.target, 'Anchored create target');
  if (targetStat === undefined) {
    if (input.discardExactUnlinkedTemporary) {
      discardExactUnlinkedTemporary(input, parent);
    }
    return 'absent';
  }
  assertRecordStatMetadata(targetStat, input.maxBytes, input.recordPosture);
  if (targetStat.nlink === 0n) {
    throw new RuntimeSnapshotChangedError('Anchored create target was unlinked during recovery');
  }
  if (targetStat.nlink === 1n) {
    if (
      input.exactTemporaryBasename !== undefined &&
      lstatIfPresent(
        join(input.parentDir, input.exactTemporaryBasename),
        'Anchored owned temporary',
      ) !== undefined
    ) {
      throw coordinationConflict(
        'Anchored complete target collides with its owned temporary',
        'temp-collision',
      );
    }
    const before = input.proveCompleteTarget
      ? readLinkedRecordProof(input.target, input.maxBytes, input.recordPosture, 1n)
      : undefined;
    if (before !== undefined && before.sha256 !== input.expectedContentSha256) {
      throw corruptCoordinationRecord(
        'Anchored complete target does not match expected identity',
        'content-identity',
      );
    }
    assertAnchoredParentUnchanged(
      parent.fd,
      parent.identity,
      input.parentDir,
      input.trustedAnchorDir,
      input.parentPosture,
    );
    fsyncParent(parent.fd);
    assertAnchoredParentUnchanged(
      parent.fd,
      parent.identity,
      input.parentDir,
      input.trustedAnchorDir,
      input.parentPosture,
    );
    if (before !== undefined) {
      const durable = readLinkedRecordProof(input.target, input.maxBytes, input.recordPosture, 1n);
      if (
        durable.sha256 !== input.expectedContentSha256 ||
        !sameRecordIdentity(before.identity, durable.identity)
      ) {
        throw unsafeCoordination('Anchored complete target changed during durability proof');
      }
    }
    return 'present';
  }
  if (targetStat.nlink !== 2n) {
    throw corruptCoordinationRecord('Anchored create link recovery is ambiguous', 'ambiguous');
  }
  const targetProof = readLinkedRecordProof(input.target, input.maxBytes, input.recordPosture, 2n);
  input.checkpoint?.('after-linked-create-target-proof');
  settleLinkedCreate(input, parent, targetProof);
  return 'present';
}

function settleCoordinationLinkedCreate(path: string, maxBytes: number): void {
  const paths = resolveCoordinationPaths();
  if (!existsSync(paths.coordinationDir)) return;
  const parentDir = dirname(path);
  const parent = openAnchoredParentIdentity(parentDir, paths.coordinationDir, 'private');
  try {
    const stat = lstatIfPresent(path, 'Runtime coordination linked create');
    if (stat === undefined || stat.nlink === 1n) return;
    if (stat.nlink === 0n) {
      throw new RuntimeSnapshotChangedError(
        'Runtime coordination linked create was unlinked during recovery',
      );
    }
    if (stat.nlink !== 2n) {
      throw corruptCoordinationRecord(
        'Runtime coordination linked create is ambiguous',
        'ambiguous',
      );
    }
    const proof = readLinkedRecordProof(path, maxBytes, 'private', 2n);
    reconcileAnchoredCreate(
      {
        trustedAnchorDir: paths.coordinationDir,
        parentDir,
        basename: basename(path),
        target: path,
        maxBytes,
        parentPosture: 'private',
        recordPosture: 'private',
        expectedContentSha256: proof.sha256,
        linkedContentIdentity: 'expected',
        discardExactUnlinkedTemporary: false,
        proveCompleteTarget: false,
        maxEntries: 512,
      },
      parent,
    );
  } finally {
    closeSync(parent.fd);
  }
}

/** @throws {SystemError} When an anchored mutation fails validation, containment, or recovery. */
function performAnchoredRecordMutation(
  input: AnchoredRecordMutation,
  runtime: AnchoredRecordMutationRuntimeOptions = {},
): {
  readonly strategy: typeof COORDINATION_MUTATION_STRATEGY;
} {
  const {
    assertPublicationAllowed,
    afterUnlink,
    linkedCreateCheckpoint,
    beforeExpectedDigest,
    beforeFinalUnlinkIdentity,
    beforeFinalUnlink,
  } = runtime;
  const parentPosture = anchoredPermissionPosture(
    input.permissionPosture,
    'owner-controlled',
    'parent posture',
  );
  const recordPosture = anchoredPermissionPosture(
    input.recordPosture,
    parentPosture,
    'record posture',
  );
  assertDirectory(input.trustedAnchorDir, undefined, parentPosture);
  assertSafeBasename(input.basename);
  if (join(input.parentDir, input.basename) !== join(input.parentDir, basename(input.basename))) {
    throw coordinationInputInvalid('Runtime coordination mutation target is invalid', 'target');
  }
  const maxBytes = boundedRecordSize(input.maxBytes);
  const content = input.content ?? '';
  if (
    input.expectedContentSha256 !== undefined &&
    !/^[a-f0-9]{64}$/u.test(input.expectedContentSha256)
  ) {
    throw coordinationInputInvalid('Anchored mutation expected digest is invalid', 'digest');
  }
  if (input.operation === 'create' && input.expectedContentSha256 !== undefined) {
    throw coordinationInputInvalid(
      'Anchored create cannot carry an expected-content digest',
      'digest',
    );
  }
  if (input.operation !== 'create' && input.createIdentity !== undefined) {
    throw coordinationInputInvalid(
      'Anchored create identity requires a create operation',
      'operation',
    );
  }
  const exactTemporaryBasename =
    input.createIdentity === undefined
      ? undefined
      : anchoredRecordTemporaryBasename(input.basename, input.createIdentity);
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    throw coordinationCapacity('Runtime coordination mutation exceeds its size bound', 'bytes');
  }
  const target = join(input.parentDir, input.basename);
  const linkedTargetCanBeBusy =
    input.operation === 'create' || runtime.linkedTargetCanBeBusy === true;
  const parent = openAnchoredParentIdentity(input.parentDir, input.trustedAnchorDir, parentPosture);
  try {
    if (input.operation === 'create') {
      reconcileAnchoredCreate(
        {
          trustedAnchorDir: input.trustedAnchorDir,
          parentDir: input.parentDir,
          basename: input.basename,
          target,
          maxBytes,
          parentPosture,
          recordPosture,
          expectedContentSha256: createHash('sha256').update(content).digest('hex'),
          linkedContentIdentity:
            exactTemporaryBasename === undefined ? 'observed-incumbent' : 'expected',
          ...(linkedCreateCheckpoint === undefined ? {} : { checkpoint: linkedCreateCheckpoint }),
          exactTemporaryBasename,
          discardExactUnlinkedTemporary: exactTemporaryBasename !== undefined,
          proveCompleteTarget: false,
          maxEntries: ANCHORED_CREATE_RECOVERY_MAX_ENTRIES,
        },
        parent,
      );
    }
    const beforeTarget = targetIdentity(target, maxBytes, recordPosture, linkedTargetCanBeBusy);
    /** @throws {SystemError} When the observed record digest differs from the expected digest. */
    const assertExpectedDigest = (): void => {
      if (input.expectedContentSha256 === undefined) return;
      beforeExpectedDigest?.();
      const observed = readAnchoredRecordInternal(
        {
          trustedAnchorDir: input.trustedAnchorDir,
          parentDir: input.parentDir,
          basename: input.basename,
          maxBytes,
          permissionPosture: parentPosture,
          recordPosture,
        },
        linkedTargetCanBeBusy,
      );
      if (observed.status !== 'present' || observed.sha256 !== input.expectedContentSha256) {
        throw new SystemError('Anchored record changed since the caller observed it', {
          code: 'CORE.RUNTIME_COORDINATION.CAS_MISMATCH',
        });
      }
    };
    assertExpectedDigest();
    let tempPath: string | undefined;
    let tempIdentity: RecordIdentity | undefined;
    try {
      if (input.operation === 'create') {
        if (beforeTarget !== undefined) {
          throw new SystemError('Runtime coordination record already exists', {
            code: 'CORE.RUNTIME_COORDINATION.EXISTS',
          });
        }
        const tempBasename = exactTemporaryBasename ?? `.${input.basename}.tmp-${generateUUID()}`;
        tempPath = join(input.parentDir, tempBasename);
        tempIdentity = createExclusiveRecord(tempPath, content, recordPosture);
        assertAnchoredParentUnchanged(
          parent.fd,
          parent.identity,
          input.parentDir,
          input.trustedAnchorDir,
          parentPosture,
        );
        try {
          assertPublicationAllowed?.();
          linkSync(tempPath, target);
          assertPublicationAllowed?.();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new SystemError('Runtime coordination record already exists', {
              code: 'CORE.RUNTIME_COORDINATION.EXISTS',
            });
          }
          throw error;
        }
        try {
          assertPublicationAllowed?.();
          unlinkSync(tempPath);
          assertPublicationAllowed?.();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        tempPath = undefined;
        tempIdentity = undefined;
        assertRegularRecord(target, maxBytes, recordPosture);
        fsyncParent(parent.fd);
      } else if (input.operation === 'replace') {
        if (beforeTarget === undefined) {
          throw unsafeCoordination('Runtime coordination record disappeared before replacement');
        }
        const current = targetIdentity(target, maxBytes, recordPosture, linkedTargetCanBeBusy);
        if (current === undefined || !sameRecordIdentity(beforeTarget, current)) {
          throw new RuntimeSnapshotChangedError(
            'Runtime coordination record changed before replacement',
          );
        }
        const tempBasename = `.${input.basename}.tmp-${generateUUID()}`;
        tempPath = join(input.parentDir, tempBasename);
        tempIdentity = createExclusiveRecord(tempPath, content, recordPosture);
        assertAnchoredParentUnchanged(
          parent.fd,
          parent.identity,
          input.parentDir,
          input.trustedAnchorDir,
          parentPosture,
        );
        const immediatelyBefore = targetIdentity(
          target,
          maxBytes,
          recordPosture,
          linkedTargetCanBeBusy,
        );
        if (
          immediatelyBefore === undefined ||
          !sameRecordIdentity(beforeTarget, immediatelyBefore)
        ) {
          throw new RuntimeSnapshotChangedError(
            'Runtime coordination record changed during replacement',
          );
        }
        assertExpectedDigest();
        const afterDigest = targetIdentity(target, maxBytes, recordPosture, linkedTargetCanBeBusy);
        if (afterDigest === undefined || !sameRecordIdentity(immediatelyBefore, afterDigest)) {
          throw new RuntimeSnapshotChangedError(
            'Runtime coordination record changed after CAS verification',
          );
        }
        assertPublicationAllowed?.();
        renameSync(tempPath, target);
        assertPublicationAllowed?.();
        tempPath = undefined;
        tempIdentity = undefined;
        assertRegularRecord(target, maxBytes, recordPosture);
        fsyncParent(parent.fd);
      } else {
        if (beforeTarget === undefined) {
          return { strategy: COORDINATION_MUTATION_STRATEGY };
        }
        const current = targetIdentity(target, maxBytes, recordPosture, linkedTargetCanBeBusy);
        if (current === undefined || !sameRecordIdentity(beforeTarget, current)) {
          throw new RuntimeSnapshotChangedError(
            'Runtime coordination record changed before unlink',
          );
        }
        assertAnchoredParentUnchanged(
          parent.fd,
          parent.identity,
          input.parentDir,
          input.trustedAnchorDir,
          parentPosture,
        );
        assertExpectedDigest();
        const afterDigest = targetIdentity(target, maxBytes, recordPosture, linkedTargetCanBeBusy);
        if (afterDigest === undefined || !sameRecordIdentity(current, afterDigest)) {
          throw new RuntimeSnapshotChangedError(
            'Runtime coordination record changed after CAS verification',
          );
        }
        assertPublicationAllowed?.();
        beforeFinalUnlinkIdentity?.();
        const immediatelyBeforeUnlink = targetIdentity(
          target,
          maxBytes,
          recordPosture,
          linkedTargetCanBeBusy,
        );
        if (
          immediatelyBeforeUnlink === undefined ||
          !sameRecordIdentity(afterDigest, immediatelyBeforeUnlink)
        ) {
          throw new RuntimeSnapshotChangedError(
            'Runtime coordination record changed immediately before unlink',
          );
        }
        assertPublicationAllowed?.();
        beforeFinalUnlink?.();
        try {
          unlinkSync(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new RuntimeSnapshotChangedError(
              'Runtime coordination record disappeared during unlink',
            );
          }
          throw error;
        }
        afterUnlink?.();
        assertPublicationAllowed?.();
        // unlinkSync success is the proof that this exact pathname entry was
        // removed. Re-reading the pathname here is racy: another process may
        // already have published a valid successor (especially the fixed
        // coordination mutex), which must not turn a healthy hand-off into an
        // intermittent release error.
        fsyncParent(parent.fd);
      }
      assertAnchoredParentUnchanged(
        parent.fd,
        parent.identity,
        input.parentDir,
        input.trustedAnchorDir,
        parentPosture,
      );
      return { strategy: COORDINATION_MUTATION_STRATEGY };
    } catch (error) {
      if (tempPath !== undefined) {
        try {
          assertAnchoredParentUnchanged(
            parent.fd,
            parent.identity,
            input.parentDir,
            input.trustedAnchorDir,
            parentPosture,
          );
          const observedTemp = targetIdentity(tempPath, maxBytes, recordPosture);
          if (
            tempIdentity === undefined ||
            observedTemp === undefined ||
            !sameRecordIdentity(tempIdentity, observedTemp)
          ) {
            throw new RuntimeSnapshotChangedError(
              'Anchored temporary record changed before failure cleanup',
            );
          }
          assertPublicationAllowed?.();
          unlinkSync(tempPath);
          assertPublicationAllowed?.();
        } catch {
          // @swallow-ok Ambiguous temporary state is preserved before rethrowing the primary error.
          // Fail closed: never clean a newly observed/replaced path.
        }
      }
      throw error;
    }
  } finally {
    closeSync(parent.fd);
  }
}

function unlinkFixedAnchoredRecordWithoutSize(
  trustedAnchorDir: string,
  parentDir: string,
  basenameValue: string,
  assertPublicationAllowed: () => void,
): void {
  assertSafeBasename(basenameValue);
  const target = join(parentDir, basenameValue);
  const parent = openAnchoredParentIdentity(parentDir, trustedAnchorDir, 'private');
  try {
    const beforeStat = lstatIfPresent(target, 'Fixed recovery record');
    if (beforeStat === undefined) return;
    assertRegularRecordStat(beforeStat, undefined, 'private');
    const before = recordIdentity(beforeStat);
    assertAnchoredParentUnchanged(
      parent.fd,
      parent.identity,
      parentDir,
      trustedAnchorDir,
      'private',
    );
    assertPublicationAllowed();
    const immediatelyBeforeStat = lstatIfPresent(target, 'Fixed recovery record');
    if (immediatelyBeforeStat === undefined) {
      throw new RuntimeSnapshotChangedError(
        'Fixed recovery record disappeared before destructive discard',
      );
    }
    assertRegularRecordStat(immediatelyBeforeStat, undefined, 'private');
    if (!sameRecordIdentity(before, recordIdentity(immediatelyBeforeStat))) {
      throw new RuntimeSnapshotChangedError(
        'Fixed recovery record changed before destructive discard',
      );
    }
    unlinkSync(target);
    assertPublicationAllowed();
    if (lstatIfPresent(target, 'Fixed recovery record') !== undefined) {
      throw unsafeCoordination('Fixed recovery record remained after destructive discard');
    }
    fsyncParent(parent.fd);
    assertAnchoredParentUnchanged(
      parent.fd,
      parent.identity,
      parentDir,
      trustedAnchorDir,
      'private',
    );
  } finally {
    closeSync(parent.fd);
  }
}

/** @throws {SystemError} When a general anchored read targets runtime coordination state. */
function assertOutsideRuntimeCoordination(parentDir: string, basenameValue: string): void {
  const coordinationRoot = resolveCoordinationPaths().coordinationDir;
  let canonicalTarget: string;
  let canonicalCoordinationRoot: string;
  try {
    canonicalTarget = join(realpathSync(parentDir), basenameValue);
    canonicalCoordinationRoot = join(
      realpathSync(dirname(coordinationRoot)),
      basename(coordinationRoot),
    );
  } catch {
    throw coordinationProbeFailed('Anchored mutation containment cannot be established', 'probe');
  }
  if (isContainedPath(canonicalTarget, canonicalCoordinationRoot)) {
    throw new SystemError('Generic anchored mutation cannot target runtime coordination records', {
      code: 'CORE.RUNTIME_LEASE.AUTHORITY_SCOPE',
    });
  }
}

/**
 * General audited portable mutation under an explicit trusted containment
 * anchor. Task-specific wrappers remain responsible for fixed basenames.
 * Replace/unlink callers that need atomic multi-writer CAS must hold an
 * external lock across their read and mutation.
 */
export function mutateAnchoredRecord(input: AnchoredRecordMutation): {
  readonly strategy: typeof COORDINATION_MUTATION_STRATEGY;
} {
  assertOutsideRuntimeCoordination(input.parentDir, input.basename);
  return performAnchoredRecordMutation(input);
}

function mutateCoordinationRecordWhileOwned(
  input: CoordinationRecordMutation,
  guard?: RuntimeMutexGuard,
  afterUnlink?: () => void,
  linkedCreateCheckpoint?: (name: LinkedCreateCheckpoint) => void,
  runtimeOptions: CoordinationRecordMutationRuntimeOptions = {},
): {
  readonly strategy: typeof COORDINATION_MUTATION_STRATEGY;
} {
  const paths = ensureCoordinationScaffold();
  return performAnchoredRecordMutation(
    {
      ...input,
      trustedAnchorDir: paths.coordinationDir,
      permissionPosture: 'private',
    },
    {
      ...runtimeOptions,
      assertPublicationAllowed: guard === undefined ? undefined : () => guard.assertOwned(),
      afterUnlink,
      linkedCreateCheckpoint,
    },
  );
}

/** @throws {Error} When the bounded record changes, exceeds its cap, or fails its safety proof. */
function readAnchoredBoundedRecord(
  path: string,
  maxBytes: number,
  trustedAnchorDir: string,
  parentPosture: 'private' | 'owner-controlled',
  linkedCreateCanBeBusy = false,
  recordPosture: 'private' | 'owner-controlled' = parentPosture,
): string | undefined {
  let before;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw coordinationProbeFailed('Runtime coordination record cannot be inspected', 'probe');
  }
  const beforeIdentity = recordIdentity(before);
  if (linkedCreateCanBeBusy && before.nlink === 2n) {
    const uid = currentUid();
    const mode = Number(before.mode & 0o777n);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (uid !== undefined && before.uid !== BigInt(uid)) ||
      (process.platform !== 'win32' &&
        (recordPosture === 'private' ? mode !== 0o600 : (mode & 0o002) !== 0)) ||
      before.size > BigInt(maxBytes)
    ) {
      throw unsafeCoordination('Runtime coordination linked create is unsafe');
    }
    throw new RuntimeSnapshotChangedError(
      'Runtime coordination create publication is still in progress',
    );
  }
  try {
    assertRegularRecord(path, maxBytes, recordPosture);
  } catch (error) {
    const current = lstatIfPresent(path, 'Runtime coordination record');
    if (current === undefined || !sameRecordIdentity(beforeIdentity, recordIdentity(current))) {
      throw new RuntimeSnapshotChangedError('Runtime coordination record disappeared before read');
    }
    throw error;
  }
  const parent = openAnchoredParentIdentity(dirname(path), trustedAnchorDir, parentPosture);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    const openedIdentity = recordIdentity(opened);
    if (!sameRecordIdentity(beforeIdentity, openedIdentity)) {
      throw new RuntimeSnapshotChangedError('Runtime coordination record changed before read');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) {
      throw coordinationCapacity('Runtime coordination record exceeds its size bound', 'bytes');
    }
    const openedAfter = recordIdentity(fstatSync(fd, { bigint: true }));
    let after;
    try {
      after = recordIdentity(lstatSync(path, { bigint: true }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RuntimeSnapshotChangedError(
          'Runtime coordination record disappeared during read',
        );
      }
      throw error;
    }
    if (
      !sameRecordIdentity(beforeIdentity, openedAfter) ||
      !sameRecordIdentity(beforeIdentity, after)
    ) {
      throw new RuntimeSnapshotChangedError('Runtime coordination record changed during read');
    }
    assertAnchoredParentUnchanged(
      parent.fd,
      parent.identity,
      dirname(path),
      trustedAnchorDir,
      parentPosture,
    );
    return buffer.toString('utf8', 0, offset);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RuntimeSnapshotChangedError('Runtime coordination record disappeared before read');
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeSync(parent.fd);
  }
}

/**
 * Read one bounded record without repair by default and return a
 * conflict-detection digest. `linkedCreateRecovery` is explicit mutation
 * authority and is rejected for runtime coordination paths. A later
 * replace/unlink still requires external writer serialization when
 * linearizable compare-and-swap semantics are needed.
 *
 * @throws {Error} When the read target or recovery request is unsafe or changes during inspection.
 */
function readAnchoredRecordInternal(
  input: AnchoredRecordRead,
  linkedCreateCanBeBusy = false,
): AnchoredRecordReadResult {
  assertSafeBasename(input.basename);
  const parentPosture = anchoredPermissionPosture(
    input.permissionPosture,
    'owner-controlled',
    'parent posture',
  );
  const recordPosture = anchoredPermissionPosture(
    input.recordPosture,
    parentPosture,
    'record posture',
  );
  const maxBytes = boundedRecordSize(input.maxBytes);
  const target = join(input.parentDir, input.basename);
  const recovery = input.linkedCreateRecovery;
  if (recovery !== undefined && !/^[a-f0-9]{64}$/u.test(recovery.expectedContentSha256)) {
    throw coordinationInputInvalid('Anchored create recovery digest is invalid', 'digest');
  }
  const exactTemporaryBasename =
    recovery?.effect === 'settle-or-discard-owned-temporary'
      ? anchoredRecordTemporaryBasename(input.basename, recovery.createIdentity)
      : undefined;
  if (
    recovery !== undefined &&
    recovery.effect !== 'settle-linked-create' &&
    recovery.effect !== 'settle-or-discard-owned-temporary'
  ) {
    throw coordinationInputInvalid('Anchored create recovery effect is invalid', 'effect');
  }
  if (recovery !== undefined) {
    assertOutsideRuntimeCoordination(input.parentDir, input.basename);
  }
  const parent = openAnchoredParentIdentity(input.parentDir, input.trustedAnchorDir, parentPosture);
  try {
    if (recovery !== undefined) {
      const reconciliation = reconcileAnchoredCreate(
        {
          trustedAnchorDir: input.trustedAnchorDir,
          parentDir: input.parentDir,
          basename: input.basename,
          target,
          maxBytes,
          parentPosture,
          recordPosture,
          expectedContentSha256: recovery.expectedContentSha256,
          linkedContentIdentity: 'expected',
          exactTemporaryBasename,
          discardExactUnlinkedTemporary: recovery.effect === 'settle-or-discard-owned-temporary',
          proveCompleteTarget: true,
          maxEntries: boundedAnchoredRecoveryEntries(recovery.maxEntries),
        },
        parent,
      );
      if (reconciliation === 'absent') {
        assertAnchoredParentUnchanged(
          parent.fd,
          parent.identity,
          input.parentDir,
          input.trustedAnchorDir,
          parentPosture,
        );
        return { status: 'absent' };
      }
    }
    const content = readAnchoredBoundedRecord(
      target,
      maxBytes,
      input.trustedAnchorDir,
      parentPosture,
      linkedCreateCanBeBusy,
      recordPosture,
    );
    assertAnchoredParentUnchanged(
      parent.fd,
      parent.identity,
      input.parentDir,
      input.trustedAnchorDir,
      parentPosture,
    );
    if (content === undefined) return { status: 'absent' };
    const result = {
      status: 'present',
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    } as const;
    if (recovery !== undefined && result.sha256 !== recovery.expectedContentSha256) {
      throw corruptCoordinationRecord(
        'Anchored record does not match expected recovery identity',
        'recovery-identity',
      );
    }
    return result;
  } finally {
    closeSync(parent.fd);
  }
}

export function readAnchoredRecord(input: AnchoredRecordRead): AnchoredRecordReadResult {
  return readAnchoredRecordInternal(input);
}

function readBoundedRecord(
  path: string,
  maxBytes: number,
  repairLinkedCreate = true,
): string | undefined {
  if (repairLinkedCreate) settleCoordinationLinkedCreate(path, maxBytes);
  return readAnchoredBoundedRecord(
    path,
    maxBytes,
    resolveCoordinationPaths().coordinationDir,
    'private',
    repairLinkedCreate,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validRecordMetadata(value: unknown): value is RecordMetadata {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.ownerToken === 'string' &&
    OWNER_TOKEN_PATTERN.test(value.ownerToken) &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.hostname === 'string' &&
    value.hostname.length > 0 &&
    Buffer.byteLength(value.hostname, 'utf8') <= MAX_HOST_IDENTITY_BYTES &&
    typeof value.hostIdentityProven === 'boolean' &&
    (value.processIncarnation === undefined ||
      (typeof value.processIncarnation === 'string' &&
        PROCESS_INCARNATION_PATTERN.test(value.processIncarnation))) &&
    typeof value.command === 'string' &&
    value.command.length > 0 &&
    Buffer.byteLength(value.command, 'utf8') <= MAX_METADATA_TEXT_BYTES &&
    typeof value.cwdBasename === 'string' &&
    value.cwdBasename.length > 0 &&
    Buffer.byteLength(value.cwdBasename, 'utf8') <= MAX_METADATA_TEXT_BYTES &&
    Number.isSafeInteger(value.acquiredAt) &&
    (value.acquiredAt as number) >= 0 &&
    Number.isSafeInteger(value.lastHeartbeatAt) &&
    (value.lastHeartbeatAt as number) >= 0 &&
    Number.isSafeInteger(value.staleMs) &&
    (value.staleMs as number) >= MIN_HEARTBEAT_MS * 3 &&
    (value.staleMs as number) <= MAX_STALE_MS &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) > 0
  );
}

function validWriterRecord(value: unknown): value is WriterRecord {
  if (!validRecordMetadata(value) || !isPlainRecord(value)) return false;
  if (value.kind !== 'project' && value.kind !== 'global') return false;
  if (value.phase !== 'queued' && value.phase !== 'intent') return false;
  if (value.kind === 'project') {
    return (
      typeof value.coordinationKey === 'string' && PROJECT_KEY_PATTERN.test(value.coordinationKey)
    );
  }
  return value.coordinationKey === undefined;
}

function initialState(): LeaseStateFile {
  return { version: STATE_VERSION, nextSequence: 1, writers: [] };
}

function readLeaseState(paths: CoordinationPaths): LeaseStateFile {
  const raw = readBoundedRecord(paths.stateFile, MAX_RECORD_BYTES);
  return parseLeaseState(raw);
}

function inspectLeaseState(paths: CoordinationPaths): LeaseStateFile {
  const raw = readBoundedRecord(paths.stateFile, MAX_RECORD_BYTES, false);
  return parseLeaseState(raw);
}

/** @throws {SystemError} When persisted writer-queue state is malformed or inconsistent. */
function parseLeaseState(raw: string | undefined): LeaseStateFile {
  if (raw === undefined) return initialState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptCoordinationRecord('Runtime coordination writer queue is malformed', 'malformed');
  }
  if (
    !isPlainRecord(parsed) ||
    parsed.version !== STATE_VERSION ||
    !Number.isSafeInteger(parsed.nextSequence) ||
    (parsed.nextSequence as number) < 1 ||
    !Array.isArray(parsed.writers) ||
    parsed.writers.length > MAX_WRITER_QUEUE ||
    !parsed.writers.every(validWriterRecord)
  ) {
    throw corruptCoordinationRecord('Runtime coordination writer queue is malformed', 'malformed');
  }
  const writers = parsed.writers;
  const tickets = new Set(writers.map((writer) => writer.sequence));
  const owners = new Set(writers.map((writer) => writer.ownerToken));
  if (tickets.size !== writers.length || owners.size !== writers.length) {
    throw corruptCoordinationRecord(
      'Runtime coordination writer queue has duplicate ownership',
      'duplicate-owner',
    );
  }
  const sorted = [...writers].sort((left, right) => left.sequence - right.sequence);
  if (sorted.some((writer, index) => writer !== writers[index])) {
    throw corruptCoordinationRecord(
      'Runtime coordination writer queue is not FIFO ordered',
      'ordering',
    );
  }
  if (
    writers.some((writer) => writer.sequence >= (parsed as { nextSequence: number }).nextSequence)
  ) {
    throw corruptCoordinationRecord(
      'Runtime coordination writer queue has an invalid ticket',
      'invalid-ticket',
    );
  }
  return {
    version: STATE_VERSION,
    nextSequence: (parsed as { nextSequence: number }).nextSequence,
    writers,
  };
}

/** @throws {SystemError} When the writer queue is unsafe or changed before publication. */
function writeLeaseState(
  paths: CoordinationPaths,
  previous: LeaseStateFile,
  state: LeaseStateFile,
  guard?: RuntimeMutexGuard,
): void {
  if (state.writers.length > MAX_WRITER_QUEUE || !Number.isSafeInteger(state.nextSequence)) {
    throw coordinationCapacity('Runtime coordination writer queue exceeds its bound', 'entries');
  }
  const content = JSON.stringify(state);
  if (Buffer.byteLength(content, 'utf8') > MAX_RECORD_BYTES) {
    throw coordinationCapacity('Runtime coordination writer queue exceeds its byte bound', 'bytes');
  }
  const observed = readAnchoredRecord({
    trustedAnchorDir: paths.coordinationDir,
    parentDir: paths.coordinationDir,
    basename: basename(paths.stateFile),
    maxBytes: MAX_RECORD_BYTES,
    permissionPosture: 'private',
  });
  const operation = observed.status === 'absent' ? 'create' : 'replace';
  if (
    (observed.status === 'absent' && JSON.stringify(previous) !== JSON.stringify(initialState())) ||
    (observed.status === 'present' &&
      JSON.stringify(parseLeaseState(observed.content)) !== JSON.stringify(previous))
  ) {
    throw new RuntimeSnapshotChangedError(
      'Runtime coordination writer queue changed before publication',
    );
  }
  guard?.refresh();
  mutateCoordinationRecordWhileOwned(
    {
      parentDir: paths.coordinationDir,
      basename: basename(paths.stateFile),
      operation,
      content,
      maxBytes: MAX_RECORD_BYTES,
      ...(observed.status === 'present' ? { expectedContentSha256: observed.sha256 } : {}),
    },
    guard,
  );
}

interface RuntimeMutexRecord {
  readonly ownerToken: string;
  readonly pid: number;
  readonly hostname: string;
  readonly hostIdentityProven: boolean;
  readonly processIncarnation?: string;
  readonly acquiredAt: number;
  readonly lastHeartbeatAt: number;
  readonly staleMs: number;
}

interface ObservedRuntimeMutex {
  readonly record: RuntimeMutexRecord;
  readonly sha256: string;
}

/** @throws {SystemError} When persisted mutex ownership metadata is malformed. */
function parseMutexRecord(raw: string): RuntimeMutexRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptCoordinationRecord('Runtime coordination mutex is malformed', 'malformed');
  }
  if (
    !isPlainRecord(parsed) ||
    typeof parsed.ownerToken !== 'string' ||
    !OWNER_TOKEN_PATTERN.test(parsed.ownerToken) ||
    !Number.isSafeInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    typeof parsed.hostname !== 'string' ||
    parsed.hostname.length === 0 ||
    Buffer.byteLength(parsed.hostname, 'utf8') > MAX_HOST_IDENTITY_BYTES ||
    typeof parsed.hostIdentityProven !== 'boolean' ||
    (parsed.processIncarnation !== undefined &&
      (typeof parsed.processIncarnation !== 'string' ||
        !PROCESS_INCARNATION_PATTERN.test(parsed.processIncarnation))) ||
    !Number.isSafeInteger(parsed.acquiredAt) ||
    !Number.isSafeInteger(parsed.lastHeartbeatAt) ||
    !Number.isSafeInteger(parsed.staleMs) ||
    (parsed.staleMs as number) < MIN_HEARTBEAT_MS * 3 ||
    (parsed.staleMs as number) > MAX_STALE_MS
  ) {
    throw corruptCoordinationRecord('Runtime coordination mutex is malformed', 'malformed');
  }
  return parsed as unknown as RuntimeMutexRecord;
}

function observeRuntimeMutex(paths: CoordinationPaths): ObservedRuntimeMutex | undefined {
  const content = readBoundedRecord(paths.globalMutexFile, MAX_RECORD_BYTES);
  if (content === undefined) return undefined;
  return {
    record: parseMutexRecord(content),
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

interface RemoteStaleObservation {
  readonly lastHeartbeatAt: number;
  readonly firstObservedAt: number;
}

type RemoteStaleTracker = Map<string, RemoteStaleObservation>;

function foreignOwnerExpired(
  record: {
    readonly ownerToken: string;
    readonly pid: number;
    readonly hostname: string;
    readonly hostIdentityProven: boolean;
    readonly acquiredAt: number;
    readonly lastHeartbeatAt: number;
    readonly staleMs: number;
    readonly sequence?: number;
  },
  environment: RuntimeLeaseEnvironment,
  tracker?: RemoteStaleTracker,
): boolean {
  if (tracker === undefined) return false;
  const key = [
    record.hostname,
    record.hostIdentityProven,
    record.pid,
    record.ownerToken,
    record.acquiredAt,
    record.staleMs,
    record.sequence ?? 'mutex',
  ].join(':');
  const observedAt = environment.monotonicNow();
  const previous = tracker.get(key);
  if (previous?.lastHeartbeatAt !== record.lastHeartbeatAt) {
    tracker.set(key, {
      lastHeartbeatAt: record.lastHeartbeatAt,
      firstObservedAt: observedAt,
    });
    return false;
  }
  return observedAt - previous.firstObservedAt > record.staleMs;
}

function mutexOwnerIsStale(
  record: RuntimeMutexRecord,
  _policy: RuntimeLeasePolicy,
  _now: number,
  environment: RuntimeLeaseEnvironment,
  tracker?: RemoteStaleTracker,
  processInspector?: SafetyBiasedProcessInspector,
  freshProcessProof = false,
): boolean {
  if (!sameProvenRuntimeHost(record, environment)) {
    return foreignOwnerExpired(record, environment, tracker);
  }
  if (record.processIncarnation === undefined) {
    return !environment.isProcessAlive(record.pid);
  }
  let current: ProcessIncarnationInspection;
  if (processInspector === undefined) {
    current = environment.inspectProcessIncarnation(record.pid);
  } else {
    current = freshProcessProof
      ? processInspector.inspectFresh(record.pid)
      : processInspector.inspect(record.pid);
  }
  if (current.status === 'absent') return true;
  if (current.status === 'unknown') return false;
  return current.identity !== record.processIncarnation;
}

function createRuntimeMutexProcessInspector(
  environment: RuntimeLeaseEnvironment,
): SafetyBiasedProcessInspector {
  return createSafetyBiasedProcessInspector({
    inspect: environment.inspectProcessIncarnation,
    monotonicNow: environment.monotonicNow,
    ttlMs: RUNTIME_MUTEX_PROCESS_PROBE_CACHE_MS,
    maxEntries: 8,
  });
}

function emitMutexEvent(
  environment: RuntimeLeaseEnvironment,
  onEvent: RuntimeLeaseCommonInput['onEvent'],
  event: FileLockEvent,
): void {
  try {
    environment.transition?.(`mutex.${event.kind}`);
  } catch {
    // @swallow-ok diagnostic observers never own coordination state
  }
  try {
    onEvent?.(event);
  } catch {
    // @swallow-ok diagnostic observers never own coordination state
  }
}

function tryCreateRuntimeMutex(
  paths: CoordinationPaths,
  ownerToken: string,
  policy: RuntimeLeasePolicy,
  environment: RuntimeLeaseEnvironment,
  processIncarnation: string | undefined,
): boolean {
  const now = environment.now();
  const hostIdentity = runtimeHostIdentity(environment);
  const content = JSON.stringify({
    ownerToken,
    pid: environment.pid,
    hostname: hostIdentity.id,
    hostIdentityProven: hostIdentity.proven,
    ...(processIncarnation === undefined ? {} : { processIncarnation }),
    acquiredAt: now,
    lastHeartbeatAt: now,
    staleMs: policy.staleMs,
  } satisfies RuntimeMutexRecord);
  try {
    mutateCoordinationRecordWhileOwned(
      {
        parentDir: paths.coordinationDir,
        basename: basename(paths.globalMutexFile),
        operation: 'create',
        content,
        maxBytes: MAX_RECORD_BYTES,
      },
      undefined,
      undefined,
      (name) => environment.coordinationCheckpoint?.(name),
    );
    return true;
  } catch (error) {
    if (error instanceof RuntimeSnapshotChangedError) return false;
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'EEXIST' ||
      (error instanceof SystemError && error.code === 'CORE.RUNTIME_COORDINATION.EXISTS')
    ) {
      return false;
    }
    throw error;
  }
}

function recoverStaleRuntimeMutex(
  paths: CoordinationPaths,
  policy: RuntimeLeasePolicy,
  onEvent: RuntimeLeaseCommonInput['onEvent'],
  environment: RuntimeLeaseEnvironment,
  tracker: RemoteStaleTracker,
  processInspector: SafetyBiasedProcessInspector,
): boolean {
  let observed: ObservedRuntimeMutex | undefined;
  try {
    observed = observeRuntimeMutex(paths);
  } catch (error) {
    if (error instanceof RuntimeSnapshotChangedError) return false;
    throw error;
  }
  if (observed === undefined) return true;
  if (
    !mutexOwnerIsStale(
      observed.record,
      policy,
      environment.now(),
      environment,
      tracker,
      processInspector,
    )
  )
    return false;
  let current: ObservedRuntimeMutex | undefined;
  try {
    current = observeRuntimeMutex(paths);
  } catch (error) {
    if (error instanceof RuntimeSnapshotChangedError) return false;
    throw error;
  }
  if (current === undefined) return true;
  if (
    current.record.ownerToken !== observed.record.ownerToken ||
    !mutexOwnerIsStale(
      current.record,
      policy,
      environment.now(),
      environment,
      tracker,
      processInspector,
      true,
    )
  ) {
    return false;
  }
  try {
    environment.coordinationCheckpoint?.('before-stale-mutex-mutation');
    mutateCoordinationRecordWhileOwned(
      {
        parentDir: paths.coordinationDir,
        basename: basename(paths.globalMutexFile),
        operation: 'unlink',
        maxBytes: MAX_RECORD_BYTES,
        expectedContentSha256: current.sha256,
      },
      undefined,
      undefined,
      undefined,
      {
        linkedTargetCanBeBusy: true,
        beforeExpectedDigest: () =>
          environment.coordinationCheckpoint?.('before-stale-mutex-digest-read'),
        beforeFinalUnlinkIdentity: () =>
          environment.coordinationCheckpoint?.('before-stale-mutex-final-identity'),
        beforeFinalUnlink: () => environment.coordinationCheckpoint?.('before-stale-mutex-unlink'),
      },
    );
  } catch (error) {
    if (error instanceof RuntimeSnapshotChangedError) return false;
    if (error instanceof SystemError && error.code === 'CORE.RUNTIME_COORDINATION.CAS_MISMATCH') {
      return false;
    }
    throw error;
  }
  emitMutexEvent(environment, onEvent, {
    kind: 'stale.recovered',
    lockPath: RUNTIME_MUTEX_EVENT_PATH,
    resource: 'runtime',
    operation: 'coordination-transition',
    ownerPid: current.record.pid,
    ownerHostname: current.record.hostname,
  });
  return true;
}

/** @throws {SystemError} When the observed mutex is absent or owned by another process. */
function assertObservedMutexOwner(
  observed: ObservedRuntimeMutex | undefined,
  ownerToken: string,
  environment: RuntimeLeaseEnvironment,
): ObservedRuntimeMutex {
  if (
    observed?.record.ownerToken !== ownerToken ||
    !ownedByRuntimeProcess(observed.record, environment)
  ) {
    throw unsafeCoordination('Runtime coordination mutex ownership changed during transition');
  }
  return observed;
}

interface RuntimeMutexGuard {
  readonly assertOwned: () => void;
  readonly refresh: () => void;
  readonly release: () => void;
}

function ownedRuntimeMutex(
  paths: CoordinationPaths,
  ownerToken: string,
  policy: RuntimeLeasePolicy,
  environment: RuntimeLeaseEnvironment,
): RuntimeMutexGuard {
  let released = false;
  let lastHeartbeatPublicationAt = environment.monotonicNow();
  const observeOwned = (): ObservedRuntimeMutex =>
    assertObservedMutexOwner(observeRuntimeMutex(paths), ownerToken, environment);
  return {
    /** @throws {SystemError} When this guard no longer owns the runtime mutex. */
    assertOwned: () => {
      if (released) {
        throw coordinationConflict(
          'Runtime coordination mutex was already released',
          'already-released',
        );
      }
      observeOwned();
    },
    /** @throws {SystemError} When ownership is lost or the heartbeat cannot be republished safely. */
    refresh: () => {
      if (released) {
        throw coordinationConflict(
          'Runtime coordination mutex was already released',
          'already-released',
        );
      }
      const observed = observeOwned();
      const monotonicNow = environment.monotonicNow();
      if (
        monotonicNow - lastHeartbeatPublicationAt <
        Math.max(1, Math.floor(policy.heartbeatMs / 2))
      ) {
        return;
      }
      const wallNow = environment.now();
      mutateCoordinationRecordWhileOwned({
        parentDir: paths.coordinationDir,
        basename: basename(paths.globalMutexFile),
        operation: 'replace',
        content: JSON.stringify({
          ...observed.record,
          lastHeartbeatAt: wallNow,
        } satisfies RuntimeMutexRecord),
        maxBytes: MAX_RECORD_BYTES,
        expectedContentSha256: observed.sha256,
      });
      lastHeartbeatPublicationAt = monotonicNow;
    },
    release: () => {
      if (released) return;
      const observed = observeOwned();
      mutateCoordinationRecordWhileOwned(
        {
          parentDir: paths.coordinationDir,
          basename: basename(paths.globalMutexFile),
          operation: 'unlink',
          maxBytes: MAX_RECORD_BYTES,
          expectedContentSha256: observed.sha256,
        },
        undefined,
        () => environment.coordinationCheckpoint?.('after-mutex-unlink'),
      );
      released = true;
    },
  };
}

function readOrphanedTemp(
  parentDir: string,
  entry: string,
  maxBytes: number,
): AnchoredRecordReadResult {
  try {
    return readAnchoredRecord({
      trustedAnchorDir: resolveCoordinationPaths().coordinationDir,
      parentDir,
      basename: entry,
      maxBytes,
      permissionPosture: 'private',
    });
  } catch (error) {
    if (
      lstatIfPresent(join(parentDir, entry), 'Runtime coordination temporary record') === undefined
    ) {
      return { status: 'absent' };
    }
    throw error;
  }
}

function reconcileOrphanedTransitionTemp(
  parentDir: string,
  entry: string,
  targetBasename: string,
  maxBytes: number,
  guard: RuntimeMutexGuard,
): void {
  settleCoordinationLinkedCreate(join(parentDir, targetBasename), maxBytes);
  const observed = readOrphanedTemp(parentDir, entry, maxBytes);
  if (observed.status === 'absent') return;
  guard.refresh();
  mutateCoordinationRecordWhileOwned(
    {
      parentDir,
      basename: entry,
      operation: 'unlink',
      maxBytes,
      expectedContentSha256: observed.sha256,
    },
    guard,
  );
}

/**
 * True only when a two-link mutex temporary is the exact hard-link peer of the
 * fixed mutex currently protecting this scan. Link count alone is never enough:
 * an unrelated extra hard link remains unsafe and must fail closed.
 */
function isLinkedOwnedMutexTemporary(paths: CoordinationPaths, entry: string): boolean {
  const temporary = lstatIfPresent(
    join(paths.coordinationDir, entry),
    'Runtime mutex temporary record',
  );
  if (temporary?.nlink !== 2n) return false;
  const fixed = lstatIfPresent(paths.globalMutexFile, 'Runtime coordination mutex');
  if (fixed?.nlink !== 2n) return false;
  assertRecordStatMetadata(temporary, MAX_RECORD_BYTES, 'private');
  assertRecordStatMetadata(fixed, MAX_RECORD_BYTES, 'private');
  return sameRecordIdentity(recordIdentity(temporary), recordIdentity(fixed));
}

function reconcileOrphanedMutexTemp(
  paths: CoordinationPaths,
  entry: string,
  guard: RuntimeMutexGuard,
): void {
  guard.refresh();
  let observed: AnchoredRecordReadResult;
  try {
    observed = readOrphanedTemp(paths.coordinationDir, entry, MAX_RECORD_BYTES);
  } catch (error) {
    if (isLinkedOwnedMutexTemporary(paths, entry)) return;
    // Multi-process cold starts race orphan temps through publication and
    // unlink. A snapshot change means another creator still owns that inode;
    // skip and let the next mutex owner re-scan rather than failing release.
    if (error instanceof RuntimeSnapshotChangedError) return;
    throw error;
  }
  if (observed.status === 'absent') return;
  // The fixed mutex is already owned. A competing one-link prepublication
  // temp cannot publish successfully; deleting it is safe whether its creator
  // is running or crashed. A live creator treats the lost temp as contention.
  guard.refresh();
  try {
    mutateCoordinationRecordWhileOwned(
      {
        parentDir: paths.coordinationDir,
        basename: entry,
        operation: 'unlink',
        maxBytes: MAX_RECORD_BYTES,
        expectedContentSha256: observed.sha256,
      },
      guard,
    );
  } catch (error) {
    if (isLinkedOwnedMutexTemporary(paths, entry)) {
      // The fixed target proves which inode owns the second link. Its creator
      // can finish unlinking the temporary, or the next mutex read will settle
      // the same proven pair without touching unrelated state.
      return;
    }
    // Concurrent cold-start creators rewrite or replace orphan temps between
    // observation and unlink. Whether the path vanished or merely changed,
    // leave it for the live owner / next mutex scan instead of failing
    // acquisition or release.
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      error instanceof RuntimeSnapshotChangedError ||
      (error instanceof SystemError && error.code === 'CORE.RUNTIME_COORDINATION.CAS_MISMATCH')
    ) {
      return;
    }
    throw error;
  }
}

interface RuntimeMutexAttempt {
  readonly paths: CoordinationPaths;
  readonly policy: RuntimeLeasePolicy;
  readonly onEvent: RuntimeLeaseCommonInput['onEvent'];
  readonly ownerToken: string;
  readonly environment: RuntimeLeaseEnvironment;
  readonly tracker: RemoteStaleTracker;
  readonly processInspector: SafetyBiasedProcessInspector;
  readonly processIncarnation: string | undefined;
}

function tryAcquireRuntimeMutexNow(attempt: RuntimeMutexAttempt): RuntimeMutexGuard | undefined {
  const { paths, policy, onEvent, ownerToken, environment, tracker, processInspector } = attempt;
  if (tryCreateRuntimeMutex(paths, ownerToken, policy, environment, attempt.processIncarnation)) {
    return ownedRuntimeMutex(paths, ownerToken, policy, environment);
  }
  try {
    if (
      recoverStaleRuntimeMutex(paths, policy, onEvent, environment, tracker, processInspector) &&
      tryCreateRuntimeMutex(paths, ownerToken, policy, environment, attempt.processIncarnation)
    ) {
      return ownedRuntimeMutex(paths, ownerToken, policy, environment);
    }
  } catch (error) {
    // Multi-process cold starts race linked-create settlement while recovering
    // a contested mutex. Treat snapshot churn as contention and retry the wait
    // loop rather than failing the whole acquisition.
    if (error instanceof RuntimeSnapshotChangedError) return undefined;
    throw error;
  }
  return undefined;
}

function acquireRuntimeMutex(
  paths: CoordinationPaths,
  policy: RuntimeLeasePolicy,
  onEvent: RuntimeLeaseCommonInput['onEvent'],
  remainingMs: number,
  environment: RuntimeLeaseEnvironment,
  signal?: AbortSignal,
): RuntimeMutexGuard | Promise<RuntimeMutexGuard> {
  const ownerToken = environment.generateToken();
  validateOwnerToken(ownerToken);
  const waitMs = Math.max(0, remainingMs);
  const startedAt = environment.monotonicNow();
  const deadline = startedAt + waitMs;
  const remoteStaleTracker: RemoteStaleTracker = new Map();
  const processInspector = createRuntimeMutexProcessInspector(environment);
  const processIncarnation = currentProcessIncarnation(environment);
  emitMutexEvent(environment, onEvent, {
    kind: 'acquire.start',
    lockPath: RUNTIME_MUTEX_EVENT_PATH,
    resource: 'runtime',
    operation: 'coordination-transition',
  });
  const attempt: RuntimeMutexAttempt = {
    paths,
    policy,
    onEvent,
    ownerToken,
    environment,
    tracker: remoteStaleTracker,
    processInspector,
    processIncarnation,
  };
  const immediate = tryAcquireRuntimeMutexNow(attempt);
  if (immediate !== undefined) return immediate;
  return (async () => {
    for (;;) {
      if (signal?.aborted === true) throw abortedError();
      if (environment.monotonicNow() >= deadline) {
        emitMutexEvent(environment, onEvent, {
          kind: 'acquire.timeout',
          lockPath: RUNTIME_MUTEX_EVENT_PATH,
          resource: 'runtime',
          operation: 'coordination-transition',
          waitMs,
        });
        throw new TimeoutError(
          `Timed out waiting for runtime coordination mutex after ${waitMs}ms`,
          { code: COORDINATION_MUTEX_TIMEOUT.code, definition: COORDINATION_MUTEX_TIMEOUT },
        );
      }
      emitMutexEvent(environment, onEvent, {
        kind: 'acquire.wait',
        lockPath: RUNTIME_MUTEX_EVENT_PATH,
        resource: 'runtime',
        operation: 'coordination-transition',
        waitMs: Math.min(waitMs, Math.max(0, environment.monotonicNow() - startedAt)),
      });
      await environment.poll(
        Math.min(policy.pollMs, Math.max(1, deadline - environment.monotonicNow())),
        signal,
      );
      const acquired = tryAcquireRuntimeMutexNow(attempt);
      if (acquired !== undefined) return acquired;
    }
  })();
}

function acquireRuntimeMutexSync(
  paths: CoordinationPaths,
  policy: RuntimeLeasePolicy,
  onEvent: RuntimeLeaseCommonInput['onEvent'],
  environment: RuntimeLeaseEnvironment,
): RuntimeMutexGuard {
  const ownerToken = environment.generateToken();
  validateOwnerToken(ownerToken);
  // Release is synchronous so RunScope teardown cannot outlive the process,
  // but it must honor the same bounded coordination horizon as acquisition.
  // A shorter release-only cap can strand a live reader during otherwise
  // healthy contention and turn one slow mutex holder into a stale-record
  // cascade for every following process.
  const maxWaitMs = policy.waitMs;
  const deadline = environment.monotonicNow() + maxWaitMs;
  const remoteStaleTracker: RemoteStaleTracker = new Map();
  const processInspector = createRuntimeMutexProcessInspector(environment);
  const processIncarnation = currentProcessIncarnation(environment);
  for (;;) {
    const acquired = tryAcquireRuntimeMutexNow({
      paths,
      policy,
      onEvent,
      ownerToken,
      environment,
      tracker: remoteStaleTracker,
      processInspector,
      processIncarnation,
    });
    if (acquired !== undefined) return acquired;
    const remainingMs = deadline - environment.monotonicNow();
    if (remainingMs <= 0) {
      throw new TimeoutError('Timed out releasing runtime coordination state', {
        code: COORDINATION_MUTEX_TIMEOUT.code,
        definition: COORDINATION_MUTEX_TIMEOUT,
      });
    }
    const delay = Math.min(policy.pollMs, Math.max(1, remainingMs));
    environment.pollSync(delay);
  }
}

async function withCoordinationMutex<T>(
  policy: RuntimeLeasePolicy,
  onEvent: RuntimeLeaseCommonInput['onEvent'],
  remainingMs: number,
  fn: (paths: CoordinationPaths, guard: RuntimeMutexGuard) => T | Promise<T>,
  environment: RuntimeLeaseEnvironment = DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
  signal?: AbortSignal,
): Promise<T> {
  const paths = ensureCoordinationScaffold();
  const acquisition = acquireRuntimeMutex(paths, policy, onEvent, remainingMs, environment, signal);
  const guard = acquisition instanceof Promise ? await acquisition : acquisition;
  try {
    void environment.coordinationCheckpoint?.('mutex-entered');
    void guard.refresh();
    assertRegularRecord(paths.globalMutexFile, MAX_RECORD_BYTES);
    assertDirectory(paths.coordinationDir);
    validateCoordinationRootEntries(paths, guard);
    void guard.refresh();
    const result = fn(paths, guard);
    const resolved = result instanceof Promise ? await result : result;
    void environment.coordinationCheckpoint?.('before-mutex-postcondition');
    guard.assertOwned();
    assertDirectory(paths.coordinationDir);
    return resolved;
  } finally {
    void guard.release();
  }
}

function withCoordinationMutexSync<T>(
  policy: RuntimeLeasePolicy,
  onEvent: RuntimeLeaseCommonInput['onEvent'],
  fn: (paths: CoordinationPaths, guard: RuntimeMutexGuard) => T,
  environment: RuntimeLeaseEnvironment = DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
): T {
  const paths = ensureCoordinationScaffold();
  const guard = acquireRuntimeMutexSync(paths, policy, onEvent, environment);
  try {
    guard.refresh();
    assertRegularRecord(paths.globalMutexFile, MAX_RECORD_BYTES);
    validateCoordinationRootEntries(paths, guard);
    guard.refresh();
    const result = fn(paths, guard);
    guard.assertOwned();
    assertDirectory(paths.coordinationDir);
    return result;
  } finally {
    guard.release();
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** @throws {SystemError} When the polling wait is aborted. */
async function defaultPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw abortedError();
  await new Promise<void>((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(complete, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortedError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

const SYNCHRONOUS_POLL_CELL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function defaultPollSync(ms: number): void {
  if (ms <= 0) return;
  // Atomics.wait is Node's blocking sleep primitive. It preserves the
  // synchronous release contract without burning a CPU core and starving
  // other OpenSIP processes that need the same coordination mutex.
  Atomics.wait(SYNCHRONOUS_POLL_CELL, 0, 0, ms);
}

const DEFAULT_RUNTIME_LEASE_ENVIRONMENT: RuntimeLeaseEnvironment = Object.freeze({
  now: () => Date.now(),
  monotonicNow: () => Number(process.hrtime.bigint() / 1_000_000n),
  hostname,
  hostInstanceIdentity: defaultHostInstanceIdentity,
  inspectProcessIncarnation,
  pid: process.pid,
  parentPid: process.ppid,
  isProcessAlive: processIsAlive,
  generateToken: generateUUID,
  poll: defaultPoll,
  pollSync: defaultPollSync,
});

function runtimeEnvironment(input?: InternalRuntimeLeaseInput): RuntimeLeaseEnvironment {
  return input?.[RUNTIME_ENVIRONMENT] ?? DEFAULT_RUNTIME_LEASE_ENVIRONMENT;
}

function ownerIsStale(
  metadata: RecordMetadata,
  _policy: RuntimeLeasePolicy,
  _now: number,
  environment: RuntimeLeaseEnvironment = DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
  tracker?: RemoteStaleTracker,
  processInspectionCache?: ProcessInspectionCache,
  freshProcessProof = false,
): boolean {
  if (!sameProvenRuntimeHost(metadata, environment)) {
    return foreignOwnerExpired(metadata, environment, tracker);
  }
  return sameHostOwnerIsStale(metadata, environment, processInspectionCache, freshProcessProof);
}

function emitLeaseEvent(
  input: RuntimeLeaseCommonInput,
  event: Omit<RuntimeLeaseEvent, 'resource'>,
): void {
  notifyRuntimeLeaseEvent(runtimeEnvironment(input), input.onEvent, {
    ...event,
    resource: 'runtime',
  });
}

function notifyRuntimeLeaseEvent(
  environment: RuntimeLeaseEnvironment,
  onEvent: RuntimeLeaseCommonInput['onEvent'],
  event: RuntimeLeaseEvent,
): void {
  try {
    environment.transition?.(event.kind);
  } catch {
    // @swallow-ok diagnostic observers never own coordination state
  }
  try {
    onEvent?.(event);
  } catch {
    // @swallow-ok diagnostic observers never own coordination state
  }
}

function readerFile(readersDir: string, ownerToken: string): string {
  validateOwnerToken(ownerToken);
  return join(readersDir, `reader-${ownerToken}.json`);
}

/** @throws {SystemError} When persisted reader ownership metadata is malformed. */
function parseReaderRecord(raw: string, dimension: ReaderRecord['dimension']): ReaderRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptCoordinationRecord('Runtime reader record is malformed', 'malformed');
  }
  if (
    !validRecordMetadata(parsed) ||
    !isPlainRecord(parsed) ||
    parsed.version !== STATE_VERSION ||
    parsed.dimension !== dimension ||
    !Number.isSafeInteger(parsed.refs) ||
    (parsed.refs as number) < 1 ||
    (parsed.refs as number) > MAX_REFERENCES_PER_OWNER ||
    !Array.isArray(parsed.references) ||
    parsed.references.length !== parsed.refs ||
    parsed.references.length > MAX_REFERENCES_PER_OWNER ||
    !parsed.references.every(
      (reference) => typeof reference === 'string' && REFERENCE_TOKEN_PATTERN.test(reference),
    ) ||
    new Set(parsed.references).size !== parsed.references.length
  ) {
    throw corruptCoordinationRecord('Runtime reader record is malformed', 'malformed');
  }
  return parsed as unknown as ReaderRecord;
}

/**
 * Reader records are created only while the global mutex is held. Once a new
 * mutex owner reaches this scan, an unlinked reader temp predates that owner
 * and cannot belong to a live cooperating creator.
 */
function recoverReaderTemporaryUnderMutex(
  readersDir: string,
  entry: string,
  guard?: RuntimeMutexGuard,
): void {
  const targetBasename = READER_TEMP_FILE_PATTERN.exec(entry)?.[1];
  if (targetBasename === undefined) return;
  settleCoordinationLinkedCreate(join(readersDir, targetBasename), MAX_RECORD_BYTES);
  const observed = readAnchoredRecord({
    trustedAnchorDir: resolveCoordinationPaths().coordinationDir,
    parentDir: readersDir,
    basename: entry,
    maxBytes: MAX_RECORD_BYTES,
    permissionPosture: 'private',
  });
  if (observed.status === 'absent') return;
  guard?.refresh();
  mutateCoordinationRecordWhileOwned(
    {
      parentDir: readersDir,
      basename: entry,
      operation: 'unlink',
      maxBytes: MAX_RECORD_BYTES,
      expectedContentSha256: observed.sha256,
    },
    guard,
  );
}

interface ObservedReaderRecord {
  readonly path: string;
  readonly record: ReaderRecord;
  readonly sha256: string;
}

function readObservedReaderRecord(
  path: string,
  dimension: ReaderRecord['dimension'],
): ObservedReaderRecord | undefined {
  const observed = readAnchoredRecord({
    trustedAnchorDir: resolveCoordinationPaths().coordinationDir,
    parentDir: dirname(path),
    basename: basename(path),
    maxBytes: MAX_RECORD_BYTES,
    permissionPosture: 'private',
  });
  return observed.status === 'absent'
    ? undefined
    : {
        path,
        record: parseReaderRecord(observed.content, dimension),
        sha256: observed.sha256,
      };
}

/** @throws {SystemError} When the bounded reader directory or a reader record is unsafe. */
function readReaderRecords(
  readersDir: string,
  dimension: ReaderRecord['dimension'],
  repairLinkedCreates = true,
  guard?: RuntimeMutexGuard,
): readonly ObservedReaderRecord[] {
  let entries = [
    ...validateReaderDirectoryEntries(
      readersDir,
      resolveCoordinationPaths().coordinationDir,
      guard,
    ),
  ];
  if (
    entries.length >
    (repairLinkedCreates ? MAX_READERS_PER_DIMENSION * 2 : MAX_READERS_PER_DIMENSION)
  ) {
    throw coordinationCapacity('Runtime reader count exceeds its bound', 'entries');
  }
  if (repairLinkedCreates) {
    for (const [index, entry] of entries.entries()) {
      if (index % 16 === 0) guard?.refresh();
      recoverReaderTemporaryUnderMutex(readersDir, entry, guard);
    }
    entries = [
      ...readDirectoryBounded(readersDir, MAX_READERS_PER_DIMENSION, 'Runtime reader count'),
    ];
  } else if (entries.some((entry) => READER_TEMP_FILE_PATTERN.test(entry))) {
    throw new RuntimeSnapshotChangedError('Runtime reader publication is in progress');
  }
  return entries.map((entry, index) => {
    if (index % 16 === 0) guard?.refresh();
    const match = READER_FILE_PATTERN.exec(entry);
    if (match?.[1] === undefined) {
      throw unsafeCoordination('Runtime reader directory contains an unexpected entry');
    }
    const path = join(readersDir, entry);
    const observed = readObservedReaderRecord(path, dimension);
    if (observed === undefined) {
      throw unsafeCoordination('Runtime reader record disappeared during inspection');
    }
    return observed;
  });
}

function removeObservedReaderRecord(
  observed: ObservedReaderRecord,
  guard?: RuntimeMutexGuard,
  environment: RuntimeLeaseEnvironment = DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
): boolean {
  guard?.refresh();
  environment.coordinationCheckpoint?.('before-stale-reader-unlink');
  try {
    mutateCoordinationRecordWhileOwned(
      {
        parentDir: dirname(observed.path),
        basename: basename(observed.path),
        operation: 'unlink',
        maxBytes: MAX_RECORD_BYTES,
        expectedContentSha256: observed.sha256,
      },
      guard,
    );
    return true;
  } catch (error) {
    if (
      error instanceof SystemError &&
      (error.code === 'CORE.RUNTIME_COORDINATION.CAS_MISMATCH' ||
        error.code === 'CORE.RUNTIME_COORDINATION.BUSY')
    ) {
      return false;
    }
    throw error;
  }
}

/** @throws {SystemError} When exact reader ownership cannot be proven before removal. */
function removeRecordIfOwned(
  path: string,
  ownerToken: string,
  dimension: ReaderRecord['dimension'],
  guard?: RuntimeMutexGuard,
): void {
  const observed = readAnchoredRecord({
    trustedAnchorDir: resolveCoordinationPaths().coordinationDir,
    parentDir: dirname(path),
    basename: basename(path),
    maxBytes: MAX_RECORD_BYTES,
    permissionPosture: 'private',
  });
  if (observed.status === 'absent') return;
  const record = parseReaderRecord(observed.content, dimension);
  if (record.ownerToken !== ownerToken) {
    throw unsafeCoordination('Runtime reader ownership changed before unlink');
  }
  guard?.refresh();
  mutateCoordinationRecordWhileOwned(
    {
      parentDir: dirname(path),
      basename: basename(path),
      operation: 'unlink',
      maxBytes: MAX_RECORD_BYTES,
      expectedContentSha256: observed.sha256,
    },
    guard,
  );
}

interface ReaderScan {
  readonly readersDir: string;
  readonly dimension: ReaderRecord['dimension'];
  readonly policy: RuntimeLeasePolicy;
  readonly onEvent: RuntimeLeaseCommonInput['onEvent'];
  readonly environment?: RuntimeLeaseEnvironment;
  readonly guard?: RuntimeMutexGuard;
  readonly observedAt?: number;
  readonly remoteStaleTracker?: RemoteStaleTracker;
  readonly processInspectionCache?: ProcessInspectionCache;
}

function cleanAndListReaders(scan: ReaderScan): readonly ReaderRecord[] {
  const {
    readersDir,
    dimension,
    policy,
    onEvent,
    environment = DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
    guard,
    observedAt,
    remoteStaleTracker,
    processInspectionCache = createProcessInspectionCache(environment.maxProcessInspectionsPerScan),
  } = scan;
  const now = observedAt ?? environment.now();
  const records = readReaderRecords(readersDir, dimension, true, guard);
  const live: ReaderRecord[] = [];
  for (const [index, { path, record }] of records.entries()) {
    if (index % 16 === 0) guard?.refresh();
    if (
      !ownerIsStale(record, policy, now, environment, remoteStaleTracker, processInspectionCache)
    ) {
      live.push(record);
      continue;
    }
    const current = readObservedReaderRecord(path, dimension);
    if (current === undefined) continue;
    if (
      current.record.ownerToken !== record.ownerToken ||
      // Re-probe without the cache immediately before deletion. In particular,
      // an earlier absent result is never sufficient deletion proof.
      !ownerIsStale(
        current.record,
        policy,
        now,
        environment,
        remoteStaleTracker,
        processInspectionCache,
        true,
      )
    ) {
      live.push(current.record);
      continue;
    }
    if (!removeObservedReaderRecord(current, guard, environment)) {
      const successor = readObservedReaderRecord(path, dimension);
      if (successor !== undefined) live.push(successor.record);
      continue;
    }
    notifyRuntimeLeaseEvent(environment, onEvent, {
      kind: 'lease.stale.recovered',
      resource: 'runtime',
      operation: dimension === 'project' ? 'runtime-read' : 'user-state-read',
      ownerPid: current.record.pid,
      ownerHostname: current.record.hostname,
    });
  }
  return live;
}

function cleanStaleWriters(
  paths: CoordinationPaths,
  state: LeaseStateFile,
  policy: RuntimeLeasePolicy,
  onEvent: RuntimeLeaseCommonInput['onEvent'],
  environment: RuntimeLeaseEnvironment = DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
  guard?: RuntimeMutexGuard,
  remoteStaleTracker?: RemoteStaleTracker,
): LeaseStateFile {
  const now = environment.now();
  const live = state.writers.filter((writer) => {
    const stale = ownerIsStale(writer, policy, now, environment, remoteStaleTracker);
    if (stale) {
      notifyRuntimeLeaseEvent(environment, onEvent, {
        kind: 'lease.stale.recovered',
        resource: 'runtime',
        operation: writer.kind === 'project' ? 'runtime-exclusive' : 'runtime-global-maintenance',
        ownerPid: writer.pid,
        ownerHostname: writer.hostname,
      });
    }
    return !stale;
  });
  if (live.length === state.writers.length) return state;
  const next = { ...state, writers: live };
  writeLeaseState(paths, state, next, guard);
  return next;
}

function buildMetadata(
  ownerToken: string,
  sequence: number,
  input: RuntimeLeaseCommonInput,
  policy: RuntimeLeasePolicy,
): RecordMetadata {
  const environment = runtimeEnvironment(input);
  const now = environment.now();
  const hostIdentity = runtimeHostIdentity(environment);
  const processIncarnation = currentProcessIncarnation(environment);
  return {
    ownerToken,
    pid: environment.pid,
    hostname: hostIdentity.id,
    hostIdentityProven: hostIdentity.proven,
    ...(processIncarnation === undefined ? {} : { processIncarnation }),
    command: safeText(input.command, 'opensip', MAX_NEW_METADATA_TEXT_BYTES),
    cwdBasename: safeText(
      input.cwdBasename,
      safeText(basename(process.cwd()), 'project'),
      MAX_NEW_METADATA_TEXT_BYTES,
    ),
    acquiredAt: now,
    lastHeartbeatAt: now,
    staleMs: policy.staleMs,
    sequence,
  };
}

function writeReaderRecord(
  readersDir: string,
  metadata: RecordMetadata,
  dimension: ReaderRecord['dimension'],
  referenceToken: string,
  guard?: RuntimeMutexGuard,
): void {
  const path = readerFile(readersDir, metadata.ownerToken);
  const content = JSON.stringify({
    version: STATE_VERSION,
    dimension,
    refs: 1,
    references: [referenceToken],
    ...metadata,
  });
  guard?.refresh();
  mutateCoordinationRecordWhileOwned(
    {
      parentDir: readersDir,
      basename: basename(path),
      operation: 'create',
      content,
      maxBytes: MAX_RECORD_BYTES,
    },
    guard,
  );
}

/** @throws {SystemError} When a reader record changes or cannot be replaced safely. */
function replaceReaderRecord(
  readersDir: string,
  record: ReaderRecord,
  guard?: RuntimeMutexGuard,
): void {
  const path = readerFile(readersDir, record.ownerToken);
  const observed = readAnchoredRecord({
    trustedAnchorDir: resolveCoordinationPaths().coordinationDir,
    parentDir: readersDir,
    basename: basename(path),
    maxBytes: MAX_RECORD_BYTES,
    permissionPosture: 'private',
  });
  if (observed.status !== 'present') {
    throw new RuntimeSnapshotChangedError('Runtime reader record disappeared before replacement');
  }
  const current = parseReaderRecord(observed.content, record.dimension);
  if (current.ownerToken !== record.ownerToken) {
    throw unsafeCoordination('Runtime reader ownership changed before replacement');
  }
  guard?.refresh();
  mutateCoordinationRecordWhileOwned(
    {
      parentDir: readersDir,
      basename: basename(path),
      operation: 'replace',
      content: JSON.stringify(record),
      maxBytes: MAX_RECORD_BYTES,
      expectedContentSha256: observed.sha256,
    },
    guard,
  );
}

function replaceReaderHeartbeat(
  readersDir: string,
  ownerToken: string,
  dimension: ReaderRecord['dimension'],
  environment: RuntimeLeaseEnvironment = DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
  guard?: RuntimeMutexGuard,
): void {
  const path = readerFile(readersDir, ownerToken);
  const observed = readAnchoredRecord({
    trustedAnchorDir: resolveCoordinationPaths().coordinationDir,
    parentDir: readersDir,
    basename: basename(path),
    maxBytes: MAX_RECORD_BYTES,
    permissionPosture: 'private',
  });
  if (observed.status === 'absent') return;
  const record = parseReaderRecord(observed.content, dimension);
  if (record.ownerToken !== ownerToken || !ownedByRuntimeProcess(record, environment)) {
    return;
  }
  guard?.refresh();
  mutateCoordinationRecordWhileOwned(
    {
      parentDir: readersDir,
      basename: basename(path),
      operation: 'replace',
      content: JSON.stringify({
        ...record,
        lastHeartbeatAt: environment.now(),
      }),
      maxBytes: MAX_RECORD_BYTES,
      expectedContentSha256: observed.sha256,
    },
    guard,
  );
}

function inspectRecoveryHeader(
  path: string,
  expectedKind: 'init-promotion' | 'user-uninstall',
  expectedCoordinationKey?: string,
  repairLinkedCreate = true,
): RecoveryHeaderInspection {
  if (repairLinkedCreate) {
    try {
      settleCoordinationLinkedCreate(path, RUNTIME_RECOVERY_RECORD_MAX_BYTES);
    } catch {
      return { status: 'malformed', reason: 'unsafe-file' };
    }
  }
  try {
    const prefix = `.${basename(path)}.tmp-`;
    const siblings = readDirectoryBounded(
      dirname(path),
      MAX_MUTEX_TEMPS + 8,
      'Runtime recovery-header directory',
    );
    if (siblings.some((entry) => entry.startsWith(prefix))) {
      return { status: 'malformed', reason: 'unsafe-file' };
    }
  } catch {
    return { status: 'malformed', reason: 'unsafe-file' };
  }
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'malformed', reason: 'unsafe-file' };
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    (() => {
      const uid = currentUid();
      return uid !== undefined && stat.uid !== BigInt(uid);
    })() ||
    (process.platform !== 'win32' && Number(stat.mode & 0o777n) !== 0o600)
  ) {
    return { status: 'malformed', reason: 'unsafe-file' };
  }
  if (stat.size > BigInt(RUNTIME_RECOVERY_RECORD_MAX_BYTES)) {
    return { status: 'malformed', reason: 'oversize' };
  }
  let raw: string;
  try {
    const read = readBoundedRecord(path, RUNTIME_RECOVERY_RECORD_MAX_BYTES, repairLinkedCreate);
    if (read === undefined) return { status: 'absent' };
    raw = read;
  } catch {
    return { status: 'malformed', reason: 'unsafe-file' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'malformed', reason: 'invalid-json' };
  }
  if (
    !isPlainRecord(parsed) ||
    parsed.kind !== expectedKind ||
    parsed.version !== RUNTIME_RECOVERY_HEADER_VERSION ||
    (parsed.state !== 'open' && parsed.state !== 'closed') ||
    typeof parsed.operationId !== 'string' ||
    !validateOperationId(parsed.operationId)
  ) {
    return { status: 'malformed', reason: 'invalid-header' };
  }
  if (
    expectedKind === 'init-promotion' &&
    (typeof parsed.coordinationKey !== 'string' ||
      parsed.coordinationKey !== expectedCoordinationKey)
  ) {
    return { status: 'malformed', reason: 'coordination-key-mismatch' };
  }
  if (
    parsed.reason !== undefined &&
    (typeof parsed.reason !== 'string' || Buffer.byteLength(parsed.reason, 'utf8') > MAX_SAFE_TEXT)
  ) {
    return { status: 'malformed', reason: 'invalid-header' };
  }
  return {
    status: 'valid',
    state: parsed.state,
    operationId: parsed.operationId,
    ...(typeof parsed.reason === 'string' ? { reason: safeText(parsed.reason, 'recovery') } : {}),
  };
}

function inspectPromotionHeader(
  paths: CoordinationPaths,
  coordinationKey: string,
  guard?: RuntimeMutexGuard,
): RecoveryHeaderInspection {
  ensureProjectScaffold(paths, coordinationKey, guard);
  return inspectRecoveryHeader(
    paths.forProject(coordinationKey).promotionJournalFile,
    'init-promotion',
    coordinationKey,
  );
}

function inspectUserReceiptHeader(paths: CoordinationPaths): RecoveryHeaderInspection {
  return inspectRecoveryHeader(paths.userUninstallReceiptFile, 'user-uninstall');
}

/** @throws {SystemError} When recovery state blocks normal shared access. */
function assertNormalSharedAccess(
  paths: CoordinationPaths,
  coordinationKey: string | undefined,
  input: RuntimeLeaseCommonInput,
  kind: RuntimeLeaseWaitKind,
  guard?: RuntimeMutexGuard,
): void {
  const userReceipt = inspectUserReceiptHeader(paths);
  if (
    userReceipt.status === 'malformed' ||
    (userReceipt.status === 'valid' && userReceipt.state === 'open')
  ) {
    emitLeaseEvent(input, { kind: 'lease.recovery.required', operation: kind });
    throw recoveryRequired(
      'An interrupted user uninstall requires recovery. Run `opensip status` and retry uninstall.',
    );
  }
  if (coordinationKey === undefined) return;
  const promotion = inspectPromotionHeader(paths, coordinationKey, guard);
  if (
    promotion.status === 'malformed' ||
    (promotion.status === 'valid' && promotion.state === 'open')
  ) {
    emitLeaseEvent(input, { kind: 'lease.recovery.required', operation: kind });
    throw recoveryRequired(
      'An interrupted Init promotion requires recovery. Run `opensip status`, then `opensip init`.',
    );
  }
}

/** @throws {SystemError} When project recovery state is incompatible with exclusive posture. */
function assertProjectExclusivePosture(
  paths: CoordinationPaths,
  coordinationKey: string,
  posture: RuntimeExclusivePosture,
  recoveryOperationId: string | undefined,
  guard?: RuntimeMutexGuard,
): void {
  const header = inspectPromotionHeader(paths, coordinationKey, guard);
  if (posture === 'normal') {
    if (header.status !== 'absent') {
      throw recoveryRequired(
        'Runtime maintenance is blocked by an Init promotion journal. Run `opensip init` to recover it.',
      );
    }
    return;
  }
  if (posture === 'init-recovery') {
    if (
      header.status !== 'valid' ||
      !validateOperationId(recoveryOperationId) ||
      header.operationId !== recoveryOperationId
    ) {
      throw recoveryRequired('Init recovery requires a matching promotion operation.');
    }
    return;
  }
  if (header.status === 'absent') {
    throw recoveryRequired(
      'Destructive promotion-journal discard requires an existing recovery journal.',
    );
  }
}

/** @throws {SystemError} When user recovery state is incompatible with global posture. */
function assertGlobalExclusivePosture(
  paths: CoordinationPaths,
  posture: GlobalRuntimeMaintenancePosture,
  recoveryOperationId: string | undefined,
): void {
  const header = inspectUserReceiptHeader(paths);
  if (posture === 'normal') {
    if (header.status !== 'absent') {
      throw recoveryRequired(
        'User-state maintenance is blocked by an uninstall receipt. Retry uninstall recovery.',
      );
    }
    return;
  }
  if (posture === 'user-recovery') {
    if (
      header.status !== 'valid' ||
      !validateOperationId(recoveryOperationId) ||
      header.operationId !== recoveryOperationId
    ) {
      throw recoveryRequired('User uninstall recovery requires a matching operation.');
    }
    return;
  }
  if (header.status !== 'malformed') {
    throw recoveryRequired(
      'Receipt-only discard is allowed only for a malformed or oversize uninstall receipt.',
    );
  }
}

interface ExistingReader {
  readonly coordinationKey?: string;
  readonly readersDir: string;
  readonly record: ReaderRecord;
}

/** @throws {SystemError} When project coordination inventory is excessive or malformed. */
function listProjectCoordinationKeys(
  paths: CoordinationPaths,
  guard?: RuntimeMutexGuard,
): readonly string[] {
  assertDirectory(paths.projectsDir, paths.coordinationDir);
  const entries = readDirectoryBounded(
    paths.projectsDir,
    MAX_PROJECT_KEYS,
    'Runtime coordination project count',
  );
  for (const entry of entries) {
    guard?.refresh();
    if (!PROJECT_KEY_PATTERN.test(entry)) {
      throw coordinationInputInvalid('Runtime coordination projects contain an invalid key', 'key');
    }
    validateProjectCoordinationEntries(paths, entry, guard);
  }
  return [...entries].sort();
}

function readOwnerRecordIfPresent(
  readersDir: string,
  ownerToken: string,
  dimension: ReaderRecord['dimension'],
): ObservedReaderRecord | undefined {
  return readObservedReaderRecord(readerFile(readersDir, ownerToken), dimension);
}

function findExistingOwnerReaders(
  paths: CoordinationPaths,
  ownerToken: string,
  policy: RuntimeLeasePolicy,
  onEvent: RuntimeLeaseCommonInput['onEvent'],
  environment: RuntimeLeaseEnvironment = DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
  guard?: RuntimeMutexGuard,
  remoteStaleTracker?: RemoteStaleTracker,
): {
  readonly projects: readonly ExistingReader[];
  readonly user?: ExistingReader;
} {
  const projects: ExistingReader[] = [];
  for (const coordinationKey of listProjectCoordinationKeys(paths, guard)) {
    guard?.refresh();
    const projectPaths = paths.forProject(coordinationKey);
    assertDirectory(projectPaths.readersDir, paths.coordinationDir);
    const observed = readOwnerRecordIfPresent(projectPaths.readersDir, ownerToken, 'project');
    if (observed === undefined) continue;
    const { record } = observed;
    if (ownerIsStale(record, policy, environment.now(), environment, remoteStaleTracker)) {
      if (!removeObservedReaderRecord(observed, guard, environment)) {
        const successor = readOwnerRecordIfPresent(projectPaths.readersDir, ownerToken, 'project');
        if (successor !== undefined) {
          projects.push({
            coordinationKey,
            readersDir: projectPaths.readersDir,
            record: successor.record,
          });
        }
        continue;
      }
      notifyRuntimeLeaseEvent(environment, onEvent, {
        kind: 'lease.stale.recovered',
        resource: 'runtime',
        operation: 'runtime-read',
        ownerPid: record.pid,
        ownerHostname: record.hostname,
      });
      continue;
    }
    projects.push({
      coordinationKey,
      readersDir: projectPaths.readersDir,
      record,
    });
  }
  const userObserved = readOwnerRecordIfPresent(paths.userReadersDir, ownerToken, 'user');
  let user: ExistingReader | undefined;
  if (userObserved !== undefined) {
    const { record: userRecord } = userObserved;
    if (ownerIsStale(userRecord, policy, environment.now(), environment, remoteStaleTracker)) {
      if (!removeObservedReaderRecord(userObserved, guard, environment)) {
        const successor = readOwnerRecordIfPresent(paths.userReadersDir, ownerToken, 'user');
        if (successor !== undefined) {
          user = { readersDir: paths.userReadersDir, record: successor.record };
        }
        return { projects, ...(user === undefined ? {} : { user }) };
      }
      notifyRuntimeLeaseEvent(environment, onEvent, {
        kind: 'lease.stale.recovered',
        resource: 'runtime',
        operation: 'user-state-read',
        ownerPid: userRecord.pid,
        ownerHostname: userRecord.hostname,
      });
    } else {
      user = { readersDir: paths.userReadersDir, record: userRecord };
    }
  }
  return { projects, ...(user === undefined ? {} : { user }) };
}

function assertOwnerRecordsCompatible(
  existing: ReturnType<typeof findExistingOwnerReaders>,
  projectKey: string | undefined,
  environment: RuntimeLeaseEnvironment,
): void {
  if (existing.projects.length > 1) {
    throw new SystemError('One runtime lease owner cannot span multiple project keys', {
      code: 'CORE.RUNTIME_LEASE.OWNER_MISMATCH',
    });
  }
  const records = [
    ...existing.projects.map((entry) => entry.record),
    ...(existing.user === undefined ? [] : [existing.user.record]),
  ];
  if (records.some((record) => !ownedByRuntimeProcess(record, environment))) {
    throw new SystemError('Runtime lease owner token belongs to another process', {
      code: 'CORE.RUNTIME_LEASE.OWNER_MISMATCH',
    });
  }
  const existingKey = existing.projects[0]?.coordinationKey;
  if (existingKey !== undefined && projectKey !== undefined && existingKey !== projectKey) {
    throw new SystemError('Runtime lease owner token belongs to another project', {
      code: 'CORE.RUNTIME_LEASE.OWNER_MISMATCH',
    });
  }
}

function parentInheritanceDenied(message: string): SystemError {
  return new SystemError(message, {
    code: 'CORE.RUNTIME_LEASE.INHERITANCE_DENIED',
  });
}

function ownedByDirectParentProcess(
  record: ReaderRecord,
  environment: RuntimeLeaseEnvironment,
): boolean {
  const parentPid = environment.parentPid;
  if (
    !Number.isInteger(parentPid) ||
    parentPid <= 0 ||
    parentPid === environment.pid ||
    record.pid !== parentPid ||
    !sameProvenRuntimeHost(record, environment)
  ) {
    return false;
  }
  const inspection = environment.inspectProcessIncarnation(parentPid);
  if (record.processIncarnation !== undefined) {
    return inspection.status === 'present' && inspection.identity === record.processIncarnation;
  }
  // Windows and other platforms without a portable process-start identity
  // still expose the kernel-reported direct parent PID. Admit the narrower
  // same-host fallback only when incarnation inspection is unavailable and
  // that exact parent PID is currently live. Both composite dimensions must
  // still agree on owner/sequence below, so this does not become a transported
  // or arbitrary-PID delegation credential.
  return inspection.status === 'unknown' && environment.isProcessAlive(parentPid);
}

interface DirectParentCompositeReader {
  readonly ownerToken: string;
  readonly sequence: number;
  readonly acquiredAt: number;
}

/**
 * Discover exactly one requested-project reader owned by this process's live
 * direct parent, then bind it to the corresponding live user reader. No parent
 * dimensions means an ordinary top-level acquisition; partial or ambiguous
 * parent evidence is rejected rather than guessed.
 *
 * @throws {SystemError} When parent ownership evidence is partial, ambiguous, stale, or unsafe.
 */
function resolveDirectParentCompositeReader(
  projectReaders: readonly ReaderRecord[],
  userReaders: readonly ReaderRecord[],
  environment: RuntimeLeaseEnvironment,
): DirectParentCompositeReader | undefined {
  const parentPid = environment.parentPid;
  const projectPidMatches = projectReaders.filter((record) => record.pid === parentPid);
  const userPidMatches = userReaders.filter((record) => record.pid === parentPid);
  if (projectPidMatches.length === 0 && userPidMatches.length === 0) {
    return undefined;
  }
  const projectCandidates = projectReaders.filter((record) =>
    ownedByDirectParentProcess(record, environment),
  );
  const userCandidates = userReaders.filter((record) =>
    ownedByDirectParentProcess(record, environment),
  );
  if (
    projectCandidates.length !== projectPidMatches.length ||
    userCandidates.length !== userPidMatches.length
  ) {
    throw parentInheritanceDenied(
      'Runtime reader inheritance could not prove direct-parent host and process identity',
    );
  }
  if (projectCandidates.length !== 1) {
    throw parentInheritanceDenied(
      projectCandidates.length === 0
        ? 'Runtime reader inheritance found direct-parent user state without the requested project'
        : 'Runtime reader inheritance found multiple direct-parent project readers',
    );
  }
  const project = projectCandidates[0];
  if (userCandidates.length !== 1) {
    throw parentInheritanceDenied(
      userCandidates.length === 0
        ? 'Runtime reader inheritance requires matching direct-parent user state'
        : 'Runtime reader inheritance found multiple direct-parent user-state readers',
    );
  }
  const user = userCandidates[0];
  if (user.ownerToken !== project.ownerToken || user.sequence !== project.sequence) {
    throw parentInheritanceDenied(
      'Runtime reader inheritance could not prove a live direct-parent composite owner',
    );
  }
  return {
    ownerToken: project.ownerToken,
    sequence: project.sequence,
    acquiredAt: Math.min(project.acquiredAt, user.acquiredAt),
  };
}

function writerBlocksSharedRegistration(
  writer: WriterRecord,
  projectKey: string | undefined,
  wantsProject: boolean,
  existing: ReturnType<typeof findExistingOwnerReaders>,
  ownedProjectWriter?: WriterRecord,
): boolean {
  const existingProject = existing.projects[0];
  const existingRecords = [
    ...(existingProject === undefined ? [] : [existingProject.record]),
    ...(existing.user === undefined ? [] : [existing.user.record]),
  ];
  const oldestExisting = Math.min(
    ...existingRecords.map((record) => record.sequence),
    ...(ownedProjectWriter === undefined ? [] : [ownedProjectWriter.sequence]),
  );
  const hasExisting = Number.isFinite(oldestExisting);
  if (writer.kind === 'global') {
    return !hasExisting || writer.sequence < oldestExisting;
  }
  if (!wantsProject || writer.coordinationKey !== projectKey) return false;
  if (existingProject?.coordinationKey !== projectKey) return true;
  return writer.sequence < existingProject.record.sequence;
}

interface SharedRegistrationResult {
  readonly acquiredAt: number;
  readonly sequence: number;
}

interface OwnedWriterReentryCheck {
  readonly paths: CoordinationPaths;
  readonly writer: WriterRecord;
  readonly wantsProject: boolean;
  readonly wantsUser: boolean;
  readonly input: RuntimeLeaseCommonInput;
  readonly policy: RuntimeLeasePolicy;
  readonly environment: RuntimeLeaseEnvironment;
  readonly guard?: RuntimeMutexGuard;
  readonly remoteStaleTracker?: RemoteStaleTracker;
}

function validateOwnedWriterUserReentry(check: OwnedWriterReentryCheck): boolean {
  const {
    paths,
    writer,
    wantsProject,
    wantsUser,
    input,
    policy,
    environment,
    guard,
    remoteStaleTracker,
  } = check;
  if (!ownedByRuntimeProcess(writer, environment)) {
    throw new SystemError('Runtime lease owner token belongs to another process', {
      code: 'CORE.RUNTIME_LEASE.OWNER_MISMATCH',
    });
  }
  if (writer.kind !== 'project' || writer.phase !== 'intent' || wantsProject || !wantsUser) {
    throw new SystemError('Exclusive runtime leases cannot be upgraded or nested', {
      code: 'CORE.RUNTIME_LEASE.EXCLUSIVE_UPGRADE',
    });
  }
  // Init discovers project-local state under this writer before it discovers
  // user policy/tool state. The writer's earlier sequence is the ordering
  // anchor; publish no user reader until its project dimension has drained.
  return (
    cleanAndListReaders({
      readersDir: paths.forProject(requiredProjectCoordinationKey(writer.coordinationKey))
        .readersDir,
      dimension: 'project',
      policy,
      onEvent: input.onEvent,
      environment,
      guard,
      remoteStaleTracker,
    }).length === 0
  );
}

function incrementReaderRef(
  existing: ExistingReader,
  environment: RuntimeLeaseEnvironment,
  referenceToken: string,
  policy: RuntimeLeasePolicy,
  guard?: RuntimeMutexGuard,
): void {
  if (
    existing.record.references.includes(referenceToken) ||
    existing.record.refs >= MAX_REFERENCES_PER_OWNER
  ) {
    throw new SystemError('Runtime reader reference capacity is exhausted', {
      code: 'CORE.RUNTIME_LEASE.CAPACITY',
    });
  }
  replaceReaderRecord(
    existing.readersDir,
    {
      ...existing.record,
      refs: existing.record.refs + 1,
      references: [...existing.record.references, referenceToken],
      lastHeartbeatAt: environment.now(),
      staleMs: Math.max(existing.record.staleMs, policy.staleMs),
    },
    guard,
  );
}

interface SharedRegistrationRequest {
  readonly paths: CoordinationPaths;
  readonly ownerToken: string;
  readonly projectKey: string | undefined;
  readonly wantsProject: boolean;
  readonly wantsUser: boolean;
  readonly referenceToken: string;
  readonly input: RuntimeLeaseCommonInput;
  readonly policy: RuntimeLeasePolicy;
  readonly guard?: RuntimeMutexGuard;
  readonly remoteStaleTracker?: RemoteStaleTracker;
}

function registerSharedDimensions(
  request: SharedRegistrationRequest,
): SharedRegistrationResult | undefined {
  const {
    paths,
    ownerToken,
    projectKey,
    wantsProject,
    wantsUser,
    referenceToken,
    input,
    policy,
    guard,
    remoteStaleTracker,
  } = request;
  const environment = runtimeEnvironment(input);
  if (projectKey !== undefined) ensureProjectScaffold(paths, projectKey, guard);
  assertNormalSharedAccess(
    paths,
    wantsProject ? projectKey : undefined,
    input,
    sharedWaitKind(wantsProject, wantsUser),
    guard,
  );
  const state = cleanStaleWriters(
    paths,
    readLeaseState(paths),
    policy,
    input.onEvent,
    environment,
    guard,
    remoteStaleTracker,
  );
  const ownedWriter = state.writers.find((writer) => writer.ownerToken === ownerToken);
  if (
    ownedWriter !== undefined &&
    !validateOwnedWriterUserReentry({
      paths,
      writer: ownedWriter,
      wantsProject,
      wantsUser,
      input,
      policy,
      environment,
      guard,
      remoteStaleTracker,
    })
  ) {
    return undefined;
  }
  const existing = findExistingOwnerReaders(
    paths,
    ownerToken,
    policy,
    input.onEvent,
    environment,
    guard,
    remoteStaleTracker,
  );
  assertOwnerRecordsCompatible(existing, projectKey, environment);
  if (
    state.writers.some((writer) =>
      writerBlocksSharedRegistration(writer, projectKey, wantsProject, existing, ownedWriter),
    )
  ) {
    return undefined;
  }

  const existingProject =
    existing.projects[0]?.coordinationKey === projectKey ? existing.projects[0] : undefined;
  const existingUser = existing.user;
  if (wantsProject && existingProject === undefined) {
    const projectReaders = cleanAndListReaders({
      readersDir: paths.forProject(requiredProjectCoordinationKey(projectKey)).readersDir,
      dimension: 'project',
      policy,
      onEvent: input.onEvent,
      environment,
      guard,
      remoteStaleTracker,
    });
    if (projectReaders.length >= MAX_READERS_PER_DIMENSION) return undefined;
  }
  if (wantsUser && existingUser === undefined) {
    const userReaders = cleanAndListReaders({
      readersDir: paths.userReadersDir,
      dimension: 'user',
      policy,
      onEvent: input.onEvent,
      environment,
      guard,
      remoteStaleTracker,
    });
    if (userReaders.length >= MAX_READERS_PER_DIMENSION) return undefined;
  }
  if (
    (wantsProject &&
      existingProject !== undefined &&
      existingProject.record.refs >= MAX_REFERENCES_PER_OWNER) ||
    (wantsUser &&
      existingUser !== undefined &&
      existingUser.record.refs >= MAX_REFERENCES_PER_OWNER)
  ) {
    return undefined;
  }
  const existingSequence =
    existingProject?.record.sequence ?? existingUser?.record.sequence ?? ownedWriter?.sequence;
  const sequence = existingSequence ?? state.nextSequence;
  if (existingSequence === undefined) {
    const nextState = { ...state, nextSequence: state.nextSequence + 1 };
    writeLeaseState(paths, state, nextState, guard);
  }
  const metadata = buildMetadata(ownerToken, sequence, input, policy);
  const created: { path: string; dimension: ReaderRecord['dimension'] }[] = [];
  const replaced: ExistingReader[] = [];
  try {
    if (wantsProject) {
      const readersDir = paths.forProject(requiredProjectCoordinationKey(projectKey)).readersDir;
      if (existingProject === undefined) {
        writeReaderRecord(readersDir, metadata, 'project', referenceToken, guard);
        created.push({
          path: readerFile(readersDir, ownerToken),
          dimension: 'project',
        });
      } else {
        incrementReaderRef(existingProject, environment, referenceToken, policy, guard);
        replaced.push(existingProject);
      }
    }
    if (wantsUser) {
      if (existingUser === undefined) {
        writeReaderRecord(paths.userReadersDir, metadata, 'user', referenceToken, guard);
        created.push({
          path: readerFile(paths.userReadersDir, ownerToken),
          dimension: 'user',
        });
      } else {
        incrementReaderRef(existingUser, environment, referenceToken, policy, guard);
        replaced.push(existingUser);
      }
    }
  } catch (error) {
    for (let index = created.length - 1; index >= 0; index -= 1) {
      const entry = created[index];
      try {
        removeRecordIfOwned(entry.path, ownerToken, entry.dimension, guard);
      } catch {
        // @swallow-ok Ambiguous rollback state remains live before the primary error is rethrown.
        // Fail closed: a partial live record is safer than erasing ambiguous state.
      }
    }
    for (let index = replaced.length - 1; index >= 0; index -= 1) {
      const entry = replaced[index];
      try {
        replaceReaderRecord(entry.readersDir, entry.record, guard);
      } catch {
        // @swallow-ok Refcount rollback failure preserves live ownership before rethrow.
        // Fail closed: an elevated refcount remains owned by this live process.
      }
    }
    throw error;
  }
  return {
    acquiredAt:
      existingProject?.record.acquiredAt ??
      existingUser?.record.acquiredAt ??
      ownedWriter?.acquiredAt ??
      metadata.acquiredAt,
    sequence,
  };
}

/**
 * Register a fresh child-owned composite reader at its live direct parent's
 * sequence. This is the only cross-process fairness inheritance path: it
 * cannot re-use the parent's record, span another project, omit the user
 * dimension, or pass a writer that precedes the parent.
 */
interface ParentInheritedRegistrationRequest {
  readonly paths: CoordinationPaths;
  readonly ownerToken: string;
  readonly projectKey: string;
  readonly referenceToken: string;
  readonly input: RuntimeLeaseCommonInput;
  readonly policy: RuntimeLeasePolicy;
  readonly guard?: RuntimeMutexGuard;
  readonly remoteStaleTracker?: RemoteStaleTracker;
}

/** @throws {SystemError} When direct-parent reader inheritance cannot be proven safely. */
function registerParentInheritedSharedDimensions(
  request: ParentInheritedRegistrationRequest,
): SharedRegistrationResult | undefined {
  const {
    paths,
    ownerToken,
    projectKey,
    referenceToken,
    input,
    policy,
    guard,
    remoteStaleTracker,
  } = request;
  const environment = runtimeEnvironment(input);
  ensureProjectScaffold(paths, projectKey, guard);
  assertNormalSharedAccess(paths, projectKey, input, 'runtime-access-composite', guard);
  const state = cleanStaleWriters(
    paths,
    readLeaseState(paths),
    policy,
    input.onEvent,
    environment,
    guard,
    remoteStaleTracker,
  );
  const projectReaders = cleanAndListReaders({
    readersDir: paths.forProject(projectKey).readersDir,
    dimension: 'project',
    policy,
    onEvent: input.onEvent,
    environment,
    guard,
    remoteStaleTracker,
  });
  const userReaders = cleanAndListReaders({
    readersDir: paths.userReadersDir,
    dimension: 'user',
    policy,
    onEvent: input.onEvent,
    environment,
    guard,
    remoteStaleTracker,
  });
  const parent = resolveDirectParentCompositeReader(projectReaders, userReaders, environment);
  if (parent === undefined) {
    return registerSharedDimensions({
      paths,
      ownerToken,
      projectKey,
      wantsProject: true,
      wantsUser: true,
      referenceToken,
      input,
      policy,
      guard,
      remoteStaleTracker,
    });
  }

  if (state.writers.some((writer) => writer.ownerToken === ownerToken)) {
    throw parentInheritanceDenied('A child runtime reader owner is already in use');
  }
  const existing = findExistingOwnerReaders(
    paths,
    ownerToken,
    policy,
    input.onEvent,
    environment,
    guard,
    remoteStaleTracker,
  );
  if (existing.projects.length > 0 || existing.user !== undefined) {
    throw parentInheritanceDenied('A child runtime reader owner is already registered');
  }
  if (ownerToken === parent.ownerToken) {
    throw parentInheritanceDenied('A child runtime reader requires a fresh owner token');
  }

  const earlierWriter = state.writers.find(
    (writer) =>
      (writer.kind === 'global' ||
        (writer.kind === 'project' && writer.coordinationKey === projectKey)) &&
      writer.sequence <= parent.sequence,
  );
  if (earlierWriter !== undefined) {
    throw parentInheritanceDenied(
      'Runtime reader inheritance cannot bypass a writer that precedes its parent',
    );
  }

  if (
    projectReaders.length >= MAX_READERS_PER_DIMENSION ||
    userReaders.length >= MAX_READERS_PER_DIMENSION
  ) {
    return undefined;
  }

  // Parent processes can exit without acquiring this mutex. Re-prove the exact
  // composite immediately before publishing the inherited child records.
  const confirmedParent = resolveDirectParentCompositeReader(
    projectReaders,
    userReaders,
    environment,
  );
  if (
    confirmedParent?.ownerToken !== parent.ownerToken ||
    confirmedParent.sequence !== parent.sequence
  ) {
    throw parentInheritanceDenied('The direct-parent runtime reader changed during inheritance');
  }

  const metadata = buildMetadata(ownerToken, confirmedParent.sequence, input, policy);
  const created: { path: string; dimension: ReaderRecord['dimension'] }[] = [];
  try {
    const projectReadersDir = paths.forProject(projectKey).readersDir;
    writeReaderRecord(projectReadersDir, metadata, 'project', referenceToken, guard);
    created.push({
      path: readerFile(projectReadersDir, ownerToken),
      dimension: 'project',
    });
    writeReaderRecord(paths.userReadersDir, metadata, 'user', referenceToken, guard);
    created.push({
      path: readerFile(paths.userReadersDir, ownerToken),
      dimension: 'user',
    });
  } catch (error) {
    for (let index = created.length - 1; index >= 0; index -= 1) {
      const entry = created[index];
      try {
        removeRecordIfOwned(entry.path, ownerToken, entry.dimension, guard);
      } catch {
        // @swallow-ok Ambiguous child state stays owned before the primary error is rethrown.
        // Fail closed: a partial child record remains owned by this live process.
      }
    }
    throw error;
  }
  return {
    acquiredAt: metadata.acquiredAt,
    sequence: confirmedParent.sequence,
  };
}

function abortedError(): SystemError {
  return new SystemError('Runtime lease acquisition was cancelled', {
    code: 'CORE.RUNTIME_LEASE.CANCELLED',
  });
}

/** @throws {SystemError} When runtime lease acquisition has been cancelled. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortedError();
}

/** @throws {SystemError} When acquisition is cancelled or its deadline expires while polling. */
async function pollDelay(
  input: RuntimeLeaseCommonInput,
  policy: RuntimeLeasePolicy,
  deadline: number,
) {
  const environment = runtimeEnvironment(input);
  if (input.signal?.aborted === true) throw abortedError();
  const delay = Math.min(policy.pollMs, Math.max(1, deadline - environment.monotonicNow()));
  await environment.poll(delay, input.signal);
}

function sharedWaitKind(wantsProject: boolean, wantsUser: boolean): RuntimeLeaseWaitKind {
  if (wantsProject && wantsUser) return 'runtime-access-composite';
  return wantsProject ? 'runtime-read' : 'user-state-read';
}

function generateReferenceToken(): string {
  return createHash('sha256').update(generateUUID()).digest('hex').slice(0, 24);
}

interface DeferredPublicationCleanup {
  readonly key: string;
  run?: () => Promise<void>;
  baseDelayMs: number;
  nextAttemptAt: number;
  attempts: number;
  inFlight: boolean;
}

interface DeferredPublicationCleanupReservation {
  readonly complete: () => void;
  readonly defer: (run: () => Promise<void>, baseDelayMs: number) => void;
}

/*
 * Failed post-publication cleanup outlives the invocation that initiated it,
 * so it is process infrastructure rather than RunScope state. One bounded
 * registry and one coalesced timer prevent an attacker or repeated I/O fault
 * from creating an unbounded number of retained closures and intervals.
 */
const deferredPublicationCleanups = new Map<string, DeferredPublicationCleanup>();
let deferredPublicationCleanupTimer: ReturnType<typeof setInterval> | undefined;
let deferredPublicationCleanupInFlight = 0;

function stopDeferredPublicationCleanupSchedulerIfIdle(): void {
  if (
    deferredPublicationCleanupTimer === undefined ||
    [...deferredPublicationCleanups.values()].some(
      (cleanup) => cleanup.run !== undefined || cleanup.inFlight,
    )
  ) {
    return;
  }
  clearInterval(deferredPublicationCleanupTimer);
  deferredPublicationCleanupTimer = undefined;
}

function deferredCleanupBackoff(cleanup: DeferredPublicationCleanup): number {
  return Math.min(
    MAX_DEFERRED_CLEANUP_BACKOFF_MS,
    cleanup.baseDelayMs * 2 ** Math.min(cleanup.attempts, 10),
  );
}

function drainDeferredPublicationCleanups(): void {
  const now = Date.now();
  for (const cleanup of deferredPublicationCleanups.values()) {
    if (deferredPublicationCleanupInFlight >= MAX_CONCURRENT_DEFERRED_CLEANUPS) break;
    if (cleanup.run === undefined || cleanup.inFlight || cleanup.nextAttemptAt > now) {
      continue;
    }
    const run = cleanup.run;
    cleanup.inFlight = true;
    deferredPublicationCleanupInFlight += 1;
    void run()
      .then(() => {
        if (deferredPublicationCleanups.get(cleanup.key) === cleanup) {
          deferredPublicationCleanups.delete(cleanup.key);
        }
      })
      .catch(() => {
        if (deferredPublicationCleanups.get(cleanup.key) !== cleanup) return;
        cleanup.attempts += 1;
        cleanup.nextAttemptAt = Date.now() + deferredCleanupBackoff(cleanup);
      })
      .finally(() => {
        cleanup.inFlight = false;
        deferredPublicationCleanupInFlight -= 1;
        stopDeferredPublicationCleanupSchedulerIfIdle();
      });
  }
}

function ensureDeferredPublicationCleanupScheduler(): void {
  if (deferredPublicationCleanupTimer !== undefined) return;
  deferredPublicationCleanupTimer = setInterval(
    drainDeferredPublicationCleanups,
    DEFERRED_CLEANUP_TICK_MS,
  );
  deferredPublicationCleanupTimer.unref?.();
}

/**
 * Claim the deferred-publication cleanup slot for `key`.
 * @throws {SystemError} When another writer already holds the slot for this key.
 */
function reserveDeferredPublicationCleanup(key: string): DeferredPublicationCleanupReservation {
  if (
    deferredPublicationCleanups.size >= MAX_DEFERRED_PUBLICATION_CLEANUPS ||
    deferredPublicationCleanups.has(key)
  ) {
    throw createToolError(LEASE_CAPACITY, 'Runtime publication cleanup capacity is exhausted', {
      metadata: { bound: 'deferred-publication-cleanups' },
    });
  }
  const cleanup: DeferredPublicationCleanup = {
    key,
    baseDelayMs: DEFERRED_CLEANUP_TICK_MS,
    nextAttemptAt: Number.POSITIVE_INFINITY,
    attempts: 0,
    inFlight: false,
  };
  deferredPublicationCleanups.set(key, cleanup);
  let settled = false;
  return Object.freeze({
    complete: () => {
      if (settled) return;
      settled = true;
      if (deferredPublicationCleanups.get(key) === cleanup) {
        deferredPublicationCleanups.delete(key);
      }
      stopDeferredPublicationCleanupSchedulerIfIdle();
    },
    defer: (run: () => Promise<void>, baseDelayMs: number) => {
      if (settled) return;
      settled = true;
      cleanup.run = run;
      cleanup.baseDelayMs = Math.max(DEFERRED_CLEANUP_TICK_MS, baseDelayMs);
      cleanup.nextAttemptAt = Date.now();
      ensureDeferredPublicationCleanupScheduler();
    },
  });
}

function deferRuntimeLeaseRelease(
  cleanupKey: string,
  release: () => Promise<void>,
  baseDelayMs: number,
): boolean {
  try {
    const reservation = reserveDeferredPublicationCleanup(`lease-release:${cleanupKey}`);
    reservation.defer(release, baseDelayMs);
    return true;
  } catch {
    // @swallow-ok Capacity refusal is the false result; the heartbeat remains active.
    // A prior retry for this exact lease is already registered, or the bounded
    // registry is saturated. The live heartbeat remains the safety fallback.
    return false;
  }
}

interface FailedSharedRegistrationCleanup {
  readonly ownerToken: string;
  readonly coordinationKey: string | undefined;
  readonly wantsProject: boolean;
  readonly wantsUser: boolean;
  readonly referenceToken: string;
  readonly input: RuntimeLeaseCommonInput;
  readonly policy: RuntimeLeasePolicy;
  readonly reservation: DeferredPublicationCleanupReservation;
}

async function cleanupFailedSharedRegistration(
  cleanupInput: FailedSharedRegistrationCleanup,
): Promise<void> {
  const {
    ownerToken,
    coordinationKey,
    wantsProject,
    wantsUser,
    referenceToken,
    input,
    policy,
    reservation,
  } = cleanupInput;
  const environment = runtimeEnvironment(input);
  const cleanupWaitMs = Math.min(
    MAX_FAILED_PUBLICATION_CLEANUP_WAIT_MS,
    Math.max(100, policy.pollMs * 4),
  );
  const cleanup = () =>
    withCoordinationMutex(
      policy,
      input.onEvent,
      cleanupWaitMs,
      (paths, guard) =>
        removeSharedRegistrationWhileOwned({
          paths,
          ownerToken,
          coordinationKey,
          wantsProject,
          wantsUser,
          referenceToken,
          policy,
          environment,
          guard,
        }),
      environment,
    );
  try {
    await cleanup();
    reservation.complete();
  } catch {
    // @swallow-ok Failed immediate cleanup is retained by the bounded retry scheduler.
    const retryEveryMs = Math.max(policy.pollMs, Math.min(policy.heartbeatMs, 1000));
    void reservation.defer(cleanup, retryEveryMs);
  }
}

/** @throws {Error} When shared dimensions are invalid, blocked, cancelled, or time out. */
async function acquireSharedDimensions(
  input: RuntimeLeaseCommonInput,
  projectDir: string | undefined,
  wantsProject: boolean,
  wantsUser: boolean,
  inheritFromParent?: boolean,
): Promise<{
  readonly ownerToken: string;
  readonly coordinationKey?: string;
  readonly acquiredAt: number;
  readonly referenceToken: string;
  readonly policy: RuntimeLeasePolicy;
  readonly timer: ReturnType<typeof setInterval>;
}> {
  if (!wantsProject && !wantsUser) {
    throw new SystemError('Runtime access lease requires at least one shared dimension', {
      code: 'CORE.RUNTIME_LEASE.EMPTY_ACCESS',
    });
  }
  const environment = runtimeEnvironment(input);
  const ownerToken = input.ownerToken ?? environment.generateToken();
  validateOwnerToken(ownerToken);
  const referenceToken = generateReferenceToken();
  const coordinationKey =
    wantsProject && projectDir !== undefined ? projectCoordinationKey(projectDir) : undefined;
  const policy = normalizePolicy(input.policy);
  const waitKind = sharedWaitKind(wantsProject, wantsUser);
  const startedAt = environment.monotonicNow();
  const deadline = startedAt + policy.waitMs;
  const remoteStaleTracker: RemoteStaleTracker = new Map();
  emitLeaseEvent(input, { kind: 'lease.acquire.start', operation: waitKind });
  for (;;) {
    if (input.signal?.aborted === true) throw abortedError();
    const remaining = Math.max(0, deadline - environment.monotonicNow());
    const cleanupReservation = reserveDeferredPublicationCleanup(
      `shared:${ownerToken}:${referenceToken}`,
    );
    let result: SharedRegistrationResult | undefined;
    let registrationAttempted = false;
    try {
      result = await withCoordinationMutex(
        policy,
        input.onEvent,
        remaining,
        (paths, guard) => {
          registrationAttempted = true;
          return inheritFromParent === true
            ? registerParentInheritedSharedDimensions({
                paths,
                ownerToken,
                projectKey: requiredProjectCoordinationKey(coordinationKey),
                referenceToken,
                input,
                policy,
                guard,
                remoteStaleTracker,
              })
            : registerSharedDimensions({
                paths,
                ownerToken,
                projectKey: coordinationKey,
                wantsProject,
                wantsUser,
                referenceToken,
                input,
                policy,
                guard,
                remoteStaleTracker,
              });
        },
        environment,
        input.signal,
      );
    } catch (error) {
      if (registrationAttempted) {
        await cleanupFailedSharedRegistration({
          ownerToken,
          coordinationKey,
          wantsProject,
          wantsUser,
          referenceToken,
          input,
          policy,
          reservation: cleanupReservation,
        });
      } else {
        cleanupReservation.complete();
      }
      // Concurrent multi-process cold starts race temporary records under the
      // coordination root. Snapshot/BUSY churn is contention: wait and retry.
      if (error instanceof RuntimeSnapshotChangedError) {
        if (environment.monotonicNow() >= deadline) throw timeoutError(waitKind, policy.waitMs);
        await pollDelay(input, policy, deadline);
        continue;
      }
      mapCoordinationTimeout(error, waitKind, policy.waitMs);
    }
    cleanupReservation.complete();
    if (result !== undefined) {
      const timer = startSharedHeartbeat(
        ownerToken,
        coordinationKey,
        wantsProject,
        wantsUser,
        input,
        policy,
      );
      emitLeaseEvent(input, {
        kind: 'lease.acquire.complete',
        operation: waitKind,
        waitMs: Math.min(policy.waitMs, environment.monotonicNow() - startedAt),
      });
      return {
        ownerToken,
        ...(coordinationKey === undefined ? {} : { coordinationKey }),
        acquiredAt: result.acquiredAt,
        referenceToken,
        policy,
        timer,
      };
    }
    if (environment.monotonicNow() >= deadline) throw timeoutError(waitKind, policy.waitMs);
    emitLeaseEvent(input, {
      kind: 'lease.acquire.wait',
      operation: waitKind,
      waitMs: Math.min(policy.waitMs, environment.monotonicNow() - startedAt),
    });
    await pollDelay(input, policy, deadline);
  }
}

async function heartbeatSharedDimensions(
  ownerToken: string,
  coordinationKey: string | undefined,
  wantsProject: boolean,
  wantsUser: boolean,
  input: RuntimeLeaseCommonInput,
  policy: RuntimeLeasePolicy,
): Promise<void> {
  const environment = runtimeEnvironment(input);
  const heartbeat = async (dimension: ReaderRecord['dimension']): Promise<void> => {
    try {
      await withCoordinationMutex(
        policy,
        input.onEvent,
        Math.min(policy.waitMs, 1000),
        (paths, guard) => {
          if (dimension === 'project') {
            if (coordinationKey === undefined) return;
            replaceReaderHeartbeat(
              paths.forProject(coordinationKey).readersDir,
              ownerToken,
              'project',
              environment,
              guard,
            );
            return;
          }
          replaceReaderHeartbeat(paths.userReadersDir, ownerToken, 'user', environment, guard);
        },
        environment,
      );
    } catch {
      // @swallow-ok Heartbeats are best effort; ownership probes remain authoritative.
      // Each dimension is best effort and isolated. A broken/missing project
      // record must not prevent the user-state record from being refreshed.
    }
  };
  if (wantsProject && coordinationKey !== undefined) {
    await heartbeat('project');
  }
  if (wantsUser) {
    await heartbeat('user');
  }
}

function startSharedHeartbeat(
  ownerToken: string,
  coordinationKey: string | undefined,
  wantsProject: boolean,
  wantsUser: boolean,
  input: RuntimeLeaseCommonInput,
  policy: RuntimeLeasePolicy,
): ReturnType<typeof setInterval> {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void heartbeatSharedDimensions(
      ownerToken,
      coordinationKey,
      wantsProject,
      wantsUser,
      input,
      policy,
    )
      .catch(() => {
        // @swallow-ok Best-effort heartbeat. A rejection must not escape this
        // process-global timer as an unhandled rejection — that would crash the
        // host process (Node's default). `.finally` alone does NOT handle a
        // rejection; this `.catch` is the actual guard.
      })
      .finally(() => {
        inFlight = false;
      });
  }, policy.heartbeatMs);
  timer.unref?.();
  return timer;
}

/** @throws {SystemError} When the owned reader reference cannot be validated or updated exactly. */
function decrementReaderRef(
  readersDir: string,
  ownerToken: string,
  dimension: ReaderRecord['dimension'],
  referenceToken: string,
  environment: RuntimeLeaseEnvironment,
  guard?: RuntimeMutexGuard,
): void {
  try {
    lstatSync(readersDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && dimension === 'project') return;
    throw coordinationProbeFailed(
      'Runtime reader directory is unavailable during release',
      'probe',
    );
  }
  assertDirectory(readersDir, resolveCoordinationPaths().coordinationDir);
  const path = readerFile(readersDir, ownerToken);
  const raw = readBoundedRecord(path, MAX_RECORD_BYTES);
  if (raw === undefined) return;
  const record = parseReaderRecord(raw, dimension);
  if (record.ownerToken !== ownerToken || !ownedByRuntimeProcess(record, environment)) {
    throw unsafeCoordination('Runtime reader ownership changed before release');
  }
  if (!record.references.includes(referenceToken)) return;
  const references = record.references.filter((candidate) => candidate !== referenceToken);
  if (references.length === 0) {
    removeRecordIfOwned(path, ownerToken, dimension, guard);
  } else {
    replaceReaderRecord(
      readersDir,
      {
        ...record,
        refs: references.length,
        references,
        lastHeartbeatAt: environment.now(),
      },
      guard,
    );
  }
}

interface SharedRegistrationRemoval {
  readonly paths: CoordinationPaths;
  readonly ownerToken: string;
  readonly coordinationKey: string | undefined;
  readonly wantsProject: boolean;
  readonly wantsUser: boolean;
  readonly referenceToken: string;
  readonly policy: RuntimeLeasePolicy;
  readonly environment: RuntimeLeaseEnvironment;
  readonly guard: RuntimeMutexGuard;
}

function removeSharedRegistrationWhileOwned(removal: SharedRegistrationRemoval): void {
  const {
    paths,
    ownerToken,
    coordinationKey,
    wantsProject,
    wantsUser,
    referenceToken,
    policy,
    environment,
    guard,
  } = removal;
  if (wantsProject && coordinationKey !== undefined) {
    decrementReaderRef(
      paths.forProject(coordinationKey).readersDir,
      ownerToken,
      'project',
      referenceToken,
      environment,
      guard,
    );
  }
  if (wantsUser) {
    decrementReaderRef(
      paths.userReadersDir,
      ownerToken,
      'user',
      referenceToken,
      environment,
      guard,
    );
  }
  // Cleanup follows both exact decrements. If either dimension faults, a retry
  // can still reach the other record before the project scaffold disappears.
  if (wantsProject && coordinationKey !== undefined) {
    try {
      cleanupEmptyRuntimeLeaseKeyWhileOwned(paths, coordinationKey, policy, environment, guard);
    } catch {
      // @swallow-ok Exact lease authority is gone; only optional empty-scaffold hygiene failed.
      // Exact reference authority is already removed from every requested
      // dimension. Empty-scaffold cleanup is best-effort hygiene.
    }
  }
}

function releaseSharedDimensions(
  ownerToken: string,
  coordinationKey: string | undefined,
  wantsProject: boolean,
  wantsUser: boolean,
  referenceToken: string,
  input: RuntimeLeaseCommonInput,
  policy: RuntimeLeasePolicy,
): void {
  const environment = runtimeEnvironment(input);
  withCoordinationMutexSync(
    policy,
    input.onEvent,
    (paths, guard) =>
      removeSharedRegistrationWhileOwned({
        paths,
        ownerToken,
        coordinationKey,
        wantsProject,
        wantsUser,
        referenceToken,
        policy,
        environment,
        guard,
      }),
    environment,
  );
}

function deferredReleasePolicy(policy: RuntimeLeasePolicy): RuntimeLeasePolicy {
  return {
    ...policy,
    waitMs: Math.min(250, Math.max(50, policy.waitMs)),
    pollMs: Math.min(10, policy.pollMs),
  };
}

async function releaseSharedDimensionsAsync(
  ownerToken: string,
  coordinationKey: string | undefined,
  wantsProject: boolean,
  wantsUser: boolean,
  referenceToken: string,
  input: RuntimeLeaseCommonInput,
  originalPolicy: RuntimeLeasePolicy,
): Promise<void> {
  const environment = runtimeEnvironment(input);
  const policy = deferredReleasePolicy(originalPolicy);
  await withCoordinationMutex(
    policy,
    input.onEvent,
    policy.waitMs,
    (paths, guard) =>
      removeSharedRegistrationWhileOwned({
        paths,
        ownerToken,
        coordinationKey,
        wantsProject,
        wantsUser,
        referenceToken,
        policy,
        environment,
        guard,
      }),
    environment,
  );
}

function createLeaseReleaseFinalizer(
  timer: ReturnType<typeof setInterval>,
  input: RuntimeLeaseCommonInput,
  operation: RuntimeLeaseWaitKind,
): { readonly isReleased: () => boolean; readonly finish: () => void } {
  let released = false;
  return {
    isReleased: () => released,
    finish: () => {
      if (released) return;
      clearInterval(timer);
      released = true;
      emitLeaseEvent(input, { kind: 'lease.release', operation });
    },
  };
}

function sharedReleaseHandle(
  acquired: Awaited<ReturnType<typeof acquireSharedDimensions>>,
  wantsProject: boolean,
  wantsUser: boolean,
  input: RuntimeLeaseCommonInput,
  operation: RuntimeLeaseWaitKind,
): () => void {
  let deferredScheduled = false;
  const finalizer = createLeaseReleaseFinalizer(acquired.timer, input, operation);
  const release = (): void => {
    if (finalizer.isReleased()) return;
    try {
      releaseSharedDimensions(
        acquired.ownerToken,
        acquired.coordinationKey,
        wantsProject,
        wantsUser,
        acquired.referenceToken,
        input,
        acquired.policy,
      );
      finalizer.finish();
    } catch (error) {
      if (!deferredScheduled) {
        deferredScheduled = deferRuntimeLeaseRelease(
          `${operation}:${acquired.ownerToken}:${acquired.referenceToken}`,
          async () => {
            await releaseSharedDimensionsAsync(
              acquired.ownerToken,
              acquired.coordinationKey,
              wantsProject,
              wantsUser,
              acquired.referenceToken,
              input,
              acquired.policy,
            );
            void finalizer.finish();
          },
          acquired.policy.pollMs,
        );
      }
      throw error;
    }
  };
  return release;
}

function captureRuntimeIdentity<T extends RuntimeLeaseCommonInput>(input: T): T {
  const environment = runtimeEnvironment(input);
  const capturedHostname = environment.hostname().normalize('NFC');
  const capturedHostInstanceIdentity = environment.hostInstanceIdentity();
  return {
    ...input,
    [RUNTIME_ENVIRONMENT]: Object.freeze({
      ...environment,
      hostname: () => capturedHostname,
      hostInstanceIdentity: () => capturedHostInstanceIdentity,
    }),
  };
}

/** Acquire a shared lease for one canonical project runtime. */
export async function acquireRuntimeReadLease(
  input: AcquireRuntimeReadLeaseInput,
): Promise<RuntimeReadLease> {
  const stableInput = captureRuntimeIdentity(input);
  const acquired = await acquireSharedDimensions(stableInput, stableInput.projectDir, true, false);
  return {
    kind: 'runtime-read',
    ownerToken: acquired.ownerToken,
    acquiredAt: acquired.acquiredAt,
    coordinationKey: requiredProjectCoordinationKey(acquired.coordinationKey),
    release: sharedReleaseHandle(acquired, true, false, stableInput, 'runtime-read'),
  };
}

/** Acquire a shared lease for user-root state mutation. */
export async function acquireUserStateReadLease(
  input: AcquireUserStateReadLeaseInput = {},
): Promise<UserStateReadLease> {
  const stableInput = captureRuntimeIdentity(input);
  const acquired = await acquireSharedDimensions(stableInput, undefined, false, true);
  return {
    kind: 'user-state-read',
    ownerToken: acquired.ownerToken,
    acquiredAt: acquired.acquiredAt,
    release: sharedReleaseHandle(acquired, false, true, stableInput, 'user-state-read'),
  };
}

/**
 * Atomically acquire project and/or user shared dimensions under one owner.
 *
 * @throws {Error} When the requested dimensions are invalid, blocked, cancelled, or time out.
 */
export async function acquireRuntimeAccessLease(
  input: AcquireRuntimeAccessLeaseInput,
): Promise<RuntimeAccessLease> {
  const stableInput = captureRuntimeIdentity(input);
  const wantsProject = stableInput.projectRead !== false && stableInput.projectRead !== undefined;
  const wantsUser = stableInput.userStateRead === true;
  if (stableInput.inheritFromParent === true && (!wantsProject || !wantsUser)) {
    throw parentInheritanceDenied(
      'Direct-parent runtime inheritance requires project and user-state dimensions',
    );
  }
  const projectDir = wantsProject ? stableInput.projectRead.projectDir : undefined;
  const acquired = await acquireSharedDimensions(
    stableInput,
    projectDir,
    wantsProject,
    wantsUser,
    stableInput.inheritFromParent,
  );
  return {
    kind: 'runtime-access-composite',
    ownerToken: acquired.ownerToken,
    acquiredAt: acquired.acquiredAt,
    ...(acquired.coordinationKey === undefined
      ? {}
      : { coordinationKey: acquired.coordinationKey }),
    projectRead: wantsProject,
    userStateRead: wantsUser,
    release: sharedReleaseHandle(
      acquired,
      wantsProject,
      wantsUser,
      stableInput,
      'runtime-access-composite',
    ),
  };
}

function projectWriterEligible(writer: WriterRecord, writers: readonly WriterRecord[]): boolean {
  return !writers.some(
    (other) =>
      (other.ownerToken !== writer.ownerToken &&
        other.phase === 'intent' &&
        (other.kind === 'global' ||
          (other.kind === 'project' && other.coordinationKey === writer.coordinationKey))) ||
      (other.sequence < writer.sequence &&
        (other.kind === 'global' ||
          (other.kind === 'project' && other.coordinationKey === writer.coordinationKey))),
  );
}

function globalWriterEligible(writer: WriterRecord, writers: readonly WriterRecord[]): boolean {
  return !writers.some(
    (other) =>
      other.ownerToken !== writer.ownerToken &&
      (other.phase === 'intent' || other.sequence < writer.sequence),
  );
}

interface ProjectReaderScan {
  readonly paths: CoordinationPaths;
  readonly policy: RuntimeLeasePolicy;
  readonly onEvent: RuntimeLeaseCommonInput['onEvent'];
  readonly environment?: RuntimeLeaseEnvironment;
  readonly guard?: RuntimeMutexGuard;
  readonly observedAt?: number;
  readonly remoteStaleTracker?: RemoteStaleTracker;
  readonly processInspectionCache?: ProcessInspectionCache;
}

/** @throws {SystemError} When the bounded project-reader scan encounters unsafe state. */
function scanAllProjectReaders(scan: ProjectReaderScan): readonly ReaderRecord[] {
  const {
    paths,
    policy,
    onEvent,
    environment = DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
    guard,
    observedAt = environment.now(),
    remoteStaleTracker,
    processInspectionCache = createProcessInspectionCache(environment.maxProcessInspectionsPerScan),
  } = scan;
  const readers: ReaderRecord[] = [];
  for (const coordinationKey of listProjectCoordinationKeys(paths, guard)) {
    guard?.refresh();
    const readerDir = paths.forProject(coordinationKey).readersDir;
    readers.push(
      ...cleanAndListReaders({
        readersDir: readerDir,
        dimension: 'project',
        policy,
        onEvent,
        environment,
        guard,
        observedAt,
        remoteStaleTracker,
        processInspectionCache,
      }),
    );
    if (readers.length > MAX_PROJECT_KEYS * MAX_READERS_PER_DIMENSION) {
      throw coordinationCapacity('Runtime global reader scan exceeds its bound', 'entries');
    }
  }
  return readers;
}

/** @throws {SystemError} When any project retains a recovery journal. */
function assertNoProjectRecoveryJournals(
  paths: CoordinationPaths,
  guard?: RuntimeMutexGuard,
): void {
  for (const coordinationKey of listProjectCoordinationKeys(paths, guard)) {
    guard?.refresh();
    const projectPaths = paths.forProject(coordinationKey);
    const header = inspectRecoveryHeader(
      projectPaths.promotionJournalFile,
      'init-promotion',
      coordinationKey,
    );
    if (header.status !== 'absent') {
      throw recoveryRequired(
        'Global user-state maintenance is blocked by project Init recovery state.',
      );
    }
  }
}

interface WriterAcquisitionOptions {
  readonly kind: 'project' | 'global';
  readonly coordinationKey?: string;
  readonly waitKind: 'runtime-exclusive' | 'runtime-global-maintenance';
  readonly projectPosture?: RuntimeExclusivePosture;
  readonly globalPosture?: GlobalRuntimeMaintenancePosture;
  readonly recoveryOperationId?: string;
}

/** @throws {SystemError} When recovery state is incompatible with the requested writer posture. */
function assertWriterPosture(
  paths: CoordinationPaths,
  options: WriterAcquisitionOptions,
  guard?: RuntimeMutexGuard,
): void {
  if (options.kind === 'project') {
    const receipt = inspectUserReceiptHeader(paths);
    if (
      receipt.status === 'malformed' ||
      (receipt.status === 'valid' && receipt.state === 'open')
    ) {
      throw recoveryRequired('Project maintenance is blocked by user-uninstall recovery state.');
    }
    assertProjectExclusivePosture(
      paths,
      requiredProjectCoordinationKey(options.coordinationKey),
      options.projectPosture ?? 'normal',
      options.recoveryOperationId,
      guard,
    );
  } else {
    const posture = options.globalPosture ?? 'normal';
    assertGlobalExclusivePosture(paths, posture, options.recoveryOperationId);
    // Receipt-only discard cannot mutate project state. Allowing it through is
    // necessary to break the otherwise cyclic recovery dependency where a
    // malformed receipt blocks project recovery and a project journal blocks
    // removal of that malformed receipt.
    if (posture !== 'receipt-only-discard') {
      assertNoProjectRecoveryJournals(paths, guard);
    }
  }
}

interface WriterEnqueueRequest {
  readonly paths: CoordinationPaths;
  readonly ownerToken: string;
  readonly options: WriterAcquisitionOptions;
  readonly input: RuntimeLeaseCommonInput;
  readonly policy: RuntimeLeasePolicy;
  readonly guard?: RuntimeMutexGuard;
  readonly remoteStaleTracker?: RemoteStaleTracker;
  readonly onPublicationPrepared?: (writer: WriterRecord) => void;
}

function enqueueWriter(request: WriterEnqueueRequest): WriterRecord {
  const {
    paths,
    ownerToken,
    options,
    input,
    policy,
    guard,
    remoteStaleTracker,
    onPublicationPrepared,
  } = request;
  const environment = runtimeEnvironment(input);
  assertWriterPosture(paths, options, guard);
  const state = cleanStaleWriters(
    paths,
    readLeaseState(paths),
    policy,
    input.onEvent,
    environment,
    guard,
    remoteStaleTracker,
  );
  if (state.writers.some((writer) => writer.ownerToken === ownerToken)) {
    throw new SystemError('Duplicate runtime writer request for one owner token', {
      code: 'CORE.RUNTIME_LEASE.DUPLICATE_WRITER',
    });
  }
  const existing = findExistingOwnerReaders(
    paths,
    ownerToken,
    policy,
    input.onEvent,
    environment,
    guard,
    remoteStaleTracker,
  );
  if (existing.projects.length > 0 || existing.user !== undefined) {
    throw new SystemError('Shared runtime leases cannot be upgraded to exclusive', {
      code: 'CORE.RUNTIME_LEASE.EXCLUSIVE_UPGRADE',
    });
  }
  if (state.writers.length >= MAX_WRITER_QUEUE) {
    throw new SystemError('Runtime writer queue capacity is exhausted', {
      code: 'CORE.RUNTIME_LEASE.CAPACITY',
    });
  }
  const metadata = buildMetadata(ownerToken, state.nextSequence, input, policy);
  const writer: WriterRecord = {
    ...metadata,
    kind: options.kind,
    ...(options.coordinationKey === undefined ? {} : { coordinationKey: options.coordinationKey }),
    phase: 'queued',
  };
  const nextState = {
    ...state,
    nextSequence: state.nextSequence + 1,
    writers: [...state.writers, writer],
  };
  // Stage an exact cleanup receipt before publication. The enclosing mutex can
  // still fail its post-callback ownership check after the state write lands.
  onPublicationPrepared?.(writer);
  writeLeaseState(paths, state, nextState, guard);
  return writer;
}

interface WriterProgress {
  readonly acquired: boolean;
  readonly acquiredAt: number;
  readonly timedOut?: boolean;
  readonly heartbeatPublished?: boolean;
}

interface WriterProgressRequest {
  readonly paths: CoordinationPaths;
  readonly ownerToken: string;
  readonly options: WriterAcquisitionOptions;
  readonly input: RuntimeLeaseCommonInput;
  readonly policy: RuntimeLeasePolicy;
  readonly heartbeatDue: boolean;
  readonly guard?: RuntimeMutexGuard;
  readonly remoteStaleTracker?: RemoteStaleTracker;
}

function progressWriter(request: WriterProgressRequest): WriterProgress {
  const { paths, ownerToken, options, input, policy, heartbeatDue, guard, remoteStaleTracker } =
    request;
  const environment = runtimeEnvironment(input);
  assertWriterPosture(paths, options, guard);
  const state = cleanStaleWriters(
    paths,
    readLeaseState(paths),
    policy,
    input.onEvent,
    environment,
    guard,
    remoteStaleTracker,
  );
  const index = state.writers.findIndex((writer) => writer.ownerToken === ownerToken);
  if (index < 0) {
    throw new SystemError('Runtime writer request disappeared during acquisition', {
      code: 'CORE.RUNTIME_LEASE.REQUEST_LOST',
    });
  }
  let writer = state.writers[index];
  let heartbeatPublished = false;
  if (!ownedByRuntimeProcess(writer, environment)) {
    throw new SystemError('Runtime writer owner token belongs to another process', {
      code: 'CORE.RUNTIME_LEASE.OWNER_MISMATCH',
    });
  }
  const eligible =
    writer.kind === 'project'
      ? projectWriterEligible(writer, state.writers)
      : globalWriterEligible(writer, state.writers);
  if (writer.phase === 'queued' && eligible) {
    writer = {
      ...writer,
      phase: 'intent',
      lastHeartbeatAt: environment.now(),
    };
    const writers = [...state.writers];
    writers[index] = writer;
    const nextState = { ...state, writers };
    writeLeaseState(paths, state, nextState, guard);
    heartbeatPublished = true;
  } else if (heartbeatDue) {
    writer = { ...writer, lastHeartbeatAt: environment.now() };
    const writers = [...state.writers];
    writers[index] = writer;
    const nextState = { ...state, writers };
    writeLeaseState(paths, state, nextState, guard);
    heartbeatPublished = true;
  }
  if (writer.phase !== 'intent') {
    return {
      acquired: false,
      acquiredAt: writer.acquiredAt,
      ...(heartbeatPublished ? { heartbeatPublished: true } : {}),
    };
  }
  // One cutoff covers the whole global scan. A remote reader that was healthy
  // when scanning began cannot become reclaimable merely because this mutex
  // holder delayed its heartbeat while walking other projects.
  const staleObservationTime = environment.now();
  const processInspectionCache = createProcessInspectionCache(
    environment.maxProcessInspectionsPerScan,
  );
  const readers =
    writer.kind === 'project'
      ? cleanAndListReaders({
          readersDir: paths.forProject(requiredProjectCoordinationKey(writer.coordinationKey))
            .readersDir,
          dimension: 'project',
          policy,
          onEvent: input.onEvent,
          environment,
          guard,
          observedAt: staleObservationTime,
          remoteStaleTracker,
          processInspectionCache,
        })
      : [
          ...cleanAndListReaders({
            readersDir: paths.userReadersDir,
            dimension: 'user',
            policy,
            onEvent: input.onEvent,
            environment,
            guard,
            observedAt: staleObservationTime,
            remoteStaleTracker,
            processInspectionCache,
          }),
          ...scanAllProjectReaders({
            paths,
            policy,
            onEvent: input.onEvent,
            environment,
            guard,
            observedAt: staleObservationTime,
            remoteStaleTracker,
            processInspectionCache,
          }),
        ];
  return {
    acquired: readers.length === 0,
    acquiredAt: writer.acquiredAt,
    ...(heartbeatPublished ? { heartbeatPublished: true } : {}),
  };
}

/** @throws {SystemError} When the expected writer request cannot be removed exactly. */
function removeWriterRequest(
  paths: CoordinationPaths,
  expected: WriterRecord,
  policy: RuntimeLeasePolicy,
  onEvent: RuntimeLeaseCommonInput['onEvent'],
  environment: RuntimeLeaseEnvironment = DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
  guard?: RuntimeMutexGuard,
  replacementIsAbsent = false,
): void {
  const state = cleanStaleWriters(
    paths,
    readLeaseState(paths),
    policy,
    onEvent,
    environment,
    guard,
  );
  const writer = state.writers.find((entry) => entry.ownerToken === expected.ownerToken);
  if (writer === undefined) return;
  if (
    writer.pid !== expected.pid ||
    writer.hostname !== expected.hostname ||
    writer.hostIdentityProven !== expected.hostIdentityProven ||
    writer.acquiredAt !== expected.acquiredAt ||
    writer.sequence !== expected.sequence ||
    writer.kind !== expected.kind ||
    writer.coordinationKey !== expected.coordinationKey ||
    !ownedByRuntimeProcess(writer, environment)
  ) {
    if (replacementIsAbsent) return;
    throw unsafeCoordination('Runtime writer ownership changed before release');
  }
  const nextState = {
    ...state,
    writers: state.writers.filter((entry) => entry.ownerToken !== expected.ownerToken),
  };
  writeLeaseState(paths, state, nextState, guard);
}

function startWriterHeartbeat(
  ownerToken: string,
  input: RuntimeLeaseCommonInput,
  policy: RuntimeLeasePolicy,
): ReturnType<typeof setInterval> {
  const environment = runtimeEnvironment(input);
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void withCoordinationMutex(
      policy,
      input.onEvent,
      Math.min(policy.waitMs, 1000),
      (paths, guard) => {
        const state = readLeaseState(paths);
        const index = state.writers.findIndex((writer) => writer.ownerToken === ownerToken);
        if (index < 0) return;
        const writer = state.writers[index];
        if (!ownedByRuntimeProcess(writer, environment)) return;
        const writers = [...state.writers];
        writers[index] = {
          ...writer,
          lastHeartbeatAt: environment.now(),
        };
        writeLeaseState(paths, state, { ...state, writers }, guard);
      },
      environment,
    )
      .catch(() => {
        // Best effort. Same-host PID liveness remains authoritative.
      })
      .finally(() => {
        inFlight = false;
      });
  }, policy.heartbeatMs);
  timer.unref?.();
  return timer;
}

async function cleanupFailedWriter(
  expected: WriterRecord | undefined,
  input: RuntimeLeaseCommonInput,
  policy: RuntimeLeasePolicy,
  reservation: DeferredPublicationCleanupReservation,
): Promise<void> {
  if (expected === undefined) {
    reservation.complete();
    return;
  }
  const environment = runtimeEnvironment(input);
  const cleanupWaitMs = Math.min(
    MAX_FAILED_PUBLICATION_CLEANUP_WAIT_MS,
    Math.max(100, policy.pollMs * 4),
  );
  const cleanup = () =>
    withCoordinationMutex(
      policy,
      input.onEvent,
      cleanupWaitMs,
      (paths, guard) =>
        removeWriterRequest(paths, expected, policy, input.onEvent, environment, guard, true),
      environment,
    );
  try {
    await cleanup();
    reservation.complete();
  } catch {
    // @swallow-ok Failed immediate writer cleanup is retained by the bounded retry scheduler.
    const retryEveryMs = Math.max(policy.pollMs, Math.min(policy.heartbeatMs, 1000));
    void reservation.defer(cleanup, retryEveryMs);
  }
}

/** @throws {Error} When exclusive acquisition is blocked, cancelled, unsafe, or times out. */
async function acquireWriter(
  input: RuntimeLeaseCommonInput,
  options: WriterAcquisitionOptions,
): Promise<{
  readonly ownerToken: string;
  readonly acquiredAt: number;
  readonly policy: RuntimeLeasePolicy;
  readonly timer: ReturnType<typeof setInterval>;
  readonly writer: WriterRecord;
}> {
  const environment = runtimeEnvironment(input);
  const ownerToken = input.ownerToken ?? environment.generateToken();
  validateOwnerToken(ownerToken);
  const policy = normalizePolicy(input.policy);
  const startedAt = environment.monotonicNow();
  const deadline = startedAt + policy.waitMs;
  const remoteStaleTracker: RemoteStaleTracker = new Map();
  let enqueuedWriter: WriterRecord | undefined;
  let stagedWriter: WriterRecord | undefined;
  let lastWriterHeartbeatPublicationAt = environment.monotonicNow();
  const cleanupReservation = reserveDeferredPublicationCleanup(
    `writer:${ownerToken}:${generateReferenceToken()}`,
  );
  emitLeaseEvent(input, {
    kind: 'lease.acquire.start',
    operation: options.waitKind,
  });
  try {
    throwIfAborted(input.signal);
    const publishedWriter = await withCoordinationMutex(
      policy,
      input.onEvent,
      Math.max(0, deadline - environment.monotonicNow()),
      (paths, guard) => {
        if (options.coordinationKey !== undefined) {
          ensureProjectScaffold(paths, options.coordinationKey, guard);
        }
        return enqueueWriter({
          paths,
          ownerToken,
          options,
          input,
          policy,
          guard,
          remoteStaleTracker,
          onPublicationPrepared: (writer) => {
            stagedWriter = writer;
          },
        });
      },
      environment,
      input.signal,
    );
    enqueuedWriter = publishedWriter;
    for (;;) {
      throwIfAborted(input.signal);
      const progressObservedAt = environment.monotonicNow();
      const heartbeatDue =
        progressObservedAt - lastWriterHeartbeatPublicationAt >=
        Math.max(1, Math.floor(policy.heartbeatMs / 2));
      const progress = await withCoordinationMutex(
        policy,
        input.onEvent,
        Math.max(0, deadline - environment.monotonicNow()),
        (paths, guard) => {
          const current = progressWriter({
            paths,
            ownerToken,
            options,
            input,
            policy,
            heartbeatDue,
            guard,
            remoteStaleTracker,
          });
          if (!current.acquired && environment.monotonicNow() >= deadline) {
            removeWriterRequest(paths, publishedWriter, policy, input.onEvent, environment, guard);
            return { ...current, timedOut: true };
          }
          return current;
        },
        environment,
        input.signal,
      );
      if (progress.heartbeatPublished === true) {
        lastWriterHeartbeatPublicationAt = progressObservedAt;
      }
      if (progress.acquired) {
        const timer = startWriterHeartbeat(ownerToken, input, policy);
        cleanupReservation.complete();
        emitLeaseEvent(input, {
          kind: 'lease.acquire.complete',
          operation: options.waitKind,
          waitMs: Math.min(policy.waitMs, environment.monotonicNow() - startedAt),
        });
        return {
          ownerToken,
          acquiredAt: progress.acquiredAt,
          policy,
          timer,
          writer: publishedWriter,
        };
      }
      if (progress.timedOut === true) throw timeoutError(options.waitKind, policy.waitMs);
      if (environment.monotonicNow() >= deadline)
        throw timeoutError(options.waitKind, policy.waitMs);
      emitLeaseEvent(input, {
        kind: 'lease.acquire.wait',
        operation: options.waitKind,
        waitMs: Math.min(policy.waitMs, environment.monotonicNow() - startedAt),
      });
      await pollDelay(input, policy, deadline);
    }
  } catch (error) {
    await cleanupFailedWriter(enqueuedWriter ?? stagedWriter, input, policy, cleanupReservation);
    if (error instanceof TimeoutError && error.code === 'CORE.RUNTIME_COORDINATION.MUTEX') {
      throw timeoutError(options.waitKind, policy.waitMs);
    }
    throw error;
  }
}

function removeWriterRegistrationWhileOwned(
  paths: CoordinationPaths,
  acquired: Awaited<ReturnType<typeof acquireWriter>>,
  input: RuntimeLeaseCommonInput,
  environment: RuntimeLeaseEnvironment,
  guard: RuntimeMutexGuard,
  coordinationKey?: string,
): void {
  removeWriterRequest(paths, acquired.writer, acquired.policy, input.onEvent, environment, guard);
  if (coordinationKey === undefined) return;
  try {
    cleanupEmptyRuntimeLeaseKeyWhileOwned(
      paths,
      coordinationKey,
      acquired.policy,
      environment,
      guard,
    );
  } catch {
    // @swallow-ok Exact writer authority is gone; only optional scaffold hygiene failed.
    // Exact writer authority is already removed. Empty-scaffold cleanup is
    // hygiene and must not retain the live heartbeat.
  }
}

async function releaseWriterAsync(
  acquired: Awaited<ReturnType<typeof acquireWriter>>,
  input: RuntimeLeaseCommonInput,
  coordinationKey?: string,
): Promise<void> {
  const environment = runtimeEnvironment(input);
  const policy = deferredReleasePolicy(acquired.policy);
  await withCoordinationMutex(
    policy,
    input.onEvent,
    policy.waitMs,
    (paths, guard) =>
      removeWriterRegistrationWhileOwned(
        paths,
        acquired,
        input,
        environment,
        guard,
        coordinationKey,
      ),
    environment,
  );
}

function writerReleaseHandle(
  acquired: Awaited<ReturnType<typeof acquireWriter>>,
  input: RuntimeLeaseCommonInput,
  operation: WriterAcquisitionOptions['waitKind'],
  coordinationKey?: string,
): () => void {
  let deferredScheduled = false;
  const finalizer = createLeaseReleaseFinalizer(acquired.timer, input, operation);
  const release = (): void => {
    if (finalizer.isReleased()) return;
    const environment = runtimeEnvironment(input);
    try {
      withCoordinationMutexSync(
        acquired.policy,
        input.onEvent,
        (paths, guard) =>
          removeWriterRegistrationWhileOwned(
            paths,
            acquired,
            input,
            environment,
            guard,
            coordinationKey,
          ),
        environment,
      );
      finalizer.finish();
    } catch (error) {
      if (!deferredScheduled) {
        deferredScheduled = deferRuntimeLeaseRelease(
          `${operation}:${acquired.ownerToken}:${String(acquired.writer.sequence)}`,
          async () => {
            await releaseWriterAsync(acquired, input, coordinationKey);
            void finalizer.finish();
          },
          acquired.policy.pollMs,
        );
      }
      throw error;
    }
  };
  return release;
}

function attachWriterAuthority<T extends RuntimeExclusiveLease | GlobalRuntimeMaintenanceLease>(
  lease: T,
  writer: WriterRecord,
  environment: RuntimeLeaseEnvironment,
): T {
  let mutationCapability: RuntimeWriterAuthority['mutationCapability'];
  if (lease.kind === 'runtime-exclusive') {
    mutationCapability =
      lease.posture === 'destructive-discard' ? 'project-discard-only' : 'project-record';
  } else {
    mutationCapability = lease.receiptOnlyDiscard ? 'receipt-discard-only' : 'user-record';
  }
  const frozenLease = Object.freeze(lease);
  RUNTIME_WRITER_AUTHORITIES.set(
    frozenLease,
    Object.freeze({
      ownerToken: writer.ownerToken,
      acquiredAt: writer.acquiredAt,
      sequence: writer.sequence,
      kind: writer.kind,
      ...(writer.coordinationKey === undefined ? {} : { coordinationKey: writer.coordinationKey }),
      mutationCapability,
      environment,
    } satisfies RuntimeWriterAuthority),
  );
  return frozenLease;
}

/** Acquire one path-stable project exclusive maintenance lease. */
export async function acquireRuntimeExclusiveLease(
  input: AcquireRuntimeExclusiveLeaseInput,
): Promise<RuntimeExclusiveLease> {
  const stableInput = captureRuntimeIdentity(input);
  const coordinationKey = projectCoordinationKey(stableInput.projectDir);
  const posture = stableInput.posture ?? 'normal';
  const acquired = await acquireWriter(stableInput, {
    kind: 'project',
    coordinationKey,
    waitKind: 'runtime-exclusive',
    projectPosture: posture,
    recoveryOperationId: stableInput.recoveryOperationId,
  });
  return attachWriterAuthority(
    {
      kind: 'runtime-exclusive',
      ownerToken: acquired.ownerToken,
      acquiredAt: acquired.acquiredAt,
      coordinationKey,
      posture,
      release: writerReleaseHandle(acquired, stableInput, 'runtime-exclusive', coordinationKey),
    },
    acquired.writer,
    runtimeEnvironment(stableInput),
  );
}

/** Acquire the global exclusive user-runtime maintenance lease. */
export async function acquireGlobalRuntimeMaintenanceLease(
  input: AcquireGlobalRuntimeMaintenanceLeaseInput = {},
): Promise<GlobalRuntimeMaintenanceLease> {
  const stableInput = captureRuntimeIdentity(input);
  const posture = stableInput.posture ?? 'normal';
  const acquired = await acquireWriter(stableInput, {
    kind: 'global',
    waitKind: 'runtime-global-maintenance',
    globalPosture: posture,
    recoveryOperationId: stableInput.recoveryOperationId,
  });
  return attachWriterAuthority(
    {
      kind: 'runtime-global-maintenance',
      ownerToken: acquired.ownerToken,
      acquiredAt: acquired.acquiredAt,
      posture,
      receiptOnlyDiscard: posture === 'receipt-only-discard',
      release: writerReleaseHandle(acquired, stableInput, 'runtime-global-maintenance'),
    },
    acquired.writer,
    runtimeEnvironment(stableInput),
  );
}

function assertRecoveryMutationAuthority(
  paths: CoordinationPaths,
  lease: WriterLeaseWithAuthority,
  kind: 'project' | 'global',
  mutationCapability: RuntimeWriterAuthority['mutationCapability'],
  coordinationKey?: string,
): void {
  const authority = RUNTIME_WRITER_AUTHORITIES.get(lease);
  const writer = readLeaseState(paths).writers.find(
    (candidate) => candidate.ownerToken === lease.ownerToken,
  );
  if (
    authority?.ownerToken !== lease.ownerToken ||
    authority.acquiredAt !== lease.acquiredAt ||
    authority.kind !== kind ||
    authority.mutationCapability !== mutationCapability ||
    authority.coordinationKey !== coordinationKey ||
    writer?.phase !== 'intent' ||
    writer.kind !== kind ||
    writer.acquiredAt !== authority.acquiredAt ||
    writer.sequence !== authority.sequence ||
    (kind === 'project' && writer.coordinationKey !== coordinationKey)
  ) {
    throw new SystemError('Runtime recovery mutation no longer holds exclusive authority', {
      code: 'CORE.RUNTIME_LEASE.AUTHORITY_LOST',
    });
  }
}

function writerAuthorityEnvironment(lease: WriterLeaseWithAuthority): RuntimeLeaseEnvironment {
  return RUNTIME_WRITER_AUTHORITIES.get(lease)?.environment ?? DEFAULT_RUNTIME_LEASE_ENVIRONMENT;
}

function readFixedRecoveryRecordWhileOwned(
  paths: CoordinationPaths,
  parentDir: string,
  basenameValue: string,
  guard: RuntimeMutexGuard,
  environment: RuntimeLeaseEnvironment,
): AnchoredRecordReadResult {
  assertSafeBasename(basenameValue);
  const target = join(parentDir, basenameValue);
  const parent = openAnchoredParentIdentity(parentDir, paths.coordinationDir, 'private');
  try {
    guard.assertOwned();
    const content = readAnchoredBoundedRecord(
      target,
      RUNTIME_RECOVERY_RECORD_MAX_BYTES,
      paths.coordinationDir,
      'private',
    );
    environment.coordinationCheckpoint?.('before-fixed-recovery-read-parent-revalidation');
    guard.assertOwned();
    assertAnchoredParentUnchanged(
      parent.fd,
      parent.identity,
      parentDir,
      paths.coordinationDir,
      'private',
    );
    if (content === undefined) return { status: 'absent' };
    return {
      status: 'present',
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  } finally {
    closeSync(parent.fd);
  }
}

/** @throws {Error} When fixed-record authority, identity, digest, or durability cannot be proven. */
function durableIdempotentFixedRecoveryUnlink(
  paths: CoordinationPaths,
  parentDir: string,
  basenameValue: string,
  expectedContentSha256: string,
  guard: RuntimeMutexGuard,
  environment: RuntimeLeaseEnvironment,
): { readonly strategy: typeof COORDINATION_MUTATION_STRATEGY } {
  assertSafeBasename(basenameValue);
  if (!/^[a-f0-9]{64}$/u.test(expectedContentSha256)) {
    throw coordinationInputInvalid('Anchored mutation expected digest is invalid', 'digest');
  }
  const target = join(parentDir, basenameValue);
  const parent = openAnchoredParentIdentity(parentDir, paths.coordinationDir, 'private');
  const assertParentAndAuthority = (): void => {
    guard.assertOwned();
    assertAnchoredParentUnchanged(
      parent.fd,
      parent.identity,
      parentDir,
      paths.coordinationDir,
      'private',
    );
    guard.assertOwned();
  };
  /** @throws {Error} When the fixed recovery record is still present after unlink. */
  const assertTargetAbsent = (): void => {
    if (targetIdentity(target, RUNTIME_RECOVERY_RECORD_MAX_BYTES, 'private') !== undefined) {
      throw new RuntimeSnapshotChangedError(
        'Fixed recovery record reappeared during durable unlink',
      );
    }
  };
  try {
    const before = targetIdentity(target, RUNTIME_RECOVERY_RECORD_MAX_BYTES, 'private');
    if (before === undefined) {
      // A prior attempt can have completed the unlink but failed before the
      // parent-directory fsync returned. Re-establish durability instead of
      // turning that safe retry into a CAS mismatch.
      assertParentAndAuthority();
      assertTargetAbsent();
      fsyncParent(parent.fd);
      assertParentAndAuthority();
      assertTargetAbsent();
      return { strategy: COORDINATION_MUTATION_STRATEGY };
    }

    /** @throws {Error} When the fixed recovery record no longer matches its expected digest. */
    const assertExpectedDigest = (): RecordIdentity => {
      const observed = readAnchoredRecord({
        trustedAnchorDir: paths.coordinationDir,
        parentDir,
        basename: basenameValue,
        maxBytes: RUNTIME_RECOVERY_RECORD_MAX_BYTES,
        permissionPosture: 'private',
      });
      if (observed.status !== 'present' || observed.sha256 !== expectedContentSha256) {
        throw new SystemError('Anchored record changed since the caller observed it', {
          code: 'CORE.RUNTIME_COORDINATION.CAS_MISMATCH',
        });
      }
      const identity = targetIdentity(target, RUNTIME_RECOVERY_RECORD_MAX_BYTES, 'private');
      if (identity === undefined || !sameRecordIdentity(before, identity)) {
        throw new RuntimeSnapshotChangedError(
          'Fixed recovery record changed during CAS verification',
        );
      }
      return identity;
    };

    assertExpectedDigest();
    assertParentAndAuthority();
    const immediatelyBefore = assertExpectedDigest();
    assertParentAndAuthority();
    const finalIdentity = targetIdentity(target, RUNTIME_RECOVERY_RECORD_MAX_BYTES, 'private');
    if (finalIdentity === undefined || !sameRecordIdentity(immediatelyBefore, finalIdentity)) {
      throw new RuntimeSnapshotChangedError('Fixed recovery record changed before durable unlink');
    }
    unlinkSync(target);
    environment.coordinationCheckpoint?.('before-fixed-recovery-parent-fsync');
    guard.assertOwned();
    assertTargetAbsent();
    fsyncParent(parent.fd);
    assertParentAndAuthority();
    assertTargetAbsent();
    return { strategy: COORDINATION_MUTATION_STRATEGY };
  } finally {
    closeSync(parent.fd);
  }
}

function fixedRecoveryMutation(
  paths: CoordinationPaths,
  parentDir: string,
  basenameValue: string,
  mutation: RuntimeRecoveryRecordMutation,
  guard: RuntimeMutexGuard,
  environment: RuntimeLeaseEnvironment,
): { readonly strategy: typeof COORDINATION_MUTATION_STRATEGY } {
  if (mutation.operation === 'unlink') {
    return durableIdempotentFixedRecoveryUnlink(
      paths,
      parentDir,
      basenameValue,
      mutation.expectedContentSha256,
      guard,
      environment,
    );
  }
  return performAnchoredRecordMutation(
    {
      trustedAnchorDir: paths.coordinationDir,
      parentDir,
      basename: basenameValue,
      operation: mutation.operation,
      content: mutation.content,
      maxBytes: RUNTIME_RECOVERY_RECORD_MAX_BYTES,
      ...(mutation.operation === 'create'
        ? {}
        : { expectedContentSha256: mutation.expectedContentSha256 }),
      permissionPosture: 'private',
    },
    { assertPublicationAllowed: () => guard.assertOwned() },
  );
}

/** @throws {SystemError} When recovery content is malformed or bound to the wrong operation. */
function assertValidRecoveryMutationContent(
  mutation: RuntimeRecoveryRecordMutation,
  expectedKind: 'init-promotion' | 'user-uninstall',
  expectedCoordinationKey?: string,
): void {
  if (mutation.operation === 'unlink') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(mutation.content);
  } catch {
    throw corruptCoordinationRecord('Recovery mutation content is not valid JSON', 'not-json');
  }
  if (
    !isPlainRecord(parsed) ||
    parsed.kind !== expectedKind ||
    parsed.version !== RUNTIME_RECOVERY_HEADER_VERSION ||
    (parsed.state !== 'open' && parsed.state !== 'closed') ||
    typeof parsed.operationId !== 'string' ||
    !validateOperationId(parsed.operationId) ||
    (parsed.reason !== undefined &&
      (typeof parsed.reason !== 'string' ||
        Buffer.byteLength(parsed.reason, 'utf8') > MAX_SAFE_TEXT)) ||
    (expectedKind === 'init-promotion' &&
      (typeof parsed.coordinationKey !== 'string' ||
        parsed.coordinationKey !== expectedCoordinationKey))
  ) {
    throw corruptCoordinationRecord(
      'Recovery mutation content has an invalid bounded header',
      'bad-header',
    );
  }
}

/**
 * Read only the fixed project promotion journal while the exact project
 * writer remains live. The returned digest may be used with the fixed mutation
 * seam; no caller-controlled path participates in the read.
 */
export async function readRuntimePromotionJournal(
  lease: RuntimeExclusiveLease,
): Promise<AnchoredRecordReadResult> {
  if (lease.posture === 'destructive-discard') {
    throw new SystemError('Destructive journal authority cannot read the recovery body', {
      code: 'CORE.RUNTIME_LEASE.AUTHORITY_SCOPE',
    });
  }
  const policy = normalizePolicy();
  const environment = writerAuthorityEnvironment(lease);
  return withCoordinationMutex(
    policy,
    undefined,
    policy.waitMs,
    (paths, guard) => {
      assertRecoveryMutationAuthority(
        paths,
        lease,
        'project',
        'project-record',
        lease.coordinationKey,
      );
      const projectPaths = paths.forProject(lease.coordinationKey);
      return readFixedRecoveryRecordWhileOwned(
        paths,
        projectPaths.projectCoordinationDir,
        RUNTIME_PROMOTION_JOURNAL_FILE,
        guard,
        environment,
      );
    },
    environment,
  );
}

/**
 * Read only the fixed user-uninstall receipt while the exact global writer
 * remains live. The returned digest is suitable for fixed-record CAS updates.
 */
export async function readUserUninstallReceipt(
  lease: GlobalRuntimeMaintenanceLease,
): Promise<AnchoredRecordReadResult> {
  if (lease.receiptOnlyDiscard) {
    throw new SystemError('Receipt-only authority cannot read the recovery body', {
      code: 'CORE.RUNTIME_LEASE.AUTHORITY_SCOPE',
    });
  }
  const policy = normalizePolicy();
  const environment = writerAuthorityEnvironment(lease);
  return withCoordinationMutex(
    policy,
    undefined,
    policy.waitMs,
    (paths, guard) => {
      assertRecoveryMutationAuthority(paths, lease, 'global', 'user-record');
      return readFixedRecoveryRecordWhileOwned(
        paths,
        paths.coordinationDir,
        USER_UNINSTALL_RECEIPT_FILE,
        guard,
        environment,
      );
    },
    environment,
  );
}

/** Mutate only the fixed project promotion journal while its writer is live. */
export async function mutateRuntimePromotionJournal(
  lease: RuntimeExclusiveLease,
  mutation: RuntimeRecoveryRecordMutation,
): Promise<{ readonly strategy: typeof COORDINATION_MUTATION_STRATEGY }> {
  if (lease.posture === 'destructive-discard') {
    throw new SystemError('Destructive journal authority can only discard the fixed record', {
      code: 'CORE.RUNTIME_LEASE.AUTHORITY_SCOPE',
    });
  }
  const policy = normalizePolicy();
  const environment = writerAuthorityEnvironment(lease);
  return withCoordinationMutex(
    policy,
    undefined,
    policy.waitMs,
    (paths, guard) => {
      assertRecoveryMutationAuthority(
        paths,
        lease,
        'project',
        'project-record',
        lease.coordinationKey,
      );
      assertValidRecoveryMutationContent(mutation, 'init-promotion', lease.coordinationKey);
      const projectPaths = paths.forProject(lease.coordinationKey);
      return fixedRecoveryMutation(
        paths,
        projectPaths.projectCoordinationDir,
        RUNTIME_PROMOTION_JOURNAL_FILE,
        mutation,
        guard,
        environment,
      );
    },
    environment,
  );
}

/** Mutate only the fixed user-uninstall receipt while its global writer is live. */
export async function mutateUserUninstallReceipt(
  lease: GlobalRuntimeMaintenanceLease,
  mutation: RuntimeRecoveryRecordMutation,
): Promise<{ readonly strategy: typeof COORDINATION_MUTATION_STRATEGY }> {
  if (lease.receiptOnlyDiscard) {
    throw new SystemError('Receipt-only authority can only discard the fixed receipt', {
      code: 'CORE.RUNTIME_LEASE.AUTHORITY_SCOPE',
    });
  }
  const policy = normalizePolicy();
  const environment = writerAuthorityEnvironment(lease);
  return withCoordinationMutex(
    policy,
    undefined,
    policy.waitMs,
    (paths, guard) => {
      assertRecoveryMutationAuthority(paths, lease, 'global', 'user-record');
      assertValidRecoveryMutationContent(mutation, 'user-uninstall');
      return fixedRecoveryMutation(
        paths,
        paths.coordinationDir,
        USER_UNINSTALL_RECEIPT_FILE,
        mutation,
        guard,
        environment,
      );
    },
    environment,
  );
}

/** Discard only the fixed promotion journal under explicit destructive posture. */
export async function discardRuntimePromotionJournal(lease: RuntimeExclusiveLease): Promise<void> {
  if (lease.posture !== 'destructive-discard') {
    throw new SystemError('Promotion-journal discard requires destructive authority', {
      code: 'CORE.RUNTIME_LEASE.AUTHORITY_SCOPE',
    });
  }
  const policy = normalizePolicy();
  await withCoordinationMutex(policy, undefined, policy.waitMs, (paths, guard) => {
    assertRecoveryMutationAuthority(
      paths,
      lease,
      'project',
      'project-discard-only',
      lease.coordinationKey,
    );
    const projectPaths = paths.forProject(lease.coordinationKey);
    unlinkFixedAnchoredRecordWithoutSize(
      paths.coordinationDir,
      projectPaths.projectCoordinationDir,
      RUNTIME_PROMOTION_JOURNAL_FILE,
      () => guard.assertOwned(),
    );
  });
}

/** Discard only the fixed malformed receipt under receipt-only posture. */
export async function discardUserUninstallReceipt(
  lease: GlobalRuntimeMaintenanceLease,
): Promise<void> {
  if (!lease.receiptOnlyDiscard) {
    throw new SystemError('User receipt discard requires receipt-only authority', {
      code: 'CORE.RUNTIME_LEASE.AUTHORITY_SCOPE',
    });
  }
  const policy = normalizePolicy();
  await withCoordinationMutex(policy, undefined, policy.waitMs, (paths, guard) => {
    assertRecoveryMutationAuthority(paths, lease, 'global', 'receipt-discard-only');
    if (inspectUserReceiptHeader(paths).status !== 'malformed') {
      throw recoveryRequired('Receipt-only discard requires a malformed fixed receipt.');
    }
    unlinkFixedAnchoredRecordWithoutSize(
      paths.coordinationDir,
      paths.coordinationDir,
      USER_UNINSTALL_RECEIPT_FILE,
      () => guard.assertOwned(),
    );
  });
}

export interface RuntimeLeaseCoordinator {
  readonly acquireRuntimeReadLease: (
    input: AcquireRuntimeReadLeaseInput,
  ) => Promise<RuntimeReadLease>;
  readonly acquireRuntimeExclusiveLease: (
    input: AcquireRuntimeExclusiveLeaseInput,
  ) => Promise<RuntimeExclusiveLease>;
  readonly acquireUserStateReadLease: (
    input?: AcquireUserStateReadLeaseInput,
  ) => Promise<UserStateReadLease>;
  readonly acquireGlobalRuntimeMaintenanceLease: (
    input?: AcquireGlobalRuntimeMaintenanceLeaseInput,
  ) => Promise<GlobalRuntimeMaintenanceLease>;
  readonly acquireRuntimeAccessLease: (
    input: AcquireRuntimeAccessLeaseInput,
  ) => Promise<RuntimeAccessLease>;
}

function bindRuntimeEnvironment<T extends RuntimeLeaseCommonInput>(
  input: T,
  environment: RuntimeLeaseEnvironment,
): T {
  return { ...input, [RUNTIME_ENVIRONMENT]: environment };
}

/**
 * Build an isolated coordinator with deterministic clock/process/poll seams.
 * Production top-level APIs use the frozen default environment; tests and
 * fault harnesses close over overrides here without module-global run state.
 */
export function createRuntimeLeaseCoordinator(
  overrides: Partial<RuntimeLeaseEnvironment> = {},
): RuntimeLeaseCoordinator {
  const environment: RuntimeLeaseEnvironment = Object.freeze({
    ...DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
    ...overrides,
    monotonicNow:
      overrides.monotonicNow ?? overrides.now ?? DEFAULT_RUNTIME_LEASE_ENVIRONMENT.monotonicNow,
    hostInstanceIdentity:
      overrides.hostInstanceIdentity ??
      (overrides.hostname === undefined
        ? DEFAULT_RUNTIME_LEASE_ENVIRONMENT.hostInstanceIdentity
        : noHostInstanceIdentity),
  });
  return Object.freeze({
    acquireRuntimeReadLease: (input: AcquireRuntimeReadLeaseInput) =>
      acquireRuntimeReadLease(bindRuntimeEnvironment(input, environment)),
    acquireRuntimeExclusiveLease: (input: AcquireRuntimeExclusiveLeaseInput) =>
      acquireRuntimeExclusiveLease(bindRuntimeEnvironment(input, environment)),
    acquireUserStateReadLease: (input: AcquireUserStateReadLeaseInput = {}) =>
      acquireUserStateReadLease(bindRuntimeEnvironment(input, environment)),
    acquireGlobalRuntimeMaintenanceLease: (input: AcquireGlobalRuntimeMaintenanceLeaseInput = {}) =>
      acquireGlobalRuntimeMaintenanceLease(bindRuntimeEnvironment(input, environment)),
    acquireRuntimeAccessLease: (input: AcquireRuntimeAccessLeaseInput) =>
      acquireRuntimeAccessLease(bindRuntimeEnvironment(input, environment)),
  });
}

/** @throws {SystemError} When coordination-root presence cannot be safely inspected. */
function coordinationRootPresence(paths: CoordinationPaths): 'absent' | 'present' {
  try {
    lstatSync(paths.coordinationDir);
    return 'present';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw coordinationProbeFailed('Runtime coordination root cannot be inspected', 'probe');
  }
}

function assertExistingScaffold(paths: CoordinationPaths): void {
  assertDirectory(paths.coordinationDir);
  assertDirectory(paths.projectsDir, paths.coordinationDir);
  assertDirectory(paths.userReadersDir, paths.coordinationDir);
  validateCoordinationRootEntries(paths);
}

/** Trusted Init seam for the bounded fixed promotion header only. */
export function inspectRuntimePromotionRecoveryHeader(
  projectDir: string,
): RecoveryHeaderInspection {
  const paths = resolveCoordinationPaths();
  if (coordinationRootPresence(paths) === 'absent') return { status: 'absent' };
  assertExistingScaffold(paths);
  const coordinationKey = projectCoordinationKey(projectDir);
  const projectPaths = paths.forProject(coordinationKey);
  if (
    lstatIfPresent(projectPaths.projectCoordinationDir, 'Runtime project coordination state') ===
    undefined
  ) {
    return { status: 'absent' };
  }
  validateProjectCoordinationEntries(paths, coordinationKey);
  return inspectRecoveryHeader(
    projectPaths.promotionJournalFile,
    'init-promotion',
    coordinationKey,
    false,
  );
}

/** Trusted uninstall seam for the bounded fixed user receipt header only. */
export function inspectUserUninstallRecoveryHeader(): RecoveryHeaderInspection {
  const paths = resolveCoordinationPaths();
  if (coordinationRootPresence(paths) === 'absent') return { status: 'absent' };
  assertExistingScaffold(paths);
  return inspectRecoveryHeader(paths.userUninstallReceiptFile, 'user-uninstall', undefined, false);
}

function sanitizedRecovery(inspection: RecoveryHeaderInspection): RuntimeRecoveryStateProjection {
  if (inspection.status === 'absent') return { status: 'absent' };
  if (inspection.status === 'malformed') return { status: 'malformed' };
  return { status: 'valid', state: inspection.state };
}

/** @throws {SystemError} When project coordination inspection encounters unsafe state. */
function readProjectInspection(
  paths: CoordinationPaths,
  coordinationKey: string,
  policy: RuntimeLeasePolicy,
): {
  readonly readers: number;
  readonly promotion: RecoveryHeaderInspection;
} {
  const projectDir = join(paths.projectsDir, coordinationKey);
  try {
    lstatSync(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { readers: 0, promotion: { status: 'absent' } };
    }
    throw coordinationProbeFailed(
      'Runtime project coordination state cannot be inspected',
      'probe',
    );
  }
  validateProjectCoordinationEntries(paths, coordinationKey);
  const projectPaths = paths.forProject(coordinationKey);
  const readers = readReaderRecords(projectPaths.readersDir, 'project', false).filter(
    ({ record }) => !ownerIsStale(record, policy, Date.now()),
  ).length;
  return {
    readers,
    promotion: inspectRecoveryHeader(
      projectPaths.promotionJournalFile,
      'init-promotion',
      coordinationKey,
      false,
    ),
  };
}

/** @throws {SystemError} When an inspection target cannot be identified safely. */
function inspectionIdentity(path: string): string {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) return 'unsafe-symlink';
    return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw coordinationProbeFailed(
      'Runtime coordination snapshot identity cannot be inspected',
      'probe',
    );
  }
}

function captureInspectionIdentities(
  paths: CoordinationPaths,
  coordinationKey: string,
): readonly string[] {
  const project = paths.forProject(coordinationKey);
  return [
    paths.coordinationDir,
    paths.globalMutexFile,
    paths.stateFile,
    paths.projectsDir,
    paths.userReadersDir,
    paths.userUninstallReceiptFile,
    project.projectCoordinationDir,
    project.readersDir,
    project.promotionJournalFile,
  ].map(inspectionIdentity);
}

function hasRuntimeMutexPublicationTemp(paths: CoordinationPaths): boolean {
  return readDirectoryBounded(
    paths.coordinationDir,
    MAX_MUTEX_TEMPS + 8,
    'Runtime coordination root',
  ).some((entry) => MUTEX_TEMP_FILE_PATTERN.test(entry));
}

/**
 * Inspect the current project's coordination state without creating or
 * repairing any directory, mutex, queue, reader record, or recovery file.
 */
export async function inspectRuntimeLeaseState(
  projectDir: string,
): Promise<RuntimeLeaseStateInspection> {
  await Promise.resolve();
  const coordinationKey = projectCoordinationKey(projectDir);
  const paths = resolveCoordinationPaths();
  if (coordinationRootPresence(paths) === 'absent') {
    return {
      status: 'stable',
      projectReaders: 0,
      userStateReaders: 0,
      writer: 'none',
      globalWriter: 'none',
      promotion: { status: 'absent' },
      userUninstall: { status: 'absent' },
    };
  }
  const policy = normalizePolicy();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = captureInspectionIdentities(paths, coordinationKey);
    // A stable-looking filesystem snapshot can still be an intermediate
    // composite transition while the mutex holder is between dimensions.
    if (before[1] !== 'absent' || hasRuntimeMutexPublicationTemp(paths)) {
      await Promise.resolve();
      continue;
    }
    try {
      assertExistingScaffold(paths);
      const state = inspectLeaseState(paths);
      const now = Date.now();
      const liveWriters = state.writers.filter((writer) => !ownerIsStale(writer, policy, now));
      const project = readProjectInspection(paths, coordinationKey, policy);
      const userReaders = readReaderRecords(paths.userReadersDir, 'user', false).filter(
        ({ record }) => !ownerIsStale(record, policy, now),
      ).length;
      const projectWriter = liveWriters.find(
        (writer) => writer.kind === 'project' && writer.coordinationKey === coordinationKey,
      );
      const globalWriter = liveWriters.find((writer) => writer.kind === 'global');
      const result: StableRuntimeLeaseStateInspection = {
        status: 'stable',
        projectReaders: project.readers,
        userStateReaders: userReaders,
        writer: projectWriter?.phase ?? 'none',
        globalWriter: globalWriter?.phase ?? 'none',
        promotion: sanitizedRecovery(project.promotion),
        userUninstall: sanitizedRecovery(
          inspectRecoveryHeader(paths.userUninstallReceiptFile, 'user-uninstall', undefined, false),
        ),
      };
      const after = captureInspectionIdentities(paths, coordinationKey);
      if (before.some((identity, index) => identity !== after[index])) {
        await Promise.resolve();
        continue;
      }
      return result;
    } catch (error) {
      let changed = error instanceof RuntimeSnapshotChangedError;
      if (before[3] === 'absent' || before[4] === 'absent') {
        changed = true;
      }
      if (!changed) {
        try {
          const after = captureInspectionIdentities(paths, coordinationKey);
          changed = before.some((identity, index) => identity !== after[index]);
        } catch {
          // @swallow-ok fail-closed: an inspection that cannot complete must read as CHANGED, so the caller retries rather than acting on a stale identity
          changed = true;
        }
      }
      if (!changed) throw error;
      await Promise.resolve();
    }
  }
  return { status: 'busy', reason: 'changed-during-inspection' };
}

/**
 * Return bounded active project coordination keys for cache-prune optimization.
 *
 * Unsafe, malformed, or over-cap state throws rather than returning a false
 * empty set; pruning must treat that uncertainty as "skip deletion".
 */
export async function listActiveRuntimeLeaseKeys(
  input: ListActiveRuntimeLeaseKeysInput = {},
): Promise<readonly string[]> {
  const paths = resolveCoordinationPaths();
  if (coordinationRootPresence(paths) === 'absent') return [];
  assertExistingScaffold(paths);
  const policy = normalizePolicy(input.policy);
  return withCoordinationMutex(policy, input.onEvent, policy.waitMs, (lockedPaths, guard) => {
    let state = cleanStaleWriters(
      lockedPaths,
      readLeaseState(lockedPaths),
      policy,
      input.onEvent,
      DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
      guard,
    );
    if (state.writers.some((writer) => writer.kind === 'global')) {
      throw coordinationConflict(
        'Global runtime maintenance prevents safe cache pruning',
        'maintenance-active',
      );
    }
    if (inspectUserReceiptHeader(lockedPaths).status !== 'absent') {
      throw coordinationConflict(
        'User-uninstall recovery state prevents safe cache pruning',
        'maintenance-active',
      );
    }
    const active = new Set<string>();
    for (const writer of state.writers) {
      if (writer.kind === 'project' && writer.coordinationKey !== undefined) {
        active.add(writer.coordinationKey);
      }
    }
    const processInspectionCache = createProcessInspectionCache();
    for (const coordinationKey of listProjectCoordinationKeys(lockedPaths, guard)) {
      const projectPaths = lockedPaths.forProject(coordinationKey);
      const promotion = inspectRecoveryHeader(
        projectPaths.promotionJournalFile,
        'init-promotion',
        coordinationKey,
      );
      // Open, closed, and malformed journals all preserve the source cache key
      // until Init recovery or explicit discard has completed.
      const readers = cleanAndListReaders({
        readersDir: projectPaths.readersDir,
        dimension: 'project',
        policy,
        onEvent: input.onEvent,
        environment: DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
        guard,
        processInspectionCache,
      });
      if (promotion.status !== 'absent' || readers.length > 0) {
        active.add(coordinationKey);
        continue;
      }
      cleanupEmptyRuntimeLeaseKeyWhileOwned(
        lockedPaths,
        coordinationKey,
        policy,
        DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
        guard,
      );
    }
    state = readLeaseState(lockedPaths);
    if (state.writers.length > MAX_WRITER_QUEUE) {
      throw unsafeCoordination('Runtime writer state became uncertain during enumeration');
    }
    if (state.writers.some((writer) => writer.kind === 'global')) {
      throw unsafeCoordination('Global runtime maintenance changed during cache-prune enumeration');
    }
    return Object.freeze([...active].sort());
  });
}

export type EmptyRuntimeLeaseKeyCleanup = 'absent' | 'kept' | 'removed';

/** @throws {SystemError} When an empty project scaffold cannot be proven or removed safely. */
function cleanupEmptyRuntimeLeaseKeyWhileOwned(
  lockedPaths: CoordinationPaths,
  coordinationKey: string,
  policy: RuntimeLeasePolicy,
  environment: RuntimeLeaseEnvironment,
  guard: RuntimeMutexGuard,
): EmptyRuntimeLeaseKeyCleanup {
  const projectPaths = lockedPaths.forProject(coordinationKey);
  try {
    lstatSync(projectPaths.projectCoordinationDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw coordinationProbeFailed('Runtime key directory cannot be inspected', 'probe');
  }
  assertDirectory(projectPaths.projectCoordinationDir, lockedPaths.coordinationDir);
  validateProjectCoordinationEntries(lockedPaths, coordinationKey, guard);
  const state = cleanStaleWriters(
    lockedPaths,
    readLeaseState(lockedPaths),
    policy,
    undefined,
    environment,
    guard,
  );
  if (
    state.writers.some(
      (writer) => writer.kind === 'project' && writer.coordinationKey === coordinationKey,
    )
  ) {
    return 'kept';
  }
  if (
    inspectRecoveryHeader(projectPaths.promotionJournalFile, 'init-promotion', coordinationKey)
      .status !== 'absent'
  ) {
    return 'kept';
  }
  if (
    cleanAndListReaders({
      readersDir: projectPaths.readersDir,
      dimension: 'project',
      policy,
      onEvent: undefined,
      environment,
      guard,
    }).length > 0
  ) {
    return 'kept';
  }
  const readerEntries = validateReaderDirectoryEntries(
    projectPaths.readersDir,
    lockedPaths.coordinationDir,
    guard,
  );
  validateProjectCoordinationEntries(lockedPaths, coordinationKey, guard);
  const projectEntries = readDirectoryBounded(
    projectPaths.projectCoordinationDir,
    MAX_MUTEX_TEMPS + 2,
    'Runtime project coordination directory',
  );
  if (readerEntries.length > 0 || projectEntries.some((entry) => entry !== 'readers')) {
    return 'kept';
  }
  const projectParent = openParentIdentity(
    projectPaths.projectCoordinationDir,
    lockedPaths.coordinationDir,
  );
  try {
    const readersIdentity = assertDirectory(projectPaths.readersDir, lockedPaths.coordinationDir);
    const projectsParent = openParentIdentity(lockedPaths.projectsDir, lockedPaths.coordinationDir);
    try {
      environment.coordinationCheckpoint?.('empty-scaffold-parents-opened');
      assertParentUnchanged(
        projectParent.fd,
        projectParent.identity,
        projectPaths.projectCoordinationDir,
        lockedPaths.coordinationDir,
      );
      const readersNow = assertDirectory(projectPaths.readersDir, lockedPaths.coordinationDir);
      if (
        !sameIdentity(readersIdentity, readersNow) ||
        validateReaderDirectoryEntries(projectPaths.readersDir, lockedPaths.coordinationDir, guard)
          .length > 0
      ) {
        return 'kept';
      }
      guard.refresh();
      guard.assertOwned();
      rmdirSync(projectPaths.readersDir);
      guard.assertOwned();
      fsyncParent(projectParent.fd);
      assertParentUnchanged(
        projectsParent.fd,
        projectsParent.identity,
        lockedPaths.projectsDir,
        lockedPaths.coordinationDir,
      );
      if (
        readDirectoryBounded(
          projectPaths.projectCoordinationDir,
          MAX_MUTEX_TEMPS + 2,
          'Runtime project coordination directory',
        ).length > 0
      ) {
        mkdirSecure(projectPaths.readersDir, lockedPaths.coordinationDir);
        return 'kept';
      }
      const projectNow = assertDirectory(
        projectPaths.projectCoordinationDir,
        lockedPaths.coordinationDir,
      );
      if (!sameIdentity(projectParent.identity, projectNow)) {
        mkdirSecure(projectPaths.readersDir, lockedPaths.coordinationDir);
        return 'kept';
      }
      guard.refresh();
      guard.assertOwned();
      rmdirSync(projectPaths.projectCoordinationDir);
      guard.assertOwned();
      fsyncParent(projectsParent.fd);
      return 'removed';
    } finally {
      closeSync(projectsParent.fd);
    }
  } finally {
    closeSync(projectParent.fd);
  }
}

/**
 * Remove only a proven-empty per-key scaffold under the global mutex.
 * Recovery journals, live/malformed readers, writer requests, temporary or
 * unknown entries all preserve the directory.
 */
export async function cleanupEmptyRuntimeLeaseKey(
  coordinationKey: string,
): Promise<EmptyRuntimeLeaseKeyCleanup> {
  if (!PROJECT_KEY_PATTERN.test(coordinationKey)) {
    throw new SystemError('Runtime coordination key is invalid', {
      code: 'CORE.RUNTIME_COORDINATION.INVALID_KEY',
    });
  }
  const paths = resolveCoordinationPaths();
  if (coordinationRootPresence(paths) === 'absent') return 'absent';
  assertExistingScaffold(paths);
  const policy = normalizePolicy({ waitMs: 250 });
  return withCoordinationMutex(policy, undefined, policy.waitMs, (lockedPaths, guard) =>
    cleanupEmptyRuntimeLeaseKeyWhileOwned(
      lockedPaths,
      coordinationKey,
      policy,
      DEFAULT_RUNTIME_LEASE_ENVIRONMENT,
      guard,
    ),
  );
}

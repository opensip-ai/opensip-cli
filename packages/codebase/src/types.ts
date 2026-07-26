import type {
  FileEvidenceSupport,
  FileFact,
  PackageFact,
  ProjectInventorySnapshot,
  VerificationCommand,
} from '@opensip-cli/contracts';
import type { TargetResolver } from '@opensip-cli/core';

export const MAX_INVENTORY_FILES = 20_000;
export const MAX_INVENTORY_PACKAGES = 2000;
export const MAX_PACKAGE_SCRIPTS = 64;
export const MAX_FILE_TARGETS = 8;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_MANIFEST_DEPTH = 12;
export const MAX_FACT_TEXT = 1024;
export const MAX_MANIFEST_EXPORTS = 256;
export const MAX_MANIFEST_BINS = 128;
export const MAX_WORKSPACE_PATTERNS = 128;
export const MAX_COMMAND_ARGV = 32;
export const MAX_COMMAND_ARG_LENGTH = 256;
export const MAX_SCRIPT_NAME = 128;
export const MAX_TARGET_NAME = 128;
/** Hard ceiling on target definitions inventory will enumerate. */
export const MAX_INVENTORY_TARGETS = 128;
/** Hard ceiling on tags, concerns, or languages retained from one target. */
export const MAX_TARGET_METADATA_VALUES = 128;
/** Hard ceiling on code units in one target tag, concern, or language. */
export const MAX_TARGET_METADATA_TEXT = 128;
/** Hard ceiling on convention paths inspected from one target. */
export const MAX_TARGET_CONVENTION_PATHS = 128;
/** Hard ceiling on code units in one target convention path. */
export const MAX_TARGET_CONVENTION_PATH_LENGTH = 1024;
/** Hard ceiling on code units in one path returned by a host targeting capability. */
export const MAX_TARGET_RESOLVED_PATH_LENGTH = 4096;
export const MAX_FILE_LANGUAGES = 32;
export const MAX_PROJECT_LANGUAGES = 256;
/** Leaves 2 MiB of headroom below graph's 8 MiB persisted-payload ceiling. */
export const MAX_INVENTORY_SERIALIZED_BYTES = 6 * 1024 * 1024;
/**
 * Hard ceiling on distinct coverage reason codes.
 *
 * MIRRORS `contextCoverageSchema.reasonCodes` (`z.array(...).max(32)`) in
 * `@opensip-cli/contracts`. The producer must cap at the schema's bound or the
 * DEGRADATION path itself fails validation; `inventory-snapshot.test.ts` pins the two
 * numbers together so a contracts change cannot drift away unnoticed.
 */
export const MAX_COVERAGE_REASON_CODES = 32;
/**
 * Per-invocation budget for one host targeting capability call.
 *
 * The capability is foreign code supplied by the host; without a budget a resolver that
 * never settles hangs the whole inventory regardless of every other bound.
 */
export const MAX_BOUNDED_CAPABILITY_MS = 30_000;
/** Wall-clock ceiling applied to one inventory build when the caller names none. */
export const DEFAULT_INVENTORY_DEADLINE_MS = 300_000;
/**
 * Ceiling for a caller-supplied wall-clock deadline.
 *
 * There is deliberately no floor: like every other bound here a caller may only REDUCE the
 * built-in maximum. Clamping a small deadline upward would widen a bound the caller asked
 * to narrow, which is the exact failure this module refuses elsewhere.
 */
export const MAX_INVENTORY_DEADLINE_MS = 1_800_000;

export interface InventoryLimits {
  readonly files: number;
  readonly packages: number;
  readonly scriptsPerPackage: number;
  readonly targetsPerFile: number;
  readonly manifestBytes: number;
  readonly manifestDepth: number;
  readonly serializedBytes: number;
}

export const DEFAULT_INVENTORY_LIMITS: InventoryLimits = Object.freeze({
  files: MAX_INVENTORY_FILES,
  packages: MAX_INVENTORY_PACKAGES,
  scriptsPerPackage: MAX_PACKAGE_SCRIPTS,
  targetsPerFile: MAX_FILE_TARGETS,
  manifestBytes: MAX_MANIFEST_BYTES,
  manifestDepth: MAX_MANIFEST_DEPTH,
  serializedBytes: MAX_INVENTORY_SERIALIZED_BYTES,
});

/** Host-supplied, graph-agnostic evidence capabilities for one language id. */
export type LanguageEvidenceSupport = ReadonlyMap<string, FileEvidenceSupport>;

export interface ProjectInventoryInput {
  /** Existing project directory. It is canonicalized before any reads occur. */
  readonly projectRoot: string;
  /** Identity supplied by the one host config reader; the substrate never rereads config. */
  readonly configIdentity: string;
  /**
   * Captured structural resolver. File inventory requires the additive
   * `BoundedTargetResolver` capability at runtime; a base-only resolver fails
   * closed instead of falling back to synchronous unbounded expansion.
   */
  readonly targets?: TargetResolver;
  /**
   * Test/smaller-project overrides can reduce, but never increase, hard limits.
   *
   * An omitted key accepts the built-in maximum. A key that is present but not a positive
   * finite number is REFUSED with `CODEBASE.CODEBASE.INVENTORY_INPUT_INVALID` — it is
   * never reinterpreted as the maximum, because silently widening a walk the caller asked
   * to narrow is the failure mode this bound exists to prevent.
   */
  readonly limits?: Partial<InventoryLimits>;
  /** Absent language/capability entries project explicit `unknown` support. */
  readonly languageEvidenceSupport?: LanguageEvidenceSupport;
  /**
   * Caller cancellation.
   *
   * Composed with — never replacing — the host-owned per-invocation root cancel signal
   * (`currentScope()?.abortSignal`, ruling D5) and the wall-clock deadline below. Omitting
   * it therefore still yields an OS-interrupt-cancellable and deadline-bounded run; pass
   * one only to add a narrower cancellation source.
   */
  readonly signal?: AbortSignal;
  /**
   * Wall-clock ceiling for the whole build, capped at {@link MAX_INVENTORY_DEADLINE_MS}
   * and defaulting to {@link DEFAULT_INVENTORY_DEADLINE_MS}.
   *
   * Every other bound limits WORK (entries, directories, bytes, files); none limits TIME,
   * so without this a single unresponsive filesystem read outlives them all. Expiry
   * degrades the run and is reported as `inventory-deadline-exceeded`, distinct from an
   * operator interrupt. A present-but-invalid value is refused, like `limits`.
   */
  readonly deadlineMs?: number;
}

export type PackageManifestFailureReason =
  | 'cancelled'
  | 'invalid-input'
  | 'path-invalid'
  | 'outside-root'
  | 'read-failed'
  | 'too-large'
  | 'parse-failed'
  | 'invalid-shape';

export interface PackageManifestReadInput {
  readonly packageRoot: string;
  readonly projectRoot: string;
  readonly maxBytes?: number;
  readonly maxScripts?: number;
  readonly signal?: AbortSignal;
}

/** Bounded manifest projection. It deliberately retains no raw JSON or script text. */
export interface PackageManifestFacts {
  readonly name: string;
  /** Project-relative POSIX package root; `.` denotes the project root. */
  readonly root: string;
  readonly private: boolean;
  readonly exports: readonly string[];
  /** Literal object keys only; graph uses these to preserve exports-subpath gating. */
  readonly exportMapKeys?: readonly string[];
  readonly bins: readonly string[];
  readonly verificationCommands: readonly VerificationCommand[];
  readonly packageManager?: string;
  readonly workspacePatterns: readonly string[];
  readonly reasonCodes: readonly string[];
}

export type PackageManifestFactsResult =
  | { readonly ok: true; readonly facts: PackageManifestFacts }
  | { readonly ok: false; readonly reason: PackageManifestFailureReason };

/** Snapshot plus read-optimized, non-persisted indexes. */
export interface ProjectInventory {
  readonly snapshot: ProjectInventorySnapshot;
  readonly fileByPath: ReadonlyMap<string, FileFact>;
  readonly packageByRoot: ReadonlyMap<string, PackageFact>;
  readonly manifestByRoot: ReadonlyMap<string, PackageManifestFacts>;
}

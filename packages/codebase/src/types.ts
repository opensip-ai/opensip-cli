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
export const MAX_FILE_LANGUAGES = 32;
export const MAX_PROJECT_LANGUAGES = 256;
/** Leaves 2 MiB of headroom below graph's 8 MiB persisted-payload ceiling. */
export const MAX_INVENTORY_SERIALIZED_BYTES = 6 * 1024 * 1024;

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
  /** Captured structural resolver. Absent means file inventory is unavailable. */
  readonly targets?: TargetResolver;
  /** Test/smaller-project overrides can reduce, but never increase, hard limits. */
  readonly limits?: Partial<InventoryLimits>;
  /** Absent language/capability entries project explicit `unknown` support. */
  readonly languageEvidenceSupport?: LanguageEvidenceSupport;
  readonly signal?: AbortSignal;
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

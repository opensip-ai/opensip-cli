/**
 * Platform-support type vocabulary (Plan 02 — macOS GA qualification).
 *
 * The normative shapes for a native-host support claim: the status vocabulary,
 * the exact host tuple, the registry row, and the observation/assessment
 * vocabulary the classifier produces. Split out of `platform-support.ts` as a
 * dependency-free LEAF: the registry data (`./platform-support-rows.js`), the
 * pure classifier (`./platform-support-eval.js`), and the `./platform-support.js`
 * barrel all depend on these types one-directionally, so there is no import
 * cycle. This module imports nothing and defines only types (erased at runtime).
 */

/**
 * The closed status vocabulary (spec §3):
 *   - `supported`   — measured tuple past burn-in; every release evidence-gated.
 *   - `preview`     — published tuple with useful evidence but documented gaps.
 *   - `unqualified` — not measured by this contract; may work, no promise.
 *   - `unsupported` — intentionally excluded (absent evidence / known limit).
 */
export type PlatformSupportStatus = 'supported' | 'preview' | 'unqualified' | 'unsupported';

// ---------------------------------------------------------------------------
// Normative tuple + registry row
// ---------------------------------------------------------------------------

/** The exact, normative host tuple a support row claims (spec §4). */
export interface PlatformSupportTuple {
  /** `process.platform` value, e.g. `darwin`. */
  readonly osPlatform: string;
  /** Human product name, e.g. `macOS`. */
  readonly osName: string;
  /** Required product-version major, e.g. `26` from `sw_vers -productVersion`. */
  readonly osVersionMajor: number;
  /** Human product-version range, e.g. `26.x`. */
  readonly osVersionRange: string;
  /** Kernel name, e.g. `Darwin`. */
  readonly kernelName: string;
  /** Required kernel-version major, e.g. `25` from `uname -r`. */
  readonly kernelVersionMajor: number;
  /** Human kernel-version range, e.g. `25.x`. */
  readonly kernelVersionRange: string;
  /** `process.arch` value, e.g. `arm64`. */
  readonly arch: string;
  /** Required Node runtime major, e.g. `24`. */
  readonly nodeVersionMajor: number;
  /** Required Node module ABI, e.g. `137` from `process.versions.modules`. */
  readonly nodeAbi: string;
  /** Required npm major, e.g. `11`. */
  readonly npmVersionMajor: number;
  /** Required filesystem type, e.g. `apfs`. */
  readonly filesystemType: string;
  /** Required case behavior: `false` = case-insensitive volume. */
  readonly caseSensitive: boolean;
  /** Allowed install-channel ids (exact npm version + canonical installer). */
  readonly installChannels: readonly string[];
}

/** Digest-free reference to the acceptance profile that qualifies a row. */
export interface PlatformSupportProfileRef {
  readonly id: string;
  readonly version: number;
}

/** Where a row's release evidence lives; `url` is absent until published. */
export interface PlatformSupportEvidence {
  /** The authoritative evidence artifact filename (spec §9). */
  readonly artifact: string;
  /** Public evidence link, or `null` before burn-in publication. */
  readonly url: string | null;
}

/** Burn-in qualification metadata; present ONLY on a `supported` row. */
export interface PlatformQualification {
  /** Consecutive daily pinned-runner passes achieved (spec §10 requires 14). */
  readonly consecutiveDailyPasses: number;
  /** The exact published version whose evidence promoted the row. */
  readonly qualifiedVersion: string;
  /** ISO timestamp of promotion. */
  readonly qualifiedAt: string;
  /** SHA-256 of the exact acceptance profile used for qualification. */
  readonly profileDigest: string;
}

/** One immutable entry in the platform-support registry. */
export interface PlatformSupportRow {
  /** Stable row id; acceptance profiles bind it via `supportRow.rowId`. */
  readonly id: string;
  readonly status: PlatformSupportStatus;
  readonly tuple: PlatformSupportTuple;
  /** The qualification profile (required for `preview`/`supported`). */
  readonly profile?: PlatformSupportProfileRef;
  /** Repo-relative source of the public Supported Platforms doc. */
  readonly docsPath: string;
  /** Public docs URL for this support claim. */
  readonly docsUrl: string;
  /** Release evidence pointer (required for a `supported` row). */
  readonly evidence?: PlatformSupportEvidence;
  /** Burn-in metadata; present ONLY on a `supported` row. */
  readonly qualification?: PlatformQualification;
  /** Human rationale for the row's status. */
  readonly notes: string;
}

// ---------------------------------------------------------------------------
// Observation + assessment vocabulary
// ---------------------------------------------------------------------------

/**
 * A collected view of a host. Every normative dimension may be absent — a host
 * collector fills what it can prove; an absent dimension is `unobserved`, never
 * a guessed value.
 */
export interface ObservedHost {
  /** `process.platform`, e.g. `darwin`, `linux`, `win32`. */
  readonly osPlatform?: string;
  /** Product version, e.g. `26.0.1` (`sw_vers -productVersion`). */
  readonly osVersion?: string;
  /** Kernel name, e.g. `Darwin`. */
  readonly kernelName?: string;
  /** Kernel release, e.g. `25.5.0` (`uname -r`). */
  readonly kernelRelease?: string;
  /** `process.arch`, e.g. `arm64`, `x64`. */
  readonly arch?: string;
  /** `process.version`, e.g. `v24.16.0`. */
  readonly nodeVersion?: string;
  /** `process.versions.modules`, e.g. `137`. */
  readonly nodeAbi?: string;
  /** npm version, e.g. `11.0.0`. */
  readonly npmVersion?: string;
  /** Run-root filesystem type, e.g. `apfs`. */
  readonly filesystemType?: string;
  /** Run-root case behavior; `false` = case-insensitive. */
  readonly caseSensitive?: boolean;
  /** Install-channel id used for the candidate under test. */
  readonly installChannel?: string;
}

/** Stable, kebab-case identifiers for the normative tuple dimensions. */
export type PlatformDimension =
  | 'os-platform'
  | 'os-version'
  | 'kernel-name'
  | 'kernel-version'
  | 'arch'
  | 'node-major'
  | 'node-abi'
  | 'npm-major'
  | 'filesystem-type'
  | 'case-sensitivity'
  | 'install-channel';

/** Stable, kebab-case reason codes emitted when a host is not the exact tuple. */
export type PlatformMismatchReason =
  | 'non-macos-host'
  | 'insufficient-host-facts'
  | 'macos-intel-unsupported'
  | 'os-platform-mismatch'
  | 'os-version-mismatch'
  | 'kernel-name-mismatch'
  | 'kernel-version-mismatch'
  | 'arch-mismatch'
  | 'node-major-mismatch'
  | 'node-abi-mismatch'
  | 'npm-major-mismatch'
  | 'filesystem-type-mismatch'
  | 'case-sensitivity-mismatch'
  | 'install-channel-mismatch';

/** Degree to which an observed host matches the returned row's tuple. */
export type PlatformMatchLevel = 'exact' | 'partial' | 'none';

/** The pure result of classifying an observed host against the registry. */
export interface HostSupportAssessment {
  readonly status: PlatformSupportStatus;
  /** The registry row the host was classified against, when one applies. */
  readonly row?: PlatformSupportRow;
  readonly match: PlatformMatchLevel;
  /** Normative dimensions that were present in the observation. */
  readonly observed: readonly PlatformDimension[];
  /** Normative dimensions that were absent from the observation. */
  readonly unobserved: readonly PlatformDimension[];
  /** Stable mismatch/classification reason codes (empty on a clean match). */
  readonly reasonCodes: readonly PlatformMismatchReason[];
}

/** The reliably process-observable host facts (no shell/npm/filesystem probes). */
export interface RuntimeHostFacts {
  /** `process.platform`. */
  readonly platform?: string;
  /** `process.arch`. */
  readonly arch?: string;
  /** `process.version`. */
  readonly nodeVersion?: string;
  /** `process.versions.modules`. */
  readonly nodeAbi?: string;
}

/**
 * A support projection built only from process-observable facts. It can NEVER be
 * an exact match because npm, filesystem, case behavior, OS product version,
 * kernel name/release, and install channel are unobserved at runtime. This
 * projection performs no shell probe. Both the CLI and MCP surfaces call
 * `projectRuntimeHostSupport` with explicit facts.
 */
export interface RuntimeHostSupportProjection {
  readonly status: PlatformSupportStatus;
  /** Runtime projections are `partial` or `none`; never `exact`. */
  readonly match: 'partial' | 'none';
  readonly rowId: string | null;
  readonly rowStatus: PlatformSupportStatus | null;
  readonly profile: PlatformSupportProfileRef | null;
  readonly docsUrl: string | null;
  readonly reasonCodes: readonly PlatformMismatchReason[];
  readonly observed: readonly PlatformDimension[];
  readonly unobserved: readonly PlatformDimension[];
}

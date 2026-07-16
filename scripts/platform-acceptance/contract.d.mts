/**
 * Type declarations for the installed-artifact platform-acceptance contract.
 *
 * The runtime lives in `contract.mjs`; this file is the SINGLE source of type
 * truth for the module (the repo has `allowJs` off, so TS consumers resolve
 * types from this declaration, not from JSDoc). Keep types here, prose there.
 *
 * This contract defines the closed, fail-closed vocabulary for platform
 * acceptance evidence: an OS-neutral `AcceptanceProfile` selects journeys and
 * bounds; a run produces one versioned `AcceptanceEvidence` artifact that an
 * independent verifier can revalidate and re-digest without trusting any claim
 * the runner printed to a console.
 */

export const PLATFORM_ACCEPTANCE_SCHEMA_VERSION: 1;
export type PlatformAcceptanceCapability =
  'pty' | 'symlink' | 'permissions' | 'process-tree-rss' | 'process-tree-cleanup';
export const PLATFORM_ACCEPTANCE_CAPABILITIES: readonly PlatformAcceptanceCapability[];

/**
 * Every journey lands in exactly one of these states. `required` journeys pass
 * the profile only with `pass`; `skipped` and `unavailable` never masquerade as
 * proof. `reasonCode` is preserved separately so success is never inferred from
 * an exit code alone.
 */
export type JourneyStatus = 'pass' | 'fail' | 'skipped' | 'unavailable';

/** Overall run verdict. `infrastructure-fault` means evidence is untrustworthy. */
export type AcceptanceVerdict = 'pass' | 'fail' | 'infrastructure-fault';

/** Closed origin of one terminal child-process observation. */
export type JourneyStepStage = 'process' | 'lifecycle' | 'mcp';

/** The two trusted candidate forms. No arbitrary npm spec, URL, or branch. */
export type CandidateKind = 'packed-release' | 'published-version';

/**
 * A resident-set-size measurement is a tagged value. `available` requires a
 * finite, non-negative peak; `unavailable` carries a bounded stable reason.
 * Bare `0`/`undefined` never counts as a measurement.
 */
export type RssMeasurement =
  | { readonly status: 'available'; readonly peakBytes: number }
  | { readonly status: 'unavailable'; readonly reasonCode: string };

/** A host fact that may be genuinely uncollectable on this host. */
export type HostFact<T> = T | { readonly status: 'unavailable'; readonly reasonCode: string };

/** One journey selection inside a data-only profile. */
export interface ProfileJourneySelection {
  readonly id: string;
  readonly required: boolean;
  readonly capabilities?: readonly PlatformAcceptanceCapability[];
  /**
   * Candidate forms for which this row is executable. Omission means both
   * closed candidate kinds. A non-applicable row is preserved as an explicit,
   * non-required `skipped` result rather than being removed from the profile.
   */
  readonly candidateKinds?: readonly CandidateKind[];
}

/** All numeric bounds a run enforces. Every value must be a positive integer. */
export interface AcceptanceBounds {
  readonly journeyTimeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxDiagnosticTailBytes: number;
  readonly rssSampleIntervalMs: number;
  readonly maxEvidenceBytes: number;
  readonly maxJourneyResults: number;
}

/** Closed hard limits applied before a data-only profile can drive the runner. */
export const PLATFORM_ACCEPTANCE_BOUND_LIMITS: Readonly<{
  [Key in keyof AcceptanceBounds]: Readonly<{ min: number; max: number }>;
}>;

/** Digest-bound reference to a known base profile for OS-specific composition. */
export interface ProfileBaseRef {
  readonly id: string;
  readonly digest: string;
}

/**
 * Optional binding to the platform-support contract. Pins the profile to a
 * platform-support contract version + support-row id so acceptance evidence can
 * never match a different public support claim. Part of the profile digest.
 */
export interface ProfileSupportRowBinding {
  readonly contractVersion: number;
  readonly rowId: string;
}

/** The data-only acceptance profile loaded from `.config/platform-acceptance/*.json`. */
export interface AcceptanceProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: number;
  readonly base?: ProfileBaseRef;
  readonly requiredCapabilities: readonly PlatformAcceptanceCapability[];
  readonly rssRequired: boolean;
  readonly bounds: AcceptanceBounds;
  readonly journeys: readonly ProfileJourneySelection[];
  readonly supportRow?: ProfileSupportRowBinding;
}

/** Resolved, redacted identity of the exact bytes under test. */
export interface CandidateIdentity {
  readonly kind: CandidateKind;
  readonly version: string;
  /** Human-readable, credential-free description of where the bytes came from. */
  readonly source: string;
  /** Manifest/checksum digest (packed) or version identity (published). */
  readonly digest: string;
  /** Canonical HTTPS registry origin + pathname; never contains credentials. */
  readonly registry?: string;
  /** Exact release-manifest SHA-256 when the candidate is release-bound. */
  readonly manifestDigest?: string;
  /** Exact registry-integrity inventory SHA-256 for a published candidate. */
  readonly registryIntegrityDigest?: string;
}

/** Workflow/runner identity bound into the standalone evidence artifact. */
export interface AcceptanceExecutionIdentity {
  readonly runId: string;
  readonly runAttempt: number;
  readonly runnerLabel: string;
}

/** Lifecycle facts independently cross-checked against candidate identities. */
export interface AcceptanceLifecycleEvidence {
  readonly installedVersion: string | null;
  readonly upgradedVersion: string | null;
  readonly versionMigrated: boolean | null;
  readonly stateMigrated: boolean | null;
  readonly cliStateRemoved: boolean | null;
  readonly packageRemoved: boolean | null;
  /** Install path used for the primary target; absent only on legacy v1 evidence. */
  readonly targetInstallChannel?: 'canonical-installer' | 'npm-direct' | 'packed-consumer' | null;
  /** Bounded wall time spent on candidate-integrity boundary observations. */
  readonly integrityChecks?: {
    readonly count: number;
    readonly durationMs: number;
  };
}

/**
 * Independently re-verifiable proof that one isolated npm install consumed a
 * projection of the retained canonical registry inventory. Package names stay
 * in inventory order; the verifier resolves those rows and recomputes the set
 * digest instead of trusting the runner's success claim.
 */
export interface RegistryInstallBindingEvidence {
  readonly inventoryDigest: string;
  readonly packageNames: readonly string[];
  readonly packageCount: number;
  readonly packageSetDigest: string;
  readonly offlineReplayComplete: true;
}

/** Published qualification binds lifecycle and canonical facets to one target. */
export interface AcceptanceRegistryBindingsEvidence {
  readonly candidateLifecycle: RegistryInstallBindingEvidence | null;
  readonly canonicalInstaller: RegistryInstallBindingEvidence | null;
}

export interface FilesystemFacts {
  readonly type: HostFact<string>;
  readonly caseSensitive: HostFact<boolean>;
}

/** Availability of each declared native probe, keyed by capability id. */
export interface HostCapabilities {
  readonly pty?: boolean;
  readonly symlink?: boolean;
  readonly permissions?: boolean;
  readonly 'process-tree-rss'?: boolean;
  readonly 'process-tree-cleanup'?: boolean;
}

/** Bounded, secret-free native host facts. */
export interface HostProfile {
  readonly platform: string;
  readonly arch: string;
  readonly osRelease: HostFact<string>;
  readonly osVersion: HostFact<string>;
  readonly nodeVersion: string;
  readonly nodeModuleAbi: string;
  readonly npmVersion: HostFact<string>;
  readonly packageManager: HostFact<string>;
  readonly cpuModel: HostFact<string>;
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
  readonly filesystem: FilesystemFacts;
  readonly shell: HostFact<string>;
  /** macOS product version from `/usr/bin/sw_vers -productVersion` (darwin-only). */
  readonly swVers: HostFact<string>;
  /** Darwin kernel release from `/usr/bin/uname -r` (darwin-only). */
  readonly kernelRelease: HostFact<string>;
  /** Machine architecture from `/usr/bin/uname -m` (darwin-only). */
  readonly unameArch: HostFact<string>;
  readonly capabilities: HostCapabilities;
}

/**
 * One bounded terminal child-process observation. It deliberately contains no
 * argv, environment, command, cwd, package path, or executable path.
 */
export interface JourneyStepEvidence {
  /** Stable, non-secret kebab-case label (for example `process-1`). */
  readonly label: string;
  readonly stage: JourneyStepStage;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Signal the harness intentionally delivered, when a journey probes native signal identity. */
  readonly deliveredSignal?: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly outputTruncated: boolean;
  readonly durationMs: number;
  readonly rss: RssMeasurement;
  readonly residualDescendants: number;
  readonly reasonCode: string | null;
  readonly diagnostics: readonly string[];
}

/** One journey outcome inside the ordered results array. */
export interface JourneyResult {
  readonly id: string;
  readonly category: string;
  readonly required: boolean;
  readonly status: JourneyStatus;
  readonly reasonCode: string | null;
  readonly durationMs: number;
  readonly rss: RssMeasurement;
  /** Bounded diagnostic tails; never full output, never credentials/paths. */
  readonly diagnostics: readonly string[];
  /**
   * Present on evidence produced by the completed v1 runner. Optional only so
   * an early v1 artifact can still be parsed/digested; the independent verifier
   * rejects a required passing result that omits or empties this array.
   */
  readonly steps?: readonly JourneyStepEvidence[];
}

/** Result of the run-owned cleanup step. */
export interface CleanupResult {
  readonly status: 'clean' | 'incomplete';
  readonly reasonCode: string | null;
  readonly removedRoots: number;
  readonly residualDescendants: number;
}

/** Terminal record appended only after cleanup; a verifier rejects its absence. */
export interface CompletionRecord {
  readonly state: 'completed' | 'infrastructure-fault';
  readonly evidenceDigest: string;
}

/** Deterministic count summary derived from results. */
export interface EvidenceSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly unavailable: number;
  readonly requiredTotal: number;
  readonly requiredPassed: number;
}

export interface EvidenceProfileRef {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}

/** The one authoritative, versioned evidence artifact. */
export interface AcceptanceEvidence {
  readonly schemaVersion: 1;
  readonly profile: EvidenceProfileRef;
  readonly candidate: CandidateIdentity;
  /** Exact upgrade source, or null for a bootstrap/self-reinstall run. */
  readonly previousCandidate: CandidateIdentity | null;
  readonly execution: AcceptanceExecutionIdentity;
  readonly lifecycle: AcceptanceLifecycleEvidence;
  /** Null proofs for packed candidates; published proofs are verifier-gated. */
  readonly registryBindings?: AcceptanceRegistryBindingsEvidence;
  readonly harnessGitSha: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly host: HostProfile;
  readonly results: readonly JourneyResult[];
  readonly cleanup: CleanupResult;
  readonly summary: EvidenceSummary;
  readonly verdict: AcceptanceVerdict;
  readonly completion: CompletionRecord;
}

/** A closed, machine-readable failure raised by contract parsing/composition. */
export interface ContractError extends Error {
  readonly reasonCode: string;
}

export function parseAcceptanceProfile(input: unknown): AcceptanceProfile;
export function parseAcceptanceEvidence(input: unknown): AcceptanceEvidence;

/**
 * Compose an OS-specific derived profile over a validated base. Additive only:
 * may add journeys/capabilities, strengthen optional→required, and tighten
 * bounds. New journeys may be interleaved, but base journeys must remain an
 * ordered subsequence. Rejects removal/reorder, weaker bounds,
 * required→optional downgrade, base-digest mismatch, unknown/cyclic base ids.
 */
export function composeProfile(
  base: AcceptanceProfile,
  derived: unknown,
  options?: { readonly knownBaseIds?: readonly string[] },
): AcceptanceProfile;

/** Stable, key-sorted canonical JSON for any JSON-serializable value. */
export function canonicalize(value: unknown): string;

/** sha256 hex digest of the canonical form of `value`. */
export function digestOf(value: unknown): string;

/** Recompute the profile identity digest (over the profile sans `base` proof). */
export function profileDigest(profile: AcceptanceProfile): string;

/** Derive the deterministic summary from ordered journey results. */
export function computeSummary(
  profile: AcceptanceProfile,
  results: readonly JourneyResult[],
): EvidenceSummary;

/** Upgrade is dynamically required whenever an exact previous candidate exists. */
export function isJourneyRequired(
  journey: ProfileJourneySelection,
  previousCandidate: CandidateIdentity | null,
): boolean;

/** Whether a profile row applies to the exact primary candidate form. */
export function isJourneyApplicable(
  journey: ProfileJourneySelection,
  candidateKind: CandidateKind,
): boolean;

/** Derive the overall verdict from a profile + results (before completion). */
export function computeVerdict(
  profile: AcceptanceProfile,
  results: readonly JourneyResult[],
  cleanup: CleanupResult,
): AcceptanceVerdict;

/** Digest of evidence with its `completion` record stripped (the sealed body). */
export function evidenceDigest(evidence: Omit<AcceptanceEvidence, 'completion'>): string;

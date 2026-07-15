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

/**
 * Every journey lands in exactly one of these states. `required` journeys pass
 * the profile only with `pass`; `skipped` and `unavailable` never masquerade as
 * proof. `reasonCode` is preserved separately so success is never inferred from
 * an exit code alone.
 */
export type JourneyStatus = 'pass' | 'fail' | 'skipped' | 'unavailable';

/** Overall run verdict. `infrastructure-fault` means evidence is untrustworthy. */
export type AcceptanceVerdict = 'pass' | 'fail' | 'infrastructure-fault';

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
  readonly capabilities?: readonly string[];
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
  readonly requiredCapabilities: readonly string[];
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
  /** Registry host only; never contains credentials. */
  readonly registry?: string;
}

export interface FilesystemFacts {
  readonly type: HostFact<string>;
  readonly caseSensitive: HostFact<boolean>;
}

/** Availability of each declared native probe, keyed by capability id. */
export interface HostCapabilities {
  readonly [capability: string]: boolean;
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
 * bounds. Rejects removal/override, weaker bounds, required→optional downgrade,
 * base-digest mismatch, unknown/cyclic base ids.
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

/** Derive the overall verdict from a profile + results (before completion). */
export function computeVerdict(
  profile: AcceptanceProfile,
  results: readonly JourneyResult[],
  cleanup: CleanupResult,
): AcceptanceVerdict;

/** Digest of evidence with its `completion` record stripped (the sealed body). */
export function evidenceDigest(evidence: Omit<AcceptanceEvidence, 'completion'>): string;

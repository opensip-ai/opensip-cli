/**
 * Type declarations for the platform-acceptance common journey catalog.
 *
 * The runtime lives in `journey-catalog.mjs` + `journey-kit.mjs` + the domain
 * modules under `journeys/`; this file is the SINGLE source of type truth AND
 * the authoritative HANDOFF CONTRACT for Phase 3. Phase 3 implements the
 * injected ports (`MeasuredProcessPort`, `McpClientPort`) and the journey
 * runner to match `JourneyExecutorContext` VERBATIM — nothing a journey
 * executor reads may fall outside the surface declared here.
 *
 * Design invariants:
 *   - A journey is a closed, frozen registry row keyed by a stable id. Profiles
 *     (data) select ids; they can never inject argv, environment keys, or code.
 *   - A journey executor receives ONLY the surface on `JourneyExecutorContext`.
 *     It never spawns a process, resolves a binary, or reads ambient `process.env`
 *     — every child runs through the injected measured-process port, and every
 *     MCP session through the injected MCP client port.
 *   - An executor returns a bounded `JourneyOutcome`; the runner stamps
 *     `id`/`category`/`required`/`durationMs`/`rss` onto the contract's
 *     `JourneyResult`. `rss` is a tagged measurement (see `contract.d.mts`).
 */

import type { Scenario } from '../cli-acceptance-core.mjs';

/** Every journey lands in exactly one status (mirrors the contract). */
export type JourneyStatus = 'pass' | 'fail' | 'skipped' | 'unavailable';

/**
 * The closed native-capability vocabulary a journey may declare. A journey that
 * declares a capability the host lacks becomes an explicit `unavailable` result
 * (produced by the runner), never an omitted row.
 */
export type JourneyCapability = 'pty' | 'symlink' | 'permissions';

/** Tagged resident-set-size measurement (identical to the contract's shape). */
export type RssMeasurement =
  | { readonly status: 'available'; readonly peakBytes: number }
  | { readonly status: 'unavailable'; readonly reasonCode: string };

/** The two verified installed descriptors carried unchanged from lifecycle.installed. */
export interface InstalledBinDescriptor {
  readonly kind: 'installed-bin';
  readonly bin: string;
}
export interface JsEntrypointDescriptor {
  readonly kind: 'node-script';
  readonly script: string;
}

/**
 * The immutable installed-candidate view a journey may read. It is a read-only
 * projection of `CandidateLifecycle.installed`: the two descriptors plus the
 * resolved identity facts a journey legitimately asserts against.
 */
export interface InstalledCandidateView {
  readonly mode: 'packed-release' | 'published-version';
  readonly installedBin: InstalledBinDescriptor;
  readonly jsEntrypoint: JsEntrypointDescriptor;
  /** The version the installed package.json reports, or null when uncaptured. */
  readonly resolvedVersion: string | null;
}

/** Run-owned, writable paths a journey may use. All are descendants of the run root. */
export interface JourneyPaths {
  /**
   * The working root the runner assigned to THIS journey. For journeys that
   * share initialized project/session state (declared `isolated: false`) the
   * runner reuses one primary project root across the serial group; for
   * `isolated: true` journeys it is a fresh, journey-owned root.
   */
  readonly workRoot: string;
}

/** Packed fixture tarball paths produced once per run by `fixture-packages.mjs`. */
export interface JourneyFixtures {
  readonly toolPluginTarball: string;
  readonly fitPackTarball: string;
  readonly simPackTarball: string;
}

/**
 * One measured child invocation. `argv[0]` is the executable (an installed
 * descriptor's `bin`, or the run's node for a `node-script` entrypoint); the
 * journey never discovers or resolves it — it is handed the resolved descriptor.
 * The bound fields (`timeoutMs`/`*Bytes`/`rssSampleIntervalMs`) default from the
 * active profile bounds when omitted.
 */
export interface MeasuredProcessRunSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Per-run overrides merged onto the port's deterministic, credential-free base env. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly rssSampleIntervalMs?: number;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  /**
   * Opt-in TTY seam. Honoured ONLY on a host the runner reports as `pty`-capable
   * (a `pty`-declaring journey is otherwise marked `unavailable` before it runs).
   * Omitted/false => piped, non-TTY stdio.
   */
  readonly pty?: boolean;
}

/** The bounded, redacted outcome of one measured child invocation. */
export interface MeasuredProcessResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly outputTruncated: boolean;
  readonly durationMs: number;
  readonly rss: RssMeasurement;
  /** Bounded, redacted stdout tail for diagnostics (never full output). */
  readonly stdoutTail: string;
  /** Bounded, redacted stderr tail for diagnostics (never full output). */
  readonly stderrTail: string;
  /** Full captured stdout up to `stdoutBytes` — the parse surface for `--json` assertions. */
  readonly stdoutCapture: string;
  /** Process-tree cleanup accounting for this invocation. */
  readonly cleanup: { readonly residualDescendants: number };
}

/** The injected measured-process port — the ONLY way a journey runs a child. */
export interface MeasuredProcessPort {
  run(spec: MeasuredProcessRunSpec): Promise<MeasuredProcessResult>;
  /**
   * The peak resident-set size across every child this port has driven, tagged
   * `available` once at least one child yields a real sample. The runner reads
   * this per journey; journeys never call it.
   */
  rssMeasurement(): RssMeasurement;
}

/** One live MCP stdio session, already through the `initialize` handshake. */
export interface McpClientHandle {
  serverVersion(): { readonly name: string; readonly version: string } | undefined;
  listTools(): Promise<{ readonly tools: ReadonlyArray<{ readonly name: string }> }>;
  callTool(input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }): Promise<unknown>;
  /** Bounded stderr accounting; stderr is NEVER parsed as protocol data. */
  stderrSummary(): { readonly bytes: number; readonly truncated: boolean };
  close(): Promise<void>;
}

/**
 * The injected MCP client port. `connect` launches the MCP child via the
 * installed `jsEntrypoint` (`node <jsEntrypoint> mcp --cwd <cwd>`), performs the
 * initialize handshake, and returns a ready handle. The journey supplies only a
 * run-owned project `cwd` (and optional literal env overrides).
 */
export interface McpClientPort {
  connect(spec: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  }): Promise<McpClientHandle>;
}

/** A `SpawnResult`-shaped view a `MeasuredProcessResult` adapts to for `checkScenario`. */
export interface AssertableResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Bounded, side-effect-free assertion helpers reused from the acceptance core. */
export interface JourneyAssertHelpers {
  /** Adapt a measured result to the `{stdout,stderr,exitCode}` shape `checkScenario` reads. */
  toAssertable(result: MeasuredProcessResult): AssertableResult;
  /** Run a `checkScenario`-style expectation block; returns failure messages ([] = pass). */
  check(result: MeasuredProcessResult, expect: Scenario['expect']): string[];
  /** Shape-assert a `--json` Signal envelope (schemaVersion 2, tool, signals[]). */
  envelope(options?: { readonly tool?: string }): (parsed: unknown) => string[];
  /** Bounded, redacted diagnostic line (caps length; strips control characters). */
  diagnostic(text: string): string;
}

/**
 * The complete, closed surface handed to a journey executor. A journey reads
 * NOTHING outside this object — no ambient env, no spawn, no binary resolution.
 */
export interface JourneyExecutorContext {
  readonly installed: InstalledCandidateView;
  readonly paths: JourneyPaths;
  /** `null` when fixture packing failed; fixture-using journeys are gated off first. */
  readonly fixtures: JourneyFixtures | null;
  readonly process: MeasuredProcessPort;
  /** Present only for journeys in the `mcp` category. */
  readonly mcp?: McpClientPort;
  readonly assert: JourneyAssertHelpers;
}

/** The bounded outcome an executor returns; the runner adds id/category/required/duration/rss. */
export interface JourneyOutcome {
  readonly status: JourneyStatus;
  /** kebab-case reason; required for a non-`pass` status, optional (null) for `pass`. */
  readonly reasonCode?: string | null;
  /** Bounded diagnostic tails; never secrets, credentials, or absolute host paths. */
  readonly diagnostics: readonly string[];
}

/** A short, bounded human/agent value statement for a journey. */
export interface JourneyValue {
  readonly human: string;
  readonly agent: string;
}

/** One bounded, declarative step-plan entry (documents what the journey does). */
export interface JourneyStepPlanEntry {
  readonly label: string;
}

/**
 * Parameters used to materialize a command-only journey's ordered scenario steps
 * for BOTH the async executor and the synchronous release-smoke projection.
 */
export interface CommandStepParams {
  readonly cwd: string;
  readonly expectedVersion: string;
  /** `undefined` when fixture packing failed; a fixture-free command journey ignores it. */
  readonly toolPluginTarball: string | undefined;
  /** `undefined` when fixture packing failed; a fixture-free command journey ignores it. */
  readonly fitPackTarball: string | undefined;
}

/** One declarative command step shared by the executor and the smoke projection. */
export interface CommandStepSpec {
  /** Stable, unique step slug within its journey. */
  readonly slug: string;
  /** Human sentence (preserved verbatim from the historical packed-smoke scenario name). */
  readonly name: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeout?: number;
  readonly setup?: (context: { readonly cwd: string }) => void;
  readonly expect: Scenario['expect'];
}

/** A frozen catalog row. Registration rejects duplicate ids and unknown capabilities. */
export interface AcceptanceJourney {
  readonly id: string;
  readonly category: string;
  readonly value: JourneyValue;
  readonly capabilities: readonly JourneyCapability[];
  readonly steps: readonly JourneyStepPlanEntry[];
  /** True when the runner may parallelize this journey (it owns all its state). */
  readonly isolated: boolean;
  /**
   * True for journeys the runner produces from its `CandidateLifecycle`
   * orchestration (install / upgrade / cli-state removal / package removal)
   * rather than by calling `executor`. `executor` remains a fail-closed fallback
   * (it returns `unavailable`, never a false `pass`).
   */
  readonly lifecycleDriven: boolean;
  /** Command-only journeys expose their shared step source; the projection reads it. */
  readonly commandSteps?: (params: CommandStepParams) => readonly CommandStepSpec[];
  readonly executor: (context: JourneyExecutorContext) => Promise<JourneyOutcome>;
}

/** The closed registry: id -> frozen journey row. */
export type JourneyRegistry = ReadonlyMap<string, AcceptanceJourney>;

export const JOURNEY_REGISTRY: JourneyRegistry;
export const KNOWN_CAPABILITIES: ReadonlySet<JourneyCapability>;

/** The explicit common-v1 selection (all 46 ids, in profile order). */
export const COMMON_V1_JOURNEY_IDS: readonly string[];
/** The macOS-specific ids the macOS profile adds on top of common-v1 (spec §8). */
export const MACOS_JOURNEY_IDS: readonly string[];
/** The explicit release-smoke selection (command-only subset, in projection order). */
export const RELEASE_SMOKE_JOURNEY_IDS: readonly string[];

/** Look up a registered journey by id (throws on an unregistered id). */
export function getJourney(id: string, registry?: JourneyRegistry): AcceptanceJourney;

/**
 * Resolve a profile's selected ids to their frozen registry rows, in profile
 * order. Throws on an id the registry does not know (a profile can never
 * reference an unregistered journey).
 */
export function resolveProfileJourneys(
  ids: readonly string[],
  registry?: JourneyRegistry,
): readonly AcceptanceJourney[];

/**
 * Project the release-smoke journeys into the ordered `Scenario[]` the packed
 * smoke runs. The scenarios ARE the catalog source — each carries a stable
 * `id` (`<journeyId>#<stepSlug>`) so parity can be proven structurally.
 */
export function projectReleaseSmokeScenarios(params: CommandStepParams): Scenario[];

/**
 * Assert that every scenario maps to a registered release-smoke journey and that
 * the projected set matches the catalog source exactly (no hand-authored drift).
 * Throws with a bounded message on any mismatch.
 */
export function assertReleaseSmokeParity(
  scenarios: readonly Scenario[],
  params: CommandStepParams,
): void;

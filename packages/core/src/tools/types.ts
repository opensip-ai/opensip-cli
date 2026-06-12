// @fitness-ignore-file file-length-limit -- the canonical Tool plugin contract: one cohesive interface (metadata, commands, commandSpecs, initialize, contributeScope, collectDashboardData, config, capabilityRegistrars, sessionReplay) whose every member carries load-bearing JSDoc. The slots are the contract surface; splitting the single interface across files would fragment the one type tools implement. Grew past the 400-line soft limit with the 2.10.0 config + capability slots (ADR-0023 / §5.3).
/**
 * Tool plugin contract.
 *
 * A Tool is a self-contained capability (fitness, simulation, future
 * audit/lint/etc.) that contributes one or more CLI subcommands. The
 * CLI is a generic dispatcher that walks the registered tool list and
 * mounts each tool's declared `commandSpecs`.
 *
 * Tools are first-party (declared as a direct dep of opensip-tools)
 * or third-party (any npm package whose package.json declares
 * `opensipTools.kind === 'tool'` — discovered via tool-package-discovery).
 *
 * Contract:
 *   - `commands[]` carries metadata only (name + description, used for
 *     `--help` listings and conflict detection).
 *   - The actual subcommand wiring is host-owned: the tool declares typed
 *     `commandSpecs` and the host's `mountCommandSpec` mounts each one
 *     (3.0.0 GA — `register()` and the raw-Commander `program` handle were
 *     removed; "one command surface", §8).
 *
 * The two-field shape (commands[] for metadata; commandSpecs for the typed
 * command surface) keeps `--help` discovery cheap (no per-tool Commander
 * invocation required to enumerate available commands) while the host owns
 * the full option-parsing / output / error pipeline for every command.
 */

import { ToolError, type ToolErrorOptions } from '../lib/errors.js';

import type { CapabilityRegistrar, ToolConfigContribution } from './capability.js';
import type { CommandSpec } from './command-spec.js';
import type { ToolShortId } from './ids.js';
import type { FingerprintStrategy } from '../baseline/fingerprint-strategy.js';
import type { Logger } from '../lib/logger.js';
import type { ScopeContribution, ToolScope } from '../lib/scope-types.js';
import type { PluginLayout } from '../plugins/types.js';
import type { Signal } from '../types/signal.js';

// `ToolScope` (the Tool-facing scope view) and `ScopeContribution` (the
// augmentable subscope bag a tool returns from `contributeScope`) live in
// the leaf `lib/scope-types.ts`. The `Tool` contract depends on those
// abstractions, never on the concrete `RunScope`, so there is no
// `tools/types.ts → lib/run-scope.ts` edge — the former RunScope⟷Tool
// type cycle is gone (audit 2026-05-29, M4). A plain top-level
// `import type` is safe: scope-types is a leaf with no edge back here.

/** Static descriptor for a tool plugin: id, semver, and one-line description. */
export interface ToolMetadata {
  /** Stable identifier — e.g. 'fitness', 'simulation'. */
  readonly id: string;
  readonly version: string;
  readonly description: string;
}

/**
 * Identity of a command a tool contributes — used for --help, plugin
 * listings, and conflict detection across tools. The actual handler is
 * wired up by the tool's `commandSpecs` (mounted by the host).
 */
export interface ToolCommandDescriptor {
  /** CLI subcommand name — 'fit', 'sim', 'fit-list', etc. */
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
}

/** Generic stored-session shape accepted by tool replay hooks.
 *
 * This mirrors `@opensip-tools/contracts` `StoredSession` structurally without
 * importing contracts into core. The CLI passes hydrated session-store rows;
 * tools narrow their opaque payloads inside their own replay builders.
 */
export interface ToolSessionRecord {
  readonly id: string;
  readonly tool: ToolShortId;
  readonly timestamp: string;
  readonly cwd: string;
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly payload?: unknown;
}

/** Optional tool contribution for host-owned `sessions show` replay. */
export interface ToolSessionReplayContribution {
  readonly tool: ToolShortId;
  readonly replaySession: (stored: ToolSessionRecord) => unknown;
}

/**
 * Renderer signature for a tool-contributed live view. The CLI looks up
 * the registered renderer by key when a tool calls
 * `ToolCliContext.renderLive(key, args)` and invokes it with the tool's
 * args payload.
 *
 * Renderers are tool-specific. They typically wrap an Ink `render(...)`
 * call against a stateful component (FitView, GraphView) and resolve
 * once the underlying Ink app exits.
 *
 * The `args` parameter is `unknown` at the contract layer because each
 * tool defines its own args shape; tools narrow the type inside their
 * own renderer body via a runtime cast.
 */
export type LiveViewRenderer = (args: unknown) => Promise<void>;

/**
 * Thrown by `ToolCliContext.renderLive(key, args)` when no renderer has
 * been registered for `key`. A typed throw is preferable to silently
 * falling back to a static render — the latter masked bugs where a tool
 * mistyped its view key.
 */
export class UnknownLiveViewError extends ToolError {
  readonly viewKey: string;

  constructor(viewKey: string, options?: ToolErrorOptions) {
    super(
      `No live view registered for key '${viewKey}'. The tool that owns '${viewKey}' must call cli.registerLiveView('${viewKey}', renderer) before its first live render (e.g. in a lazy setup hook).`,
      options?.code ?? 'UNKNOWN_LIVE_VIEW',
      options,
    );
    this.name = 'UnknownLiveViewError';
    this.viewKey = viewKey;
  }
}

/**
 * Result of the host baseline/ratchet compare seam (ADR-0036) — three full-object
 * buckets + the gate decision. Core declares this thin shape for the
 * {@link ToolCliContext.compareBaseline} return so `core` need not import
 * `@opensip-tools/output` (which owns the authoritative `GateCompareResult` used
 * by `diffBaseline`). The two are kept structurally in sync by a dedicated test
 * (`core ↔ output GateCompareResult must not diverge`).
 */
export interface GateCompareResult {
  /** Findings present now but not in the baseline (current ∖ baseline). */
  readonly added: readonly Signal[];
  /** Findings present in the baseline but not now (baseline ∖ current). */
  readonly resolved: readonly Signal[];
  /** Findings present in both (current ∩ baseline). */
  readonly unchanged: readonly Signal[];
  /** True iff `added` is non-empty — the gate decision. */
  readonly degraded: boolean;
}

/**
 * Outcome of the root's post-run signal delivery
 * ({@link ToolCliContext.deliverSignals}). Delivery stays best-effort and
 * non-blocking (ADR-0008) — this result exists so a caller (or a test) can
 * SURFACE what happened instead of the user silently assuming their signals
 * shipped. The root already prints the user-facing skip/failure notices; tools
 * may ignore the result entirely.
 */
export interface SignalDeliveryResult {
  /** Signals the cloud sink acknowledged (0 for the keyless/no-op majority). */
  readonly cloudAccepted: number;
  /**
   * Why an ACTIVE cloud sink accepted nothing, when knowable: `'unentitled'`
   * (the entitlement check said no) or `'error'` (the emit faulted). Omitted on
   * success and for the no-op sink (user opted out / no key — silence correct).
   */
  readonly cloudSkippedReason?: 'unentitled' | 'error';
  /** Whether a `--report-to` upload was attempted and succeeded. */
  readonly reportSuccess?: boolean;
  /** The `--report-to` target URL, when one was requested. */
  readonly reportUrl?: string;
}

/**
 * Context the host hands to each command handler (and the tool's optional
 * lifecycle hooks): the shared CLI behaviour a handler calls back into — Ink
 * rendering, machine-output emit seams, dashboard auto-open, structured logging,
 * per-run scope — without depending on the CLI package directly.
 *
 * 3.0.0 GA: this context carries NO Commander `program`. Tools declare
 * `commandSpecs` and the host mounts them (`mountCommandSpec`); a handler has no
 * raw-Commander handle to reach, so the "one command surface" invariant (§8) is
 * structural, not merely guarded. The host owns the program internally and passes
 * it to its own mount step (`mountAllToolCommands(registry, program, ctx)`).
 */
export interface ToolCliContext {
  /**
   * Per-run resources (logger, parseCache, registries, datastore,
   * recipeUnitConfig, projectContext). Constructed once per CLI
   * invocation by the bootstrap. Tools read every per-run resource
   * via `cli.scope.foo` — the previously-exported `defaultToolRegistry`
   * / `defaultLanguageRegistry` singletons are gone, and the Phase 5
   * `cli.project` / `cli.datastore` back-compat alias accessors were
   * retired in audit-round-3 Finding K once no tool referenced them
   * directly. Read `cli.scope.projectContext` and `cli.scope.datastore()`
   * instead.
   *
   * Typed as the Tool-facing `ToolScope` view (not the concrete
   * `RunScope`): everything tools read via `cli.scope.*`, minus the
   * `tools` registry tools never touch. This is what keeps the `Tool`
   * contract free of any `RunScope` reference (audit 2026-05-29, M4).
   */
  readonly scope: ToolScope;
  /** Render an Ink result (CommandResult shape from @opensip-tools/contracts). */
  readonly render: (result: unknown) => Promise<void>;
  /**
   * Register a renderer for a live, stateful view keyed by `key`. Tools
   * call this (lazily, from a setup hook on first live render) to contribute
   * their own Ink view (spinner → results transition); the CLI then dispatches
   * to the registered renderer when `renderLive(key, args)` is invoked.
   *
   * Registration is first-writer-wins, matching the policy used by
   * `ToolRegistry.register`. A duplicate key triggers a structured
   * `cli.live_view.duplicate` warning via the shared logger and the
   * second call is silently ignored.
   */
  readonly registerLiveView: (key: string, renderer: LiveViewRenderer) => void;
  /**
   * Render the live view registered under `key`, passing `args` through
   * to the registered renderer. Returns once the underlying Ink app
   * exits. Throws `UnknownLiveViewError` if no renderer has been
   * registered for `key` (rather than silently falling back to a static
   * render — the latter would mask bugs where a tool mistypes its view
   * key).
   *
   * `key` is a string instead of a typed enum so new tools can
   * contribute additional live views without touching the core type.
   */
  readonly renderLive: (key: string, args: unknown) => Promise<void>;
  /**
   * Open the HTML dashboard in the user's browser when the run
   * conditions allow it (TTY, not JSON-mode, opt-in). Tools call this
   * after a run to honor the user's --open flag.
   */
  readonly maybeOpenDashboard: (opts: {
    openRequested: boolean;
    jsonOutput: boolean;
  }) => Promise<void>;
  /** Shared structured logger. */
  readonly logger: Logger;
  /**
   * Process exit-code setter — tools call this instead of mutating
   * `process.exitCode` directly so the CLI controls the final exit.
   */
  readonly setExitCode: (code: number) => void;
  /**
   * Read the exit code set so far this run (`undefined` if none set yet). The
   * host always provides it; it is optional only so the many inline test
   * `ToolCliContext` stubs need not stub it. Used by gate COMPARE modes, which
   * set their baseline-diff exit upstream and must re-affirm it when the host's
   * `deliverSignals` would otherwise derive a findings exit from the run verdict
   * (ADR-0035).
   */
  readonly getExitCode?: () => number | undefined;
  /**
   * Emit a structured JSON value to the CLI's stdout. Centralises the
   * `process.stdout.write(JSON.stringify(value, null, 2) + '\n')` call
   * that every tool's `--json` mode would otherwise duplicate. The CLI
   * owns the IO seam; tools call `emitJson` and the CLI decides how the
   * value reaches the terminal.
   *
   * This is the **general-purpose JSON seam**, distinct from `emitEnvelope`
   * (below). Use it for `--json` output that is NOT a run-signal envelope:
   * auxiliary/list subcommands (`fit-list`, `fit-recipes`, `graph-lookup`,
   * `graph-symbol-index`), the `graph --workspace --json` report document,
   * and bare error objects (`{ error }`). The main analyze commands' run
   * output goes through `emitEnvelope` instead. Both are current, sanctioned
   * stdout seams — see the `no-direct-stdout-in-tool-engine` check, which
   * permits exactly `render` / `emitJson` / `emitEnvelope` / `deliverSignals`
   * / `writeSarif`.
   */
  readonly emitJson: (value: unknown) => void;
  /**
   * Emit a tool **run-signal envelope** as machine-output (ADR-0011). The
   * CLI composition root formats the envelope through the single shared
   * `formatSignalJson` formatter and writes it to stdout — so the `--json`
   * wire contract for a run lives in `@opensip-tools/output`, not
   * re-stringified per tool.
   *
   * This is the specialised seam for the **main analyze commands' run output**
   * (`fit`, `graph`, `sim`): they build a `SignalEnvelope` and call
   * `emitEnvelope`, where the older bespoke-JSON path used `emitJson(result)`
   * (the ADR-0011 Phase 4–6 migration, now complete). `emitJson` remains for
   * everything that is not a run envelope (see above) — the two seams are
   * complementary, not transitional.
   *
   * The value is the `SignalEnvelope` from `@opensip-tools/contracts`; it is
   * typed `unknown` here for the same reason `render`/`emitJson` are — the
   * `Tool` contract in core must not name the contracts-layer payload type
   * (that edge would invert the layer graph). The composition root narrows
   * it.
   */
  readonly emitEnvelope: (envelope: unknown) => void;
  /**
   * Emit a **structured error** as machine-output (release 2.12.0, §5.5). The
   * host wraps `{ message, exitCode, suggestion? }` in a `status:'error'`
   * `CommandOutcome` (`.errors`) through the single `renderOutcome` seam, and
   * threads `exitCode` to `setExitCode` so the process exit and the reported
   * outcome agree.
   *
   * This RETIRES the bare `emitJson({ error })` shape: a `--json` run that fails
   * before it can build an envelope (e.g. a config error) calls `emitError`
   * instead, so machine consumers read one outcome schema for success AND
   * failure. The `one-outcome-shape` guardrail forbids the bare shape.
   */
  readonly emitError: (detail: {
    readonly message: string;
    readonly exitCode: number;
    readonly suggestion?: string;
    /**
     * Optional machine-readable error category (e.g. `'not-found'`,
     * `'decode-error'`). The host surfaces it as the structured
     * `ErrorDetail.code` so machine consumers can branch on the failure kind
     * without parsing `message`.
     */
    readonly code?: string;
  }) => void;
  /**
   * Deliver a tool-run **signal envelope** to the effectful sinks the
   * composition root owns (ADR-0011 / ADR-0008): best-effort cloud sync via
   * the run's `scope.signalSink`, and — when `--report-to` is set — a SARIF
   * upload (which owns exit code 4). The tool builds the envelope and calls
   * this **once per run** after rendering / emitting; the root maps it to
   * `SignalBatch` (cloud) and `formatSignalSarif` (report-to). Awaitable so
   * egress completes before the short-lived CLI process exits.
   *
   * This replaces the per-tool `emitRunSignals` / `reportToCloud` calls the
   * engines make today — moving all egress to the root lets the engines drop
   * their `@opensip-tools/output` dependency (Phases 4–6). Best-effort: cloud
   * failures never throw and never affect the exit code; only a `--report-to`
   * failure on an otherwise-passing run sets exit 4. Resolves to a
   * {@link SignalDeliveryResult} stating what actually shipped (the root also
   * prints the user-facing skip/failure notices); callers may ignore it.
   *
   * `envelope` is the `SignalEnvelope` from `@opensip-tools/contracts`, typed
   * `unknown` here for the same layer reason as `render`/`emitEnvelope`.
   */
  readonly deliverSignals: (
    envelope: unknown,
    opts: {
      readonly cwd: string;
      readonly reportTo?: string;
      readonly apiKey?: string;
      readonly runFailed?: boolean;
    },
  ) => Promise<SignalDeliveryResult>;
  /**
   * Write a tool-run **signal envelope** to a SARIF v2.1.0 file (ADR-0011).
   * The composition root formats the envelope through the single shared
   * `formatSignalSarif` formatter and writes the bytes to `path` (creating
   * parent directories as needed). This is the root-owned SARIF-**file** sink
   * — distinct from `--report-to` (a network sink) and the cloud sync — so a
   * tool that exports SARIF to a file (e.g. `graph sarif-export`, the
   * cross-repo `EngineSubprocessPort.runSarifExport` contract) does it through
   * the root instead of importing `@opensip-tools/output` itself. Awaitable so
   * the write completes before the short-lived CLI process exits.
   *
   * `envelope` is the `SignalEnvelope` from `@opensip-tools/contracts`, typed
   * `unknown` here for the same layer reason as `render`/`emitEnvelope`/
   * `deliverSignals`.
   */
  readonly writeSarif: (envelope: unknown, path: string) => Promise<void>;
  /**
   * Host baseline/ratchet plane seams (ADR-0036). The host owns persistence
   * (`BaselineRepo`), the diff, and exit derivation; a tool inherits a CI ratchet
   * by emitting fingerprint-stamped signals. The seams are **read-only** of
   * `signal.fingerprint` — the tool stamps its envelope's signals
   * (`stampFingerprints`) at envelope-construction time; the plane NEVER
   * re-fingerprints. `tool` scopes every operation; `envelope` is the
   * `SignalEnvelope` typed `unknown` here for the same layer reason as
   * `writeSarif`/`deliverSignals`.
   */
  readonly saveBaseline: (tool: string, envelope: unknown) => Promise<void>;
  /**
   * Compare the current (stamped) envelope against this tool's saved baseline.
   * Throws a `ConfigurationError` (→ exit 2) when no baseline exists. The host
   * derives the gate exit from `result.degraded` via the `deliverSignals`
   * runFailed override — no tool calls `setExitCode` for the gate path (ADR-0035).
   */
  readonly compareBaseline: (tool: string, envelope: unknown) => Promise<GateCompareResult>;
  /**
   * Export this tool's baseline to a SARIF file by reconstructing a synthetic
   * envelope from the stored per-fingerprint payloads (no stored envelope to
   * reload). Throws when no baseline exists.
   */
  readonly exportBaselineSarif: (tool: string, path: string) => Promise<void>;
  /**
   * Export this tool's baseline as the git-trackable fingerprint JSON
   * (`{version,tool,capturedAt,fingerprints[]}`). Throws when no baseline exists.
   */
  readonly exportBaselineFingerprints: (tool: string, path: string) => Promise<void>;
}

/**
 * Tool error-handling contract.
 *
 * Tools have two paths for surfacing failure to the CLI dispatcher:
 *
 *   1. **Result-shaped return** — for expected business outcomes that
 *      callers may want to render with full UX (Ink, JSON, dashboard).
 *      Action handlers compute a `CommandResult` (`type: 'error'` is
 *      one variant) and pass it through `cli.render` / `cli.emitJson`,
 *      setting the exit code via `cli.setExitCode`. Both `simulation`
 *      and `graph` use this path for normal failures.
 *
 *   2. **Throw a `ToolError` subclass** — for unrecoverable / programmer
 *      conditions, or for known-error classes that the tool would
 *      rather let the central handler map to an exit code. The CLI's
 *      top-level `handleParseError` catches every `ToolError` that
 *      escapes a tool's action body and routes it through the
 *      canonical `mapToolErrorToExitCode` (in `@opensip-tools/contracts`).
 *
 * Which subclass to throw, by intent:
 *
 *   - `ConfigurationError` — bad user input / missing config / wrong
 *     flag combination. Exit code: `CONFIGURATION_ERROR` (2).
 *   - `ValidationError`    — a validated value failed an invariant.
 *     Exit code: `CONFIGURATION_ERROR` (2).
 *   - `NotFoundError`      — a named entity (check, recipe, scenario)
 *     does not exist. Exit code: `CHECK_NOT_FOUND` (3).
 *   - `NetworkError`       — remote call failed (e.g. `--report-to`).
 *     Exit code: `REPORT_FAILED` (4).
 *   - `TimeoutError`       — an operation exceeded its deadline.
 *     Exit code: `RUNTIME_ERROR` (1).
 *   - `SystemError`        — bootstrap-invariant violation or data
 *     corruption. Exit code: `RUNTIME_ERROR` (1).
 *   - bare `ToolError`     — any other tool failure. Exit code:
 *     `RUNTIME_ERROR` (1).
 *
 * Tools that need to catch their own `ToolError` locally (e.g. to
 * render in a non-Ink format) should still derive the exit code from
 * `mapToolErrorToExitCode` rather than hardcoding the constant — that
 * keeps a single source of truth for the policy.
 *
 * Plain `Error` instances thrown from a tool action body fall through
 * to the data-driven `getErrorSuggestion` substring matcher, then to a
 * generic `RUNTIME_ERROR`. Prefer the typed path.
 */

/**
 * Inputs the host hands a tool's `scaffoldExamples` hook (ADR-0038): the
 * project's detected/selected languages (and, optionally, the scaffolded check
 * slugs). `languages` is `string[]` — core carries no language enum; the CLI
 * passes its detected list through structurally.
 */
export interface ScaffoldContext {
  readonly languages: readonly string[];
  readonly slugs?: readonly string[];
}

/**
 * One example file a tool contributes to `init` (ADR-0038). The host writes
 * `content` to `userPluginDir(tool's domain, kind)/filename`. `kind` is a plain
 * string matched against the tool's own `pluginLayout.userSubdirs` (never a
 * host-side enum of `'checks'|'recipes'|…`). `stableId` is the pinned id embedded
 * in `content` that drives stale-scaffolded detection.
 */
export interface ScaffoldFile {
  readonly kind: string;
  readonly filename: string;
  readonly content: string;
  readonly stableId: string;
}

/**
 * The contract every first-party, installed, or project-local tool implements
 * (`fitness`, `simulation`, `graph`, …). A tool declares its metadata and
 * `commandSpecs` (the only command surface), and opts into host-owned planes via
 * optional hooks — session replay, capability discovery, fingerprinting, and the
 * `init`-scaffold seam (`pluginLayout` + `scaffoldExamples` + `stableExampleIds` +
 * `scaffoldConfigBlock`, ADR-0038). The host (`cli`) loads every tool through the
 * same dynamic-import plugin path; nothing here distinguishes a bundled tool from
 * an installed one (ADR-0027).
 */
export interface Tool {
  readonly metadata: ToolMetadata;
  /**
   * Metadata for every command this tool contributes. Used for --help
   * listings and conflict detection. Actual handlers are mounted by
   * register().
   */
  readonly commands: readonly ToolCommandDescriptor[];
  /**
   * Optional project-local plugin layout. Tools that support
   * user-authored / npm plugins under `<project>/opensip-tools/<domain>/`
   * declare `{ domain, userSubdirs }` here; the kernel's `discoverPlugins`
   * / `loadAllPlugins` and the CLI's `plugin` command read it instead of
   * hardcoding domain names (ADR-0009 corollary 1). Tools with no
   * project-local plugins (e.g. graph) leave this undefined.
   */
  readonly pluginLayout?: PluginLayout;
  /**
   * Declarative command surface (release 2.11.0, north-star §5.4). The
   * PREFERRED way a tool contributes commands: it returns one
   * {@link CommandSpec} per subcommand and the host's `mountCommandSpec`
   * (cli, Phase 1) translates each into a wired Commander command — the tool
   * never touches Commander. Specs are typed against the concrete host
   * {@link ToolCliContext} (the kernel's default `CommandContext` marker isn't
   * assignable to it), so a tool authors them via
   * `defineCommand<TOpts, ToolCliContext>(...)`.
   *
   * The host mounts each spec via `mountCommandSpec` (the ONLY command surface
   * as of 3.0.0 — `register()` was removed). A tool that declares no
   * `commandSpecs` contributes no commands (a mis-declaration the host surfaces
   * loudly via `cli.tool.no_command_surface`).
   *
   * Typed `CommandSpec<unknown, ToolCliContext>` (the kernel cannot name the
   * per-spec `TOpts`); the host's `mountCommandSpec` narrows each spec.
   */
  readonly commandSpecs?: readonly CommandSpec<unknown, ToolCliContext>[];
  /**
   * Optional one-time initialization. Called by the CLI before any of
   * the tool's commands run. Use it to register sub-packages (check
   * packs, scenario packs), language adapters, etc.
   *
   * The CLI calls initialize() at most once per process. Tools that
   * need lazy init (e.g. fitness, where ensureChecksLoaded is wired
   * deep into command handlers) can leave this undefined and run
   * setup inside their command handlers instead.
   */
  readonly initialize?: () => Promise<void>;
  /**
   * Optional per-run subscope contribution. Called by the CLI's
   * pre-action-hook AFTER constructing the per-invocation scope and
   * BEFORE `enterScope` makes it visible to tool action bodies. Each
   * registered tool is invoked once per CLI invocation; the kernel
   * `Object.assign`s the returned contribution onto the scope (D7: tool
   * subscopes via module augmentation).
   *
   * Inversion of control (audit 2026-05-29, M4): the tool RETURNS its
   * subscope rather than mutating a passed-in `RunScope`. This keeps the
   * `Tool` contract free of any `RunScope` reference (breaking the
   * RunScope⟷Tool type cycle) and removes shared-mutable-state from the
   * extension API.
   *
   * Tools augment `ScopeContribution` from their own package:
   *
   *   declare module '@opensip-tools/core' {
   *     interface ScopeContribution {
   *       simulation?: { scenarios: Registry<RunnableScenario>; ... };
   *     }
   *   }
   *
   * and return their slot here:
   *
   *   contributeScope() {
   *     return { simulation: { scenarios: new Registry(...), ... } };
   *   }
   *
   * The kernel never inspects the slot — it just installs it. Slots are
   * optional so a graph-only run carries no `scope.simulation`, and vice
   * versa. `ScopeContribution` is empty in core; every member arrives via
   * tool augmentation, and `ToolScope`/`RunScope` extend it for reads.
   *
   * Default behavior (when undefined): the tool contributes no subscope.
   * Fitness, today, carries no per-run subscope state and leaves this
   * undefined.
   */
  readonly contributeScope?: () => ScopeContribution;
  /**
   * Optional dashboard-data contribution (audit 2026-05-29, L2). The CLI
   * is the dashboard composition root: it gathers generic sessions, then
   * walks the tool registry calling this hook and merges each tool's
   * contribution into the dashboard input. A tool returns ITS OWN inputs
   * to the HTML report (fitness: check/recipe catalogs; graph: its
   * catalog) — keyed by the field names `generateDashboardHtml` consumes.
   *
   * Returns an opaque `Record<string, unknown>` so the kernel carries no
   * tool/dashboard vocabulary; the CLI `Object.assign`s it onto the
   * `DashboardInput`. Tools that contribute nothing leave this undefined.
   * Receives the Tool-facing `ToolScope` (datastore, projectContext, …).
   */
  readonly collectDashboardData?: (
    scope: ToolScope,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Optional session replay contribution. The CLI owns the generic
   * `sessions show` command, while each tool owns decoding its opaque
   * `StoredSession.payload` projection into renderable replay data.
   *
   * Core keeps the hook structural (`unknown` return) so it does not depend on
   * `@opensip-tools/contracts`; the CLI narrows the returned value at the
   * composition boundary.
   */
  readonly sessionReplay?: ToolSessionReplayContribution;
  /**
   * Optional namespaced config contribution (release 2.10.0, ADR-0023). A
   * tool owning a top-level block (`graph:`/`fitness:`/`simulation:`) declares
   * its Zod schema here as a `ToolConfigDeclaration` (from
   * `@opensip-tools/config`). The composition root composes every tool's
   * `config` into one strict whole-document schema, validates the config file
   * once before dispatch, and exposes the resolved config back via the scope.
   * Kernel-side {@link ToolConfigContribution} carrier (core carries no Zod);
   * the CLI narrows it. Undefined ⇒ no config block.
   */
  readonly config?: ToolConfigContribution;
  /**
   * Optional capability-domain registrars (release 2.10.0, §5.3), keyed by
   * domain id. A tool that DECLARES domains in its manifest
   * (`ToolPluginManifest.capabilities`) supplies the REAL registrar for each
   * here. The host registers each manifest domain with a deferred placeholder,
   * then replaces it via `CapabilityRegistry.setRegistrar` once this module
   * loads. The registrar registers a routed contribution into the tool's own
   * registry. Undefined ⇒ no declared domains.
   */
  readonly capabilityRegistrars?: Readonly<Record<string, CapabilityRegistrar>>;
  /**
   * Optional fingerprint strategy for the host-owned baseline/ratchet plane
   * (ADR-0036). Populates `Signal.fingerprint`; the plane treats the result
   * opaquely. Undefined ⇒ host `defaultFingerprintStrategy`. Stamping happens at
   * envelope construction: pass the SAME strategy as
   * `BuildEnvelopeInput.fingerprintStrategy` to `buildSignalEnvelope`
   * (`@opensip-tools/contracts`), which stamps every signal (host default when
   * omitted) so a built envelope is gate-ready by construction. This field is
   * the tool's DECLARATION of that identity for the plane's documentation and
   * future host consumers; the envelope builder is where it takes effect.
   * Changing a declared strategy is a deliberate, documented re-capture.
   */
  readonly fingerprintStrategy?: FingerprintStrategy;
  /**
   * Optional `init`-scaffold contribution (ADR-0038): the example files this tool
   * writes for a project, given its detected languages. The host writes each
   * returned file under `userPluginDir(<this tool's pluginLayout.domain>,
   * file.kind)/file.filename`. Undefined ⇒ this tool scaffolds no examples (e.g.
   * `graph`). The host owns the directory layout (from `pluginLayout.userSubdirs`)
   * + the document header + `targets:`; the tool owns the example bytes + ids.
   */
  readonly scaffoldExamples?: (ctx: ScaffoldContext) => readonly ScaffoldFile[];
  /**
   * The tool's COMPLETE set of stable example ids across EVERY language it can
   * scaffold — NOT just the languages in any one `ScaffoldContext`. Drives
   * stale-scaffolded detection (`file-classifier.ts`): a stale
   * `example-check-python.mjs` left in a now-TS-only project must still be
   * recognised, which needs the full id universe independent of the project's
   * currently-detected languages.
   */
  readonly stableExampleIds?: () => readonly string[];
  /**
   * Optional contribution of the tool's namespaced config block for the
   * scaffolded `opensip-tools.config.yml` (ADR-0038 Phase 3). Undefined ⇒ the host
   * renders the block from the tool's `ToolConfigDeclaration` defaults (or omits
   * it). The host always renders the document header + the `targets:` section.
   */
  readonly scaffoldConfigBlock?: () => string;
}

/**
 * Plugin export shape for npm packages whose package.json declares
 * `opensipTools.kind === 'tool'`. The package's main entry must export
 * a `tool` symbol of this shape.
 */
export interface ToolPluginExports {
  readonly tool: Tool;
}

// @fitness-ignore-file file-length-limit -- the canonical Tool plugin contract: one cohesive interface (metadata, commands, commandSpecs, initialize, contributeScope, collectReportData, config, capabilityRegistrars, sessionReplay, contractVersion) whose every member carries load-bearing JSDoc. The slots are the contract surface; splitting the single interface across files would fragment the one type tools implement. Grew past the 400-line soft limit with the config + capability slots (ADR-0023 / §5.3).
/**
 * Tool plugin contract.
 *
 * A Tool is a self-contained capability (fitness, simulation, future
 * audit/lint/etc.) that contributes one or more CLI subcommands. The
 * CLI is a generic dispatcher that walks the registered tool list and
 * mounts each tool's declared `commandSpecs`.
 *
 * Tools are first-party (declared as a direct dep of opensip-cli)
 * or third-party (any npm package whose package.json declares
 * `opensipTools.kind === 'tool'` — discovered via tool-package-discovery).
 *
 * Contract:
 *   - `commands[]` carries metadata only (name + description, used for
 *     `--help` listings and conflict detection).
 *   - The actual subcommand wiring is host-owned: the tool declares typed
 *     `commandSpecs` and the host's `mountCommandSpec` mounts each one
 *     (1.0.0 launch — `register()` and the raw-Commander `program` handle were
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
import type { RunTimer } from '../lib/run-timer.js';
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

/**
 * The current version of the `Tool` plugin contract.
 *
 * Tool authors may optionally set `contractVersion: TOOL_CONTRACT_VERSION`
 * (or a string matching a future version) on their exported `Tool` object.
 *
 * ## Versioning Policy (ADR-0046)
 *
 * - `TOOL_CONTRACT_VERSION` is bumped **only** when the shape or documented
 *   semantics of the `Tool` interface (or the `ToolExtensionPoints` contract)
 *   actually change in a way that could affect tool authors.
 * - When a contract change ships, the value is set to the major.minor of the
 *   CLI release in which the change is first released (e.g. a breaking contract
 *   change released as part of CLI v1.2.0 results in
 *   `TOOL_CONTRACT_VERSION = '1.2'`).
 * - Releases that do not touch the Tool contract leave the constant at its
 *   previous value (it will frequently lag the CLI version — this is
 *   intentional).
 * - The primary evolution mechanism remains `extensionPoints` (see below and
 *   the `Tool` interface JSDoc). `contractVersion` is a marker only.
 *
 * The host can use the declared value for diagnostics, logging
 * ("tool X was written against contract vY"), future compatibility warnings,
 * or ratcheting in the plugin loader / compatibility gate.
 *
 * See ADR-0046 for the full policy, alternatives considered, and enforcement.
 */
export const TOOL_CONTRACT_VERSION = '1.0.0';

/** Static descriptor for a tool plugin: id, semver, and one-line description. */
export interface ToolMetadata {
  /**
   * Stable identity (real UUID). Matches the `id` field used for Checks'
   * stable UUID (per ADR-0048 and governing spec). Used for durable DB
   * scoping, provenance, agent-catalog, future ratchets, etc.
   */
  readonly id: string;
  /**
   * Human-facing name / current key (what was previously stored in the old
   * `id` field). Used for UX, config namespaces, CLI short forms, on-disk
   * hints, and current DB `tool` column values.
   */
  readonly name: string;
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
  /**
   * Whether this command requires a project context (RunScope with datastore etc.).
   * Mirrors CommandSpec.scope. 'project' (default for most) vs 'none' (e.g. configure).
   * Populated from the tool's CommandSpec so the declared scope drives host behavior
   * (pre-action guards, etc.) instead of a hardcoded name list.
   */
  readonly scope?: 'project' | 'none';
}

/** Generic stored-session shape accepted by tool replay hooks.
 *
 * This mirrors `@opensip-cli/contracts` `StoredSession` structurally without
 * importing contracts into core. The CLI passes hydrated session-store rows;
 * tools narrow their opaque payloads inside their own replay builders.
 */
export interface ToolSessionRecord {
  readonly id: string;
  readonly tool: ToolShortId;
  readonly startedAt: string;
  readonly completedAt: string;
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
 * The generic-session contribution a tool returns from its command handler or
 * live renderer (host-owned-run-timing §6.2).
 *
 * Tools provide only verdict + payload + provenance. The host run-lifecycle
 * plane stamps `startedAt` / `completedAt` / `durationMs` (from the shared
 * `RunLifecycle`), generates the stable `id`, and performs the actual
 * `SessionRepo.save` *after* the tool returns. Tools never capture run timing
 * and never call a generic-session writer themselves.
 *
 * Persistence is best-effort: when no datastore is available (non-project
 * commands, or tests without a scope) the host writes nothing observable.
 * Tools must never assume a row was written.
 */
export interface ToolSessionContribution {
  readonly tool: ToolShortId;
  readonly cwd: string;
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  /** Tool-owned opaque payload (same contract as StoredSession.payload). */
  readonly payload?: unknown;
}

/**
 * Legacy alias for {@link ToolSessionContribution} — the input shape the
 * transitional `runSession.record(...)` seam accepts. Removed once the
 * record seam is deleted (host-owned-run-timing Phase 3); new code returns a
 * {@link ToolRunCompletion} instead of calling `record`.
 */
export type ToolRunSessionInput = ToolSessionContribution;

/**
 * What a tool command handler or live renderer returns to the host so the
 * host can complete the run lifecycle, persist the generic session row, and
 * compose dashboard contributions (host-owned-run-timing §6.2).
 *
 * - `result` / `envelope` are the tool's domain outputs (the same shapes the
 *   handler already produced) — optional so a live renderer that only persists
 *   can return just `session`.
 * - `session` is the generic-session contribution the host persists.
 * - `dashboard` is the optional per-run rich dashboard contribution
 *   (Phase 5), persisted keyed by session id for later `opensip report`.
 *
 * The host receives this and owns the rest; the tool supplies no lifecycle
 * timing and performs no generic-session write.
 */
export interface ToolRunCompletion {
  readonly result?: unknown;
  readonly envelope?: unknown;
  readonly session?: ToolSessionContribution;
  readonly dashboard?: ToolDashboardContribution;
}

/**
 * Return value from a successful `runSession.record(...)` call.
 *
 * Contains the id assigned by the host and the timing values that were
 * stamped from the host `RunTimer.snapshot()` at record time. Tools that
 * need the stamped values for their own live summaries can read them here
 * (rather than threading their own clocks).
 */
export interface RecordedToolRunSession {
  readonly id: string;
  readonly tool: ToolShortId;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

/**
 * The host-provided run-session seam on `ToolCliContext`.
 *
 * `timing` is the host run lifecycle for this invocation (shared between the
 * static command path and any live renderers); tools may read it for
 * display-only elapsed time.
 *
 * `record` is the TRANSITIONAL generic-session writer. The launch model is
 * "return a {@link ToolSessionContribution} (inside a {@link
 * ToolRunCompletion}) from your handler / live renderer and let the host
 * persist it" — `record` is removed once the host run plane owns persistence
 * (host-owned-run-timing Phases 3/6). Do not build new code against it.
 */
export interface ToolRunSessions {
  readonly timing: RunTimer;
  record(input: ToolRunSessionInput): RecordedToolRunSession | undefined;
}

/**
 * Context object passed as the second argument to a `LiveViewRenderer`.
 * Carries the host run seam so a live renderer reads the same lifecycle
 * (timer) the host will snapshot on completion. In the launch model the
 * renderer returns its {@link ToolRunCompletion} to the host rather than
 * calling `record` itself.
 */
export interface LiveViewContext {
  readonly runSession: ToolRunSessions;
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
 *
 * In the host-owned run-lifecycle model, the second `context` argument carries
 * the host run seam (the {@link LiveViewContext}) and is supplied by the host
 * for every live tool command. A live renderer must NOT call a generic-session
 * writer itself; instead it returns a {@link ToolRunCompletion} (or `void`)
 * once the underlying Ink app exits, and the host completes the lifecycle and
 * persists the session contribution after `await renderLive(...)`. The
 * parameter stays optional at the type level during the migration window
 * (Phase 2 makes it effectively required for live tool commands).
 */
export type LiveViewRenderer = (
  args: unknown,
  context?: LiveViewContext,
) => Promise<ToolRunCompletion | void>;

// ---------------------------------------------------------------------------
// Rich dashboard contribution model (host-owned-run-timing §7)
// ---------------------------------------------------------------------------

/** A column in a declarative dashboard table view. */
export interface DashboardColumn {
  readonly key: string;
  readonly label: string;
  /** Optional value formatting hint the renderer may honor. */
  readonly format?: 'text' | 'number' | 'duration' | 'date' | 'boolean';
}

/** A labeled field in a declarative cards / timeline view. */
export interface DashboardField {
  readonly key: string;
  readonly label: string;
  readonly format?: 'text' | 'number' | 'duration' | 'date' | 'boolean';
}

/** A declarative chart specification (renderer-interpreted). */
export interface DashboardChartSpec {
  readonly kind: 'bar' | 'line' | 'pie';
  readonly xKey: string;
  readonly yKey: string;
  readonly title?: string;
}

/**
 * A declarative dashboard view model. Launch prefers declarative views over
 * arbitrary plugin JavaScript; `custom-html` is sanitized/restricted because
 * self-contained reports are often shared outside the generating machine
 * (host-owned-run-timing §7.2, open decision §12).
 */
export type DashboardViewContribution =
  | { readonly kind: 'table'; readonly columns: readonly DashboardColumn[] }
  | { readonly kind: 'cards'; readonly fields: readonly DashboardField[] }
  | {
      readonly kind: 'timeline';
      readonly timeField: string;
      readonly fields: readonly DashboardField[];
    }
  | { readonly kind: 'chart'; readonly chart: DashboardChartSpec }
  | { readonly kind: 'custom-html'; readonly html: string };

/**
 * One contributed dashboard tab. `id` must be stable kebab-case and unique
 * within the producing tool; the host namespaces it by tool id at composition
 * time. `dataKey` references a key in {@link ToolDashboardContribution.data}
 * (or the view carries inline data).
 */
export interface DashboardTabContribution {
  readonly id: string;
  readonly title: string;
  readonly order?: number;
  readonly dataKey?: string;
  readonly view: DashboardViewContribution;
}

/**
 * A tool's per-run dashboard contribution (host-owned-run-timing §7.1).
 * Returned in {@link ToolRunCompletion.dashboard}; the host persists it keyed
 * by session id so a later `opensip report` process can hydrate it without
 * relying on in-memory state. `data` is namespaced by the producing tool; the
 * host rejects/ignores reserved top-level keys.
 */
export interface ToolDashboardContribution {
  readonly data?: Record<string, unknown>;
  readonly tabs?: readonly DashboardTabContribution[];
}

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
 * `@opensip-cli/output` (which owns the authoritative `GateCompareResult` used
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
 * Wire alias for run envelopes passed across the core ↔ cli seam.
 *
 * Typed `unknown` here because core must not depend on @opensip-cli/contracts
 * (layering). The composition root (cli) narrows it to `SignalEnvelope`.
 * This is the documented cost of strict kernel layering; shape-sync tests
 * and the explicit `Wire*` aliases are the hygiene.
 *
 * (GA Lows cleanup, 2026-06: alias + usage added as part of resolving the
 * "heavy unknown + casts" item. See roadmap item 5.)
 */
/* eslint-disable sonarjs/redundant-type-aliases -- intentional named alias for the unknown seam type (the "Wire" hygiene marker from the GA "heavy unknown + casts" cleanup); used in JSDoc for the baseline seams to document the layering. */
type WireSignalEnvelope = unknown;

/**
 * Context the host hands to each command handler (and the tool's optional
 * lifecycle hooks): the shared CLI behaviour a handler calls back into — Ink
 * rendering, machine-output emit seams, report auto-open, structured logging,
 * per-run scope — without depending on the CLI package directly.
 *
 * 1.0.0 launch: this context carries NO Commander `program`. Tools declare
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
   *
   * Host-owned planes live here (baselines, toolState per ADR-0042, and now
   * the combined governance/entitlements/audit plane via the `hostPlanes`
   * evolution bag). See the plan and spec for H1-H3.
   */
  readonly scope: ToolScope;

  /**
   * Host-owned run lifecycle seam (host-owned-run-timing).
   *
   * `timing` is the single `RunLifecycle` the CLI host creates inside the
   * command action (after `RunScope` entry, before any tool handler or live
   * view). It is the source of truth for `StoredSession.startedAt` /
   * `completedAt` / `durationMs`; tools may read it for display-only elapsed.
   *
   * `record(...)` is TRANSITIONAL and slated for removal (Phases 3/6). The
   * launch model is: return a `ToolSessionContribution` (inside a
   * `ToolRunCompletion`) from your command handler / live renderer and let the
   * host complete the lifecycle and persist after you return.
   *
   * Architectural rule: tools must not capture `Date` / `performance` for the
   * generic session timing fields, must not import or call `SessionRepo`
   * directly for the generic columns, and must not build new code against
   * `record(...)`.
   */
  readonly runSession: ToolRunSessions;

  /** Render an Ink result (CommandResult shape from @opensip-cli/contracts). */
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
  readonly renderLive: (key: string, args: unknown, liveContext?: LiveViewContext) => Promise<void>;
  /**
   * Open the HTML report in the user's browser when the run
   * conditions allow it (TTY, not JSON-mode, opt-in). Tools call this
   * after a run to honor the user's --open flag.
   */
  readonly maybeOpenReport: (opts: {
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
   * wire contract for a run lives in `@opensip-cli/output`, not
   * re-stringified per tool.
   *
   * This is the specialised seam for the **main analyze commands' run output**
   * (`fit`, `graph`, `sim`): they build a `SignalEnvelope` and call
   * `emitEnvelope`, where the older bespoke-JSON path used `emitJson(result)`
   * (the ADR-0011 Phase 4–6 migration, now complete). `emitJson` remains for
   * everything that is not a run envelope (see above) — the two seams are
   * complementary, not transitional.
   *
   * The value is the `SignalEnvelope` from `@opensip-cli/contracts`; it is
   * typed `unknown` here for the same reason `render`/`emitJson` are — the
   * `Tool` contract in core must not name the contracts-layer payload type
   * (that edge would invert the layer graph). The composition root narrows
   * it.
   *
   * Hygiene note (GA Low): this `unknown` + cast pattern is the cost of
   * strict layering (core imports nothing workspace). See the shape-sync
   * tests and `WireSignalEnvelope` alias below for the invariant.
   */
  readonly emitEnvelope: (envelope: WireSignalEnvelope) => void;
  /**
   * Emit a **structured error** as machine-output (launch, §5.5). The
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
   * Emit a **raw, unwrapped** value as machine-output for a command that
   * declares `output:'raw-stream'` (north-star §5.5). Unlike `emitJson`/
   * `emitEnvelope`/`emitError` — which wrap the payload in the outer
   * `CommandOutcome` currency — this writes the bare value as a single compact
   * JSON line, the smallest possible response for agents (e.g. `sessions show
   * --raw`: session metadata + envelope + hints, no wrapper).
   *
   * It is a deliberate, declared opt-out of the one-outcome shape, NOT a bypass:
   * the single sanctioned write still lives in the host's one stdout-JSON seam
   * (`renderRaw` in render-outcome), so no command body hand-rolls
   * `process.stdout.write(JSON.stringify(...))`. A command without
   * `output:'raw-stream'` should use `emitJson` instead.
   */
  readonly emitRaw: (value: unknown) => void;
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
   * their `@opensip-cli/output` dependency (Phases 4–6). Best-effort: cloud
   * failures never throw and never affect the exit code; only a `--report-to`
   * failure on an otherwise-passing run sets exit 4. Resolves to a
   * {@link SignalDeliveryResult} stating what actually shipped (the root also
   * prints the user-facing skip/failure notices); callers may ignore it.
   *
   * `envelope` is the `SignalEnvelope` from `@opensip-cli/contracts`, typed
   * `unknown` here for the same layer reason as `render`/`emitEnvelope`.
   */
  readonly deliverSignals: (
    envelope: WireSignalEnvelope,
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
   * the root instead of importing `@opensip-cli/output` itself. Awaitable so
   * the write completes before the short-lived CLI process exits.
   *
   * `envelope` is the `SignalEnvelope` from `@opensip-cli/contracts`, typed
   * `unknown` here for the same layer reason as `render`/`emitEnvelope`/
   * `deliverSignals`.
   */
  readonly writeSarif: (envelope: WireSignalEnvelope, path: string) => Promise<void>;
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
  readonly saveBaseline: (tool: string, envelope: WireSignalEnvelope) => Promise<void>;
  /**
   * Compare the current (stamped) envelope against this tool's saved baseline.
   * Throws a `ConfigurationError` (→ exit 2) when no baseline exists. The host
   * derives the gate exit from `result.degraded` via the `deliverSignals`
   * runFailed override — no tool calls `setExitCode` for the gate path (ADR-0035).
   */
  readonly compareBaseline: (
    tool: string,
    envelope: WireSignalEnvelope,
  ) => Promise<GateCompareResult>;
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
  /**
   * Host-owned keyed tool state (ADR-0042) — durable, per-tool, opaque-JSON
   * persistence over the generic `tool_state` table, the third-party parity
   * mechanism beside sessions + baselines. ONE grouped member (not four flat
   * seams — the interface-segregation lesson from the baseline plane). Rules:
   *
   *   - `tool` scopes every operation; a tool never sees another's rows.
   *   - Payloads are opaque JSON, capped at 256 KiB per payload; an oversized
   *     `put` throws a `ValidationError` (error, never evict).
   *   - Durable: unlike baselines (drop-and-recapture), a release never drops
   *     these rows. `tools data purge <tool-id>` clears them on request.
   *   - Requires the entered project scope (the datastore is per-project);
   *     calls outside one reject with the host's datastore-unavailable error.
   */
  readonly toolState: {
    readonly get: (tool: string, key: string) => Promise<unknown>;
    readonly put: (tool: string, key: string, payload: unknown) => Promise<void>;
    readonly delete: (tool: string, key: string) => Promise<void>;
    readonly list: (tool: string) => Promise<readonly string[]>;
  };

  /**
   * Host-owned evolution bag for additional durable/governance planes.
   *
   * This is the combined Host-Owned Governance, Entitlements, and Audit Plane
   * (H1: Extension/Community Governance, H2: Per-Tool Audit/Provenance/Decision Records,
   * H3: Entitlements/Licensing/Paid-Extension State).
   *
   * See:
   * - the "Host-Owned Governance, Entitlements & Audit Plane" spec + plan
   *   (local-only working docs under docs/plans/, by that title)
   * - ADR-0042 (toolState baseline this reuses)
   *
   * Design: typed seams here (host provides the impl), opaque/namespaced storage under the
   * existing toolState seam (and the single host-owned `tool_state` table). Tools never
   * touch raw datastore for these concerns. The bag prevents interface bloat on ToolCliContext
   * (symmetric to ToolExtensionPoints on the Tool side).
   *
   * All members are optional so this change is purely additive for GA-era code and stubs.
   */
  readonly hostPlanes?: {
    governance?: HostGovernance;
    audit?: HostAudit;
    entitlements?: HostEntitlements;
  };
}

/**
 * Stable (but minimal) interfaces for the host-provided governance / audit / entitlements planes.
 * These are defined in core so that both the host (CLI) and consumers (Cloud, future community tools)
 * have a single source of truth.
 *
 * Cloud is the primary consumer. Third-party / OSS tool authors may:
 *   - ignore the bag entirely, or
 *   - use the existing `toolState` seam directly for custom records, or
 *   - supply compatible objects (the host will prefer a supplied implementation when present).
 *
 * See the governing "Host-Planes / Scope-Seams Hygiene" spec (local-only
 * working doc under docs/plans/, by that title) for the flexibility story.
 */
export interface HostGovernance {
  /** Read the current governance state blob for a tool (installed/enabled/block/approvals). */
  getGovernanceState(toolId: string): Promise<ToolGovernanceState | undefined>;
  listForProject(projectRoot: string): Promise<ToolGovernanceState[]>;
  queryAudit(toolId: string, filter?: unknown): Promise<AuditEntry[]>;

  recordInstallation(toolId: string, record: InstallationRecord): Promise<void>;
  recordApprovalDecision(toolId: string, decision: ApprovalDecision): Promise<void>;
  setBlock(toolId: string, blocked: boolean, reason?: string): Promise<void>;

  /** Enforcement helper (used by run paths or Cloud before acting on a tool). */
  checkAllowed(
    toolId: string,
    action: 'install' | 'enable' | 'run-remediation' | 'run-simulation',
  ): Promise<boolean>;
}

/**
 * Host-owned audit plane (hostPlanes.audit). Tools append per-tool audit
 * entries and query them back; the host persists them (Cloud primary, OSS
 * compat via tool_state). Cloud may additionally chain entries into its
 * WORM/tamper-evident log via {@link HostAudit.exportForCloud}.
 */
export interface HostAudit {
  /** Append one audit entry for `toolId` (host persists it). */
  append(toolId: string, entry: ToolAuditEntry): Promise<void>;
  /** Read back `toolId`'s audit entries, optionally narrowed by `filter`. */
  query(toolId: string, filter?: unknown): Promise<ToolAuditEntry[]>;
  /** Best-effort linkage point for Cloud's WORM/tamper-evident audit chain. */
  exportForCloud?(...args: unknown[]): Promise<unknown>;
}

/**
 * Host-owned entitlements plane (hostPlanes.entitlements). Tools check whether
 * an action is licensed, record usage for metering, and read the current
 * license state. OSS hosts may supply permissive compat implementations.
 */
export interface HostEntitlements {
  /** Resolve the entitlement status for `toolId` (optionally for a specific `action`). */
  check(toolId: string, action?: string): Promise<EntitlementStatus>;
  /** Record a usage event for `toolId` (metering / quota accounting). */
  recordUsage(toolId: string, usage: UsageRecord): Promise<void>;
  /** Read the current license state for `toolId`, or `undefined` if unknown. */
  getLicenseState(toolId: string): Promise<LicenseState | undefined>;
}

/**
 * Lightweight / forward-compatible record types for the host-owned
 * governance/entitlements/audit plane.
 *
 * These are intentionally minimal in the first cut. Most fields are either
 * opaque to the CLI today or will be interpreted by Cloud/Community surfaces.
 * The host (via hostPlanes seams) performs serialization into the existing
 * namespaced tool_state rows. See the governing spec for full rationale and
 * evolution path.
 */
export type ToolGovernanceState = Record<string, unknown>;
/** Opaque record describing a tool installation (host/Cloud-interpreted). */
export type InstallationRecord = Record<string, unknown>;
/** Opaque record of an install/enable approval decision (host/Cloud-interpreted). */
export type ApprovalDecision = Record<string, unknown>;
/** Opaque governance audit entry recorded via {@link HostGovernance.queryAudit}. */
export type AuditEntry = Record<string, unknown>;
/** Opaque per-tool audit entry appended/queried via {@link HostAudit}. */
export type ToolAuditEntry = Record<string, unknown>;
/** Opaque entitlement-check result returned by {@link HostEntitlements.check}. */
export type EntitlementStatus = Record<string, unknown>;
/** Opaque usage event recorded via {@link HostEntitlements.recordUsage}. */
export type UsageRecord = Record<string, unknown>;
/** Opaque license-state snapshot returned by {@link HostEntitlements.getLicenseState}. */
export type LicenseState = Record<string, unknown>;

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
 *      canonical `mapToolErrorToExitCode` (in `@opensip-cli/contracts`).
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
 * Bag for extension points and rarer/future hooks.
 *
 * ## Why this bag exists (discoverability)
 *
 * The main `Tool` interface is deliberately kept as "one cohesive interface"
 * that every tool author implements. To prevent it from becoming a god
 * interface over time, **new or experimental concerns should be added here**
 * rather than as new top-level optional members.
 *
 * This is the official evolution path for the Tool contract.
 *
 * ## What belongs here
 * - Optional lifecycle hooks (initialize, contributeScope, etc.)
 * - Future capabilities, community distribution metadata, etc.
 * - Host-plane participation declarations (governance / audit / entitlements)
 *
 * See the JSDoc on the `Tool` interface for the recommended grouping and
 * the "Evolution Path" guidance. Also see ADR-0027 and ADR-0038.
 */
export interface ToolExtensionPoints {
  readonly initialize?: () => Promise<void>;
  readonly contributeScope?: () => ScopeContribution;
  readonly collectReportData?: (
    scope: ToolScope,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  readonly sessionReplay?: ToolSessionReplayContribution;
  readonly config?: ToolConfigContribution;
  readonly capabilityRegistrars?: Readonly<Record<string, CapabilityRegistrar>>;
  readonly fingerprintStrategy?: FingerprintStrategy;
  readonly scaffoldExamples?: (ctx: ScaffoldContext) => readonly ScaffoldFile[];
  readonly stableExampleIds?: () => readonly string[];
  readonly scaffoldConfigBlock?: () => string;

  // Per-tool contract versions (ADR-0047). Each tool declares its own domain
  // surface version here (the evolution bag) rather than on the main Tool
  // interface, so the core contract stays narrow while per-tool surfaces evolve
  // independently of core's TOOL_CONTRACT_VERSION.
  readonly fitnessContractVersion?: string;
  readonly graphContractVersion?: string;
  readonly simulationContractVersion?: string;
}

/**
 * The contract every first-party, installed, or project-local tool implements
 * (`fitness`, `simulation`, `graph`, …).
 *
 * A tool declares its metadata and `commandSpecs` (the **only** command surface).
 * The host (`cli`) loads every tool through the same dynamic-import plugin path;
 * nothing here distinguishes a bundled tool from an installed one (ADR-0027).
 *
 * ## Design note (architecture review)
 *
 * The surface is deliberately *rich and cohesive* rather than a minimal set of
 * narrow interfaces. New or rare concerns are routed through the `extensionPoints`
 * bag (or top-level optionals that predate the bag) + per-tool `*ContractVersion`
 * fields (ADR-0046, ADR-0047). This keeps the core Tool contract stable while
 * allowing independent evolution of fitness/graph/simulation surfaces. The trade-off
 * (larger surface for tool authors, coordination for new capability *domains*)
 * was accepted in favor of a single place to look for "what can a tool do?" and
 * to avoid a proliferation of tiny marker interfaces. See the evolution guidance
 * in the JSDoc below and in tool-lifecycle / capability docs.
 *
 * ## Contract Structure (for discoverability)
 *
 * The surface is intentionally one cohesive interface (see top-of-file comment).
 * It is organized into these logical groups:
 *
 * ### Stable Core Surface (most tools will implement these)
 * - `metadata`, `commands`, `pluginLayout`, `commandSpecs`
 *
 * ### Lifecycle & Host Integration (optional)
 * - `initialize`, `contributeScope`, `collectReportData`, `sessionReplay`,
 *   `config`, `capabilityRegistrars`, `fingerprintStrategy`
 *
 * ### Scaffolding / `init` support (ADR-0038)
 * - `scaffoldExamples`, `stableExampleIds`, `scaffoldConfigBlock`
 *
 * ### Evolution Path (strongly preferred for new concerns)
 * - `extensionPoints` (see `ToolExtensionPoints` below)
 *
 * ## Future-Proofing
 *
 * Use the exported `TOOL_CONTRACT_VERSION` in your `contractVersion` field
 * when you author a tool. New or experimental capabilities should go into
 * `extensionPoints` rather than new top-level members.
 *
 * The host provides typed seams on `ToolCliContext` (including the typed
 * `hostPlanes` bag for governance/audit/entitlements).
 */
export interface Tool {
  // ── Core Identity ──────────────────────────────────────────────────────
  readonly metadata: ToolMetadata;

  /**
   * Optional marker for which version of the Tool contract this
   * implementation was authored against.
   *
   * Recommended usage:
   *   contractVersion: TOOL_CONTRACT_VERSION
   *
   * See the exported `TOOL_CONTRACT_VERSION` constant for rationale and
   * future evolution notes. This field is purely advisory for now.
   */
  readonly contractVersion?: string;

  /**
   * Metadata for every command this tool contributes. Used for --help
   * listings and conflict detection. Actual handlers are mounted by
   * the host.
   */
  readonly commands: readonly ToolCommandDescriptor[];
  /**
   * Optional project-local plugin layout. Tools that support
   * user-authored / npm plugins under `<project>/opensip-cli/<domain>/`
   * declare `{ domain, userSubdirs }` here; the kernel's `discoverPlugins`
   * / `loadAllPlugins` and the CLI's `plugin` command read it instead of
   * hardcoding domain names (ADR-0009 corollary 1). Tools with no
   * project-local plugins (e.g. graph) leave this undefined.
   */
  readonly pluginLayout?: PluginLayout;
  /**
   * Declarative command surface (launch, north-star §5.4). The
   * PREFERRED way a tool contributes commands: it returns one
   * {@link CommandSpec} per subcommand and the host's `mountCommandSpec`
   * (cli, Phase 1) translates each into a wired Commander command — the tool
   * never touches Commander. Specs are typed against the concrete host
   * {@link ToolCliContext} (the kernel's default `CommandContext` marker isn't
   * assignable to it), so a tool authors them via
   * `defineCommand<TOpts, ToolCliContext>(...)`.
   *
   * The host mounts each spec via `mountCommandSpec` (the ONLY command surface
   * as of launch — `register()` was removed). A tool that declares no
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
   *   declare module '@opensip-cli/core' {
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
   * Optional report-data contribution (audit 2026-05-29, L2). The CLI
   * is the report composition root: it gathers generic sessions, then
   * walks the tool registry calling this hook and merges each tool's
   * contribution into the HTML report input. A tool returns ITS OWN inputs
   * to the HTML report (fitness: check/recipe catalogs; graph: its
   * catalog) — keyed by the field names `generateDashboardHtml` consumes.
   *
   * Returns an opaque `Record<string, unknown>` so the kernel carries no
   * tool/report-renderer vocabulary; the CLI `Object.assign`s it onto the
   * `DashboardInput`. Tools that contribute nothing leave this undefined.
   * Receives the Tool-facing `ToolScope` (datastore, projectContext, …).
   */
  readonly collectReportData?: (
    scope: ToolScope,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Optional session replay contribution. The CLI owns the generic
   * `sessions show` command, while each tool owns decoding its opaque
   * `StoredSession.payload` projection into renderable replay data.
   *
   * Core keeps the hook structural (`unknown` return) so it does not depend on
   * `@opensip-cli/contracts`; the CLI narrows the returned value at the
   * composition boundary.
   */
  readonly sessionReplay?: ToolSessionReplayContribution;
  /**
   * Optional namespaced config contribution (launch, ADR-0023). A
   * tool owning a top-level block (`graph:`/`fitness:`/`simulation:`) declares
   * its Zod schema here as a `ToolConfigDeclaration` (from
   * `@opensip-cli/config`). The composition root composes every tool's
   * `config` into one strict whole-document schema, validates the config file
   * once before dispatch, and exposes the resolved config back via the scope.
   * Kernel-side {@link ToolConfigContribution} carrier (core carries no Zod);
   * the CLI narrows it. Undefined ⇒ no config block.
   */
  readonly config?: ToolConfigContribution;
  /**
   * Optional capability-domain registrars (launch, §5.3), keyed by
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
   * (`@opensip-cli/contracts`), which stamps every signal (host default when
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
   * scaffolded `opensip-cli.config.yml` (ADR-0038 Phase 3). Undefined ⇒ the host
   * renders the block from the tool's `ToolConfigDeclaration` defaults (or omits
   * it). The host always renders the document header + the `targets:` section.
   */
  readonly scaffoldConfigBlock?: () => string;

  /**
   * Bag for extension points and rarer/future hooks.
   *
   * New concerns should go here (see `ToolExtensionPoints` JSDoc) rather than
   * additional top-level optionals. This is the evolution path for the Tool
   * contract.
   */
  readonly extensionPoints?: ToolExtensionPoints;
}

/**
 * Plugin export shape for npm packages whose package.json declares
 * `opensipTools.kind === 'tool'`. The package's main entry must export
 * a `tool` symbol of this shape.
 */
export interface ToolPluginExports {
  readonly tool: Tool;
}

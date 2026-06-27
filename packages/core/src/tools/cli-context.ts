/**
 * @fileoverview The host-provided `ToolCliContext` seam.
 *
 * The large context object the host hands to every command handler (and the
 * tool's optional lifecycle hooks), plus the `WireSignalEnvelope` wire alias
 * it threads across the core ↔ cli seam. Split out of the kitchen-sink
 * `types.ts` contract hub (M6); re-exported from there so the public surface
 * is unchanged.
 */

import type { HostAudit, HostEntitlements, HostGovernance } from './host-planes.js';
import type { LiveViewContext, LiveViewRenderer } from './live-view.js';
import type { ReportFailureDetail } from './report-failure.js';
import type { GateCompareResult, SignalDeliveryResult } from './tool-results.js';
import type { ToolRunCompletion, ToolRunSessions } from './tool-sessions.js';
import type { CliDiagnostic } from '../lib/cli-diagnostic.js';
import type { Logger } from '../lib/logger.js';
import type { ToolScope } from '../lib/scope-types.js';

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
 * it to its own mount step (`mountAllToolCommands(registry, program, ctx, provenance)`).
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
   * to the registered renderer. Resolves once the underlying Ink app exits,
   * with the renderer's {@link ToolRunCompletion} (or `void`). The host
   * completes the run lifecycle and persists the returned `session`
   * contribution after the renderer resolves — the renderer must NOT call a
   * generic-session writer itself. Throws `UnknownLiveViewError` if no
   * renderer has been registered for `key` (rather than silently falling back
   * to a static render — the latter would mask bugs where a tool mistypes its
   * view key).
   *
   * `key` is a string instead of a typed enum so new tools can
   * contribute additional live views without touching the core type. The
   * host supplies the `LiveViewContext` for live tool commands; tools should
   * not pass it themselves.
   */
  readonly renderLive: (
    key: string,
    args: unknown,
    liveContext?: LiveViewContext,
  ) => Promise<ToolRunCompletion | void>;
  /**
   * Open the HTML report in the user's browser when the run
   * conditions allow it (TTY, not JSON-mode, opt-in). Tools call this
   * after a run to honor the user's --open flag.
   */
  readonly maybeOpenReport: (opts: {
    openRequested: boolean;
    jsonOutput: boolean;
  }) => Promise<void>;
  /**
   * Shared structured logger — resolves to the per-run scope logger during a
   * normal command (Plan 06). Writes to `<project>/opensip-cli/.runtime/logs/`
   * when the host configures `logDir` on the run logger.
   */
  readonly logger: Logger;
  /**
   * Report a handler-time command failure (Plan 06 / ADR-0077). The host fans out
   * to structured log, customer surface (human Ink / `--json` error outcome /
   * diagnostic stderr), process exit code, and diagnostics bus.
   *
   * Use for "the command could not run or complete" — NOT for scan findings
   * (`SignalEnvelope` / `deliverSignals`). Bootstrap/setup health during
   * discovery remains the host `CliDiagnostic` path (ADR-0060).
   */
  readonly reportFailure: (detail: ReportFailureDetail) => Promise<void>;
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
    /** Structured bootstrap/setup diagnostic (ADR-0060 command-error substrate). */
    readonly diagnostic?: CliDiagnostic;
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
   * Write durable tool-owned artifact bytes through the host's atomic file
   * writer. The host resolves the target path, writes via temp-file + rename
   * under a per-target lock, creates parent directories, and emits the standard
   * state artifact diagnostics. Use specialized seams for SARIF and baselines.
   */
  readonly writeArtifact: (path: string, bytes: string) => Promise<void>;
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

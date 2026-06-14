/**
 * cli-context — live-view registry, scope readers, and `ToolCliContext`
 * factory. Two related concerns:
 *
 *  1. `createLiveViewRegistry` — backs `registerLiveView` / `renderLive`. A tool
 *     registers its Ink view by key; an unregistered key throws
 *     `UnknownLiveViewError` rather than masking a mistyped key with a static render.
 *  2. `buildToolCliContext` — assembles the `ToolCliContext` handed to each tool and
 *     host command, including the output/raw/error emit seams (delegated to
 *     `renderOutcome` / `renderRaw`) and the single `setExitCode` write path
 *     (`process.exitCode` is mutated only here).
 *
 * There is NO module-global bootstrap-handoff bag. The populated registries +
 * admitted-tool manifests/provenance are captured in the pre-action-hook closure
 * (`installPreActionHook` is called AFTER `bootstrapCli` in `main()`), the hook
 * builds + enters the per-run `RunScope`, and from there every per-run read
 * (project, datastore, manifests, provenance, …) goes through `currentScope()`.
 *
 * Lazy datastore: a closure-based thunk caches the open DataStore on first access and
 * lands on `RunScope.datastore`; paths that never touch it never materialise
 * `.runtime/datastore.sqlite`.
 */

import {
  type RunScope,
  UnknownLiveViewError,
  logger as defaultLogger,
  type LiveViewRenderer,
  type Logger,
  type ToolCliContext,
  type ToolRunCompletion,
  type ToolRunSessions,
  type LiveViewContext,
} from '@opensip-cli/core';
import { type DataStore } from '@opensip-cli/datastore';

import { buildBaselineSeams } from './bootstrap/baseline-seams.js';
import { deliverEnvelope, writeEnvelopeSarif } from './bootstrap/deliver-envelope.js';
import { buildHostPlanes } from './bootstrap/host-planes.js';
import { createRunPlaneFactory, type RunActionHooks } from './bootstrap/run-plane.js';
import { getProjectDatastore, readScope } from './bootstrap/scope-access.js';
import { buildStateSeams } from './bootstrap/state-seams.js';
import {
  outcomeFromEnvelope,
  outcomeFromErrorMessage,
  outcomeFromResult,
} from './commands/assemble-outcome.js';
import { renderOutcome, renderRaw } from './commands/render-outcome.js';

import type { CommandResult, SignalEnvelope } from '@opensip-cli/contracts';

/** Structured-log `module` tag for this composition-root module. */
const MODULE_TAG = 'cli:context';

// ---------------------------------------------------------------------------
// No module-global bootstrap-handoff bag.
//
// The registries + admitted-tool manifests/provenance the pre-action hook needs
// to BUILD the scope are captured in the hook closure (`installPreActionHook` is
// called AFTER `bootstrapCli` in `main()`; see `PreActionRuntime`). Once the hook
// calls `enterScope`, ALL per-run state — project, datastore thunk, diagnostics,
// AND the admitted-tool manifests/provenance (now stamped onto `RunScope`) — is
// read exclusively via `currentScope()` (ALS). Host commands that surface the
// admitted set (`plugin list`, `tools list`, `tools uninstall`) read
// `currentScope()?.toolProvenance` / `?.toolManifests`.
// ---------------------------------------------------------------------------

// Per-run scope + datastore readers live in `bootstrap/scope-access.ts`. They
// are re-exported here so existing importers (and the dynamic-import tests)
// keep their stable `cli-context.js` entry point while this module focuses on
// context assembly (live-view registry + buildToolCliContext).
export {
  buildDatastoreThunk,
  getCurrentProjectRoot,
  getOrOpenDatastore,
} from './bootstrap/scope-access.js';

export interface LiveViewRegistry {
  readonly register: (key: string, renderer: LiveViewRenderer) => void;
  /**
   * Render the live view. The optional third parameter is the LiveViewContext
   * (carrying runSession) to forward as the *second* argument to the renderer
   * function itself. This lets the host dispatch site (mount) supply the
   * shared run timer without changing the public ToolCliContext.renderLive
   * (tools still call renderLive(key, args)).
   */
  readonly render: (
    key: string,
    args: unknown,
    liveContext?: LiveViewContext,
  ) => Promise<ToolRunCompletion | void>;
  readonly has: (key: string) => boolean;
}

export function createLiveViewRegistry(log: Logger = defaultLogger): LiveViewRegistry {
  const renderers = new Map<string, LiveViewRenderer>();
  return {
    register(key, renderer) {
      if (renderers.has(key)) {
        log.warn({
          evt: 'cli.live_view.duplicate',
          module: 'cli:bootstrap',
          key,
          msg: `Duplicate live-view registration for key '${key}' — first registration wins.`,
        });
        return;
      }
      renderers.set(key, renderer);
    },
    /**
     * @throws {UnknownLiveViewError} When `key` has no registered live-view renderer.
     */
    async render(key, args, liveContext) {
      const renderer = renderers.get(key);
      if (!renderer) {
        // async so the throw surfaces as a rejected promise (the contract
        // callers `await` / assert `.rejects` against).
        throw new UnknownLiveViewError(key);
      }
      // Always pass the host-supplied LiveViewContext (host-owned-run-timing
      // Phase 2): live tool commands receive it; JS safely ignores the extra arg
      // for any renderer that declares only one parameter. Return the renderer's
      // ToolRunCompletion so the host can complete the lifecycle + persist.
      return renderer(args, liveContext);
    },
    has(key) {
      return renderers.has(key);
    },
  };
}

export interface BuildToolCliContextOptions {
  readonly render: (result: CommandResult) => Promise<void>;
  readonly liveViews: LiveViewRegistry;
  readonly maybeOpenReport: (opts: {
    openRequested: boolean;
    jsonOutput: boolean;
  }) => Promise<void>;
  readonly logger?: Logger;
}

export interface ToolCliContextHandle {
  readonly ctx: ToolCliContext;
  readonly getExitCode: () => number | undefined;
}

export function buildToolCliContext(opts: BuildToolCliContextOptions): ToolCliContextHandle {
  const log = opts.logger ?? defaultLogger;
  let exitCode: number | undefined;

  const setExitCode = (code: number): void => {
    exitCode = code;
    process.exitCode = code;
  };

  const baselineSeams = buildBaselineSeams({ getDatastore: getProjectDatastore, logger: log });
  const stateSeams = buildStateSeams({ getDatastore: getProjectDatastore }); // ADR-0042, same lazy resolver
  const hostPlanes = buildHostPlanes({ getDatastore: getProjectDatastore, logger: log });

  // Host run-lifecycle plane (host-owned-run-timing Phase 1). The FACTORY is
  // created here with stable deps only — it must NOT start a lifecycle. The
  // lifecycle is created inside the command action (mount-command-spec calls
  // `beginRun()` after RunScope entry, before the handler) or lazily on first
  // access to `runSession.timing` / `.record`.
  const runPlane = createRunPlaneFactory({
    // Best-effort datastore resolver via the entered scope thunk (no direct /
    // global access). Returns undefined when no project/datastore is in scope.
    getDatastore: () => {
      try {
        const thunk = readScope().datastore;
        return thunk ? (thunk() as DataStore) : undefined;
      } catch {
        return;
      }
    },
    logger: log,
  });

  // The public run seam. `timing` exposes the current invocation lifecycle (for
  // display-only elapsed); `record` is the TRANSITIONAL writer that routes
  // through the plane (removed once tools return contributions, Phase 3).
  const runSession: ToolRunSessions = {
    get timing() {
      return runPlane.current().lifecycle;
    },
    record: (input) => runPlane.current().record(input),
  };

  // Internal run-lifecycle hooks for the mount dispatch (not part of the public
  // ToolCliContext; read via cast at the dispatch site like `runSession`).
  const runActionHooks: RunActionHooks = {
    beginRun: () => {
      runPlane.beginRun();
    },
    completeRun: (result) => {
      const completion = result as ToolRunCompletion | undefined;
      const session = completion?.session;
      // host-owned-run-timing Phase 5: forward the optional per-run dashboard
      // contribution alongside the session so the host persists both keyed by
      // the same session id. Best-effort; no dashboard ⇒ session-only persist.
      if (session) runPlane.current().completeAndPersist(session, completion?.dashboard);
    },
  };

  const ctx: ToolCliContext & RunActionHooks = {
    get scope(): RunScope {
      // The pre-action-hook (or explicit runWithScope in tests) enters the
      // RunScope via AsyncLocalStorage before the action body or any reader runs.
      // `cli.scope` (and currentScope()) surface the identical entered scope.
      // After Phase 3, readScope() no longer has holder fallbacks.
      return readScope();
    },
    render: (result) => opts.render(result as CommandResult),
    registerLiveView: opts.liveViews.register,
    renderLive: (key: string, args: unknown, liveContext?: LiveViewContext) =>
      // Host owns the live run lifecycle (host-owned-run-timing Phase 2): time
      // the TTY occupancy, then complete the lifecycle + persist the renderer's
      // returned `session` contribution. The host always supplies the
      // LiveViewContext (carrying the run seam + timer) so tools that call
      // renderLive directly (fit/sim/graph runLiveMode) get it without passing
      // it themselves. The renderer no longer writes the session itself.
      runPlane
        .current()
        .completeLiveRender(() => opts.liveViews.render(key, args, liveContext ?? { runSession })),
    maybeOpenReport: opts.maybeOpenReport,
    logger: log,
    setExitCode,
    // launch (§5.5): every machine output the host emits is wrapped in a
    // `CommandOutcome` through the single `renderOutcome` seam — `emitJson`
    // (general-purpose `.data`), `emitEnvelope` (run `.envelope`), and
    // `emitError` (`status:'error'` `.errors`). The host STAMPS the outer
    // currency; the tool only hands over its pure-domain payload. `--json` is
    // implicit here: these seams are only ever called on the `--json` path, so
    // they always serialize the outcome (the `render` arg is inert).
    //
    // Errors during renderOutcome are attached to a catch so they are not
    // completely swallowed by the `void` (they surface in logs and as
    // unhandled-rejection diagnostics instead of silent loss).
    emitJson: (value) => {
      renderOutcome(outcomeFromResult(value, exitCode ?? 0), {
        jsonRequested: true,
        render: opts.render,
      }).catch((error) => {
        // Primary machine output path failed — do not swallow silently.
        // Only force a non-success exit if the primary run had not already
        // decided on a failure code (preserve specific codes like REPORT_FAILED,
        // RUNTIME_ERROR, etc.). Render failure of the outcome is secondary.
        if ((exitCode ?? 0) === 0) {
          setExitCode(1);
        }
        log.error({
          evt: 'cli.emit_json.render_failed',
          module: MODULE_TAG,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    emitEnvelope: (envelope) => {
      renderOutcome(outcomeFromEnvelope(envelope as SignalEnvelope, exitCode ?? 0), {
        jsonRequested: true,
        render: opts.render,
      }).catch((error) => {
        if ((exitCode ?? 0) === 0) {
          setExitCode(1);
        }
        log.error({
          evt: 'cli.emit_envelope.render_failed',
          module: MODULE_TAG,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    // Structured error machine-output (retires the bare `emitJson({ error })`
    // shape the `one-outcome-shape` guardrail forbids). The handler hands a
    // diagnosed failure (message + exit code, optional suggestion); the host
    // wraps it as a `status:'error'` outcome. `exitCode` is also threaded to
    // `setExitCode` so the process exit and the reported outcome agree.
    emitError: (detail) => {
      setExitCode(detail.exitCode);
      renderOutcome(
        outcomeFromErrorMessage({
          message: detail.message,
          exitCode: detail.exitCode,
          ...(detail.suggestion === undefined ? {} : { suggestion: detail.suggestion }),
          ...(detail.code === undefined ? {} : { code: detail.code }),
        }),
        { jsonRequested: true, render: opts.render },
      ).catch((error) => {
        // Even error emission failing is fatal for the json contract.
        // Only force 1 if the error detail itself indicated success (edge).
        if ((exitCode ?? 0) === 0) {
          setExitCode(1);
        }
        log.error({
          evt: 'cli.emit_error.render_failed',
          module: MODULE_TAG,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    // RAW_STREAM seam (§5.5): emit the bare, unwrapped value for a command that
    // declares `output:'raw-stream'` (e.g. `sessions show --raw`). The single
    // sanctioned write lives in `renderRaw` (the one stdout-JSON seam), so the
    // command body never hand-rolls `process.stdout.write(JSON.stringify(...))`.
    emitRaw: (value) => renderRaw(value),
    // The root owns all effectful egress (ADR-0011 / ADR-0008): cloud sync via
    // the run's signal sink + `--report-to` SARIF upload. Tools call this once
    // per run; `setExitCode` is threaded so a `--report-to` failure on an
    // otherwise-passing run can claim exit 4. The delivery result (what actually
    // shipped / why a leg was skipped) flows back to the caller — the root has
    // already printed any user-facing notice, so callers may ignore it.
    deliverSignals: (envelope, deliverOpts) =>
      deliverEnvelope(envelope as SignalEnvelope, {
        cwd: deliverOpts.cwd,
        reportTo: deliverOpts.reportTo,
        apiKey: deliverOpts.apiKey,
        runFailed: deliverOpts.runFailed,
        setExitCode,
        logger: log,
      }),
    // Root-owned SARIF-file sink (ADR-0011): the one place that formats an
    // envelope to SARIF and writes it to disk, so tools that export SARIF to a
    // file (e.g. `graph sarif-export`) never import `@opensip-cli/output`.
    writeSarif: (envelope, path) => writeEnvelopeSarif(envelope as SignalEnvelope, path),
    // Host baseline/ratchet plane seams (ADR-0036) — persistence + diff + exports.
    saveBaseline: baselineSeams.saveBaseline,
    compareBaseline: baselineSeams.compareBaseline,
    exportBaselineSarif: baselineSeams.exportBaselineSarif,
    exportBaselineFingerprints: baselineSeams.exportBaselineFingerprints,
    toolState: stateSeams, // ADR-0042: durable per-tool keyed JSON state
    runSession, // host-owned; created above, shared with live views
    hostPlanes, // Host-owned governance / entitlements / audit plane (H1-H3)
    // Internal run-lifecycle hooks (not public ToolCliContext members; the mount
    // dispatch reads them via cast). beginRun marks the lifecycle start at the
    // command-action boundary; completeRun persists a returned contribution.
    ...runActionHooks,
  };

  return {
    ctx,
    getExitCode: () => exitCode,
  };
}

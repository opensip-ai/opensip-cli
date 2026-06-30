/**
 * cli-context — the thin `ToolCliContext` assembler (host-owned-run-timing
 * Phase 6). `buildToolCliContext` wires together the focused host planes —
 * output, egress, run, live, baseline, state, host-planes — into the single
 * coherent context handed to each tool and host command. Each concern's logic
 * lives in its own `bootstrap/*-plane` (or `*-seams`) module; this file only
 * composes them and exposes the `scope` getter + the assembled context.
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
  createRunTimer,
  currentScope,
  type RunScope,
  logger as defaultLogger,
  type Logger,
  type ToolCliContext,
} from '@opensip-cli/core';

import {
  createEnsureArtifactDirSeam,
  createWriteArtifactSeam,
} from './bootstrap/artifact-seams.js';
import { buildBaselineSeams } from './bootstrap/baseline-seams.js';
import { loadCliDefaults } from './bootstrap/cli-defaults.js';
import { buildHostPlanes } from './bootstrap/host-planes.js';
import { createIoPlane, type LiveViewRegistry } from './bootstrap/io-plane.js';
import { createOutputPlane } from './bootstrap/output-plane.js';
import { createReportFailure } from './bootstrap/report-failure.js';
import {
  createRunActionHooks,
  createRunPlaneFactory,
  createRunSessionSeam,
  type RunActionHooks,
} from './bootstrap/run-plane.js';
import { createDatastoreResolver, readScope } from './bootstrap/scope-access.js';
import { resolveSessionRetentionPolicy } from './bootstrap/session-retention.js';
import { buildStateSeams } from './bootstrap/state-seams.js';

import type { CommandResult } from '@opensip-cli/contracts';

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

// Per-run scope + datastore readers live in `bootstrap/scope-access.ts`; the
// live-view registry lives in `bootstrap/io-plane.ts`. Both are re-exported
// here so existing importers (`main()` + the dynamic-import tests) keep their
// stable `cli-context.js` entry point while this module focuses on assembly.
export {
  buildDatastoreThunk,
  getCurrentProjectRoot,
  getOrOpenDatastore,
} from './bootstrap/scope-access.js';
export { createLiveViewRegistry, type LiveViewRegistry } from './bootstrap/io-plane.js';

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

/**
 * Resolve the configured artifact-retention keep count (`cli.artifacts.keep`)
 * from the project's CLI defaults, to parametrize the host `writeArtifact` seam.
 *
 * Read at context-build time: from the entered scope's project root when one is
 * available (host-command / hook-dispatch contexts are built inside a run), else
 * from the process cwd (the primary path builds its context once at startup,
 * before the per-run scope is entered). `undefined` when unset — the seam then
 * falls back to its own default keep count.
 */
function resolveArtifactRetentionKeep(): number | undefined {
  const projectRoot = currentScope()?.projectContext?.projectRoot;
  return loadCliDefaults(projectRoot ?? process.cwd()).artifacts?.keep;
}

function resolveSessionRetentionDefaults() {
  const projectRoot = currentScope()?.projectContext?.projectRoot;
  return resolveSessionRetentionPolicy(loadCliDefaults(projectRoot ?? process.cwd()).sessions);
}

export function buildToolCliContext(opts: BuildToolCliContextOptions): ToolCliContextHandle {
  const log = opts.logger ?? defaultLogger;

  // Output plane owns the single `process.exitCode` write path + the four
  // `--json` emit seams (launch §5.5). Its `setExitCode` is the one threaded
  // into egress so the run's exit code has exactly one author.
  const outputPlane = createOutputPlane({ render: opts.render, logger: log });

  // Host planes with stable deps only (same lazy datastore resolver):
  //  - baseline/ratchet persistence + diff + exports (ADR-0036);
  //  - durable per-tool keyed JSON state (ADR-0042);
  //  - governance / entitlements / audit (H1-H3);
  //  - effectful egress (cloud sync + `--report-to` + SARIF file sink).
  const projectDatastore = createDatastoreResolver('project-seam', log);
  const baselineSeams = buildBaselineSeams({
    getDatastore: projectDatastore,
    logger: log,
  });
  const writeArtifact = createWriteArtifactSeam(log, {
    retentionKeep: resolveArtifactRetentionKeep(),
  });
  const ensureArtifactDir = createEnsureArtifactDirSeam(log);
  const stateSeams = buildStateSeams({ getDatastore: projectDatastore });
  const hostPlanes = buildHostPlanes({
    getDatastore: projectDatastore,
    logger: log,
  });

  // Host run-lifecycle plane (host-owned-run-timing Phase 1). The FACTORY holds
  // stable deps only — it must NOT start a lifecycle here. The lifecycle is
  // created inside the command action (mount-command-spec calls `beginRun()`
  // after RunScope entry, before the handler) or lazily on first `timing` read.
  const runPlane = createRunPlaneFactory({
    getDatastore: createDatastoreResolver('best-effort', log),
    sessionRetentionPolicy: resolveSessionRetentionDefaults(),
    logger: log,
  });

  // Public run seam (display-only timing) + internal action hooks (the mount
  // dispatch reads the hooks via cast). Both bind the run plane factory above;
  // there is NO public generic-session writer — tools return a contribution and
  // the action hook persists it.
  const runSession = createRunSessionSeam(runPlane);
  const runActionHooks = createRunActionHooks(runPlane);

  // Live plane binds the per-invocation registry (built in `main()`) to the run
  // plane so `renderLive` owns the live run lifecycle: it times the TTY
  // occupancy and persists the renderer's returned `session` contribution.
  const ioPlane = createIoPlane({
    setExitCode: outputPlane.setExitCode,
    logger: log,
    liveViews: opts.liveViews,
    runPlane,
    runSession,
  });

  const reportFailure = createReportFailure({
    getLogger: () => currentScope()?.logger ?? log,
    setExitCode: outputPlane.setExitCode,
    render: (result) => opts.render(result),
    emitError: outputPlane.emits.emitError,
    getDiagnostics: () => currentScope()?.diagnostics,
  });

  const ctx: ToolCliContext & RunActionHooks = {
    get scope(): RunScope {
      // The pre-action-hook (or explicit runWithScope in tests) enters the
      // RunScope via AsyncLocalStorage before the action body or any reader runs.
      // `cli.scope` (and currentScope()) surface the identical entered scope.
      // After Phase 3, readScope() no longer has holder fallbacks.
      return readScope();
    },
    render: (result) => opts.render(result as CommandResult),
    registerLiveView: ioPlane.register,
    renderLive: ioPlane.renderLive,
    maybeOpenReport: opts.maybeOpenReport,
    get logger(): Logger {
      return currentScope()?.logger ?? log;
    },
    reportFailure,
    setExitCode: outputPlane.setExitCode,
    ...outputPlane.emits, // emitJson / emitEnvelope / emitError / emitRaw
    deliverSignals: ioPlane.deliverSignals,
    writeSarif: ioPlane.writeSarif,
    writeArtifact,
    ensureArtifactDir,
    // Host baseline/ratchet plane seams (ADR-0036) — persistence + diff + exports.
    saveBaseline: baselineSeams.saveBaseline,
    compareBaseline: baselineSeams.compareBaseline,
    exportBaselineSarif: baselineSeams.exportBaselineSarif,
    exportBaselineFingerprints: baselineSeams.exportBaselineFingerprints,
    toolState: stateSeams, // ADR-0042: durable per-tool keyed JSON state
    runSession, // host-owned; shared with the live plane
    hostPlanes, // Host-owned governance / entitlements / audit plane (H1-H3)
    // Internal run-lifecycle hooks (not public ToolCliContext members; the mount
    // dispatch reads them via cast). beginRun marks the lifecycle start at the
    // command-action boundary; completeRun persists a returned contribution.
    ...runActionHooks,
  };

  return {
    ctx,
    getExitCode: outputPlane.getExitCode,
  };
}

/**
 * Build the host {@link ToolCliContext} the ADR-0054 M4-F hook-worker supervisor
 * serves host-RPC upcalls through, when running an EXTERNAL tool's
 * `collectReportData` / `sessionReplay` out-of-process from a HOST command
 * (`report` / `sessions show`) whose lean `CliCommandsContext` is not a full
 * `ToolCliContext`.
 *
 * It wires the SAME datastore-backed host planes the real context uses (baseline
 * / per-tool state / governance-audit-entitlements / egress + SARIF) against the
 * current entered scope, so any privileged effect a hook legitimately upcalls is
 * performed by the host through the real plane. The OUTPUT seams (render / emit*)
 * and the live-view + report-open seams are NOT part of a data-gathering hook's
 * contract; they throw loudly if a hook attempts them (fail loud, never a silent
 * no-op) — the worker shim already denies the live-view seams, and a hook has no
 * business rendering. This context is short-lived (one hook worker run).
 */
export function buildHostDispatchCtx(logger?: Logger): ToolCliContext {
  const log = logger ?? defaultLogger;
  const projectDatastore = createDatastoreResolver('project-seam', log);
  const baselineSeams = buildBaselineSeams({
    getDatastore: projectDatastore,
    logger: log,
  });
  const writeArtifact = createWriteArtifactSeam(log, {
    retentionKeep: resolveArtifactRetentionKeep(),
  });
  const ensureArtifactDir = createEnsureArtifactDirSeam(log);
  const stateSeams = buildStateSeams({ getDatastore: projectDatastore });
  const hostPlanes = buildHostPlanes({
    getDatastore: projectDatastore,
    logger: log,
  });
  const outputPlane = createOutputPlane({
    render: deniedHookSeam('render'),
    logger: log,
  });
  const ctx: ToolCliContext = {
    get scope(): RunScope {
      return readScope();
    },
    render: deniedHookSeam('render'),
    registerLiveView: deniedHookSeam('registerLiveView'),
    renderLive: deniedHookSeam('renderLive'),
    maybeOpenReport: deniedHookSeam('maybeOpenReport'),
    get logger(): Logger {
      return currentScope()?.logger ?? log;
    },
    reportFailure: deniedHookSeam('reportFailure'),
    setExitCode: outputPlane.setExitCode,
    ...outputPlane.emits,
    // Display-only timing seam (host-owned-run-timing); a hook never records a run.
    runSession: { timing: createRunTimer() },
    deliverSignals: deniedHookSeam('deliverSignals'),
    writeSarif: deniedHookSeam('writeSarif'),
    writeArtifact,
    ensureArtifactDir,
    saveBaseline: baselineSeams.saveBaseline,
    compareBaseline: baselineSeams.compareBaseline,
    exportBaselineSarif: baselineSeams.exportBaselineSarif,
    exportBaselineFingerprints: baselineSeams.exportBaselineFingerprints,
    toolState: stateSeams,
    hostPlanes,
  };
  return ctx;
}

/**
 * A seam stub for {@link buildHostDispatchCtx} that throws loudly when a
 * data-gathering hook worker attempts an output / render / egress seam it has no
 * business calling — fail loud, never a silent no-op (the worker shim already
 * denies the live-view seams; this is the host-side counterpart).
 *
 * @throws {Error} always — that is the point.
 */
function deniedHookSeam(seam: string): () => never {
  return () => {
    throw new Error(
      `host dispatch ctx: seam '${seam}' is not available to a data-gathering hook worker`,
    );
  };
}

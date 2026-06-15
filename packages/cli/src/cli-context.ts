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
  type RunScope,
  logger as defaultLogger,
  type Logger,
  type ToolCliContext,
} from '@opensip-cli/core';
import { type DataStore } from '@opensip-cli/datastore';

import { buildBaselineSeams } from './bootstrap/baseline-seams.js';
import { createEgressPlane } from './bootstrap/egress-plane.js';
import { buildHostPlanes } from './bootstrap/host-planes.js';
import { createLivePlane, type LiveViewRegistry } from './bootstrap/live-plane.js';
import { createOutputPlane } from './bootstrap/output-plane.js';
import {
  createRunActionHooks,
  createRunPlaneFactory,
  createRunSessionSeam,
  type RunActionHooks,
} from './bootstrap/run-plane.js';
import { getProjectDatastore, readScope } from './bootstrap/scope-access.js';
import { buildStateSeams } from './bootstrap/state-seams.js';

import type { CommandResult } from '@opensip-cli/contracts';

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

// Per-run scope + datastore readers live in `bootstrap/scope-access.ts`; the
// live-view registry lives in `bootstrap/live-plane.ts`. Both are re-exported
// here so existing importers (`main()` + the dynamic-import tests) keep their
// stable `cli-context.js` entry point while this module focuses on assembly.
export {
  buildDatastoreThunk,
  getCurrentProjectRoot,
  getOrOpenDatastore,
} from './bootstrap/scope-access.js';
export { createLiveViewRegistry, type LiveViewRegistry } from './bootstrap/live-plane.js';

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

  // Output plane owns the single `process.exitCode` write path + the four
  // `--json` emit seams (launch §5.5). Its `setExitCode` is the one threaded
  // into egress so the run's exit code has exactly one author.
  const outputPlane = createOutputPlane({ render: opts.render, logger: log });

  // Host planes with stable deps only (same lazy datastore resolver):
  //  - baseline/ratchet persistence + diff + exports (ADR-0036);
  //  - durable per-tool keyed JSON state (ADR-0042);
  //  - governance / entitlements / audit (H1-H3);
  //  - effectful egress (cloud sync + `--report-to` + SARIF file sink).
  const baselineSeams = buildBaselineSeams({ getDatastore: getProjectDatastore, logger: log });
  const stateSeams = buildStateSeams({ getDatastore: getProjectDatastore });
  const hostPlanes = buildHostPlanes({ getDatastore: getProjectDatastore, logger: log });
  const egressPlane = createEgressPlane({ setExitCode: outputPlane.setExitCode, logger: log });

  // Host run-lifecycle plane (host-owned-run-timing Phase 1). The FACTORY holds
  // stable deps only — it must NOT start a lifecycle here. The lifecycle is
  // created inside the command action (mount-command-spec calls `beginRun()`
  // after RunScope entry, before the handler) or lazily on first `timing` read.
  const runPlane = createRunPlaneFactory({
    // Best-effort datastore resolver via the entered scope thunk (no direct /
    // global access). Returns undefined when no project/datastore is in scope.
    getDatastore: () => {
      try {
        const thunk = readScope().datastore;
        return thunk ? (thunk() as DataStore) : undefined;
      } catch (error) {
        // @swallow-ok no entered scope / no datastore in scope is normal for
        // non-project commands and tests; degrade to "no datastore" (the run
        // plane then no-ops). Debug-log for diagnosability.
        log.debug?.({
          evt: 'cli.context.datastore_unavailable',
          module: MODULE_TAG,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    },
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
  const livePlane = createLivePlane({ liveViews: opts.liveViews, runPlane, runSession });

  const ctx: ToolCliContext & RunActionHooks = {
    get scope(): RunScope {
      // The pre-action-hook (or explicit runWithScope in tests) enters the
      // RunScope via AsyncLocalStorage before the action body or any reader runs.
      // `cli.scope` (and currentScope()) surface the identical entered scope.
      // After Phase 3, readScope() no longer has holder fallbacks.
      return readScope();
    },
    render: (result) => opts.render(result as CommandResult),
    registerLiveView: livePlane.register,
    renderLive: livePlane.renderLive,
    maybeOpenReport: opts.maybeOpenReport,
    logger: log,
    setExitCode: outputPlane.setExitCode,
    ...outputPlane.emits, // emitJson / emitEnvelope / emitError / emitRaw
    deliverSignals: egressPlane.deliverSignals,
    writeSarif: egressPlane.writeSarif,
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

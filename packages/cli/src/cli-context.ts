/**
 * cli-context — live-view registry, scope construction, and
 * `ToolCliContext` factory. Three related concerns:
 *
 *  1. `createLiveViewRegistry` — backs `registerLiveView` / `renderLive`. A tool
 *     registers its Ink view by key; an unregistered key throws
 *     `UnknownLiveViewError` rather than masking a mistyped key with a static render.
 *  2. `setCliRuntimeContextForRun` — the one-time bootstrap handoff `main()` uses to
 *     pass the locally-constructed `LanguageRegistry` / `ToolRegistry` / manifests to
 *     the pre-action-hook (which reads them via `getCurrentRegistriesForScope()` /
 *     `getToolManifestsForRun()` when it builds the per-run `RunScope`). Per-run
 *     project + datastore hang off the entered scope, not module globals.
 *  3. `buildToolCliContext` — assembles the `ToolCliContext` handed to each tool and
 *     host command, including the output/raw/error emit seams (delegated to
 *     `renderOutcome` / `renderRaw`) and the single `setExitCode` write path
 *     (`process.exitCode` is mutated only here).
 *
 * Lazy datastore: a closure-based thunk caches the open DataStore on first access and
 * lands on `RunScope.datastore`; paths that never touch it never materialise
 * `.runtime/datastore.sqlite`.
 */

import {
  type RunScope,
  SystemError,
  UnknownLiveViewError,
  currentScope,
  logger as defaultLogger,
  resolveProjectPaths,
  type LanguageRegistry,
  type LiveViewRenderer,
  type Logger,
  type ProjectContext,
  type ToolCliContext,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';

import { buildBaselineSeams } from './bootstrap/baseline-seams.js';
import { deliverEnvelope, writeEnvelopeSarif } from './bootstrap/deliver-envelope.js';
import { buildHostPlanes } from './bootstrap/host-planes.js';
import { resetInitializedToolIdsForTest } from './bootstrap/process-idempotency.js';
import { buildStateSeams } from './bootstrap/state-seams.js';
import {
  outcomeFromEnvelope,
  outcomeFromErrorMessage,
  outcomeFromResult,
} from './commands/assemble-outcome.js';
import { renderOutcome, renderRaw } from './commands/render-outcome.js';
import { resetTelemetryStartedForTest } from './telemetry/sdk-init.js';

import type { CommandResult, SignalEnvelope } from '@opensip-cli/contracts';

// ---------------------------------------------------------------------------
// Minimal bootstrap handoff context (Phase 3 of host-planes-scope-seams-hygiene).
//
// Registries + manifests/provenance are created in `main()` *before* the pre-action
// hook can construct+enter the RunScope, so a tiny process-scoped handoff bag carries
// them to the hook. After the hook calls enterScope(), *all* per-run state
// (project, datastore thunk, diagnostics, etc.) is read exclusively via currentScope()
// (ALS). The old general "pre-scope holder + scopeEntered guard + runScope mirror"
// has been removed from production paths.
// ---------------------------------------------------------------------------

interface CliRuntimeContext {
  readonly languages?: LanguageRegistry;
  readonly tools?: ToolRegistry;
  readonly toolProvenance: readonly ToolProvenance[];
  readonly toolManifests: readonly ToolPluginManifest[];
}

// Bootstrap handoff holder (minimal, production use only for registries/manifests/provenance
// created in main() before the pre-action hook runs and can build/enter the RunScope).
// Per-run *state* (scope, project, datastore thunk, etc.) MUST come from currentScope() after
// enterScope (ALS). This tiny holder is *not* a general pre-scope state bag; after Phase 3 of
// host-planes-scope-seams-hygiene it is used solely for the one-time bootstrap handoff of the
// Language/Tool registries and manifests. Test helpers retain a narrow surface.
// @fitness-ignore-next-line context-leakage -- single-process bootstrap handoff, reset per run.
let currentRuntimeContext: CliRuntimeContext = {
  toolProvenance: [],
  toolManifests: [],
};

function updateRuntimeContext(patch: Partial<CliRuntimeContext>): void {
  currentRuntimeContext = { ...currentRuntimeContext, ...patch };
}

export function setCliRuntimeContextForRun(opts: {
  readonly languages: LanguageRegistry;
  readonly tools: ToolRegistry;
  readonly toolProvenance?: readonly ToolProvenance[];
  readonly toolManifests?: readonly ToolPluginManifest[];
}): void {
  resetInitializedToolIdsForTest();
  resetTelemetryStartedForTest();
  currentRuntimeContext = {
    languages: opts.languages,
    tools: opts.tools,
    toolProvenance: opts.toolProvenance ?? [],
    toolManifests: opts.toolManifests ?? [],
  };
}

/**
 * Back-compat / test-only helper. Kept for isolated tests; production code never uses the
 * pre-scope holder for per-run state after hygiene Phase 3.
 */
export function setCliRegistriesForRun(opts: {
  readonly languages: LanguageRegistry;
  readonly tools: ToolRegistry;
}): void {
  // @fitness-ignore-next-line env-via-registry -- NODE_ENV is the test-runtime meta-guard that makes this pre-scope helper *throw* if reached outside tests; it is not governed application configuration (intentionally absent from host-env-specs), so it does not flow through EnvRegistry.
  if (process.env.NODE_ENV !== 'test') {
    throw new SystemError(
      'Direct use of pre-scope registry setter outside tests is forbidden. ' +
        'Registries are handed to the per-run scope at construction time.',
      { code: 'SYSTEM.SCOPE.HOLDER_MISUSE' },
    );
  }
  resetInitializedToolIdsForTest();
  resetTelemetryStartedForTest();
  updateRuntimeContext({ languages: opts.languages, tools: opts.tools });
}

/**
 * Read the per-run registries installed by `setCliRuntimeContextForRun` (bootstrap handoff only).
 * Used by pre-action-hook to construct the RunScope before enterScope. After enter, all
 * production code reads registries via currentScope().languages / .tools (see RunScope).
 */
export function getCurrentRegistriesForScope(): {
  readonly languages: LanguageRegistry;
  readonly tools: ToolRegistry;
} {
  const { languages, tools } = currentRuntimeContext;
  if (!languages || !tools) {
    throw new SystemError(
      'getCurrentRegistriesForScope() called before setCliRuntimeContextForRun(). ' +
        'main() must construct LanguageRegistry/ToolRegistry and install the ' +
        'CLI runtime context before any preAction hook runs.',
      { code: 'SYSTEM.BOOTSTRAP.REGISTRIES_UNSET' },
    );
  }
  return { languages, tools };
}

/**
 * Record the provenance for the tools admitted through the launch
 * compatibility gate. Called by `main()` once per invocation from the
 * `bootstrapCli` result, BEFORE Commander dispatch. Read by `plugin list`
 * (Phase 4) via {@link getToolProvenanceForRun}.
 */
export function setToolProvenanceForRun(records: readonly ToolProvenance[]): void {
  updateRuntimeContext({ toolProvenance: records });
}

/**
 * Read the admitted-tool provenance recorded by
 * {@link setToolProvenanceForRun}. Empty until bootstrap has run (e.g. in
 * isolated unit tests that never bootstrap).
 */
export function getToolProvenanceForRun(): readonly ToolProvenance[] {
  return currentRuntimeContext.toolProvenance;
}

/**
 * Read the admitted-tool manifests recorded for this invocation (release
 * launch, §5.3) — installed cohesively by {@link setCliRuntimeContextForRun}.
 * Read by the pre-action-hook to register each tool's manifest-declared
 * capability domains into the per-run capability registry. Empty until
 * bootstrap has run (e.g. in isolated unit tests that never bootstrap) — the
 * pre-action-hook then registers no manifest domains.
 */
export function getToolManifestsForRun(): readonly ToolPluginManifest[] {
  return currentRuntimeContext.toolManifests;
}

/**
 * Strict reader: after Phase 3 hygiene, the only way to obtain the per-run scope is
 * currentScope() (entered by pre-action-hook or explicit runWithScope in tests).
 * All previous holder fallbacks removed. Non-action paths (report, errors) that need
 * scope must ensure entry or restructure to occur inside an entered action.
 */
function readScope(): RunScope {
  const bound = currentScope();
  if (!bound) {
    throw new SystemError(
      'CLI scope accessed before pre-action-hook constructed and entered it (enterScope + ALS). ' +
        'All production paths (tool actions, host commands, report/error seams) must run inside ' +
        'an entered RunScope. See host-planes-scope-seams-hygiene plan Phase 3 and currentScope().',
      { code: 'SYSTEM.SCOPE.NOT_ENTERED' },
    );
  }
  return bound;
}

/**
 * Read the current project root. Convenience for non-tool bootstrap
 * helpers (e.g. `maybeOpenReport`) that need the project root but
 * don't carry a ToolCliContext. Throws if accessed before pre-action-hook
 * constructed the scope.
 */
export function getCurrentProjectRoot(): string {
  const project = readScope().projectContext;
  if (!project) {
    throw new SystemError(
      'getCurrentProjectRoot() called before pre-action-hook resolved the context.',
      { code: 'SYSTEM.BOOTSTRAP.PROJECT_UNSET' },
    );
  }
  return project.projectRoot;
}

/**
 * Build a closure-based datastore thunk for the given project.
 * Caches the open DataStore on first access. The pre-action-hook
 * wires the result into `RunScope.datastore` so tools and CLI
 * commands reach the same instance.
 *
 * Throws when called outside a project scope — callers must check
 * `project.scope === 'project'` first or handle the throw as a
 * "no project found" error.
 */
export function buildDatastoreThunk(
  project: ProjectContext,
  log: Logger = defaultLogger,
): () => DataStore {
  let cached: DataStore | undefined;
  return () => {
    if (cached) return cached;
    if (project.scope !== 'project') {
      throw new SystemError(
        'Datastore accessed in a non-project context. The action body should have ' +
          'errored earlier with "No OpenSIP CLI project found" before touching this.',
        { code: 'SYSTEM.BOOTSTRAP.DATASTORE_OUTSIDE_PROJECT' },
      );
    }
    const path = `${resolveProjectPaths(project.projectRoot).runtimeDir}/datastore.sqlite`;
    cached = DataStoreFactory.open({ backend: 'sqlite', path });
    log.info({
      evt: 'cli.datastore.opened',
      module: 'cli:context',
      path,
    });
    return cached;
  };
}

/**
 * Open (or return cached) project-local SQLite DataStore via the
 * scope's datastore thunk. Shared between tool action bodies and
 * the host commands (e.g. `sessions`, in `host-subcommand-groups.ts`) so
 * both paths are equally lazy.
 *
 * Throws when called outside a project scope — see
 * `buildDatastoreThunk`'s contract.
 */
export function getOrOpenDatastore(_log: Logger = defaultLogger): DataStore {
  const thunk = readScope().datastore;
  return thunk() as DataStore;
}

export interface LiveViewRegistry {
  readonly register: (key: string, renderer: LiveViewRenderer) => void;
  readonly render: (key: string, args: unknown) => Promise<void>;
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
    async render(key, args) {
      const renderer = renderers.get(key);
      if (!renderer) {
        throw new UnknownLiveViewError(key);
      }
      await renderer(args);
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

  // Host baseline/ratchet plane seams (ADR-0036): persistence + diff + exports.
  // Bound to the lazy project datastore (resolved per call, like the run paths).
  const baselineSeams = buildBaselineSeams({ getDatastore: getOrOpenDatastore, logger: log });
  const stateSeams = buildStateSeams({ getDatastore: getOrOpenDatastore }); // ADR-0042, same lazy resolver
  const hostPlanes = buildHostPlanes({ getDatastore: getOrOpenDatastore, logger: log });

  const ctx: ToolCliContext = {
    get scope(): RunScope {
      // The pre-action-hook (or explicit runWithScope in tests) enters the
      // RunScope via AsyncLocalStorage before the action body or any reader runs.
      // `cli.scope` (and currentScope()) surface the identical entered scope.
      // After Phase 3, readScope() no longer has holder fallbacks.
      return readScope();
    },
    render: (result) => opts.render(result as CommandResult),
    registerLiveView: opts.liveViews.register,
    renderLive: opts.liveViews.render,
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
    emitJson: (value) => {
      void renderOutcome(outcomeFromResult(value, exitCode ?? 0), {
        jsonRequested: true,
        render: opts.render,
      });
    },
    emitEnvelope: (envelope) => {
      void renderOutcome(outcomeFromEnvelope(envelope as SignalEnvelope, exitCode ?? 0), {
        jsonRequested: true,
        render: opts.render,
      });
    },
    // Structured error machine-output (retires the bare `emitJson({ error })`
    // shape the `one-outcome-shape` guardrail forbids). The handler hands a
    // diagnosed failure (message + exit code, optional suggestion); the host
    // wraps it as a `status:'error'` outcome. `exitCode` is also threaded to
    // `setExitCode` so the process exit and the reported outcome agree.
    emitError: (detail) => {
      setExitCode(detail.exitCode);
      void renderOutcome(
        outcomeFromErrorMessage({
          message: detail.message,
          exitCode: detail.exitCode,
          ...(detail.suggestion === undefined ? {} : { suggestion: detail.suggestion }),
          ...(detail.code === undefined ? {} : { code: detail.code }),
        }),
        { jsonRequested: true, render: opts.render },
      );
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
    hostPlanes, // Host-owned governance / entitlements / audit plane (H1-H3)
  };

  return {
    ctx,
    getExitCode: () => exitCode,
  };
}

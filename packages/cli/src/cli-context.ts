/**
 * cli-context — live-view registry, scope construction, and
 * `ToolCliContext` factory.
 *
 * Three related concerns live here:
 *
 *  1. `createLiveViewRegistry` — backs `ToolCliContext.registerLiveView`
 *     / `renderLive`. Each tool's `register(cli)` calls
 *     `cli.registerLiveView(key, renderer)`; `renderLive(key, args)`
 *     looks the renderer up. An unregistered key throws
 *     `UnknownLiveViewError` rather than silently falling back to a
 *     static render — the latter masked bugs where a tool mistyped its
 *     view key.
 *
 *  2. `setCliRegistriesForRun` — invoked by `main()` once per
 *     invocation, after the `LanguageRegistry` and `ToolRegistry` are
 *     constructed locally. The pre-action-hook reads them via
 *     `getCurrentRegistriesForScope()` when it builds the per-run
 *     `RunScope`. Module-level holders are kept narrowly: only the two
 *     registries (`languages`, `tools`) and the *constructed* RunScope
 *     itself live here. The legacy `currentProjectContext` and
 *     `datastoreCache` module globals retired in T1 deferred Item D —
 *     project + datastore now hang off the entered RunScope.
 *
 *  3. `buildToolCliContext` — assembles the `ToolCliContext` the
 *     dispatcher hands to each tool. Captures the exit code through a
 *     single `setExitCode` write path. `process.exitCode` is mutated
 *     in exactly one place (here); commands and the catch handler all
 *     route through `ctx.setExitCode`.
 *
 * Lazy datastore: pre-action-hook constructs a closure-based thunk
 * that caches the open DataStore on first access. The thunk lands on
 * `RunScope.datastore`; tools read it via `cli.scope.datastore()` (typed
 * as `unknown` per the Tool contract). Dry-runs and error paths that never
 * touch the datastore never materialise `.runtime/datastore.sqlite`.
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
} from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';

import { deliverEnvelope, writeEnvelopeSarif } from './bootstrap/deliver-envelope.js';
import {
  outcomeFromEnvelope,
  outcomeFromErrorMessage,
  outcomeFromResult,
} from './commands/assemble-outcome.js';
import { renderOutcome } from './commands/render-outcome.js';

import type { CommandResult, SignalEnvelope } from '@opensip-tools/contracts';
import type { Command } from 'commander';

// ---------------------------------------------------------------------------
// Per-invocation holders.
//
// The two registries are constructed in `main()` and need to be visible to
// pre-action-hook (which builds the scope). They CAN'T live on the entered
// scope because they're needed BEFORE the scope is built.
//
// The `currentRunScope` holder mirrors the entered AsyncLocalStorage scope.
// It's strictly redundant with `currentScope()` for tools (which always
// read via ALS), but the CLI's non-action paths — `maybeOpenDashboard`,
// the host `sessions` command — call `getCurrentProjectRoot()` /
// `getOrOpenDatastore()` from outside the ALS-tracked async chain in
// rare cases (post-action handlers, error printers). The holder lets
// those callers reach the scope without each one having to thread
// `cli` through every signature.
// ---------------------------------------------------------------------------

let currentLanguageRegistry: LanguageRegistry | undefined;
let currentToolRegistry: ToolRegistry | undefined;
let currentRunScope: RunScope | undefined;
// Provenance for the tools admitted through the 2.8.0 compatibility gate
// (bundled + installed). Set once per invocation by main() from the
// bootstrap result; read by `plugin list` (Phase 4). Same per-run-holder
// pattern as the registries above — needed before the RunScope is built,
// so it can't hang off the scope.
let currentToolProvenance: readonly ToolProvenance[] = [];
// Manifests for the tools admitted this invocation (release 2.10.0, §5.3).
// Set once per invocation by main() from the bootstrap result; read by the
// pre-action-hook to register each tool's manifest-declared capability domains
// into the per-run capability registry. Same per-run-holder pattern as the
// registries/provenance above — the manifests are read at bootstrap (before
// any scope exists) but consumed when the scope is built.
let currentToolManifests: readonly ToolPluginManifest[] = [];

/**
 * Called by `main()` after constructing the per-invocation registries so
 * the pre-action-hook can build a scope that points at them. Replaces
 * the previously-exported `defaultLanguageRegistry` /
 * `defaultToolRegistry` module globals (T1 Item A).
 */
export function setCliRegistriesForRun(opts: {
  readonly languages: LanguageRegistry;
  readonly tools: ToolRegistry;
}): void {
  currentLanguageRegistry = opts.languages;
  currentToolRegistry = opts.tools;
}

/**
 * Read the per-run registries set by `setCliRegistriesForRun`. Throws
 * when the registries have not been set — that indicates a bootstrap
 * ordering bug (the CLI composition root must call
 * `setCliRegistriesForRun` before any preAction hook fires).
 */
export function getCurrentRegistriesForScope(): {
  readonly languages: LanguageRegistry;
  readonly tools: ToolRegistry;
} {
  if (!currentLanguageRegistry || !currentToolRegistry) {
    throw new SystemError(
      'getCurrentRegistriesForScope() called before setCliRegistriesForRun(). ' +
        'main() must construct LanguageRegistry/ToolRegistry and call ' +
        'setCliRegistriesForRun before any preAction hook runs.',
      { code: 'SYSTEM.BOOTSTRAP.REGISTRIES_UNSET' },
    );
  }
  return { languages: currentLanguageRegistry, tools: currentToolRegistry };
}

/**
 * Record the provenance for the tools admitted through the 2.8.0
 * compatibility gate. Called by `main()` once per invocation from the
 * `bootstrapCli` result, BEFORE Commander dispatch. Read by `plugin list`
 * (Phase 4) via {@link getToolProvenanceForRun}.
 */
export function setToolProvenanceForRun(records: readonly ToolProvenance[]): void {
  currentToolProvenance = records;
}

/**
 * Read the admitted-tool provenance recorded by
 * {@link setToolProvenanceForRun}. Empty until bootstrap has run (e.g. in
 * isolated unit tests that never bootstrap).
 */
export function getToolProvenanceForRun(): readonly ToolProvenance[] {
  return currentToolProvenance;
}

/**
 * Record the manifests for the tools admitted this invocation (release
 * 2.10.0, §5.3). Called by `main()` once per invocation from the bootstrap
 * result, BEFORE Commander dispatch. Read by the pre-action-hook to register
 * each tool's manifest-declared capability domains into the per-run
 * capability registry (the deferred placeholder is then replaced by the
 * tool's real registrar).
 */
export function setToolManifestsForRun(manifests: readonly ToolPluginManifest[]): void {
  currentToolManifests = manifests;
}

/**
 * Read the admitted-tool manifests recorded by {@link setToolManifestsForRun}.
 * Empty until bootstrap has run (e.g. in isolated unit tests that never
 * bootstrap) — the pre-action-hook then registers no manifest domains.
 */
export function getToolManifestsForRun(): readonly ToolPluginManifest[] {
  return currentToolManifests;
}

/**
 * Called by pre-action-hook AFTER `enterScope(scope)` so the constructed
 * scope is mirrored on a per-run holder. Tools always read via
 * `currentScope()`; the holder exists for non-action paths that can't
 * reach ALS (post-action callbacks, error printers).
 */
export function setCurrentRunScope(scope: RunScope): void {
  currentRunScope = scope;
}

function readScope(): RunScope {
  const bound = currentScope() ?? currentRunScope;
  if (!bound) {
    throw new SystemError(
      'CLI scope accessed before pre-action-hook constructed it. ' +
        'This indicates a bootstrap-order bug — tools and CLI commands must access ' +
        'cli.scope / getCurrentProjectRoot() / getOrOpenDatastore() only inside an ' +
        'action body.',
      { code: 'SYSTEM.BOOTSTRAP.SCOPE_UNSET' },
    );
  }
  return bound;
}

/**
 * Read the current project root. Convenience for non-tool bootstrap
 * helpers (e.g. `maybeOpenDashboard`) that need the project root but
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
          'errored earlier with "No opensip-tools project found" before touching this.',
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

export function createLiveViewRegistry(
  log: Logger = defaultLogger,
): LiveViewRegistry {
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
  readonly program: Command;
  readonly render: (result: CommandResult) => Promise<void>;
  readonly liveViews: LiveViewRegistry;
  readonly maybeOpenDashboard: (opts: {
    openRequested: boolean;
    jsonOutput: boolean;
  }) => Promise<void>;
  readonly logger?: Logger;
}

export interface ToolCliContextHandle {
  readonly ctx: ToolCliContext;
  readonly getExitCode: () => number | undefined;
}

export function buildToolCliContext(
  opts: BuildToolCliContextOptions,
): ToolCliContextHandle {
  const log = opts.logger ?? defaultLogger;
  let exitCode: number | undefined;

  const setExitCode = (code: number): void => {
    exitCode = code;
    process.exitCode = code;
  };

  const ctx: ToolCliContext = {
    program: opts.program,
    get scope(): RunScope {
      // The pre-action-hook constructs a RunScope and calls `enterScope`
      // (AsyncLocalStorage.enterWith) so the scope is bound for the
      // entire dynamic extent of the action body. `cli.scope` returns
      // that entered scope so tools and `currentScope()` readers agree
      // on identity. `readScope` falls back to `currentRunScope` for
      // non-action paths that can't reach ALS.
      return readScope();
    },
    render: (result) => opts.render(result as CommandResult),
    registerLiveView: opts.liveViews.register,
    renderLive: opts.liveViews.render,
    maybeOpenDashboard: opts.maybeOpenDashboard,
    logger: log,
    setExitCode,
    // 2.12.0 (§5.5): every machine output the host emits is wrapped in a
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
        }),
        { jsonRequested: true, render: opts.render },
      );
    },
    // The root owns all effectful egress (ADR-0011 / ADR-0008): cloud sync via
    // the run's signal sink + `--report-to` SARIF upload. Tools call this once
    // per run; `setExitCode` is threaded so a `--report-to` failure on an
    // otherwise-passing run can claim exit 4.
    deliverSignals: async (envelope, deliverOpts) => {
      await deliverEnvelope(envelope as SignalEnvelope, {
        cwd: deliverOpts.cwd,
        reportTo: deliverOpts.reportTo,
        apiKey: deliverOpts.apiKey,
        runFailed: deliverOpts.runFailed,
        setExitCode,
        logger: log,
      });
    },
    // Root-owned SARIF-file sink (ADR-0011): the one place that formats an
    // envelope to SARIF and writes it to disk, so tools that export SARIF to a
    // file (e.g. `graph sarif-export`) never import `@opensip-tools/output`.
    writeSarif: (envelope, path) => writeEnvelopeSarif(envelope as SignalEnvelope, path),
  };

  return {
    ctx,
    getExitCode: () => exitCode,
  };
}

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
 * `RunScope.datastore`; tools read `cli.scope.datastore()` (typed as
 * `unknown` per the Tool contract). The legacy `cli.datastore` getter
 * routes through the same thunk for back-compat. Dry-runs and error
 * paths that never touch the datastore never materialise
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
  type ToolRegistry,
} from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';

import type { CommandResult } from '@opensip-tools/contracts';
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
// `register-sessions.ts` — call `getCurrentProjectRoot()` /
// `getOrOpenDatastore()` from outside the ALS-tracked async chain in
// rare cases (post-action handlers, error printers). The holder lets
// those callers reach the scope without each one having to thread
// `cli` through every signature.
// ---------------------------------------------------------------------------

let currentLanguageRegistry: LanguageRegistry | undefined;
let currentToolRegistry: ToolRegistry | undefined;
let currentRunScope: RunScope | undefined;

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
 * CLI-only commands (`register-sessions.ts`, etc.) so both paths are
 * equally lazy.
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
    setExitCode: (code) => {
      exitCode = code;
      process.exitCode = code;
    },
    emitJson: (value) => {
      process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    },
  };

  return {
    ctx,
    getExitCode: () => exitCode,
  };
}

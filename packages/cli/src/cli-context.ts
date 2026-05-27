/**
 * cli-context — live-view registry and `ToolCliContext` factory.
 *
 * Two related concerns live here:
 *
 *  1. `createLiveViewRegistry` — backs `ToolCliContext.registerLiveView`
 *     / `renderLive`. Each tool's `register(cli)` calls
 *     `cli.registerLiveView(key, renderer)`; `renderLive(key, args)`
 *     looks the renderer up. An unregistered key throws
 *     `UnknownLiveViewError` rather than silently falling back to a
 *     static render — the latter masked bugs where a tool mistyped its
 *     view key.
 *
 *  2. `buildToolCliContext` — assembles the `ToolCliContext` the
 *     dispatcher hands to each tool. Captures the exit code through a
 *     single `setExitCode` write path. `process.exitCode` is mutated
 *     in exactly one place (here); commands and the catch handler all
 *     route through `ctx.setExitCode`.
 *
 * Lazy holders: `project` and `datastore` are exposed via getters that
 * read from module-level holders mutated by pre-action-hook. This makes
 * datastore open lazy — `openSqliteBackend`'s `mkdirSync` only fires
 * when a tool's action body genuinely reads `cli.datastore` for the
 * first time. Dry-runs and error paths that never touch the datastore
 * never materialise `.runtime/datastore.sqlite`.
 */

import {
  RunScope,
  UnknownLiveViewError,
  logger as defaultLogger,
  resolveProjectPaths,
  type LiveViewRenderer,
  type Logger,
  type ProjectContext,
  type ToolCliContext,
} from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';

import type { CommandResult } from '@opensip-tools/contracts';
import type { Command } from 'commander';

// ---------------------------------------------------------------------------
// Per-run holders. Mutated by pre-action-hook via the exported setters.
// Module-level globals are fine for the single-process CLI; if an
// in-process harness ever runs multiple invocations concurrently, a
// per-invocation context bag is the right next step.
// ---------------------------------------------------------------------------

let currentProjectContext: ProjectContext | undefined;
let datastoreCache: DataStore | undefined;

/** Called by pre-action-hook once context is resolved for the run. */
export function setProjectContextForRun(ctx: ProjectContext): void {
  currentProjectContext = ctx;
  datastoreCache = undefined;
}

/**
 * Read the current project root. Convenience for non-tool bootstrap
 * helpers (e.g. `maybeOpenDashboard`) that need the project root but
 * don't carry a ToolCliContext. Throws if accessed before preAction
 * resolves the context.
 */
export function getCurrentProjectRoot(): string {
  if (!currentProjectContext) {
    throw new Error('getCurrentProjectRoot() called before pre-action-hook resolved the context.');
  }
  return currentProjectContext.projectRoot;
}

/**
 * Open (or return cached) project-local SQLite DataStore. Shared between
 * `ToolCliContext.datastore` (tool action bodies) and CLI-only commands
 * (`register-sessions.ts`, etc.) so both paths are equally lazy.
 *
 * Throws when called outside a project scope — callers must check
 * `project.scope === 'project'` first or handle the throw as a
 * "no project found" error.
 */
export function getOrOpenDatastore(log: Logger = defaultLogger): DataStore {
  if (datastoreCache) return datastoreCache;
  const project = currentProjectContext;
  if (!project) {
    throw new Error('Datastore accessed before pre-action-hook resolved the project context.');
  }
  if (project.scope !== 'project') {
    throw new Error(
      'Datastore accessed in a non-project context. The action body should have ' +
        'errored earlier with "No opensip-tools project found" before touching this.',
    );
  }
  const path = `${resolveProjectPaths(project.projectRoot).runtimeDir}/datastore.sqlite`;
  datastoreCache = DataStoreFactory.open({ backend: 'sqlite', path });
  log.info({
    evt: 'cli.datastore.opened',
    module: 'cli:context',
    path,
  });
  return datastoreCache;
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
      // Construct a fresh RunScope view per access. The scope is a
      // value type holding the current projectContext + a thunk for
      // the lazy datastore open. Reading it inside a command action
      // body sees the current state set by pre-action-hook.
      //
      // Phase 5 leaves the underlying `currentProjectContext` holder
      // in place; Phase 6 / a follow-up plan retires the holder by
      // moving scope construction into pre-action-hook and threading
      // it via Commander's actionCommand state.
      if (!currentProjectContext) {
        throw new Error(
          'ToolCliContext.scope accessed before pre-action-hook resolved the project context. ' +
            'This indicates a bootstrap-order bug — tools should not access scope ' +
            'during register(); only inside command action bodies.',
        );
      }
      return new RunScope({
        logger: log,
        projectContext: currentProjectContext,
        datastore: () => getOrOpenDatastore(log),
      });
    },
    get project(): ProjectContext {
      if (!currentProjectContext) {
        throw new Error(
          'ToolCliContext.project accessed before pre-action-hook resolved it. ' +
            'This indicates a bootstrap-order bug — tools should not access project ' +
            'context during register(); only inside command action bodies.',
        );
      }
      return currentProjectContext;
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
    get datastore(): unknown {
      return getOrOpenDatastore(log);
    },
  };

  return {
    ctx,
    getExitCode: () => exitCode,
  };
}

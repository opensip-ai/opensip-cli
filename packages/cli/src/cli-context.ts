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
 * Factored out of `index.ts` so both pieces can be tested in isolation
 * without booting the full Commander program.
 */

import {
  UnknownLiveViewError,
  logger as defaultLogger,
  type LiveViewRenderer,
  type Logger,
  type ToolCliContext,
} from '@opensip-tools/core';

import type { CommandResult } from '@opensip-tools/contracts';
import type { Command } from 'commander';

export interface LiveViewRegistry {
  readonly register: (key: string, renderer: LiveViewRenderer) => void;
  readonly render: (key: string, args: unknown) => Promise<void>;
  readonly has: (key: string) => boolean;
}

/**
 * Build a fresh live-view registry. Registration is first-writer-wins
 * (matches `ToolRegistry.register` policy) — a duplicate key triggers a
 * structured `cli.live_view.duplicate` warning via the supplied logger
 * and the second call is silently ignored.
 *
 * Returns an opaque handle so the underlying `Map` doesn't leak; the
 * CLI passes only `register` / `render` through to `ToolCliContext`.
 */
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
  readonly builtinLiveViews: ReadonlyMap<string, LiveViewRenderer>;
  readonly maybeOpenDashboard: (opts: {
    openRequested: boolean;
    jsonOutput: boolean;
    cwd: string;
  }) => Promise<void>;
  readonly logger?: Logger;
  /**
   * v2 persistence handle. Threaded from `bootstrap/index.ts` (the
   * DataStoreFactory.open call). Tools cast to `DataStore` from
   * `@opensip-tools/datastore` at use time. Loosely typed `unknown` to
   * keep the CLI decoupled from datastore at the type layer.
   */
  readonly datastore: unknown;
}

/**
 * Handle returned by `buildToolCliContext`. The `ctx` shape is what the
 * dispatcher passes to `tool.register(cli)`. `getExitCode` is a debug
 * affordance — the catch handler reads it for structured logging when
 * a parse error rolls in. The caller still owns `process.exit`.
 */
export interface ToolCliContextHandle {
  readonly ctx: ToolCliContext;
  readonly getExitCode: () => number | undefined;
}

/**
 * Build the `ToolCliContext` the dispatcher hands to each tool. The
 * exit code is captured in this closure; `setExitCode` is the single
 * `process.exitCode` mutator in the codebase. Tools, CLI commands, and
 * the catch handler all funnel through `ctx.setExitCode`.
 */
export function buildToolCliContext(
  opts: BuildToolCliContextOptions,
): ToolCliContextHandle {
  const log = opts.logger ?? defaultLogger;
  let exitCode: number | undefined;

  const ctx: ToolCliContext = {
    program: opts.program,
    render: (result) => opts.render(result as CommandResult),
    registerLiveView: opts.liveViews.register,
    renderLive: opts.liveViews.render,
    builtinLiveViews: opts.builtinLiveViews,
    maybeOpenDashboard: opts.maybeOpenDashboard,
    logger: log,
    setExitCode: (code) => {
      exitCode = code;
      process.exitCode = code;
    },
    // Single IO seam for tool-emitted JSON. Every `--json` branch in a
    // tool funnels through here so the CLI can later add envelope
    // wrappers, file output, or piping without touching tool code.
    emitJson: (value) => {
      process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    },
    datastore: opts.datastore,
  };

  return {
    ctx,
    getExitCode: () => exitCode,
  };
}

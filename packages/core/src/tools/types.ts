/**
 * Tool plugin contract.
 *
 * A Tool is a self-contained capability (fitness, simulation, future
 * audit/lint/etc.) that contributes one or more CLI subcommands. The
 * CLI is a generic dispatcher that walks the registered tool list and
 * delegates command definition to each tool's `register(cli)` method.
 *
 * Tools are first-party (declared as a direct dep of @opensip-tools/cli)
 * or third-party (any npm package whose package.json declares
 * `opensipTools.kind === 'tool'` — discovered via tool-package-discovery).
 *
 * Contract:
 *   - `commands[]` carries metadata only (name + description, used for
 *     `--help` listings).
 *   - The actual subcommand wiring is done by each tool's
 *     `register(cli)` method, which receives a `ToolCliContext` with
 *     the Commander program + shared UX helpers (Ink renderer,
 *     dashboard auto-open, logger).
 *
 * The two-method shape (commands[] for metadata; register() for wiring)
 * keeps `--help` discovery cheap (no per-tool Commander invocation
 * required to enumerate available commands) while letting each tool
 * own the full option-parsing surface for its commands.
 */

import { ToolError, type ToolErrorOptions } from '../lib/errors.js';

import type { Logger } from '../lib/logger.js';
import type { ProjectContext } from '../lib/project-context.js';

export interface ToolMetadata {
  /** Stable identifier — e.g. 'fitness', 'simulation'. */
  readonly id: string;
  readonly version: string;
  readonly description: string;
}

/**
 * Identity of a command a tool contributes — used for --help, plugin
 * listings, and conflict detection across tools. The actual handler is
 * wired up by Tool.register().
 */
export interface ToolCommandDescriptor {
  /** CLI subcommand name — 'fit', 'sim', 'fit-list', etc. */
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
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
 */
export type LiveViewRenderer = (args: unknown) => Promise<void>;

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
      `No live view registered for key '${viewKey}'. The tool that owns '${viewKey}' must call cli.registerLiveView('${viewKey}', renderer) inside its register(cli) hook.`,
      options?.code ?? 'UNKNOWN_LIVE_VIEW',
      options,
    );
    this.name = 'UnknownLiveViewError';
    this.viewKey = viewKey;
  }
}

/**
 * Context the CLI hands to each tool when it asks the tool to wire
 * its commands. Tool.register() uses this to mount Commander commands
 * and to call back into shared CLI behavior (Ink rendering, dashboard
 * auto-open, structured logging) without depending on the CLI package
 * directly.
 *
 * Typed loosely on `program` so the contract doesn't pin every tool to
 * a specific Commander major version. Tools cast to their preferred
 * commander API; mismatches surface at register() time, not at
 * link/build time.
 */
export interface ToolCliContext {
  /**
   * The root Commander program. Tools call `program.command('fit')...`
   * to mount their subcommands.
   */
  readonly program: unknown;
  /**
   * Resolved project context for this CLI invocation. Computed once in
   * pre-action-hook after `--cwd` parsing; threaded into every tool's
   * action body via this field rather than each tool re-reading
   * `opts.cwd`.
   *
   * When `project.scope === 'none'`, no opensip-tools project was found
   * above cwd. Project-scoped commands should error in this case (with
   * the "No opensip-tools project found" copy); `init` proceeds.
   *
   * Exposed via a getter on the implementation side — accessing it
   * before pre-action-hook resolves throws to surface bootstrap-order
   * bugs. Tools must only read this inside command action bodies, not
   * during `register()`.
   */
  readonly project: ProjectContext;
  /** Render an Ink result (CommandResult shape from @opensip-tools/contracts). */
  readonly render: (result: unknown) => Promise<void>;
  /**
   * Register a renderer for a live, stateful view keyed by `key`. Tools
   * call this from their `register(cli)` hook to contribute their own
   * Ink view (spinner → results transition); the CLI then dispatches
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
  readonly renderLive: (key: string, args: unknown) => Promise<void>;
  /**
   * Open the HTML dashboard in the user's browser when the run
   * conditions allow it (TTY, not JSON-mode, opt-in). Tools call this
   * after a run to honor the user's --open flag.
   */
  readonly maybeOpenDashboard: (opts: {
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
   * Emit a structured JSON value to the CLI's stdout. Centralises the
   * `process.stdout.write(JSON.stringify(value, null, 2) + '\n')` call
   * that every tool's `--json` mode would otherwise duplicate. The CLI
   * owns the IO seam; tools call `emitJson` and the CLI decides how the
   * value reaches the terminal (today: pretty-printed JSON to stdout;
   * future: optional `--out <file>`, envelope wrappers, etc.).
   */
  readonly emitJson: (value: unknown) => void;
  /**
   * Persistence layer (SQLite + Drizzle). Opened once per CLI invocation
   * by the bootstrap and closed at process exit. Tools construct their
   * domain repos against this handle (SessionRepo, BaselineRepo, etc.).
   *
   * Typed loosely (`unknown`) for the same reason `program` is — to keep
   * core decoupled from datastore. Tools cast to `DataStore` from
   * `@opensip-tools/datastore` at use time. The shape is structurally
   * stable; mismatches surface at register() time, not at link/build time.
   */
  readonly datastore: unknown;
}

export interface Tool {
  readonly metadata: ToolMetadata;
  /**
   * Metadata for every command this tool contributes. Used for --help
   * listings and conflict detection. Actual handlers are mounted by
   * register().
   */
  readonly commands: readonly ToolCommandDescriptor[];
  /**
   * Mount this tool's subcommands onto the CLI's Commander program.
   * Called once at CLI startup, before argv parsing. Use the supplied
   * context to render results and trigger dashboard auto-open.
   */
  readonly register: (cli: ToolCliContext) => void;
  /**
   * Optional one-time initialization. Called by the CLI before any of
   * the tool's commands run. Use it to register sub-packages (check
   * packs, scenario packs), language adapters, etc.
   *
   * The CLI calls initialize() at most once per process. Tools that
   * need lazy init (e.g. fitness, where ensureChecksLoaded is wired
   * deep into command handlers) can leave this undefined and run
   * setup inside their register()'d handlers instead.
   */
  readonly initialize?: () => Promise<void>;
}

/**
 * Plugin export shape for npm packages whose package.json declares
 * `opensipTools.kind === 'tool'`. The package's main entry must export
 * a `tool` symbol of this shape.
 */
export interface ToolPluginExports {
  readonly tool: Tool;
}

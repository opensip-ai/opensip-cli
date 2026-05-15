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

import type { logger as coreLogger } from '../lib/logger.js';

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
  /** Render an Ink result (CommandResult shape from cli-shared). */
  readonly render: (result: unknown) => Promise<void>;
  /**
   * Render a live, stateful Ink view (spinner → results transition).
   * `viewKey` selects which view (e.g. 'fit'). Returns once the
   * underlying Ink app exits. Used by the fit command's visual mode.
   *
   * `viewKey` is a string instead of a typed enum so new tools can
   * register additional live views without touching the core type.
   */
  readonly renderLive: (viewKey: string, args: unknown) => Promise<void>;
  /**
   * Open the HTML dashboard in the user's browser when the run
   * conditions allow it (TTY, not JSON-mode, opt-in). Tools call this
   * after a run to honor the user's --open flag.
   */
  readonly maybeOpenDashboard: (opts: {
    openRequested: boolean;
    jsonOutput: boolean;
    cwd: string;
  }) => Promise<void>;
  /** Shared structured logger. */
  readonly logger: typeof coreLogger;
  /**
   * Process exit-code setter — tools call this instead of mutating
   * `process.exitCode` directly so the CLI controls the final exit.
   */
  readonly setExitCode: (code: number) => void;
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

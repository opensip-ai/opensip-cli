/**
 * Tool plugin contract.
 *
 * A Tool is a self-contained capability (fitness, simulation, future
 * audit/lint/etc.) that contributes one or more CLI subcommands. The
 * CLI is a generic dispatcher that walks the registered tool list and
 * delegates command definition to each tool's `register(cli)` method.
 *
 * Tools are first-party (declared as a direct dep of opensip-tools)
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
import type { ScopeContribution, ToolScope } from '../lib/scope-types.js';
import type { PluginLayout } from '../plugins/types.js';

// `ToolScope` (the Tool-facing scope view) and `ScopeContribution` (the
// augmentable subscope bag a tool returns from `contributeScope`) live in
// the leaf `lib/scope-types.ts`. The `Tool` contract depends on those
// abstractions, never on the concrete `RunScope`, so there is no
// `tools/types.ts → lib/run-scope.ts` edge — the former RunScope⟷Tool
// type cycle is gone (audit 2026-05-29, M4). A plain top-level
// `import type` is safe: scope-types is a leaf with no edge back here.

/** Static descriptor for a tool plugin: id, semver, and one-line description. */
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
   * Per-run resources (logger, parseCache, registries, datastore,
   * recipeUnitConfig, projectContext). Constructed once per CLI
   * invocation by the bootstrap. Tools read every per-run resource
   * via `cli.scope.foo` — the previously-exported `defaultToolRegistry`
   * / `defaultLanguageRegistry` singletons are gone, and the Phase 5
   * `cli.project` / `cli.datastore` back-compat alias accessors were
   * retired in audit-round-3 Finding K once no tool referenced them
   * directly. Read `cli.scope.projectContext` and `cli.scope.datastore()`
   * instead.
   *
   * Typed as the Tool-facing `ToolScope` view (not the concrete
   * `RunScope`): everything tools read via `cli.scope.*`, minus the
   * `tools` registry tools never touch. This is what keeps the `Tool`
   * contract free of any `RunScope` reference (audit 2026-05-29, M4).
   */
  readonly scope: ToolScope;
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
}

/**
 * Tool error-handling contract.
 *
 * Tools have two paths for surfacing failure to the CLI dispatcher:
 *
 *   1. **Result-shaped return** — for expected business outcomes that
 *      callers may want to render with full UX (Ink, JSON, dashboard).
 *      Action handlers compute a `CommandResult` (`type: 'error'` is
 *      one variant) and pass it through `cli.render` / `cli.emitJson`,
 *      setting the exit code via `cli.setExitCode`. Both `simulation`
 *      and `graph` use this path for normal failures.
 *
 *   2. **Throw a `ToolError` subclass** — for unrecoverable / programmer
 *      conditions, or for known-error classes that the tool would
 *      rather let the central handler map to an exit code. The CLI's
 *      top-level `handleParseError` catches every `ToolError` that
 *      escapes a tool's action body and routes it through the
 *      canonical `mapToolErrorToExitCode` (in `@opensip-tools/contracts`).
 *
 * Which subclass to throw, by intent:
 *
 *   - `ConfigurationError` — bad user input / missing config / wrong
 *     flag combination. Exit code: `CONFIGURATION_ERROR` (2).
 *   - `ValidationError`    — a validated value failed an invariant.
 *     Exit code: `CONFIGURATION_ERROR` (2).
 *   - `NotFoundError`      — a named entity (check, recipe, scenario)
 *     does not exist. Exit code: `CHECK_NOT_FOUND` (3).
 *   - `NetworkError`       — remote call failed (e.g. `--report-to`).
 *     Exit code: `REPORT_FAILED` (4).
 *   - `TimeoutError`       — an operation exceeded its deadline.
 *     Exit code: `RUNTIME_ERROR` (1).
 *   - `SystemError`        — bootstrap-invariant violation or data
 *     corruption. Exit code: `RUNTIME_ERROR` (1).
 *   - bare `ToolError`     — any other tool failure. Exit code:
 *     `RUNTIME_ERROR` (1).
 *
 * Tools that need to catch their own `ToolError` locally (e.g. to
 * render in a non-Ink format) should still derive the exit code from
 * `mapToolErrorToExitCode` rather than hardcoding the constant — that
 * keeps a single source of truth for the policy.
 *
 * Plain `Error` instances thrown from a tool action body fall through
 * to the data-driven `getErrorSuggestion` substring matcher, then to a
 * generic `RUNTIME_ERROR`. Prefer the typed path.
 */
export interface Tool {
  readonly metadata: ToolMetadata;
  /**
   * Metadata for every command this tool contributes. Used for --help
   * listings and conflict detection. Actual handlers are mounted by
   * register().
   */
  readonly commands: readonly ToolCommandDescriptor[];
  /**
   * Optional project-local plugin layout. Tools that support
   * user-authored / npm plugins under `<project>/opensip-tools/<domain>/`
   * declare `{ domain, userSubdirs }` here; the kernel's `discoverPlugins`
   * / `loadAllPlugins` and the CLI's `plugin` command read it instead of
   * hardcoding domain names (ADR-0009 corollary 1). Tools with no
   * project-local plugins (e.g. graph) leave this undefined.
   */
  readonly pluginLayout?: PluginLayout;
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
  /**
   * Optional per-run subscope contribution. Called by the CLI's
   * pre-action-hook AFTER constructing the per-invocation scope and
   * BEFORE `enterScope` makes it visible to tool action bodies. Each
   * registered tool is invoked once per CLI invocation; the kernel
   * `Object.assign`s the returned contribution onto the scope (D7: tool
   * subscopes via module augmentation).
   *
   * Inversion of control (audit 2026-05-29, M4): the tool RETURNS its
   * subscope rather than mutating a passed-in `RunScope`. This keeps the
   * `Tool` contract free of any `RunScope` reference (breaking the
   * RunScope⟷Tool type cycle) and removes shared-mutable-state from the
   * extension API.
   *
   * Tools augment `ScopeContribution` from their own package:
   *
   *   declare module '@opensip-tools/core' {
   *     interface ScopeContribution {
   *       simulation?: { scenarios: Registry<RunnableScenario>; ... };
   *     }
   *   }
   *
   * and return their slot here:
   *
   *   contributeScope() {
   *     return { simulation: { scenarios: new Registry(...), ... } };
   *   }
   *
   * The kernel never inspects the slot — it just installs it. Slots are
   * optional so a graph-only run carries no `scope.simulation`, and vice
   * versa. `ScopeContribution` is empty in core; every member arrives via
   * tool augmentation, and `ToolScope`/`RunScope` extend it for reads.
   *
   * Default behavior (when undefined): the tool contributes no subscope.
   * Fitness, today, carries no per-run subscope state and leaves this
   * undefined.
   */
  readonly contributeScope?: () => ScopeContribution;
  /**
   * Optional dashboard-data contribution (audit 2026-05-29, L2). The CLI
   * is the dashboard composition root: it gathers generic sessions, then
   * walks the tool registry calling this hook and merges each tool's
   * contribution into the dashboard input. A tool returns ITS OWN inputs
   * to the HTML report (fitness: check/recipe catalogs; graph: its
   * catalog) — keyed by the field names `generateDashboardHtml` consumes.
   *
   * Returns an opaque `Record<string, unknown>` so the kernel carries no
   * tool/dashboard vocabulary; the CLI `Object.assign`s it onto the
   * `DashboardInput`. Tools that contribute nothing leave this undefined.
   * Receives the Tool-facing `ToolScope` (datastore, projectContext, …).
   */
  readonly collectDashboardData?: (
    scope: ToolScope,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/**
 * Plugin export shape for npm packages whose package.json declares
 * `opensipTools.kind === 'tool'`. The package's main entry must export
 * a `tool` symbol of this shape.
 */
export interface ToolPluginExports {
  readonly tool: Tool;
}

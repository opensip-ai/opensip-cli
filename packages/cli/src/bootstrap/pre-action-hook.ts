// @fitness-ignore-file detached-promises -- the preAction hook is a composition root: its body invokes synchronous bootstrap helpers (mergeConfigDefaults, configureLogger, the checkSchemaVersion/checkNoProject/warnAboutPhantom bailout guards, enterScope) that the name-based heuristic mistakes for promise-returning calls. The one genuine async call (maybeInitializeOwningTool) is awaited. Matches the same suppression on index.ts and bootstrap/index.ts.
/**
 * pre-action-hook — Commander `preAction` body.
 *
 * Runs before every subcommand's action. Centralises run-id generation,
 * config-merge, project-context resolution, schema-version bailout, and
 * (only when the run will proceed) log file initialisation. Datastore is
 * NOT opened here — that's a lazy getter on ToolCliContext (Task 1.3).
 *
 * Ordering is load-bearing: side effects only fire AFTER all bailout
 * decisions. Sequence:
 *
 *   1. generate runId
 *   2. read opts; resolve project context (pure; may throw on strict --config)
 *   3. expose context on opts.projectContext (collision-free name)
 *   4. bailout window — schema check (Phase 6.3), phantom warn (Phase 7)
 *   5. side-effect setup — configureLogger({ logDir }) + setProjectContextForRun
 *      gated on project.scope === 'project' && existsSync(projectRoot)
 *   6. Project: header (Phase 2.2)
 *   7. cli.start log line
 *   8. lazy Tool.initialize() — run the owning tool's optional one-time
 *      init exactly once per process, after the scope is entered and just
 *      before the action body (P1a). CLI-only commands have no owner and
 *      skip it; a failing init is fatal.
 *
 * Strict --config: when `--config <path>` doesn't resolve, the
 * underlying ValidationError surfaces with exit 2 — no silent walk-up.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveEffectiveCloudConfig } from '@opensip-tools/config';
import {
  RunScope,
  configureLogger,
  createCapabilityRegistry,
  enterScope,
  generatePrefixedId,
  logger,
  resolveProjectContext,
  resolveProjectPaths,
  resolveUserPaths,
  type ProjectContext,
  type Tool,
  type ToolRegistry,
} from '@opensip-tools/core';
import { resolveSignalSink } from '@opensip-tools/output';

import {
  buildDatastoreThunk,
  getCurrentRegistriesForScope,
  getToolManifestsForRun,
  setCurrentRunScope,
} from '../cli-context.js';
import { checkForUpdate, formatUpdateNag } from '../update-notifier.js';

import { BootstrapError } from './bootstrap-error.js';
import { loadCliDefaults, mergeConfigDefaults } from './cli-defaults.js';
import { composeAndValidateToolConfig, wireCapabilityRegistry } from './config-and-capabilities.js';
import { loadOwningToolCapabilities } from './load-tool-capabilities.js';
import {
  checkNoProjectAndBailout,
  checkSchemaVersionAndBailout,
  warnAboutPhantomRuntimes,
} from './pre-action-guards.js';

import type { Command } from 'commander';

/** npm package whose version the update check compares against. */
const CLI_PACKAGE_NAME = 'opensip-tools';

const MODULE_TAG = 'cli:bootstrap';

/**
 * Tool ids whose `initialize()` has already run in this process. The Tool
 * contract guarantees `initialize()` is called "at most once per process";
 * this set enforces that across multiple preAction firings (long-lived
 * hosts, tests). Process-scoped on purpose — a fresh CLI process starts
 * empty.
 */
const initializedToolIds = new Set<string>();

/**
 * Find the registered tool that owns the invoked subcommand, matching the
 * descriptor's canonical name or any alias. Returns undefined for
 * CLI-only commands (init/sessions/configure/plugin/...) — they belong to
 * no tool, so no `initialize()` runs for them.
 */
export function resolveOwningTool(tools: ToolRegistry, cmdName: string): Tool | undefined {
  return tools
    .list()
    .find((tool) =>
      tool.commands.some((c) => c.name === cmdName || (c.aliases?.includes(cmdName) ?? false)),
    );
}

/**
 * Lazy, memoized Tool.initialize() (P1a). Resolve the tool owning the
 * invoked subcommand and run its initialize() exactly once per process,
 * after the scope is entered and immediately before the action body. Tools
 * not invoked this run pay nothing; `--help`/welcome run no initialize().
 *
 * Fail-fast: a throwing initialize() fails the run closed rather than letting a
 * half-initialised tool run its command and silently appear to work. The
 * id is recorded only on success, so a transient failure can retry in a
 * long-lived host. Extracted from the hook body to keep its complexity
 * within budget.
 *
 * @throws {BootstrapError} (exit 1) when the owning tool's initialize() throws —
 *   the top-level boundary renders it (human stderr / structured `--json`).
 */
async function maybeInitializeOwningTool(
  tools: ToolRegistry,
  cmdName: string,
  runId: string,
): Promise<void> {
  const owningTool = resolveOwningTool(tools, cmdName);
  if (!owningTool?.initialize || initializedToolIds.has(owningTool.metadata.id)) return;
  try {
    await owningTool.initialize();
    initializedToolIds.add(owningTool.metadata.id);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({
      evt: 'cli.tool.initialize_failed',
      module: MODULE_TAG,
      runId,
      toolId: owningTool.metadata.id,
      error: msg,
    });
    // §4.7: a tool-init failure becomes a typed BootstrapError (exit 1) the
    // top-level boundary renders, instead of an inline stderr write + exit.
    throw new BootstrapError({
      message: `Tool '${owningTool.metadata.id}' failed to initialize: ${msg}`,
      humanMessage: `✗ Tool '${owningTool.metadata.id}' failed to initialize: ${msg}`,
      suggestion: undefined,
      exitCode: 1,
    });
  }
}

/**
 * Mount the bootstrap `preAction` hook on the supplied program.
 *
 * @param program The root Commander program.
 * @param version The CLI version (from `readPackageVersion` at the entry
 *   point). Threaded in rather than re-read here so the `mini` banner shows
 *   the SAME version `--version` reports — and so the kernel-adjacent hook
 *   doesn't resolve cli-ui's or its own package version by mistake.
 */
export function installPreActionHook(program: Command, version: string): void {
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    const runId = generatePrefixedId('run');

    const opts = actionCommand.opts();
    const cwd = (opts.cwd as string) ?? process.cwd();
    const cwdExplicit = actionCommand.getOptionValueSource('cwd') === 'cli';

    // Keep the loaded defaults around: `mergeConfigDefaults` only copies the
    // flag-shaped fields onto opts, but `ui.banner` has no flag — we read it
    // straight off the config object below to build the UiContext.
    const cliDefaults = loadCliDefaults(cwd, opts.config as string | undefined);
    mergeConfigDefaults(opts, cliDefaults);

    // Single bootstrap-time configuration of the process-wide logger
    // singleton. Replaces the four prior free mutators (`setSilent`,
    // `setDebugMode`, `setRunId`, `initLogFile`). `logDir` is wired in
    // below once the project context is resolved — at that point the
    // logsDir is known and we apply a second `configureLogger` to fill
    // it in. The two-call sequence is intentional: silencing stderr
    // before the project-resolve step is what makes Ink renders clean
    // even when the project is missing.
    configureLogger({
      silent: true,
      debugMode: Boolean(opts.debug),
      runId,
    });

    // 2. Resolve the project context — pure, no side effects.
    //    Strict --config: throws ValidationError when explicit path misses.
    let project: ProjectContext;
    try {
      project = resolveProjectContext({
        cwd,
        cwdExplicit,
        explicitConfigPath: opts.config as string | undefined,
      });
    } catch (error) {
      // §4.7: a config-resolve failure (e.g. strict --config miss) becomes a typed
      // BootstrapError the top-level boundary renders — human stderr / structured
      // --json — instead of an inline stderr write + process.exit.
      const msg = error instanceof Error ? error.message : String(error);
      throw new BootstrapError({
        message: msg,
        humanMessage: `✗ ${msg}`,
        suggestion: 'Check opensip-tools.config.yml (or your --config path).',
        exitCode: 2,
      });
    }

    // 3. Stash the context on opts under the COLLISION-FREE name.
    //    `opts.project` is reserved for Commander's --project [path] flag
    //    in uninstall.ts; we never use that name here.
    (opts as Record<string, unknown>).projectContext = project;
    // Stash the resolved "was --cwd typed on the CLI?" signal alongside it,
    // so the `init` command-spec handler (release 2.11.0 Phase 6) reads ONE
    // source instead of recomputing `getOptionValueSource('cwd')` on its own
    // Commander command. `actionCommand` IS the init command here, so this is
    // byte-identical to the former register-init computation.
    (opts as Record<string, unknown>).cwdExplicit = cwdExplicit;

    // 4. Bailout window — each may THROW a BootstrapError (rendered by the
    //    top-level boundary) before any side effects. Phantom warn is non-fatal;
    //    warns then continues.
    checkSchemaVersionAndBailout(project, runId);
    checkNoProjectAndBailout(project, cwd, actionCommand.name(), runId);
    warnAboutPhantomRuntimes(project, opts.json === true);

    // 5. Side-effect setup, gated on a real project being present.
    if (project.scope === 'project' && existsSync(project.projectRoot)) {
      const projectPaths = resolveProjectPaths(project.projectRoot);
      // Second configureLogger call — fills in the project-scoped logDir
      // now that the project context is resolved. Leaves silent/debugMode/runId
      // untouched (configureLogger only writes fields present in the bag).
      configureLogger({ logDir: projectPaths.logsDir });
    }

    // Build the per-run RunScope and enter it via AsyncLocalStorage so
    // library functions deep in the call tree (currentScope() readers)
    // see the bound logger/registries/project + a lazy datastore thunk.
    // enterWith propagates forward through the same async chain, so the
    // action body invoked after this hook sees the same scope without
    // needing a callback wrapper — which Commander does not expose.
    // (Phase 5 deferred Task 5.2 / T1 Item D close-out.)
    // Resolve presentation + update state once, before the scope is built.
    // bannerSize: explicit `cli.ui.banner`, else the product default `mini`.
    // update: the cached newer-version string (best-effort; undefined when
    // up-to-date / opted-out / non-TTY). The `mini` banner shows it inline;
    // other sizes — and the banner-less `--json` path — fall back to the
    // stderr nag so the signal is never silently lost.
    const bannerSize = cliDefaults.ui?.banner ?? 'mini';
    const update = checkForUpdate({ name: CLI_PACKAGE_NAME, version });
    if (update && (bannerSize !== 'mini' || opts.json === true)) {
      process.stderr.write(formatUpdateNag(version, update));
    }

    // ADR-0008: select the cloud signal sink for this run. Sync + cheap —
    // keyless / `cloud.sync:false` / `--no-cloud` / non-https → no-op with no
    // IO; the entitlement check is deferred to first emit so non-signal
    // commands pay nothing. `opts.cloud === false` comes from `--no-cloud`.
    //
    // `cloud` layers the user-level opt-out (~/.opensip-tools/config.yml#cloud)
    // over the project's `cli.cloud:` block (audit P0-2): a user `sync: false`
    // disables sync for every project on this machine.
    const signalSink = resolveSignalSink({
      apiKey: opts.apiKey as string | undefined,
      cloud: resolveEffectiveCloudConfig(cliDefaults.cloud),
      // `--no-cloud` is a global flag, so read it through optsWithGlobals().
      // @fitness-ignore-next-line null-safety -- optsWithGlobals() returns a commander OptionValues record (never null); `.cloud` is a safe optional read
      noCloud: actionCommand.optsWithGlobals().cloud === false,
      cacheDir: join(resolveUserPaths().userHomeDir, 'cache'),
    });

    const { languages, tools } = getCurrentRegistriesForScope();
    // ADR-0023 Phase 4: compose + STRICT-validate config before building the
    // scope (a typo in any tool namespace → CONFIGURATION_ERROR); resolved
    // config rides the scope (tools read scope.toolConfig.<namespace>).
    const toolConfig = composeAndValidateToolConfig({
      tools,
      configPath: project.scope === 'project' ? project.configPath : undefined,
      env: process.env,
    });
    const scope = new RunScope({
      logger,
      projectContext: project,
      languages,
      tools,
      signalSink,
      // Item 2 — runId is a flat kernel field on RunScope (per D7); the
      // logger's runId provider reads it back via `currentScope()?.runId`.
      runId,
      // Closure-based lazy datastore. SQLite is materialised only on
      // first access. The thunk captures `project` so non-action paths
      // (post-action handlers, error printers) that read via
      // `getOrOpenDatastore()` find the same instance.
      datastore: buildDatastoreThunk(project, logger),
      // Presentation settings the render paths read via currentScope()?.ui.
      // bannerSize stays an untyped string at the kernel boundary; the
      // cli-ui render sites narrow it with normalizeBannerSize. Product
      // default is 'mini' (the compact identity card) when no
      // `cli.ui.banner` is configured; a user can opt back into lg/md/sm.
      // `update` is the cached newer-version string (if any); the mini banner
      // shows it inline, other sizes get the stderr nag emitted below.
      ui: { bannerSize, version, update },
    });
    // D7: each registered tool contributes its tool-specific subscope (e.g.
    // `scope.simulation`, `scope.graph`) BEFORE the scope is entered. IoC (M4):
    // the tool RETURNS its slot via `contributeScope()`; the kernel installs it
    // with `Object.assign` (registration order; a tool with no hook is skipped).
    for (const tool of tools.list()) {
      const contribution = tool.contributeScope?.();
      if (contribution) Object.assign(scope, contribution);
    }

    // §5.3 Phase 4: per-run capability registry (manifest domains → real registrars).
    const capabilities = wireCapabilityRegistry({
      tools,
      manifests: getToolManifestsForRun(),
      registry: createCapabilityRegistry(logger),
    });
    Object.assign(scope, { capabilities, toolConfig });

    enterScope(scope);
    setCurrentRunScope(scope);

    // Lifecycle diagnostics (§5.10): record plugin-load + config-validate facts on
    // the per-run bus now that the scope is bound. These pre-handler events ride on
    // the CommandOutcome the handler later produces, so `--json` consumers see
    // capability health (how many tools loaded; the resolved project scope).
    scope.diagnostics.event('load', 'debug', `${tools.list().length} tool(s) loaded`);
    scope.diagnostics.counter('tools.loaded', tools.list().length);
    scope.diagnostics.event('validate', 'debug', `project config resolved (scope: ${project.scope})`);

    // The `ℹ Project:` location line is rendered once, under the banner,
    // by cli-ui's ProjectHeader — mounted by the App shell (static
    // commands, via render.ts reading currentScope().project) and by each
    // live view (fit/graph). No imperative pre-action print.

    // Structured start log.
    logger.info({
      evt: 'cli.run.start',
      module: MODULE_TAG,
      runId,
      command: actionCommand.name(),
      cwd,
      projectRoot: project.projectRoot,
      scope: project.scope,
    });

    if (project.walkedUp > 0) {
      logger.info({
        evt: 'cli.project.discovered',
        module: MODULE_TAG,
        runId,
        cwd,
        projectRoot: project.projectRoot,
        walkedUp: project.walkedUp,
      });
    }

    // 8. Lazy, memoized Tool.initialize() — runs the owning tool's
    //    optional one-time init here, AFTER enterScope (so eager setup that
    //    registers packs / reads currentScope() sees the bound scope) and
    //    immediately before Commander invokes the action body. See the
    //    helper for the once-per-process + fail-fast semantics.
    await maybeInitializeOwningTool(tools, actionCommand.name(), runId);

    // 9. §5.3/§4.5: drive the generic capability loader for the invoked tool's
    //    declared domains (e.g. graph-adapter). Lazy per command — only the
    //    owning tool's domains load, routed through the host's capability
    //    registry to each owner's registrar. Replaces the host-coupled,
    //    eager register-graph-adapters.ts.
    const driven = await loadOwningToolCapabilities({
      owningTool: resolveOwningTool(tools, actionCommand.name()),
      projectDir: project.projectRoot,
      configPath: project.scope === 'project' ? project.configPath : undefined,
    });
    if (driven > 0) {
      scope.diagnostics.event('load', 'debug', `loaded ${String(driven)} capability domain(s)`);
    }
  });
}

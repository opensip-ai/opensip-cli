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

import {
  RunScope,
  checkSchemaCompat,
  configureLogger,
  detectPhantomRuntimes,
  enterScope,
  generatePrefixedId,
  logger,
  readConfigSchemaVersion,
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
  setCurrentRunScope,
} from '../cli-context.js';
import { checkForUpdate, formatUpdateNag } from '../update-notifier.js';

import { loadCliDefaults, mergeConfigDefaults } from './cli-defaults.js';
import { resolveEffectiveCloudConfig } from './global-config.js';
import { formatCliTooOldMessage, formatNoProjectFoundMessage } from './pre-action-messages.js';

import type { Command } from 'commander';

/** npm package whose version the update check compares against. */
const CLI_PACKAGE_NAME = 'opensip-tools';

/**
 * Commands that operate WITHOUT requiring a project context. These don't
 * read project files or the datastore; running them from a directory
 * with no opensip-tools project is legitimate.
 *
 * Everything else is project-scoped: when `project.scope === 'none'`,
 * the hook emits the "No opensip-tools project found" error and exits 2.
 *
 * Note: `uninstall --user` is project-agnostic, but `uninstall --project`
 * requires one. The check is per-command name here; uninstall's own
 * mode-specific guarding lives in its action body.
 */
const PROJECT_AGNOSTIC_COMMANDS: ReadonlySet<string> = new Set([
  'init',
  'configure',
  'completion',
  'uninstall',
]);

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
 * Fail-fast: a throwing initialize() exits non-zero rather than letting a
 * half-initialised tool run its command and silently appear to work. The
 * id is recorded only on success, so a transient failure can retry in a
 * long-lived host. Extracted from the hook body to keep its complexity
 * within budget.
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
    process.stderr.write(`✗ Tool '${owningTool.metadata.id}' failed to initialize: ${msg}\n`);
    logger.error({
      evt: 'cli.tool.initialize_failed',
      module: MODULE_TAG,
      runId,
      toolId: owningTool.metadata.id,
      error: msg,
    });
    process.exit(1);
  }
}

/**
 * Schema-version bailout. Exits 2 with the "upgrade your CLI" message
 * when the project config declares a schema newer than this CLI knows.
 * Direction-correct: `migrate` would go the other way (old → new); when
 * the CLI itself is behind, the user must upgrade it.
 */
function checkSchemaVersionAndBailout(project: ProjectContext, runId: string): void {
  if (project.scope !== 'project' || project.configPath === undefined) return;
  const configVersion = readConfigSchemaVersion(project.configPath);
  const compat = checkSchemaCompat(configVersion);
  if (compat.kind === 'cli-too-old') {
    const msg = formatCliTooOldMessage({
      root: project.projectRoot,
      configVersion: compat.configVersion,
      cliVersion: compat.cliVersion,
    });
    process.stderr.write(`${msg}\n`);
    logger.warn({
      evt: 'cli.config.schema.cli-too-old',
      module: MODULE_TAG,
      runId,
      root: project.projectRoot,
      configVersion: compat.configVersion,
      cliVersion: compat.cliVersion,
    });
    process.exit(2);
  }
  if (compat.kind === 'older') {
    logger.info({
      evt: 'cli.config.schema.older',
      module: MODULE_TAG,
      runId,
      root: project.projectRoot,
      configVersion: compat.configVersion,
      cliVersion: compat.cliVersion,
    });
  }
}

/**
 * No-project-found bailout. Exits 2 with the actionable error message
 * for project-scoped commands when discovery resolved scope === 'none'.
 */
function checkNoProjectAndBailout(
  project: ProjectContext,
  cwd: string,
  cmdName: string,
  jsonOutput: boolean,
  runId: string,
): void {
  if (project.scope !== 'none' || PROJECT_AGNOSTIC_COMMANDS.has(cmdName)) return;
  const msg = formatNoProjectFoundMessage(cwd, jsonOutput);
  const stream = jsonOutput ? process.stdout : process.stderr;
  stream.write(`${msg}\n`);
  logger.warn({
    evt: 'cli.project.not-found',
    module: MODULE_TAG,
    runId,
    cwd,
    command: cmdName,
  });
  process.exit(2);
}

/**
 * Phantom-runtime warning. Detects orphaned opensip-tools/.runtime/
 * subtrees between cwd and the discovered project root — fossils from
 * pre-discovery runs that scaffolded under subdirs. Warns to stderr
 * with a safe `rm -rf` hint; never auto-deletes. Suppressed for JSON
 * output (would corrupt the stream's stderr peer in some tools).
 */
function warnAboutPhantomRuntimes(project: ProjectContext, jsonOutput: boolean): void {
  if (jsonOutput) return;
  if (project.scope !== 'project' || project.walkedUp === 0) return;
  const phantoms = detectPhantomRuntimes(project.cwd, project.projectRoot);
  for (const phantom of phantoms) {
    process.stderr.write(
      `ℹ Detected an orphaned opensip-tools/ at:\n` +
      `    ${phantom}\n` +
      `  Left over from running opensip-tools from this subdirectory\n` +
      `  before project-root discovery was added. Safe to delete with:\n` +
      `    rm -rf ${phantom}\n\n`
    );
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
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`✗ ${msg}\n`);
      process.exit(2);
    }

    // 3. Stash the context on opts under the COLLISION-FREE name.
    //    `opts.project` is reserved for Commander's --project [path] flag
    //    in uninstall.ts; we never use that name here.
    (opts as Record<string, unknown>).projectContext = project;

    // 4. Bailout window — each may process.exit(2) before any side
    //    effects. Phantom warn is non-fatal; warns then continues.
    checkSchemaVersionAndBailout(project, runId);
    checkNoProjectAndBailout(project, cwd, actionCommand.name(), Boolean(opts.json), runId);
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
    const scope = new RunScope({
      logger,
      projectContext: project,
      languages,
      tools,
      signalSink,
      // Item 2 — runId moves off the logger singleton onto RunScope as
      // a flat kernel field (per D7). The logger's runId provider,
      // bound at module init in run-scope.ts, reads it back via
      // `currentScope()?.runId` for event-stamping.
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
    // D7: each registered tool contributes its tool-specific subscope
    // (e.g. `scope.simulation`, `scope.graph`) BEFORE the scope is
    // entered. Inversion of control (M4): the tool RETURNS its slot via
    // `contributeScope()`; the kernel installs it with `Object.assign`.
    // The kernel doesn't know about tool-specific namespaces. Run in
    // tool registration order; a tool with no hook is silently skipped.
    for (const tool of tools.list()) {
      const contribution = tool.contributeScope?.();
      if (contribution) Object.assign(scope, contribution);
    }
    enterScope(scope);
    setCurrentRunScope(scope);

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
  });
}

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
 *
 * Strict --config: when `--config <path>` doesn't resolve, the
 * underlying ValidationError surfaces with exit 2 — no silent walk-up.
 */

import { existsSync } from 'node:fs';

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
  type ProjectContext,
} from '@opensip-tools/core';

import {
  buildDatastoreThunk,
  getCurrentRegistriesForScope,
  setCurrentRunScope,
} from '../cli-context.js';

import { loadCliDefaults, mergeConfigDefaults } from './cli-defaults.js';

import type { Command } from 'commander';

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

interface CliTooOldInput {
  readonly root: string;
  readonly configVersion: number;
  readonly cliVersion: number;
}

/**
 * Render the "your CLI is too old" message. Direction-correct: when the
 * config schema is newer than the CLI knows about, the USER UPGRADES
 * THE CLI — not "run migrate" (migrate goes the OTHER direction, taking
 * an old config UP to the current CLI's version).
 */
function formatCliTooOldMessage(input: CliTooOldInput): string {
  return [
    `✗ This project's opensip-tools.config.yml uses a newer schema than your CLI supports.`,
    ``,
    `  Project:        ${input.root}`,
    `  Config schema:  v${input.configVersion}`,
    `  CLI supports:   v${input.cliVersion}`,
    ``,
    `  Update your CLI to continue:`,
    `    npm install -g @opensip-tools/cli@latest`,
    ``,
    `  (Or, if installed locally to the project: pnpm up @opensip-tools/cli@latest)`,
  ].join('\n');
}

function formatNoProjectFoundMessage(cwd: string, jsonOutput: boolean): string {
  if (jsonOutput) {
    return JSON.stringify({
      error: 'No opensip-tools.config.yml found. Searched from ' + cwd + ' upward. To get started: opensip-tools init',
    });
  }
  return [
    '✗ No opensip-tools project found.',
    '',
    '  Searched from: ' + cwd,
    '  Walked up to: /',
    '',
    '  To get started:',
    '    opensip-tools init',
  ].join('\n');
}


const MODULE_TAG = 'cli:bootstrap';

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
  program.hook('preAction', (_thisCommand, actionCommand) => {
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
    const { languages, tools } = getCurrentRegistriesForScope();
    const scope = new RunScope({
      logger,
      projectContext: project,
      languages,
      tools,
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
      ui: { bannerSize: cliDefaults.ui?.banner ?? 'mini', version },
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
  });
}

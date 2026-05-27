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
 *   5. side-effect setup — initLogFile + setProjectContextForRun
 *      gated on project.scope === 'project' && existsSync(projectRoot)
 *   6. Project: header (Phase 2.2)
 *   7. cli.start log line
 *
 * Strict --config: when `--config <path>` doesn't resolve, the
 * underlying ValidationError surfaces with exit 2 — no silent walk-up.
 */

import { existsSync } from 'node:fs';

import { formatProjectHeader } from '@opensip-tools/cli-ui';
import {
  RunScope,
  checkSchemaCompat,
  detectPhantomRuntimes,
  enterScope,
  generatePrefixedId,
  initLogFile,
  logger,
  readConfigSchemaVersion,
  resolveProjectContext,
  resolveProjectPaths,
  setDebugMode,
  setRunId,
  setSilent,
  type ProjectContext,
} from '@opensip-tools/core';

import { getCurrentRegistriesForScope, getOrOpenDatastore, setProjectContextForRun } from '../cli-context.js';

import { loadCliDefaults, mergeConfigDefaults } from './cli-defaults.js';

import type { Command } from 'commander';

/**
 * Commands that DON'T emit the imperative Project: header. JSON output,
 * shell-sourceable completion, help/version, user-scoped commands, and
 * Ink-rendered tools (RunHeader takes over) are all suppressed.
 */
const PROJECT_HEADER_SUPPRESSED_COMMANDS: ReadonlySet<string> = new Set([
  'completion',
  'configure',
]);

const COMMANDS_WITH_INK_RUN_HEADER: ReadonlySet<string> = new Set([
  'fit',
  'sim',
  'graph',
  'dashboard',
]);

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
    evt: 'cli.no-project-found',
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

/** Mount the bootstrap `preAction` hook on the supplied program. */
export function installPreActionHook(program: Command): void {
  program.hook('preAction', (_thisCommand, actionCommand) => {
    const runId = generatePrefixedId('run');
    setRunId(runId);

    const opts = actionCommand.opts();
    const cwd = (opts.cwd as string) ?? process.cwd();
    const cwdExplicit = actionCommand.getOptionValueSource('cwd') === 'cli';

    mergeConfigDefaults(opts, loadCliDefaults(cwd, opts.config as string | undefined));

    setSilent(true);
    if (opts.debug) setDebugMode(true);

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
      initLogFile(projectPaths.logsDir);
    }
    // Always register the context with cli-context so the getter on
    // ToolCliContext.project can return it. The datastore getter
    // additionally checks scope === 'project' before opening SQLite.
    setProjectContextForRun(project);

    // Enter the per-run AsyncLocalStorage scope so library functions
    // deep in the call tree (currentScope() readers) see the bound
    // language/tool registries + project context. enterWith propagates
    // forward through the same async chain, so the action body invoked
    // after this hook sees the same scope without needing a callback
    // wrapper around the action — which Commander does not expose.
    // (Phase 5 deferred Task 5.2 — close-out.)
    const { languages, tools } = getCurrentRegistriesForScope();
    enterScope(
      new RunScope({
        logger,
        projectContext: project,
        languages,
        tools,
        // Lazy datastore — same thunk as `ToolCliContext.scope.datastore`.
        // SQLite is materialised only on first access.
        datastore: () => getOrOpenDatastore(logger),
      }),
    );

    // 6. Imperative Project: header for non-Ink, project-scoped commands.
    const cmdName = actionCommand.name();
    const suppress =
      PROJECT_HEADER_SUPPRESSED_COMMANDS.has(cmdName) ||
      Boolean(opts.json) ||
      project.scope !== 'project' ||
      // Ink-rendered tools mount their own RunHeader with the Project line.
      (COMMANDS_WITH_INK_RUN_HEADER.has(cmdName) && !opts.json) ||
      // uninstall --project's printer (Phase 5) owns its pre-prompt block;
      // uninstall --user is user-scoped.
      cmdName === 'uninstall';
    if (!suppress) {
      process.stdout.write(formatProjectHeader({
        root: project.projectRoot,
        walkedUp: project.walkedUp,
      }));
    }

    // 7. Structured start log.
    logger.info({
      evt: 'cli.start',
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

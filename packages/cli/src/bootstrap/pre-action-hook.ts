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

import {
  generatePrefixedId,
  initLogFile,
  logger,
  resolveProjectContext,
  resolveProjectPaths,
  setDebugMode,
  setRunId,
  setSilent,
  type ProjectContext,
} from '@opensip-tools/core';

import { setProjectContextForRun } from '../cli-context.js';

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

    // 4. Bailout window — no-project error for project-scoped commands,
    //    schema check (Phase 6.3), and phantom warn (Phase 7) wire here.
    //    Each can process.exit(2) before any side-effect setup.

    if (project.scope === 'none' && !PROJECT_AGNOSTIC_COMMANDS.has(actionCommand.name())) {
      const msg = formatNoProjectFoundMessage(cwd, Boolean(opts.json));
      const stream = opts.json ? process.stdout : process.stderr;
      stream.write(`${msg}\n`);
      logger.warn({
        evt: 'cli.no-project-found',
        module: 'cli:bootstrap',
        runId,
        cwd,
        command: actionCommand.name(),
      });
      process.exit(2);
    }

    // 5. Side-effect setup, gated on a real project being present.
    if (project.scope === 'project' && existsSync(project.projectRoot)) {
      const projectPaths = resolveProjectPaths(project.projectRoot);
      initLogFile(projectPaths.logsDir);
    }
    // Always register the context with cli-context so the getter on
    // ToolCliContext.project can return it. The datastore getter
    // additionally checks scope === 'project' before opening SQLite.
    setProjectContextForRun(project);

    // 6. Project: header (Phase 2.2 wires this in).

    // 7. Structured start log.
    logger.info({
      evt: 'cli.start',
      module: 'cli:bootstrap',
      runId,
      command: actionCommand.name(),
      cwd,
      projectRoot: project.projectRoot,
      scope: project.scope,
    });

    if (project.walkedUp > 0) {
      logger.info({
        evt: 'cli.project.discovered',
        module: 'cli:bootstrap',
        runId,
        cwd,
        projectRoot: project.projectRoot,
        walkedUp: project.walkedUp,
      });
    }
  });
}

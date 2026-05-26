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

    // 4. Bailout window — schema check (Phase 6.3) and phantom warn
    //    (Phase 7) wire themselves into this slot. Schema check may
    //    process.exit(2) before any side-effect setup.

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

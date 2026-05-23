/**
 * pre-action-hook — Commander `preAction` body.
 *
 * Runs before every subcommand's action and centralises run-id
 * generation, config-merge, log/persistence path setup, and the
 * `cli.start` log line.
 *
 * F10 ordering: load → merge → derive silent/debug. Reading
 * `opts.debug` from the merged opts (rather than raw argv) means
 * `debug: true` in `opensip-tools.config.yml`'s `cli:` block surfaces
 * even when `--debug` wasn't passed on the command line.
 */

import {
  generatePrefixedId,
  initLogFile,
  logger,
  resolveProjectPaths,
  setDebugMode,
  setRunId,
  setSilent,
} from '@opensip-tools/core';

import { loadCliDefaults, mergeConfigDefaults } from './cli-defaults.js';

import type { Command } from 'commander';


/** Mount the bootstrap `preAction` hook on the supplied program. */
export function installPreActionHook(program: Command): void {
  program.hook('preAction', (_thisCommand, actionCommand) => {
    const runId = generatePrefixedId('run');
    setRunId(runId);

    const opts = actionCommand.opts();
    const cwd = (opts.cwd as string) ?? process.cwd();
    mergeConfigDefaults(opts, loadCliDefaults(cwd, opts.config as string | undefined));

    setSilent(true);
    if (opts.debug) setDebugMode(true);

    const projectPaths = resolveProjectPaths(cwd);
    initLogFile(projectPaths.logsDir);
    // v2: persistence is per-process via DataStoreFactory.open in
    // bootstrap/index.ts; configurePersistencePaths(projectPaths) was
    // removed in the v1→v2 migration.

    logger.info({
      evt: 'cli.start',
      module: 'cli:bootstrap',
      runId,
      command: actionCommand.name(),
      cwd,
    });
  });
}

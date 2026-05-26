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

import { existsSync } from 'node:fs';

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
    // Only initialise file logging when the target directory actually exists.
    // `initLogFile` uses `mkdirSync(..., { recursive: true })`, which would
    // materialise the entire `<cwd>/opensip-tools/.runtime/logs/` tree even
    // when `cwd` itself was a typo. That side-effect previously masked the
    // "Target directory does not exist" check in `executeInit` — the
    // directory was created before the check ran, so `init --cwd /typo`
    // silently scaffolded under the typo path with exit 0. Skipping the
    // log-file setup here lets the per-command guard return its
    // structured error, which the registrar maps to exit 2.
    if (existsSync(cwd)) {
      initLogFile(projectPaths.logsDir);
    }
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

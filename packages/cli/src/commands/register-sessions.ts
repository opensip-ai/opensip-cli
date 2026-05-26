/**
 * register-sessions — Commander wiring for `opensip-tools sessions list`
 * and `sessions purge`.
 *
 * Split out of `commands/index.ts` per audit 2026-05-23 M2.
 */

import { executeClear } from './clear.js';
import { showHistory } from './history.js';
import { mountResultCommand } from './mount-result-command.js';
import { JSON_DESC, type CliCommandsContext } from './shared.js';

import type { DataStore } from '@opensip-tools/datastore';
import type { Command } from 'commander';

export function registerSessions(program: Command, ctx: CliCommandsContext): void {
  const sessionsCmd = program
    .command('sessions')
    .description('Manage session data');

  const listCmd = sessionsCmd
    .command('list')
    .description('List stored sessions')
    .option('--json', JSON_DESC, false);

  mountResultCommand<{ json: boolean }>(
    listCmd,
    () => showHistory(ctx.datastore() as DataStore),
    { ctx, jsonFlag: (opts) => opts.json },
  );

  const purgeCmd = sessionsCmd
    .command('purge')
    .description('Delete session data from opensip-tools/.runtime/sessions/')
    .option('--older-than <days>', 'Only delete sessions older than N days', (v: string) => {
      const n = Number.parseInt(v, 10);
      if (Number.isNaN(n) || n < 0) throw new Error(`Invalid --older-than value: '${v}'. Must be a non-negative integer.`);
      return n;
    })
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .option('--json', JSON_DESC, false);

  mountResultCommand<{ olderThan?: number; yes: boolean; json: boolean }>(
    purgeCmd,
    (opts) => executeClear({ olderThan: opts.olderThan, yes: opts.yes, datastore: ctx.datastore() as DataStore }),
    { ctx, jsonFlag: (opts) => opts.json },
  );
}

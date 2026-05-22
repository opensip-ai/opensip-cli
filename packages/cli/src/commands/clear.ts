/**
 * clear command — clear session data from the project-local SQLite DB.
 *
 * v2: rows in the `sessions` table (and cascaded findings/checks) are
 * the unit of deletion; the file-by-file purge of v1 is gone. The CLI
 * bootstrap opens the DataStore in `preAction`; this command receives
 * the constructed repo from its caller.
 *
 * Uses Node readline for interactive confirmation (not Ink),
 * since Ink's useInput requires raw mode which isn't always available.
 */

import { createInterface } from 'node:readline';

import { SessionRepo } from '@opensip-tools/contracts';

import type { DataStore } from '@opensip-tools/datastore';

export interface ClearOptions {
  olderThan?: number;
  yes: boolean;
  datastore: DataStore;
}

export interface ClearResult {
  type: 'clear';
  action: 'done' | 'cancelled' | 'empty';
  deletedCount: number;
  sessionCount: number;
  olderThan?: number;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ANSI helpers — module-scoped to avoid per-call closure allocation.
const ansiBrand = (s: string): string => `[38;2;200;149;108m${s}[0m`;
const ansiDim = (s: string): string => `[2m${s}[0m`;

/** Print the banner using raw ANSI (avoids Ink dependency) */
function printBanner(): void {
  // Simplified banner header
  console.log('');
  console.log(`  ${ansiBrand('OpenSIP Tools')} ${ansiDim('— session management')}`);
  console.log('');
}

export async function executeClear(opts: ClearOptions): Promise<ClearResult> {
  printBanner();

  const repo = new SessionRepo(opts.datastore);
  const sessionCount = repo.count();

  if (sessionCount === 0) {
    console.log(`  ${'[2m'}No session data to clear.${'[0m'}\n`);
    return { type: 'clear', action: 'empty', deletedCount: 0, sessionCount: 0 };
  }

  // Describe what will happen
  const dayWord = opts.olderThan === 1 ? 'day' : 'days';
  const description = opts.olderThan
    ? `This will delete session data older than ${opts.olderThan} ${dayWord} from the project-local SQLite store.`
    : 'This will delete ALL session data from the project-local SQLite store.';

  // Prompt for confirmation unless --yes
  if (!opts.yes) {
    console.log(`  ${description}`);
    console.log(`  ${'[2m'}${sessionCount} session${sessionCount === 1 ? '' : 's'} currently stored.${'[0m'}`);
    console.log(`  ${'[2m'}This includes run history and dashboard data.${'[0m'}\n`);

    const answer = await ask('  Continue? (y/n) ');
    if (answer !== 'y') {
      console.log(`\n  ${'[2m'}Cancelled. No data was deleted.${'[0m'}\n`);
      return { type: 'clear', action: 'cancelled', deletedCount: 0, sessionCount };
    }
  }

  // Execute deletion
  let deletedCount: number;
  if (opts.olderThan !== undefined && opts.olderThan > 0) {
    const cutoff = new Date(Date.now() - opts.olderThan * 24 * 60 * 60 * 1000);
    deletedCount = repo.purge(cutoff);
  } else {
    deletedCount = repo.clearAll();
  }

  console.log(`\n  ${'[32m'}✓${'[0m'} ${deletedCount} session${deletedCount === 1 ? '' : 's'} deleted.\n`);
  return { type: 'clear', action: 'done', deletedCount, sessionCount, olderThan: opts.olderThan };
}

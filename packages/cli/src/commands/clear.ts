/**
 * clear command — clear session data from
 * <project>/opensip-tools/.runtime/sessions/.
 *
 * Uses Node readline for interactive confirmation (not Ink),
 * since Ink's useInput requires raw mode which isn't always available.
 */

import { createInterface } from 'node:readline';

import { countSessions, clearAllSessions, clearSessionsOlderThan } from '@opensip-tools/contracts';

export interface ClearOptions {
  olderThan?: number;
  yes: boolean;
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
const ansiBrand = (s: string): string => `\u001B[38;2;200;149;108m${s}\u001B[0m`;
const ansiDim = (s: string): string => `\u001B[2m${s}\u001B[0m`;

/** Print the banner using raw ANSI (avoids Ink dependency) */
function printBanner(): void {
  // Simplified banner header
  console.log('');
  console.log(`  ${ansiBrand('OpenSIP Tools')} ${ansiDim('— session management')}`);
  console.log('');
}

export async function executeClear(opts: ClearOptions): Promise<ClearResult> {
  printBanner();

  const sessionCount = countSessions();

  if (sessionCount === 0) {
    console.log(`  ${'\u001B[2m'}No session data to clear.${'\u001B[0m'}\n`);
    return { type: 'clear', action: 'empty', deletedCount: 0, sessionCount: 0 };
  }

  // Describe what will happen
  const dayWord = opts.olderThan === 1 ? 'day' : 'days';
  const description = opts.olderThan
    ? `This will delete session data older than ${opts.olderThan} ${dayWord} from opensip-tools/.runtime/sessions/.`
    : 'This will delete ALL session data from opensip-tools/.runtime/sessions/.';

  // Prompt for confirmation unless --yes
  if (!opts.yes) {
    console.log(`  ${description}`);
    console.log(`  ${'\u001B[2m'}${sessionCount} session file${sessionCount === 1 ? '' : 's'} currently stored.${'\u001B[0m'}`);
    console.log(`  ${'\u001B[2m'}This includes run history and dashboard data.${'\u001B[0m'}\n`);

    const answer = await ask('  Continue? (y/n) ');
    if (answer !== 'y') {
      console.log(`\n  ${'\u001B[2m'}Cancelled. No data was deleted.${'\u001B[0m'}\n`);
      return { type: 'clear', action: 'cancelled', deletedCount: 0, sessionCount };
    }
  }

  // Execute deletion
  const deletedCount = opts.olderThan !== undefined && opts.olderThan > 0 ? clearSessionsOlderThan(opts.olderThan) : clearAllSessions();

  console.log(`\n  ${'\u001B[32m'}\u2713${'\u001B[0m'} ${deletedCount} session${deletedCount === 1 ? '' : 's'} deleted.\n`);
  return { type: 'clear', action: 'done', deletedCount, sessionCount, olderThan: opts.olderThan };
}

/**
 * clear command — clear session data from ~/.opensip-tools/sessions/
 *
 * Uses Node readline for interactive confirmation (not Ink),
 * since Ink's useInput requires raw mode which isn't always available.
 */

import { createInterface } from 'node:readline';
import { countSessions, clearAllSessions, clearSessionsOlderThan } from '@opensip-tools/cli-shared';

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

/** Print the banner using raw ANSI (avoids Ink dependency) */
function printBanner(): void {
  const brand = (s: string) => `\x1b[38;2;200;149;108m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

  // Simplified banner header
  console.log('');
  console.log(`  ${brand('OpenSIP Tools')} ${dim('— session management')}`);
  console.log('');

  return void [brand, bold, green, dim]; // suppress unused warnings
}

export async function executeClear(opts: ClearOptions): Promise<ClearResult> {
  printBanner();

  const sessionCount = countSessions();

  if (sessionCount === 0) {
    console.log(`  ${'\x1b[2m'}No session data to clear.${'\x1b[0m'}\n`);
    return { type: 'clear', action: 'empty', deletedCount: 0, sessionCount: 0 };
  }

  // Describe what will happen
  const description = opts.olderThan
    ? `This will delete session data older than ${opts.olderThan} day${opts.olderThan === 1 ? '' : 's'} from ~/.opensip-tools/sessions/.`
    : 'This will delete ALL session data from ~/.opensip-tools/sessions/.';

  // Prompt for confirmation unless --yes
  if (!opts.yes) {
    console.log(`  ${description}`);
    console.log(`  ${'\x1b[2m'}${sessionCount} session file${sessionCount === 1 ? '' : 's'} currently stored.${'\x1b[0m'}`);
    console.log(`  ${'\x1b[2m'}This includes run history and dashboard data.${'\x1b[0m'}\n`);

    const answer = await ask('  Continue? (y/n) ');
    if (answer !== 'y') {
      console.log(`\n  ${'\x1b[2m'}Cancelled. No data was deleted.${'\x1b[0m'}\n`);
      return { type: 'clear', action: 'cancelled', deletedCount: 0, sessionCount };
    }
  }

  // Execute deletion
  let deletedCount: number;
  if (opts.olderThan !== undefined && opts.olderThan > 0) {
    deletedCount = clearSessionsOlderThan(opts.olderThan);
  } else {
    deletedCount = clearAllSessions();
  }

  console.log(`\n  ${'\x1b[32m'}\u2713${'\x1b[0m'} ${deletedCount} session${deletedCount === 1 ? '' : 's'} deleted.\n`);
  return { type: 'clear', action: 'done', deletedCount, sessionCount, olderThan: opts.olderThan };
}

/**
 * clear command — clear session data from
 * `<project>/opensip-tools/.runtime/sessions/`.
 *
 * Uses Node `readline` for interactive confirmation (Ink's `useInput`
 * raw-mode requirement is incompatible with prompts on every TTY).
 * Banners and result lines route through the Ink renderer via the
 * `clear-done` `CommandResult` shape — no raw ANSI escapes here.
 */

import { createInterface } from 'node:readline';

import {
  countSessions,
  clearAllSessions,
  clearSessionsOlderThan,
  type ClearDoneResult,
} from '@opensip-tools/contracts';

export interface ClearOptions {
  olderThan?: number;
  yes: boolean;
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

/**
 * Prompt for confirmation (unless --yes), then delete sessions.
 * Returns a `ClearDoneResult` that the renderer turns into the banner
 * + status line. The rendering is `App.tsx`'s `case 'clear-done':`
 * branch — this function is pure I/O for the prompt only.
 */
export async function executeClear(opts: ClearOptions): Promise<ClearDoneResult> {
  const sessionCount = countSessions();
  if (sessionCount === 0) {
    return { type: 'clear-done', action: 'empty', deletedCount: 0, sessionCount: 0 };
  }

  if (!opts.yes) {
    // Pre-prompt note. Stdout `process.stdout.write` is fine here:
    // Ink can't own this since it conflicts with `readline.question()`,
    // and there are no ANSI escapes — just plain text the user reads
    // before answering. Ink renders the result message after.
    const dayWord = opts.olderThan === 1 ? 'day' : 'days';
    const description = opts.olderThan
      ? `This will delete session data older than ${opts.olderThan} ${dayWord} from opensip-tools/.runtime/sessions/.`
      : 'This will delete ALL session data from opensip-tools/.runtime/sessions/.';
    process.stdout.write(`\n  ${description}\n`);
    process.stdout.write(`  ${sessionCount} session file${sessionCount === 1 ? '' : 's'} currently stored.\n`);
    process.stdout.write(`  This includes run history and dashboard data.\n\n`);

    const answer = await ask('  Continue? (y/n) ');
    if (answer !== 'y') {
      return { type: 'clear-done', action: 'cancelled', deletedCount: 0, sessionCount };
    }
  }

  const deletedCount = opts.olderThan !== undefined && opts.olderThan > 0
    ? clearSessionsOlderThan(opts.olderThan)
    : clearAllSessions();

  return { type: 'clear-done', action: 'done', deletedCount, sessionCount };
}

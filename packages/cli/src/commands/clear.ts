/**
 * clear command — clear session data from the project-local SQLite DB.
 *
 * v2: rows in the `sessions` table (and cascaded findings/checks) are
 * the unit of deletion; the file-by-file purge of v1 is gone. The CLI
 * bootstrap opens the DataStore in `preAction`; this command receives
 * the constructed repo from its caller.
 *
 * Uses Node `readline` for interactive confirmation (Ink's `useInput`
 * raw-mode requirement is incompatible with prompts on every TTY).
 * Banners and result lines route through the Ink renderer via the
 * `clear-done` `CommandResult` shape — no raw ANSI escapes here.
 */

import { createInterface } from 'node:readline';

import { SessionRepo } from '@opensip-tools/session-store';

import type { ClearDoneResult } from '@opensip-tools/contracts';
import type { DataStore } from '@opensip-tools/datastore';

export interface ClearOptions {
  olderThan?: number;
  yes: boolean;
  datastore: DataStore;
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
 *
 * v2: deletion goes through `SessionRepo` against the project-local
 * SQLite DB. Cascaded findings/checks are removed by foreign-key
 * cascade rules in the schema.
 */
export async function executeClear(opts: ClearOptions): Promise<ClearDoneResult> {
  const repo = new SessionRepo(opts.datastore);
  const sessionCount = repo.count();
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
      ? `This will delete session data older than ${opts.olderThan} ${dayWord} from the project-local SQLite store.`
      : 'This will delete ALL session data from the project-local SQLite store.';
    process.stdout.write(`\n  ${description}\n`);
    process.stdout.write(`  ${sessionCount} session${sessionCount === 1 ? '' : 's'} currently stored.\n`);
    process.stdout.write(`  This includes run history and dashboard data.\n\n`);

    const answer = await ask('  Continue? (y/n) ');
    if (answer !== 'y') {
      return { type: 'clear-done', action: 'cancelled', deletedCount: 0, sessionCount };
    }
  }

  let deletedCount: number;
  if (opts.olderThan !== undefined && opts.olderThan > 0) {
    const cutoff = new Date(Date.now() - opts.olderThan * 24 * 60 * 60 * 1000);
    deletedCount = repo.purge(cutoff);
  } else {
    deletedCount = repo.clearAll();
  }

  return { type: 'clear-done', action: 'done', deletedCount, sessionCount };
}

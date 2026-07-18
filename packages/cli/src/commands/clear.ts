/**
 * clear command — delete Tool Session rows from the active local evidence store.
 *
 * Works against whichever store the host opened for this run: project runtime
 * after Init, or the user-cache ephemeral store on a no-init first run. Only
 * Tool Sessions (and cascaded session payloads/findings) are deleted. Parent
 * Runs/steps/snapshots, reports, graph catalogs, baselines, plugins, and other
 * runtime state are preserved. Full-state removal is `opensip uninstall --project`.
 *
 * Uses Node `readline` for interactive confirmation (Ink's `useInput`
 * raw-mode requirement is incompatible with prompts on every TTY).
 * Banners and result lines route through the Ink renderer via the
 * `clear-done` `CommandResult` shape — no raw ANSI escapes here.
 */

import { createInterface } from 'node:readline';

import { SessionRepo } from '@opensip-cli/session-store';

import type { ClearDoneResult } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

export interface ClearOptions {
  olderThan?: number;
  yes: boolean;
  datastore: DataStore;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * Prompt for confirmation (unless --yes), then delete matching Tool Sessions
 * from the active local evidence store through SessionRepo's write-locked
 * purge/clear paths (selection + deletion share the datastore write lock and
 * a single SQLite mutation).
 *
 * Returns a `ClearDoneResult` that the renderer turns into the banner
 * + status line.
 */
export async function executeClear(opts: ClearOptions): Promise<ClearDoneResult> {
  const repo = new SessionRepo(opts.datastore);
  const sessionCount = repo.count();
  if (sessionCount === 0) {
    return {
      type: 'clear-done',
      action: 'empty',
      deletedCount: 0,
      sessionCount: 0,
    };
  }

  if (!opts.yes) {
    // Pre-prompt note. Stdout `process.stdout.write` is fine here:
    // Ink can't own this since it conflicts with `readline.question()`,
    // and there are no ANSI escapes — just plain text the user reads
    // before answering. Ink renders the result message after.
    const dayWord = opts.olderThan === 1 ? 'day' : 'days';
    const description = opts.olderThan
      ? `This will delete Tool Sessions older than ${opts.olderThan} ${dayWord} from the active local evidence store.`
      : 'This will delete ALL Tool Sessions from the active local evidence store.';
    process.stdout.write(`\n  ${description}\n`);
    process.stdout.write(
      `  ${sessionCount} session${sessionCount === 1 ? '' : 's'} currently stored.\n`,
    );
    process.stdout.write(
      `  Parent Runs, reports, graph catalogs, baselines, and other runtime state are preserved.\n`,
    );
    process.stdout.write(
      `  For full project runtime removal, use: opensip uninstall --project\n\n`,
    );

    const answer = await ask('  Continue? (y/n) ');
    if (answer !== 'y') {
      return {
        type: 'clear-done',
        action: 'cancelled',
        deletedCount: 0,
        sessionCount,
      };
    }
  }

  // Age-bounded and full clears both go through SessionRepo maintenance,
  // which acquires the datastore write lock for the mutation (serializing
  // with evidence-bundle commits and other writers).
  let deletedCount: number;
  if (opts.olderThan !== undefined && opts.olderThan > 0) {
    // Wall-time cutoff (N calendar-ish days ago by ms). Not sensitive to
    // local date boundaries or DST; sessions are purged if their stored
    // timestamp is older than (now - N*24h). This matches the user-facing
    // "older than X days" language in the prompt.
    const cutoff = new Date(Date.now() - opts.olderThan * 24 * 60 * 60 * 1000);
    deletedCount = repo.purge(cutoff);
  } else {
    deletedCount = repo.clearAll();
  }

  return { type: 'clear-done', action: 'done', deletedCount, sessionCount };
}

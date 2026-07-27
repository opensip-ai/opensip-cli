/**
 * VIOLATION fixture — reduced from the real confirmed site
 * `packages/cli/src/commands/repair/git-safety.ts:12` (unchanged shape: the
 * options bag carries `encoding` and `stdio`, neither of which bounds anything).
 *
 * `repair apply` calls this before mutating a worktree. A `git` that blocks —
 * an index.lock held by another process, a credential prompt on a hung stdin, a
 * stalled NFS/network worktree — never returns, and because `execFileSync`
 * blocks the thread the whole CLI stops with no timeout, no output ceiling, and
 * no diagnostic.
 *
 * Expected: exactly ONE finding, on the `execFileSync` line below.
 */
import { execFileSync } from 'node:child_process';

export function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

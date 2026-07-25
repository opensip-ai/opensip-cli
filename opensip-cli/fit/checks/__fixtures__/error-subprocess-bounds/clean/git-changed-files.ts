/**
 * CLEAN fixture — reduced from `packages/core/src/lib/git-changed-files.ts`,
 * the form this repo's reviewers accepted for exactly the same `git` shell-out
 * the violation fixture gets wrong. Both bounds are present: `maxBuffer` caps a
 * monorepo-wide rename diff, `timeout` caps the wall clock. Either one alone
 * would satisfy the rule; this site sets both.
 *
 * Expected: ZERO findings.
 */
import { execFileSync } from 'node:child_process';

const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    timeout: 5000,
  }).trim();
}

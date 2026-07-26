import { execFileSync } from 'node:child_process';

import { err, ok, type Result } from '@opensip-cli/core';

import type { RepairError } from './types.js';

function repairError(code: string, message: string): RepairError {
  return { code, message };
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    // Bounded (Plan 01): a git call blocked on an index lock must not hang the repair path.
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function ensureRepairWorktreeClean(
  projectRoot: string,
  relativePaths: readonly string[],
  force: boolean,
): Result<true, RepairError> {
  if (force || relativePaths.length === 0) return ok(true);

  try {
    const inside = git(['rev-parse', '--is-inside-work-tree'], projectRoot).trim();
    if (inside !== 'true') {
      return err(repairError('git-unavailable', 'repair apply requires a git worktree or --force'));
    }
  } catch {
    return err(repairError('git-unavailable', 'repair apply requires a git worktree or --force'));
  }

  const status = git(['status', '--porcelain', '--', ...relativePaths], projectRoot);
  if (status.trim() !== '') {
    return err(
      repairError(
        'dirty-worktree',
        'repair apply refuses to edit files with existing git changes; commit, stash, or pass --force',
      ),
    );
  }
  return ok(true);
}

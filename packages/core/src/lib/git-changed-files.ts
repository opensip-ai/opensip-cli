/**
 * Host-owned git changed-file resolver (ADR-0085).
 *
 * Single source of truth for deriving changed files from git. Tools must not
 * shell out independently — fitness `--changed` and `graph impact --changed`
 * both call this function.
 */
import { execFileSync } from 'node:child_process';

import { toPosixRelative } from './paths.js';

/** Basis metadata for a git-derived changed-file set. */
export interface ChangedFileBasis {
  readonly type: 'changed';
  readonly source: 'git';
  readonly ref?: string;
}

/**
 * Result of {@link resolveChangedFiles}: either the resolved changed-file set
 * with its basis, or a structured failure reason (never a throw for a non-repo
 * / bad ref / missing git).
 */
export type ChangedFilesResult =
  | {
      readonly ok: true;
      readonly basis: ChangedFileBasis;
      readonly files: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'not-a-repo' | 'git-unavailable' | 'bad-ref';
      readonly message: string;
    };

function git(
  cwd: string,
  args: readonly string[],
): { readonly ok: true; readonly out: string } | { readonly ok: false } {
  try {
    const out = execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      // @fitness-ignore-next-line no-hardcoded-timeouts -- bounded safety cap on a local git shell-out (never hangs the CLI)
      timeout: 5000,
    }).trim();
    return { ok: true, out };
  } catch {
    return { ok: false };
  }
}

function parseNameOnlyOutput(output: string): string[] {
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function validateSinceRef(cwd: string, since: string): ChangedFilesResult | null {
  if (since.startsWith('-')) {
    return {
      ok: false,
      reason: 'bad-ref',
      message: `Invalid ref "${since}": refs must not begin with "-"`,
    };
  }
  const verified = git(cwd, ['rev-parse', '--verify', '--quiet', `${since}^{commit}`]);
  if (!verified.ok) {
    return {
      ok: false,
      reason: 'bad-ref',
      message: `Ref "${since}" does not resolve to a commit`,
    };
  }
  return null;
}

/**
 * Resolve changed files from git for the given working directory.
 *
 * With `since`: diff `<since>...HEAD` (committed changes on the current branch).
 * Without `since`: working-tree diff against HEAD plus untracked files.
 */
export function resolveChangedFiles(
  cwd: string,
  opts?: { readonly since?: string },
): ChangedFilesResult {
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') {
    return {
      ok: false,
      reason: 'not-a-repo',
      message: 'Not inside a git working tree',
    };
  }

  const since = opts?.since?.trim();
  if (since) {
    const refError = validateSinceRef(cwd, since);
    if (refError) return refError;

    // NB: the ref range must NOT sit after `--` — everything after `--` is a
    // pathspec, so `<since>...HEAD` would be read as a (non-existent) filename
    // and the diff would be empty. The ref is already validated (no leading `-`,
    // resolves via rev-parse) so there is no injection exposure without `--`.
    const diff = git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', `${since}...HEAD`]);
    if (!diff.ok) {
      return {
        ok: false,
        reason: 'git-unavailable',
        message: 'Git diff failed',
      };
    }

    const files = parseNameOnlyOutput(diff.out).map((f) => toPosixRelative(cwd, f));
    return {
      ok: true,
      basis: { type: 'changed', source: 'git', ref: since },
      files,
    };
  }

  const diff = git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']);
  if (!diff.ok) {
    return {
      ok: false,
      reason: 'git-unavailable',
      message: 'Git diff failed',
    };
  }

  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']);
  if (!untracked.ok) {
    return {
      ok: false,
      reason: 'git-unavailable',
      message: 'Git ls-files failed',
    };
  }

  const fileSet = new Set<string>();
  for (const f of parseNameOnlyOutput(diff.out)) {
    fileSet.add(toPosixRelative(cwd, f));
  }
  for (const f of parseNameOnlyOutput(untracked.out)) {
    fileSet.add(toPosixRelative(cwd, f));
  }

  return {
    ok: true,
    basis: { type: 'changed', source: 'git' },
    files: [...fileSet],
  };
}

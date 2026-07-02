/**
 * Host-owned git changed-file resolver (ADR-0085).
 *
 * Single source of truth for deriving changed files from git. Tools must not
 * shell out independently — fitness `--changed` and `graph impact --changed`
 * both call this function.
 */
import { execFileSync } from 'node:child_process';

import { toPosixRelative } from './paths.js';

/** Warning code emitted when git can return files but the basis is incomplete. */
export type ChangedFileWarningCode = 'git-shallow' | 'git-merge-base-unavailable';

/** Non-fatal changed-file basis warning for conservative impact trust. */
export interface ChangedFileWarning {
  readonly code: ChangedFileWarningCode;
  readonly message: string;
}

/** Basis metadata for a git-derived changed-file set. */
export interface ChangedFileBasis {
  readonly type: 'changed';
  readonly source: 'git';
  readonly ref?: string;
  readonly mergeBase?: string;
  readonly isShallow?: boolean;
  readonly warnings?: readonly ChangedFileWarning[];
}

/** Git status classification for a changed path. */
export type ChangedFileStatus =
  | 'added'
  | 'modified'
  | 'copied'
  | 'renamed'
  | 'deleted'
  | 'untracked'
  | 'unknown';

/** A changed path plus enough status metadata for conservative impact trust. */
export interface ChangedFileEntry {
  readonly path: string;
  readonly status: ChangedFileStatus;
  readonly previousPath?: string;
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
      readonly entries: readonly ChangedFileEntry[];
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

function statusFromGitCode(code: string): ChangedFileStatus {
  switch (code.charAt(0)) {
    case 'A': {
      return 'added';
    }
    case 'C': {
      return 'copied';
    }
    case 'D': {
      return 'deleted';
    }
    case 'M': {
      return 'modified';
    }
    case 'R': {
      return 'renamed';
    }
    default: {
      return 'unknown';
    }
  }
}

function parseNameStatusOutput(output: string): ChangedFileEntry[] {
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [code = '', first = '', second] = line.split('\t');
      const status = statusFromGitCode(code);
      if ((status === 'renamed' || status === 'copied') && second !== undefined) {
        return {
          path: second,
          status,
          previousPath: first,
        };
      }
      return {
        path: first,
        status,
      };
    });
}

function toRelativeEntries(cwd: string, entries: readonly ChangedFileEntry[]): ChangedFileEntry[] {
  return entries.map((entry) => ({
    path: toPosixRelative(cwd, entry.path),
    status: entry.status,
    ...(entry.previousPath === undefined
      ? {}
      : { previousPath: toPosixRelative(cwd, entry.previousPath) }),
  }));
}

function dedupeEntries(entries: readonly ChangedFileEntry[]): ChangedFileEntry[] {
  const byPath = new Map<string, ChangedFileEntry>();
  for (const entry of entries) {
    byPath.set(entry.path, entry);
  }
  return [...byPath.values()];
}

function shallowWarning(cwd: string): {
  readonly isShallow: boolean;
  readonly warnings: ChangedFileWarning[];
} {
  const shallow = git(cwd, ['rev-parse', '--is-shallow-repository']);
  if (!shallow.ok || shallow.out !== 'true') return { isShallow: false, warnings: [] };
  return {
    isShallow: true,
    warnings: [
      {
        code: 'git-shallow',
        message: 'Repository is shallow; changed-file ancestry may be incomplete.',
      },
    ],
  };
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

function okResult(
  basis: ChangedFileBasis,
  entries: readonly ChangedFileEntry[],
): ChangedFilesResult {
  return {
    ok: true,
    basis,
    files: entries.map((entry) => entry.path),
    entries,
  };
}

function diffNameStatus(cwd: string, ref: string): ReturnType<typeof git> {
  return git(cwd, ['diff', '--name-status', '--find-renames', '--diff-filter=ACMDR', ref]);
}

function basisWithWarnings(input: {
  readonly ref?: string;
  readonly mergeBase?: string;
  readonly shallow: ReturnType<typeof shallowWarning>;
  readonly warnings: readonly ChangedFileWarning[];
}): ChangedFileBasis {
  return {
    type: 'changed',
    source: 'git',
    ...(input.ref === undefined ? {} : { ref: input.ref }),
    ...(input.mergeBase === undefined ? {} : { mergeBase: input.mergeBase }),
    ...(input.shallow.isShallow ? { isShallow: true } : {}),
    ...(input.warnings.length > 0 ? { warnings: input.warnings } : {}),
  };
}

function resolveSinceChangedFiles(cwd: string, since: string): ChangedFilesResult {
  const refError = validateSinceRef(cwd, since);
  if (refError) return refError;

  const shallow = shallowWarning(cwd);
  const warnings = [...shallow.warnings];
  const mergeBase = git(cwd, ['merge-base', since, 'HEAD']);
  if (!mergeBase.ok) {
    warnings.push({
      code: 'git-merge-base-unavailable',
      message: `Unable to resolve merge-base between ${since} and HEAD.`,
    });
  }

  // NB: the ref range must NOT sit after `--` — everything after `--` is a
  // pathspec, so `<since>...HEAD` would be read as a (non-existent) filename
  // and the diff would be empty. The ref is already validated (no leading `-`,
  // resolves via rev-parse) so there is no injection exposure without `--`.
  const diff = diffNameStatus(cwd, `${since}...HEAD`);
  if (!diff.ok) {
    return {
      ok: false,
      reason: mergeBase.ok ? 'git-unavailable' : 'bad-ref',
      message: mergeBase.ok ? 'Git diff failed' : `Merge-base for "${since}" is unavailable`,
    };
  }

  return okResult(
    basisWithWarnings({
      ref: since,
      ...(mergeBase.ok ? { mergeBase: mergeBase.out } : {}),
      shallow,
      warnings,
    }),
    toRelativeEntries(cwd, parseNameStatusOutput(diff.out)),
  );
}

function resolveWorkingTreeChangedFiles(cwd: string): ChangedFilesResult {
  const diff = diffNameStatus(cwd, 'HEAD');
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

  const entries = toRelativeEntries(cwd, parseNameStatusOutput(diff.out));
  const untrackedEntries = parseNameOnlyOutput(untracked.out).map((f): ChangedFileEntry => {
    const path = toPosixRelative(cwd, f);
    return { path, status: 'untracked' };
  });
  const allEntries = dedupeEntries([...entries, ...untrackedEntries]);
  const shallow = shallowWarning(cwd);
  return okResult(
    basisWithWarnings({
      shallow,
      warnings: shallow.warnings,
    }),
    allEntries,
  );
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
    return resolveSinceChangedFiles(cwd, since);
  }

  return resolveWorkingTreeChangedFiles(cwd);
}
